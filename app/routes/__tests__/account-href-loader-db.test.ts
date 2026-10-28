/**
 * DB test: loader finds account given decoded params.id containing '/' and ':'.
 *
 * Verifies that when React Router decodes a URL-encoded id (e.g. ids with
 * embedded path separators), the loader's DB lookup succeeds.
 *
 * Route config is derived from real app/routes/*.tsx filenames so the test
 * breaks if route files are renamed or removed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import postgres from "postgres";
import { matchRoutes, type RouteObject } from "react-router";
import { readdirSync } from "fs";
import { resolve } from "path";
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
 * Convert a flatRoutes filename segment to a route path segment.
 */
function segmentToPath(segment: string): string | null {
  if (segment === "_index") return null;
  if (segment.startsWith("_")) return "";
  if (segment === "$") return "*";
  if (segment.startsWith("$")) return ":" + segment.slice(1);
  return segment;
}

/**
 * Build route config from real app/routes/*.tsx filenames.
 */
function buildAppRouteConfig(): RouteObject[] {
  const routesDir = resolve(__dirname, "../../routes");
  const files = readdirSync(routesDir).filter(
    (f) => f.startsWith("app.") && f.endsWith(".tsx") && f !== "app.tsx"
  );

  const children: RouteObject[] = [];
  const catchAll: RouteObject[] = [];

  for (const file of files) {
    const name = file.replace(/\.tsx$/, "");
    const id = `routes/${name}`;
    const segments = name.split(".").slice(1);

    if (segments.length === 1 && segments[0] === "_index") {
      children.push({ id, index: true });
      continue;
    }

    const pathParts = segments.map(segmentToPath).filter((p) => p !== null && p !== "");
    const path = pathParts.join("/");

    const route: RouteObject = { id, path: path || undefined };

    if (path === "*") {
      catchAll.push(route);
    } else {
      children.push(route);
    }
  }

  children.push(...catchAll);

  return [
    {
      id: "routes/app",
      path: "app",
      children,
    },
  ];
}

