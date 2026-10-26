/**
 * DB-backed tests for #261 stale app/uninstalled detection.
 *
 * Tests verify that late or retried app/uninstalled webhooks arriving
 * after a quick reinstall do NOT wipe the fresh installation.
 *
 * These tests use REAL compliance functions (markShopUninstalled, deleteProcessedWebhooksViaReceipts)
 * against the database. Only the Admin API layer (getOfflineAdminContext / graphql) is mocked.
 *
 * Test cases:
 * - afterAuth paths: fresh install, reinstall, plain re-auth with/without existing lastInstalledAt
 * - Case (a): late uninstall after reinstall is ignored
 * - Case (b): genuine uninstall with newer header
 * - Case (c): header missing + NULL
 * - Case (d): probe scenarios (no_session, 401, 403, malformed 200, GraphQL errors, timeout)
 * - Log leak tests with REAL log.server.ts
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SYNTHETIC_TEST_SECRET = "synthetic-test-secret-stale-uninstall";
const SYNTHETIC_CLIENT_ID = "synthetic-client-id";

const mockGraphql = vi.fn();
const mockAdmin = { graphql: mockGraphql };
const mockGetOfflineAdminContext = vi.fn();

vi.mock("~/lib/offline-admin.server", () => ({
  getOfflineAdminContext: (...args: unknown[]) => mockGetOfflineAdminContext(...args),
}));

const mockEvictShopFromSetupCache = vi.fn();
vi.mock("~/lib/after-auth.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    evictShopFromSetupCache: (...args: unknown[]) => mockEvictShopFromSetupCache(...args),
  };
});

let testSql: ReturnType<typeof postgres> | null = null;
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: () => testSql,
}));

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function createSignedRequest(
  body: string,
  topic: string,
  secret: string,
  options: {
    shopDomain?: string;
    triggeredAt?: Date | null;
    webhookId?: string;
  } = {}
): Request {
  const hmac = generateShopifyHmac(body, secret);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-API-Version": "2026-10",
    "X-Shopify-Webhook-Id": options.webhookId ?? `stale-test-${Date.now()}`,
    "X-Shopify-Topic": topic,
    "X-Shopify-Shop-Domain": options.shopDomain ?? "test-stale.myshopify.com",
    "X-Shopify-Hmac-Sha256": hmac,
  };

  if (options.triggeredAt !== undefined && options.triggeredAt !== null) {
    headers["X-Shopify-Triggered-At"] = options.triggeredAt.toISOString();
  }

  return new Request("https://example.com/webhooks/app/uninstalled", {
    method: "POST",
    headers,
    body,
  });
}

describeWithDb("stale app/uninstalled detection (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-staleuninstall";
  const TEST_SHOP_DOMAIN = `test-stale-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;
  const originalEnv = process.env;

  const mockSessionStorage = {
    deleteAllForShop: vi.fn(async (shop: string) => {
      const result = await sql`DELETE FROM "Session" WHERE shop = ${shop}`;
      return result.count;
    }),
  };

  function createMockActionArgs(request: Request): ActionFunctionArgs {
    return {
      request,
      params: {},
      context: {
        cloudflare: { env: {}, ctx: {} },
        shopify: {},
        sessionStorage: mockSessionStorage,
      },
      url: new URL(request.url),
      pattern: "/webhooks/app/uninstalled",
    } as unknown as ActionFunctionArgs;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    testSql = sql;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'America/New_York', 'INR', 'starter', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    await sql.end();
    testSql = null;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
    mockGraphql.mockResolvedValue({ json: async () => ({ data: { shop: { id: "gid://shopify/Shop/123" } } }) });

    process.env = {
      ...originalEnv,
      SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET,
      SHOPIFY_API_KEY: SYNTHETIC_CLIENT_ID,
    };

    await sql`UPDATE "Shop" SET "uninstalledAt" = NULL, "lastInstalledAt" = NULL WHERE id = ${testShopId}`;
    await sql`DELETE FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP_DOMAIN}`;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function createTestSession(): Promise<void> {
    const sessionId = `offline_${TEST_SHOP_DOMAIN}`;
    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", scope, "accessToken", expires)
      VALUES (${sessionId}, ${TEST_SHOP_DOMAIN}, 'test', false, 'read_products', 'shpat_test', NOW() + INTERVAL '1 hour')
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async function getSessionCount(): Promise<number> {
    const [result] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int as count FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
    `;
    return result.count;
  }

  async function getShopState(): Promise<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }> {
    const [shop] = await sql<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }[]>`
      SELECT "uninstalledAt", "lastInstalledAt" FROM "Shop" WHERE id = ${testShopId}
    `;
    return shop;
  }

  describe("afterAuth paths", () => {
    it("fresh install sets lastInstalledAt to NOW", async () => {
      const TEST_FRESH_SHOP = `test-fresh-${TEST_SUFFIX}.myshopify.com`;

      try {
        const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
        await upsertShopOnAuth(sql, TEST_FRESH_SHOP, "America/New_York", "INR");

        const [shop] = await sql<{ lastInstalledAt: Date | null; createdAt: Date }[]>`
          SELECT "lastInstalledAt", "createdAt" FROM "Shop" WHERE domain = ${TEST_FRESH_SHOP}
        `;
        expect(shop.lastInstalledAt).not.toBeNull();
        expect(Math.abs(shop.lastInstalledAt!.getTime() - Date.now())).toBeLessThan(5000);
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${TEST_FRESH_SHOP}`;
      }
    });

    it("reinstall sets lastInstalledAt to NOW, moving a stale value forward", async () => {
      const TEST_REINSTALL_SHOP = `test-reinstall-${TEST_SUFFIX}.myshopify.com`;
      const oldInstallTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_REINSTALL_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), ${oldInstallTime}, NOW(), NOW())
      `;

      try {
        const [beforeShop] = await sql<{ lastInstalledAt: Date | null }[]>`
          SELECT "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_REINSTALL_SHOP}
        `;
        expect(beforeShop.lastInstalledAt?.getTime()).toBe(oldInstallTime.getTime());

        const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
        await upsertShopOnAuth(sql, TEST_REINSTALL_SHOP, "America/New_York", "INR");

        const [afterShop] = await sql<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }[]>`
          SELECT "uninstalledAt", "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_REINSTALL_SHOP}
        `;
        expect(afterShop.uninstalledAt).toBeNull();
        expect(afterShop.lastInstalledAt).not.toBeNull();
        expect(afterShop.lastInstalledAt!.getTime()).toBeGreaterThan(oldInstallTime.getTime());
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${TEST_REINSTALL_SHOP}`;
      }
    });

    it("plain re-auth with lastInstalledAt already set does NOT change it", async () => {
      const TEST_REAUTH_SHOP = `test-reauth-existing-${TEST_SUFFIX}.myshopify.com`;
      const existingInstallTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_REAUTH_SHOP}, 'America/New_York', 'INR', 'starter', ${existingInstallTime}, NOW(), NOW())
      `;

      try {
        const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
        await upsertShopOnAuth(sql, TEST_REAUTH_SHOP, "America/New_York", "INR");

        const [shop] = await sql<{ lastInstalledAt: Date | null }[]>`
          SELECT "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_REAUTH_SHOP}
        `;
        expect(shop.lastInstalledAt?.getTime()).toBe(existingInstallTime.getTime());
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${TEST_REAUTH_SHOP}`;
      }
    });

    it("plain re-auth with NULL lastInstalledAt fills it with NOW", async () => {
      const TEST_REAUTH_NULL_SHOP = `test-reauth-null-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_REAUTH_NULL_SHOP}, 'America/New_York', 'INR', 'starter', NULL, NOW(), NOW())
      `;

      try {
        const [beforeShop] = await sql<{ lastInstalledAt: Date | null }[]>`
          SELECT "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_REAUTH_NULL_SHOP}
        `;
        expect(beforeShop.lastInstalledAt).toBeNull();

        const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
        await upsertShopOnAuth(sql, TEST_REAUTH_NULL_SHOP, "America/New_York", "INR");

        const [afterShop] = await sql<{ lastInstalledAt: Date | null }[]>`
          SELECT "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_REAUTH_NULL_SHOP}
        `;
        expect(afterShop.lastInstalledAt).not.toBeNull();
        expect(Math.abs(afterShop.lastInstalledAt!.getTime() - Date.now())).toBeLessThan(5000);
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${TEST_REAUTH_NULL_SHOP}`;
      }
    });
  });

  describe("Case (a): header present and older than lastInstalledAt - stale", () => {
    it("late uninstall after reinstall is ignored, sessions and uninstalledAt untouched", async () => {
      const reinstallTime = new Date();
      const staleTriggeredAt = new Date(reinstallTime.getTime() - 60 * 60 * 1000);

      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${reinstallTime} WHERE id = ${testShopId}`;
      await createTestSession();

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: staleTriggeredAt,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);
    });
  });

  describe("Case (b): header present and newer than lastInstalledAt - genuine", () => {
    it("genuine uninstall proceeds normally", async () => {
      const installTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const genuineTriggeredAt = new Date();

      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: genuineTriggeredAt,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).not.toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(0);
    });
  });

  describe("Case (c): header missing and lastInstalledAt NULL - genuine", () => {
    it("genuine uninstall proceeds", async () => {
      await createTestSession();

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).not.toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(0);
    });
  });

  describe("Case (d): header missing and lastInstalledAt set - probe Admin API", () => {
    it("no offline session (no_session) = normal uninstall, 200, uninstalledAt set, no stale_* line", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({
        success: false,
        errorCode: "no_session",
        retryable: false,
        needsReauth: true,
      });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).not.toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(0);

      const allLogs = [...consoleSpy.mock.calls, ...consoleErrorSpy.mock.calls].map(c => c.join(" "));
      expect(allLogs.some(l => l.includes("stale_ignored"))).toBe(false);
      expect(allLogs.some(l => l.includes("stale_probe_failed"))).toBe(false);

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    it("HTTP 401 = genuine uninstall", async () => {
      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
      mockGraphql.mockRejectedValue({ response: { status: 401 } });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).not.toBeNull();
    });

    it("HTTP 403 = genuine uninstall", async () => {
      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
      mockGraphql.mockRejectedValue({ response: { status: 403 } });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).not.toBeNull();
    });

    it("well-formed 200 with shop.id = stale_ignored reason=probe_ok, return 200, nothing changed", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
      mockGraphql.mockResolvedValue({
        json: async () => ({ data: { shop: { id: "gid://shopify/Shop/123" } } }),
      });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);

      const allLogs = consoleSpy.mock.calls.map(c => c.join(" "));
      expect(allLogs.some(l => l.includes("stale_ignored reason=probe_ok"))).toBe(true);

      consoleSpy.mockRestore();
    });

    it("malformed 200 (no shop.id) = 5xx, nothing changed, stale_probe_failed reason=unexpected_response", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
      mockGraphql.mockResolvedValue({
        json: async () => ({ data: { shop: null } }),
      });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);

      const allErrors = consoleErrorSpy.mock.calls.map(c => c.join(" "));
      expect(allErrors.some(l => l.includes("stale_probe_failed reason=unexpected_response"))).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it("GraphQL errors array = 5xx, nothing changed, stale_probe_failed reason=graphql_error", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
      mockGraphql.mockResolvedValue({
        json: async () => ({ errors: [{ message: "Some internal error" }] }),
      });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);

      const allErrors = consoleErrorSpy.mock.calls.map(c => c.join(" "));
      expect(allErrors.some(l => l.includes("stale_probe_failed reason=graphql_error"))).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it("thrown error/timeout = 5xx, nothing changed, stale_probe_failed reason=graphql_error", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
      mockGraphql.mockRejectedValue(new Error("Network timeout"));

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);

      const allErrors = consoleErrorSpy.mock.calls.map(c => c.join(" "));
      expect(allErrors.some(l => l.includes("stale_probe_failed reason=graphql_error"))).toBe(true);

      consoleErrorSpy.mockRestore();
    });

    it("non-retryable non-auth probe failure (admin_session_error) = 5xx, nothing changed", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({
        success: false,
        errorCode: "admin_session_error",
        retryable: false,
        needsReauth: false,
      });

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);

      const allErrors = consoleErrorSpy.mock.calls.map(c => c.join(" "));
      expect(allErrors.some(l => l.includes("stale_probe_failed reason=admin_session_error"))).toBe(true);

      consoleErrorSpy.mockRestore();
    });
  });

  describe("Log leak tests (REAL log.server.ts)", () => {
    it("stale_ignored log contains no shop domain, token, error message, or webhookId", async () => {
      const DISTINCTIVE_SHOP = `distinctive-leak-test-${TEST_SUFFIX}.myshopify.com`;
      const DISTINCTIVE_WEBHOOK_ID = `webhook-id-leak-test-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${DISTINCTIVE_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
      `;

      try {
        const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const staleTriggeredAt = new Date(Date.now() - 60 * 60 * 1000);
        const payload = JSON.stringify({ shop_id: 123 });
        const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
          shopDomain: DISTINCTIVE_SHOP,
          triggeredAt: staleTriggeredAt,
          webhookId: DISTINCTIVE_WEBHOOK_ID,
        });

        const { action } = await import("../webhooks.app.uninstalled");
        await action(createMockActionArgs(request));

        const allLogs = [...consoleSpy.mock.calls, ...consoleErrorSpy.mock.calls].map(c => c.join(" "));
        const staleLog = allLogs.find(l => l.includes("stale_ignored"));
        expect(staleLog).toBeDefined();
        expect(staleLog).not.toContain(DISTINCTIVE_SHOP);
        expect(staleLog).not.toContain(".myshopify.com");
        expect(staleLog).not.toContain(DISTINCTIVE_WEBHOOK_ID);
        expect(staleLog).not.toContain("shpat_");

        consoleSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${DISTINCTIVE_SHOP}`;
      }
    });

    it("stale_probe_failed log contains no shop domain, token, error message, or webhookId", async () => {
      const DISTINCTIVE_SHOP = `distinctive-probe-leak-${TEST_SUFFIX}.myshopify.com`;
      const DISTINCTIVE_WEBHOOK_ID = `webhook-probe-leak-${TEST_SUFFIX}`;
      const DISTINCTIVE_ERROR_MSG = `Distinctive-Error-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${DISTINCTIVE_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), NOW(), NOW())
      `;

      try {
        const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
        mockGraphql.mockRejectedValue(new Error(DISTINCTIVE_ERROR_MSG));

        const payload = JSON.stringify({ shop_id: 123 });
        const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
          shopDomain: DISTINCTIVE_SHOP,
          triggeredAt: null,
          webhookId: DISTINCTIVE_WEBHOOK_ID,
        });

        const { action } = await import("../webhooks.app.uninstalled");
        await action(createMockActionArgs(request));

        const allErrors = consoleErrorSpy.mock.calls.map(c => c.join(" "));
        const probeFailedLog = allErrors.find(l => l.includes("stale_probe_failed"));
        expect(probeFailedLog).toBeDefined();
        expect(probeFailedLog).not.toContain(DISTINCTIVE_SHOP);
        expect(probeFailedLog).not.toContain(".myshopify.com");
        expect(probeFailedLog).not.toContain(DISTINCTIVE_WEBHOOK_ID);
        expect(probeFailedLog).not.toContain(DISTINCTIVE_ERROR_MSG);
        expect(probeFailedLog).not.toContain("shpat_");

        consoleErrorSpy.mockRestore();
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${DISTINCTIVE_SHOP}`;
      }
    });
  });

  describe("Idempotency", () => {
    it("retried delivery of stale uninstall is idempotent", async () => {
      const reinstallTime = new Date();
      const staleTriggeredAt = new Date(reinstallTime.getTime() - 60 * 60 * 1000);

      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${reinstallTime} WHERE id = ${testShopId}`;
      await createTestSession();

      const payload = JSON.stringify({ shop_id: 123 });
      const webhookId = `idempotent-stale-${TEST_SUFFIX}`;
      const createRequest = () => createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: staleTriggeredAt,
        webhookId,
      });

      const { action } = await import("../webhooks.app.uninstalled");

      const response1 = await action(createMockActionArgs(createRequest()));
      expect(response1.status).toBe(200);

      const response2 = await action(createMockActionArgs(createRequest()));
      expect(response2.status).toBe(200);

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const sessionCount = await getSessionCount();
      expect(sessionCount).toBe(1);
    });
  });
});
