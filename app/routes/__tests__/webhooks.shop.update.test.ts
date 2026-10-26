import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * #342: Tests for shop/update webhook handler.
 *
 * Tests verify:
 * 1. INR to USD: shop_config written as USD, then Shop.currency updated
 * 2. USD to INR: recovers (shop_config INR, Shop.currency INR)
 * 3. XXX does nothing
 * 4. Duplicate delivery makes no second write
 * 5. Failed shop_config write leaves Shop.currency unchanged
 * 6. Uninstalled shop / missing session is a no-op
 * 7. Bad HMAC is rejected (401)
 * 8. Uses safeLog with shopHash only, no domains
 */

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-test-342";
const TEST_SHOP_GID = "gid://shopify/Shop/342342";
const TEST_WEBHOOK_ID = "wh-test-342";
const API_SECRET = "test-api-secret-342";

const createMockSqlFn = () =>
  vi.fn().mockImplementation(() => Promise.resolve([]));

const mockSql = Object.assign(createMockSqlFn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((arr: unknown[]) => arr),
  unsafe: vi.fn((s: string) => s),
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(createMockSqlFn(), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  }),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
}));

const mockShopifyGraphQLQueue = vi.fn();
vi.mock("~/services/shopify-client.server", () => ({
  shopifyGraphQLQueue: (...args: unknown[]) => mockShopifyGraphQLQueue(...args),
}));

const mockWriteShopConfigMetafield = vi.fn();
vi.mock("~/services/shop-config.server", () => ({
  writeShopConfigMetafield: (...args: unknown[]) => mockWriteShopConfigMetafield(...args),
}));

