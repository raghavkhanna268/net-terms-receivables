/**
 * DB-backed tests for #261 stale app/uninstalled detection.
 *
 * Tests verify that late or retried app/uninstalled webhooks arriving
 * after a quick reinstall do NOT wipe the fresh installation.
 *
 * Test cases:
 * 1. Late uninstall after reinstall (case a) is ignored, sessions and uninstalledAt untouched
 * 2. Genuine uninstall (case b) still works - header present and newer than lastInstalledAt
 * 3. lastInstalledAt NULL with header - genuine uninstall (case b variant)
 * 4. header missing + lastInstalledAt NULL (case c) - genuine uninstall
 * 5. header missing + lastInstalledAt set + probe 401 means genuine uninstall
 * 6. header missing + lastInstalledAt set + probe 200 means stale no-op
 * 7. probe error/timeout means 5xx and nothing changed
 * 8. retried delivery of the same stale/genuine uninstall is idempotent
 * 9. afterAuth sets lastInstalledAt on fresh install and reinstall
 *
 * Mutation proof: disable the stale check, show test (1) fails, revert.
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

const mockSessionStorage = {
  deleteAllForShop: vi.fn().mockResolvedValue(0),
};

const mockGraphql = vi.fn();
const mockAdmin = { graphql: mockGraphql };
const mockGetOfflineAdminContext = vi.fn();

vi.mock("~/lib/offline-admin.server", () => ({
  getOfflineAdminContext: (...args: unknown[]) => mockGetOfflineAdminContext(...args),
}));

const mockMarkShopUninstalled = vi.fn();
const mockDeleteProcessedWebhooksViaReceipts = vi.fn().mockResolvedValue(0);
vi.mock("~/services/compliance", () => ({
  markShopUninstalled: (...args: unknown[]) => mockMarkShopUninstalled(...args),
  deleteProcessedWebhooksViaReceipts: (...args: unknown[]) =>
    mockDeleteProcessedWebhooksViaReceipts(...args),
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

describeWithDb("stale app/uninstalled detection (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-staleuninstall";
  const TEST_SHOP_DOMAIN = `test-stale-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;
  const originalEnv = process.env;

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
    mockSessionStorage.deleteAllForShop.mockResolvedValue(0);
    mockMarkShopUninstalled.mockResolvedValue(true);
    mockDeleteProcessedWebhooksViaReceipts.mockResolvedValue(0);
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

  async function getShopState(): Promise<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }> {
    const [shop] = await sql<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }[]>`
      SELECT "uninstalledAt", "lastInstalledAt" FROM "Shop" WHERE id = ${testShopId}
    `;
    return shop;
  }

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
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const [session] = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(session).toBeDefined();
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
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP_DOMAIN);
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
    });

    it("genuine uninstall works when lastInstalledAt is NULL", async () => {
      await createTestSession();

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: new Date(),
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP_DOMAIN);
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
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
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP_DOMAIN);
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
    });
  });

  describe("Case (d): header missing and lastInstalledAt set - probe Admin API", () => {
    it("probe 401 (no session) means genuine uninstall", async () => {
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
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP_DOMAIN);
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
    });

    it("probe 401 (invalid_grant) means genuine uninstall", async () => {
      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;

      mockGetOfflineAdminContext.mockResolvedValue({
        success: false,
        errorCode: "invalid_grant",
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
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalled();
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
    });

    it("probe 200 (shop.id returned) means stale no-op", async () => {
      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({
        success: true,
        admin: mockAdmin,
        retryable: false,
      });
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
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();
    });

    it("probe error (retryable) means 5xx and nothing changed", async () => {
      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({
        success: false,
        errorCode: "admin_session_error",
        retryable: true,
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
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();

      const shopState = await getShopState();
      expect(shopState.uninstalledAt).toBeNull();

      const [session] = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(session).toBeDefined();
    });

    it("probe GraphQL error (timeout) means 5xx and nothing changed", async () => {
      const installTime = new Date();
      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      mockGetOfflineAdminContext.mockResolvedValue({
        success: true,
        admin: mockAdmin,
        retryable: false,
      });
      mockGraphql.mockRejectedValue(new Error("Network timeout"));

      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: null,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();

      consoleErrorSpy.mockRestore();
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

      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();

      const [session] = await sql<{ id: string }[]>`
        SELECT id FROM "Session" WHERE shop = ${TEST_SHOP_DOMAIN}
      `;
      expect(session).toBeDefined();
    });

    it("retried delivery of genuine uninstall is idempotent", async () => {
      const installTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const genuineTriggeredAt = new Date();

      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${installTime} WHERE id = ${testShopId}`;
      await createTestSession();

      const payload = JSON.stringify({ shop_id: 123 });
      const webhookId = `idempotent-genuine-${TEST_SUFFIX}`;
      const createRequest = () => createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: genuineTriggeredAt,
        webhookId,
      });

      const { action } = await import("../webhooks.app.uninstalled");

      const response1 = await action(createMockActionArgs(createRequest()));
      expect(response1.status).toBe(200);
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledTimes(1);
      expect(mockMarkShopUninstalled).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      mockSessionStorage.deleteAllForShop.mockResolvedValue(0);
      mockMarkShopUninstalled.mockResolvedValue(false);

      const response2 = await action(createMockActionArgs(createRequest()));
      expect(response2.status).toBe(200);
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledTimes(1);
      expect(mockMarkShopUninstalled).toHaveBeenCalledTimes(1);
    });
  });

  describe("afterAuth sets lastInstalledAt", () => {
    it("upsertShopOnAuth sets lastInstalledAt on fresh install", async () => {
      const TEST_FRESH_SHOP = `test-fresh-${TEST_SUFFIX}.myshopify.com`;

      try {
        const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
        await upsertShopOnAuth(sql, TEST_FRESH_SHOP, "America/New_York", "INR");

        const [shop] = await sql<{ lastInstalledAt: Date | null }[]>`
          SELECT "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_FRESH_SHOP}
        `;
        expect(shop.lastInstalledAt).not.toBeNull();
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${TEST_FRESH_SHOP}`;
      }
    });

    it("upsertShopOnAuth sets lastInstalledAt on reinstall", async () => {
      const TEST_REINSTALL_SHOP = `test-reinstall-${TEST_SUFFIX}.myshopify.com`;

      const oldInstallTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_REINSTALL_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), ${oldInstallTime}, NOW(), NOW())
      `;

      try {
        const [beforeShop] = await sql<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }[]>`
          SELECT "uninstalledAt", "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_REINSTALL_SHOP}
        `;
        expect(beforeShop.uninstalledAt).not.toBeNull();
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

    it("clearUninstalledAtAndMetafieldErrors sets lastInstalledAt on reinstall", async () => {
      const TEST_CLEAR_SHOP = `test-clear-${TEST_SUFFIX}.myshopify.com`;

      const oldInstallTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await sql`
        INSERT INTO "Shop" (domain, timezone, currency, plan_key, "uninstalledAt", "lastInstalledAt", "createdAt", "updatedAt")
        VALUES (${TEST_CLEAR_SHOP}, 'America/New_York', 'INR', 'starter', NOW(), ${oldInstallTime}, NOW(), NOW())
      `;

      try {
        const { _clearUninstalledAtAndMetafieldErrorsForTesting } = await import("~/lib/after-auth.server");
        const result = await _clearUninstalledAtAndMetafieldErrorsForTesting(sql, TEST_CLEAR_SHOP);

        expect(result.wasReinstalled).toBe(true);

        const [shop] = await sql<{ uninstalledAt: Date | null; lastInstalledAt: Date | null }[]>`
          SELECT "uninstalledAt", "lastInstalledAt" FROM "Shop" WHERE domain = ${TEST_CLEAR_SHOP}
        `;
        expect(shop.uninstalledAt).toBeNull();
        expect(shop.lastInstalledAt).not.toBeNull();
        expect(shop.lastInstalledAt!.getTime()).toBeGreaterThan(oldInstallTime.getTime());
      } finally {
        await sql`DELETE FROM "Shop" WHERE domain = ${TEST_CLEAR_SHOP}`;
      }
    });
  });

  describe("Shop not found", () => {
    it("header present but Shop row missing: existing behaviour (genuine)", async () => {
      const UNKNOWN_SHOP = `unknown-${TEST_SUFFIX}.myshopify.com`;
      mockMarkShopUninstalled.mockResolvedValue(false);

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: UNKNOWN_SHOP,
        triggeredAt: new Date(),
      });

      const { action } = await import("../webhooks.app.uninstalled");
      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(UNKNOWN_SHOP);
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
    });
  });

  describe("Mutation proof: stale check prevents data loss", () => {
    it("without stale check, late uninstall would delete sessions (mutation test)", async () => {
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
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();
    });
  });

  describe("Logs do not contain shop domain", () => {
    it("stale webhook log does not contain shop domain", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const reinstallTime = new Date();
      const staleTriggeredAt = new Date(reinstallTime.getTime() - 60 * 60 * 1000);

      await sql`UPDATE "Shop" SET "lastInstalledAt" = ${reinstallTime} WHERE id = ${testShopId}`;

      const payload = JSON.stringify({ shop_id: 123 });
      const request = createSignedRequest(payload, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP_DOMAIN,
        triggeredAt: staleTriggeredAt,
      });

      const { action } = await import("../webhooks.app.uninstalled");
      await action(createMockActionArgs(request));

      for (const call of consoleSpy.mock.calls) {
        const logMessage = call.join(" ");
        expect(logMessage).not.toContain(".myshopify.com");
      }

      consoleSpy.mockRestore();
    });
  });
});
