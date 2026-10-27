/**
 * DB test: loader finds account given decoded params.id containing '/' and ':'.
 *
 * Verifies that when React Router decodes a URL-encoded id (e.g. ids with
 * embedded path separators), the loader's DB lookup succeeds.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { matchRoutes, type RouteObject } from "react-router";
import { sqlOptions } from "~/lib/db-light.server";
import { accountHref } from "~/lib/account-href";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
  ApiVersion: { October26: "2026-10" },
}));

vi.mock("@sentry/cloudflare", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  setUser: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock("~/lib/recompute-enqueue.server", () => ({
  enqueueCreditStatusRecompute: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn(() => "test-actor"),
}));

const TEST_ID_WITH_SLASHES = "seed-test-0000-example/part:9";

/**
 * Build the route config that matches the app's flat routes under app/routes/.
 */
function buildAppRouteConfig(): RouteObject[] {
  return [
    {
      id: "routes/app",
      path: "app",
      children: [
        { id: "routes/app._index", index: true },
        { id: "routes/app.accounts.$id", path: "accounts/:id" },
        { id: "routes/app.$", path: "*" },
      ],
    },
  ];
}

describeWithDb("account-href loader DB test", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-href";

  const SHOP_ID = `shop-href-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `href-${TEST_SUFFIX}.myshopify.com`;
  const ACCOUNT_ID = `${TEST_ID_WITH_SLASHES}-${TEST_SUFFIX}`;
  const COMPANY_ID = `company-href-${TEST_SUFFIX}`;
  const LOCATION_ID = `location-href-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "holdState", "createdAt", "updatedAt"
      ) VALUES (
        ${ACCOUNT_ID}, ${SHOP_ID}, 'COMPANY', ${COMPANY_ID}, ${LOCATION_ID},
        'Test Account With Slashes', 'OK', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${ACCOUNT_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  it("loader finds account when params.id is decoded (contains '/' and ':')", async () => {
    const { requestContext } = await import("~/lib/request-context.server");
    const { loader } = await import("../app.accounts.$id");

    const href = accountHref(ACCOUNT_ID);
    const routes = buildAppRouteConfig();
    const matches = matchRoutes(routes, href);

    expect(matches).not.toBeNull();
    const leafMatch = matches![matches!.length - 1];
    expect(leafMatch.route.id).toBe("routes/app.accounts.$id");

    const decodedId = leafMatch.params.id!;
    expect(decodedId).toBe(ACCOUNT_ID);

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
          }),
        },
      },
      cloudflare: {
        env: {},
      },
    };

    const url = new URL(`https://example.com${href}`);
    const request = new Request(url.toString());

    const args = {
      request,
      context: mockContext,
      params: { id: decodedId },
      url,
      pattern: "/app/accounts/:id",
    };

    const result = await requestContext.run({ getSql: () => sql }, async () => {
      return loader(args as never);
    });

    const data = extractLoaderResult<{ account: { id: string; name: string } | null; error: string | null }>(result);

    expect(data.error).toBeNull();
    expect(data.account).not.toBeNull();
    expect(data.account?.id).toBe(ACCOUNT_ID);
    expect(data.account?.name).toBe("Test Account With Slashes");
  });

  it("account id contains the special characters", () => {
    expect(ACCOUNT_ID).toContain("/");
    expect(ACCOUNT_ID).toContain(":");
  });
});

function extractLoaderResult<T>(result: unknown): T {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: T }).data;
  }
  return result as T;
}