describe("webhooks.shop.update", () => {
  const originalEnv = process.env;
  let sqlCalls: Array<{ query: string; values: unknown[] }>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: API_SECRET };
    sqlCalls = [];

    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function computeHmac(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("base64");
  }

  function createMockRequest(
    body: object,
    topic: string,
    options: { validHmac?: boolean; shop?: string; webhookId?: string } = {}
  ): Request {
    const {
      validHmac = true,
      shop = TEST_SHOP,
      webhookId = TEST_WEBHOOK_ID,
    } = options;
    const bodyStr = JSON.stringify(body);
    const hmac = validHmac ? computeHmac(API_SECRET, bodyStr) : "invalid-hmac";

    return new Request("https://example.com/webhooks/shop/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Shop-Domain": shop,
        "X-Shopify-Topic": topic,
        "X-Shopify-Webhook-Id": webhookId,
        "X-Shopify-API-Version": "2026-10",
      },
      body: bodyStr,
    });
  }

  function createActionArgs(request: Request): ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> } {
    const mockWaitUntil = vi.fn();

    return {
      request,
      context: {
        cloudflare: {
          env: {},
          ctx: { waitUntil: mockWaitUntil },
        },
      },
      params: {},
      url: new URL(request.url),
      pattern: new URL(request.url).pathname,
      _waitUntil: mockWaitUntil,
    } as unknown as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
  }

  function setupShopInDb(currency: string, hasFinancialRows = false) {
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });

      if (query.includes("SELECT id, currency FROM")) {
        return Promise.resolve([{ id: TEST_SHOP_ID, currency }]);
      }
      if (query.includes("SELECT EXISTS")) {
        return Promise.resolve([{ has_rows: hasFinancialRows }]);
      }
      if (query.includes("UPDATE")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  }

  function setupAdminApiResponse(currencyCode: string | null, shopId: string = TEST_SHOP_GID) {
    mockShopifyGraphQLQueue.mockImplementation(async () => {
      if (currencyCode === null) {
        return { success: false, errorCode: "api_error", retryable: true };
      }
      return {
        success: true,
        data: { shop: { id: shopId, currencyCode } },
        retryable: false,
      };
    });
  }

  function setupNoSession() {
    mockShopifyGraphQLQueue.mockResolvedValue({
      success: false,
      errorCode: "no_session",
      retryable: false,
    });
  }

  function setupMetafieldWriteSuccess() {
    mockWriteShopConfigMetafield.mockResolvedValue({ success: true, metafieldId: "mf-342" });
  }

  function setupMetafieldWriteFailure() {
    mockWriteShopConfigMetafield.mockResolvedValue({ success: false, error: "graphql_errors" });
  }

  describe("HMAC verification", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest(
        { id: "gid://shopify/Shop/123" },
        "shop/update",
        { validHmac: false }
      );

      try {
        await action(createActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });
  });

  describe("currency change handling", () => {
    it("INR to USD: writes shop_config as USD, then updates Shop.currency", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse("USD");
      setupMetafieldWriteSuccess();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_GID,
        "USD"
      );

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
      expect(updateCalls.length).toBeGreaterThan(0);
      expect(updateCalls.some((c) => c.values.includes("USD"))).toBe(true);
    });

    it("USD to INR: recovers - writes shop_config INR, updates Shop.currency", async () => {
      setupShopInDb("USD");
      setupAdminApiResponse("INR");
      setupMetafieldWriteSuccess();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_GID,
        "INR"
      );

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
      expect(updateCalls.length).toBeGreaterThan(0);
      expect(updateCalls.some((c) => c.values.includes("INR"))).toBe(true);
    });

    it("XXX currency does nothing", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse("XXX");

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE"));
      expect(updateCalls.length).toBe(0);
    });

    it("duplicate delivery makes no second write when currency unchanged", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse("INR");

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE"));
      expect(updateCalls.length).toBe(0);
    });

    it("USD to INR blocked when shop has financial rows", async () => {
      setupShopInDb("USD", true);
      setupAdminApiResponse("INR");

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
      expect(updateCalls.length).toBe(0);
    });

    it("USD to INR allowed when shop has no financial rows", async () => {
      setupShopInDb("USD", false);
      setupAdminApiResponse("INR");
      setupMetafieldWriteSuccess();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_GID,
        "INR"
      );

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
      expect(updateCalls.length).toBeGreaterThan(0);
      expect(updateCalls.some((c) => c.values.includes("INR"))).toBe(true);
    });

    it("XXX to INR blocked when shop has financial rows", async () => {
      setupShopInDb("XXX", true);
      setupAdminApiResponse("INR");

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
      expect(updateCalls.length).toBe(0);
    });
  });

  describe("fail-closed behavior", () => {
    it("failed shop_config write leaves Shop.currency unchanged", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse("USD");
      setupMetafieldWriteFailure();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).toHaveBeenCalled();

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
      expect(updateCalls.length).toBe(0);
    });
  });

  describe("uninstalled shop handling", () => {
    it("uninstalled shop (no_session) is a no-op", async () => {
      setupShopInDb("INR");
      setupNoSession();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();

      const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE"));
      expect(updateCalls.length).toBe(0);
    });

    it("missing session (invalid_session) is a no-op", async () => {
      setupShopInDb("INR");
      mockShopifyGraphQLQueue.mockResolvedValue({
        success: false,
        errorCode: "invalid_session",
        retryable: true,
      });

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();
    });

    it("shop not found in DB is a no-op", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      const response = await action(args);
      expect(response.status).toBe(200);

      await args._waitUntil.mock.calls[0][0];

      expect(mockShopifyGraphQLQueue).not.toHaveBeenCalled();
      expect(mockWriteShopConfigMetafield).not.toHaveBeenCalled();
    });
  });

  describe("topic handling", () => {
    it("returns 200 and processes for shop/update topic", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse("INR");

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");

      const response = await action(createActionArgs(request));
      expect(response.status).toBe(200);
    });

    it("returns 200 without processing for unexpected topic", async () => {
      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "orders/create");

      const response = await action(createActionArgs(request));
      expect(response.status).toBe(200);

      expect(mockShopifyGraphQLQueue).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("returns 500 when API secret not configured", async () => {
      process.env.SHOPIFY_API_SECRET = "";
      vi.resetModules();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");

      const response = await action(createActionArgs(request));
      expect(response.status).toBe(500);
    });

    it("returns 405 for GET requests", async () => {
      const { loader } = await import("../webhooks.shop.update");
      const response = await loader({
        request: new Request("https://example.com/webhooks/shop/update"),
        context: {},
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(response.status).toBe(405);
    });
  });

  describe("domain-free log assertions (public-log safety)", () => {
    let consoleSpy: { log: MockInstance; warn: MockInstance; error: MockInstance };

    beforeEach(() => {
      consoleSpy = {
        log: vi.spyOn(console, "log").mockImplementation(() => {}),
        warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
        error: vi.spyOn(console, "error").mockImplementation(() => {}),
      };
    });

    afterEach(() => {
      consoleSpy.log.mockRestore();
      consoleSpy.warn.mockRestore();
      consoleSpy.error.mockRestore();
    });

    function expectNoShopDomainInLogs(): void {
      for (const spy of [consoleSpy.log, consoleSpy.warn, consoleSpy.error]) {
        for (const call of spy.mock.calls) {
          const msg = String(call[0] ?? "");
          expect(msg).not.toContain(TEST_SHOP);
          expect(msg).not.toContain(".myshopify.com");
        }
      }
    }

    it("success path logs no shop domain", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse("USD");
      setupMetafieldWriteSuccess();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      await action(args);
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs();
    });

    it("error path logs no shop domain", async () => {
      setupShopInDb("INR");
      setupAdminApiResponse(null);

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      await action(args);
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs();
    });

    it("no_session path logs no shop domain", async () => {
      setupShopInDb("INR");
      setupNoSession();

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      await action(args);
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs();
    });

    it("flip blocked path logs no shop domain and logs flip_blocked event", async () => {
      setupShopInDb("USD", true);
      setupAdminApiResponse("INR");

      const { action } = await import("../webhooks.shop.update");
      const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
      const args = createActionArgs(request);

      await action(args);
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs();

      const allLogCalls = [
        ...consoleSpy.log.mock.calls,
        ...consoleSpy.warn.mock.calls,
        ...consoleSpy.error.mock.calls,
      ];
      const flipBlockedLog = allLogCalls.find((call) => {
        const msg = String(call[0] ?? "");
        return msg.includes("shop_update_webhook_flip_blocked");
      });
      expect(flipBlockedLog).toBeDefined();

      const logJson = JSON.parse(String(flipBlockedLog![0]));
      expect(logJson.event).toBe("shop_update_webhook_flip_blocked");
      expect(logJson.shopHash).toBeDefined();
      expect(Object.keys(logJson)).toEqual(["event", "shopHash"]);
    });
  });
});