describeWithDb("account-href loader DB test", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-href";

  const SHOP_ID = `shop-href-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-href-${TEST_SUFFIX}.myshopify.com`;
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

describeWithDb("account-href encoded id DB test (loader and action)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-enc";

  const SHOP_ID = `shop-enc-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-enc-${TEST_SUFFIX}.example.com`;
  const ACCOUNT_ID = `${TEST_ID_WITH_SLASHES}-${TEST_SUFFIX}`;
  const COMPANY_ID = `company-enc-${TEST_SUFFIX}`;
  const LOCATION_ID = `location-enc-${TEST_SUFFIX}`;
  const NONEXISTENT_ACCOUNT_ID = `test-nonexistent/path:segment-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", "manualHold", "createdAt", "updatedAt"
      ) VALUES (
        ${ACCOUNT_ID}, ${SHOP_ID}, 'COMPANY', ${COMPANY_ID}, ${LOCATION_ID},
        'Test Encoded Account', 50000.00, 'OK', false, NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE id = ${ACCOUNT_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  it("loader finds account with single-encoded params.id", async () => {
    const { requestContext } = await import("~/lib/request-context.server");
    const { loader } = await import("../app.accounts.$id");

    const singleEncodedId = encodeURIComponent(ACCOUNT_ID);
    const href = `/app/accounts/${singleEncodedId}`;
    const url = new URL(`https://example.com${href}`);
    const request = new Request(url.toString());

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
          }),
        },
      },
      cloudflare: { env: {} },
    };

    const args = {
      request,
      context: mockContext,
      params: { id: singleEncodedId },
      url,
      pattern: "/app/accounts/:id",
    };

    const result = await requestContext.run({ getSql: () => sql }, async () => {
      return loader(args as never);
    });

    const data = extractLoaderResult<{ account: { id: string } | null; error: string | null }>(result);
    expect(data.error).toBeNull();
    expect(data.account).not.toBeNull();
    expect(data.account?.id).toBe(ACCOUNT_ID);
  });

  it("loader finds account with double-encoded params.id", async () => {
    const { requestContext } = await import("~/lib/request-context.server");
    const { loader } = await import("../app.accounts.$id");

    const doubleEncodedId = encodeURIComponent(encodeURIComponent(ACCOUNT_ID));
    const href = `/app/accounts/${doubleEncodedId}`;
    const url = new URL(`https://example.com${href}`);
    const request = new Request(url.toString());

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
          }),
        },
      },
      cloudflare: { env: {} },
    };

    const args = {
      request,
      context: mockContext,
      params: { id: doubleEncodedId },
      url,
      pattern: "/app/accounts/:id",
    };

    const result = await requestContext.run({ getSql: () => sql }, async () => {
      return loader(args as never);
    });

    const data = extractLoaderResult<{ account: { id: string } | null; error: string | null }>(result);
    expect(data.error).toBeNull();
    expect(data.account).not.toBeNull();
    expect(data.account?.id).toBe(ACCOUNT_ID);
  });

  it("action (updateCredit) changes stored row with double-encoded params.id", async () => {
    const { requestContext } = await import("~/lib/request-context.server");
    const { action } = await import("../app.accounts.$id");

    const [beforeRow] = await sql<{ manualHold: boolean }[]>`
      SELECT "manualHold" FROM "BuyerAccount" WHERE id = ${ACCOUNT_ID}
    `;
    expect(beforeRow.manualHold).toBe(false);

    const doubleEncodedId = encodeURIComponent(encodeURIComponent(ACCOUNT_ID));
    const href = `/app/accounts/${doubleEncodedId}`;
    const url = new URL(`https://example.com${href}`);

    const formData = new FormData();
    formData.append("_action", "updateCredit");
    formData.append("manualHold", "true");
    formData.append("holdReasonCode", "MANUAL_HOLD");
    formData.append("noLimit", "true");

    const request = new Request(url.toString(), {
      method: "POST",
      body: formData,
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
          }),
        },
      },
      cloudflare: { env: {} },
    };

    const args = {
      request,
      context: mockContext,
      params: { id: doubleEncodedId },
      url,
      pattern: "/app/accounts/:id",
    };

    const result = await requestContext.run({ getSql: () => sql }, async () => {
      return action(args as never);
    });

    const data = extractLoaderResult<{ success: boolean; error?: string }>(result);
    expect(data.success).toBe(true);

    const [afterRow] = await sql<{ manualHold: boolean; holdState: string }[]>`
      SELECT "manualHold", "holdState" FROM "BuyerAccount" WHERE id = ${ACCOUNT_ID}
    `;
    expect(afterRow.manualHold).toBe(true);
    expect(afterRow.holdState).toBe("HELD");

    await sql`
      UPDATE "BuyerAccount"
      SET "manualHold" = false, "holdState" = 'OK', "holdReasonCode" = NULL
      WHERE id = ${ACCOUNT_ID}
    `;
  });

  it("loader returns 'Account not found' for nonexistent double-encoded id", async () => {
    const { requestContext } = await import("~/lib/request-context.server");
    const { loader } = await import("../app.accounts.$id");

    const doubleEncodedId = encodeURIComponent(encodeURIComponent(NONEXISTENT_ACCOUNT_ID));
    const href = `/app/accounts/${doubleEncodedId}`;
    const url = new URL(`https://example.com${href}`);
    const request = new Request(url.toString());

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
          }),
        },
      },
      cloudflare: { env: {} },
    };

    const args = {
      request,
      context: mockContext,
      params: { id: doubleEncodedId },
      url,
      pattern: "/app/accounts/:id",
    };

    const result = await requestContext.run({ getSql: () => sql }, async () => {
      return loader(args as never);
    });

    const data = extractLoaderResult<{ account: null; error: string | null }>(result);
    expect(data.account).toBeNull();
    expect(data.error).toBe("Account not found");
  });

  it("action returns 'Account not found' for nonexistent double-encoded id (no write)", async () => {
    const { requestContext } = await import("~/lib/request-context.server");
    const { action } = await import("../app.accounts.$id");

    const [countBefore] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
    `;

    const doubleEncodedId = encodeURIComponent(encodeURIComponent(NONEXISTENT_ACCOUNT_ID));
    const href = `/app/accounts/${doubleEncodedId}`;
    const url = new URL(`https://example.com${href}`);

    const formData = new FormData();
    formData.append("_action", "updateCredit");
    formData.append("manualHold", "true");
    formData.append("holdReasonCode", "MANUAL_HOLD");
    formData.append("noLimit", "true");

    const request = new Request(url.toString(), {
      method: "POST",
      body: formData,
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: SHOP_DOMAIN, accessToken: "test-token" },
            sessionToken: { sub: "12345" },
          }),
        },
      },
      cloudflare: { env: {} },
    };

    const args = {
      request,
      context: mockContext,
      params: { id: doubleEncodedId },
      url,
      pattern: "/app/accounts/:id",
    };

    const result = await requestContext.run({ getSql: () => sql }, async () => {
      return action(args as never);
    });

    const data = extractLoaderResult<{ success: boolean; error?: string }>(result);
    expect(data.success).toBe(false);
    expect(data.error).toBe("Account not found");

    const [countAfter] = await sql<{ count: string }[]>`
      SELECT COUNT(*) AS count FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}
    `;
    expect(countAfter.count).toBe(countBefore.count);
  });
});
