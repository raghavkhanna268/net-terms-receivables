/**
 * DB-backed tests for account not-found 404 behavior.
 * Uses the CI pgmq Postgres service.
 *
 * Tests:
 * - Loader returns 404 for a missing account id
 * - Loader returns 404 for an account belonging to another shop (cross-shop isolation)
 * - ErrorBoundary renders Back button and does not echo the requested id
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue(null),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn(),
  parseCreditLimitString: vi.fn().mockReturnValue({ valid: true, value: 0 }),
}));

describeWithDb("app.accounts.$id not-found 404 (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-notfound-db";
  const TEST_SHOP_ID = `shop-notfound-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-notfound-${TEST_SUFFIX}.example.com`;
  const TEST_ACCOUNT_ID = `acc-notfound-${TEST_SUFFIX}`;

  const OTHER_SHOP_ID = `shop-other-${TEST_SUFFIX}`;
  const OTHER_SHOP_DOMAIN = `test-other-${TEST_SUFFIX}.example.com`;
  const OTHER_ACCOUNT_ID = `acc-other-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${OTHER_SHOP_ID}, ${OTHER_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX},
        'Test Account', 100000.00, 'OK', false, false,
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "syncPending",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${OTHER_ACCOUNT_ID}, ${OTHER_SHOP_ID}, 'COMPANY',
        ${"co-other-" + TEST_SUFFIX}, ${"loc-other-" + TEST_SUFFIX},
        'Other Shop Account', 50000.00, 'OK', false, false,
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql.end();
  });

  function createLoaderArgs(accountId: string, shopDomain: string) {
    const url = new URL("https://example.com/app/accounts/" + accountId);
    return {
      request: new Request(url),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: shopDomain },
              sessionToken: { sub: "user-1" },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: { id: accountId },
      url,
      pattern: "/app/accounts/:id",
    } as unknown;
  }

  it("returns 404 for a non-existent account id", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));

    const { loader } = await import("../app.accounts.$id");

    const nonExistentId = `nonexistent-${TEST_SUFFIX}`;
    const args = createLoaderArgs(nonExistentId, TEST_SHOP_DOMAIN);

    try {
      await loader(args as never);
      expect.fail("Expected loader to throw 404");
    } catch (error) {
      expect(error).toHaveProperty("init.status", 404);
    }
  });

  it("returns 404 for an account belonging to another shop (cross-shop isolation)", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));

    const { loader } = await import("../app.accounts.$id");

    const args = createLoaderArgs(OTHER_ACCOUNT_ID, TEST_SHOP_DOMAIN);

    try {
      await loader(args as never);
      expect.fail("Expected loader to throw 404");
    } catch (error) {
      expect(error).toHaveProperty("init.status", 404);
    }
  });

  it("returns valid data for own shop account", async () => {
    vi.resetModules();
    vi.doMock("~/lib/request-context.server", () => ({
      getRequestSql: () => sql,
      getRequestWaitUntil: () => undefined,
    }));

    const { loader } = await import("../app.accounts.$id");

    const args = createLoaderArgs(TEST_ACCOUNT_ID, TEST_SHOP_DOMAIN);
    const result = await loader(args as never);

    expect(result.account).not.toBeNull();
    expect(result.account?.id).toBe(TEST_ACCOUNT_ID);
    expect(result.error).toBeNull();
  });
});

describe("app.accounts.$id ErrorBoundary", () => {
  it("renders Back button with href to /app", async () => {
    const { ErrorBoundary } = await import("../app.accounts.$id");
    const element = ErrorBoundary();

    const rendered = JSON.stringify(element);
    expect(rendered).toContain('"href":"/app"');
    expect(rendered).toContain("Back");
  });

  it("displays generic Account not found copy without echoing any id", async () => {
    const { ErrorBoundary } = await import("../app.accounts.$id");
    const element = ErrorBoundary();

    const rendered = JSON.stringify(element);
    expect(rendered).toContain("Account not found");
    expect(rendered).not.toContain("gid://");
    expect(rendered).not.toMatch(/acc-[a-z0-9]+/i);
    expect(rendered).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i);
  });

  it("uses s-button element not Link wrapping button", async () => {
    const { ErrorBoundary } = await import("../app.accounts.$id");
    const element = ErrorBoundary();

    const rendered = JSON.stringify(element);
    expect(rendered).toContain("s-button");
    expect(rendered).not.toMatch(/"Link"/);
  });
});
