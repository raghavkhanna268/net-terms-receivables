import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * Tests for APP_SUBSCRIPTIONS_UPDATE webhook handler (S21).
 *
 * Tests verify:
 * 1. Valid HMAC triggers plan cache refresh
 * 2. Bad HMAC returns 401
 * 3. Uses waitUntil for background refresh
 * 4. No shop domains appear in log output (public-log safety)
 */

/**
 * Helper to assert that no shop domains appear in console output.
 * Per public-log allowlist: only counts, ids, enums, booleans, timestamps.
 */
function expectNoShopDomainInLogs(
  spies: { log: MockInstance; warn: MockInstance; error: MockInstance },
  shopDomain: string
): void {
  for (const spy of [spies.log, spies.warn, spies.error]) {
    for (const call of spy.mock.calls) {
      const msg = String(call[0] ?? "");
      expect(msg).not.toContain(shopDomain);
      expect(msg).not.toContain(".myshopify.com");
    }
  }
}

// Mock SQL client
const mockSql = Object.assign(
  vi.fn().mockResolvedValue([]),
  { json: vi.fn((v) => v) }
);

// Mock the request context module
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

// Mock the plan server module
const mockRefreshPlanCache = vi.fn().mockResolvedValue(undefined);
const mockResolvePlan = vi.fn().mockResolvedValue({ plan: { key: "free" } });

vi.mock("~/services/plan.server", () => ({
  refreshPlanCache: mockRefreshPlanCache,
  resolvePlan: (...args: unknown[]) => mockResolvePlan(...args),
}));

// Mock the gating server module
const mockReactivateGatedAccounts = vi.fn().mockResolvedValue(0);

vi.mock("~/services/gating.server", () => ({
  reactivateGatedAccounts: (...args: unknown[]) => mockReactivateGatedAccounts(...args),
}));

// Mock webhook receipts for S20 idempotency
const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);

vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: vi.fn().mockResolvedValue(0),
}));

describe("webhooks.app.subscriptions_update", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_WEBHOOK_ID = "wh-test-sub-123";
  const API_SECRET = "test-api-secret";
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: API_SECRET };
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

    return new Request("https://example.com/webhooks/app/subscriptions_update", {
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

  function createActionArgs(request: Request): ActionFunctionArgs {
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

  it("returns 401 when HMAC validation fails", async () => {
    const { action } = await import("../webhooks.app.subscriptions_update");
    const request = createMockRequest(
      { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
      "app_subscriptions/update",
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

  it("returns 200 and refreshes plan cache on valid webhook", async () => {
    const { action } = await import("../webhooks.app.subscriptions_update");
    const request = createMockRequest(
      { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
      "app_subscriptions/update"
    );

    const args = createActionArgs(request) as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
    const response = await action(args);

    expect(response.status).toBe(200);
    
    // waitUntil should have been called with a promise
    expect(args._waitUntil).toHaveBeenCalledTimes(1);
    const waitUntilArg = args._waitUntil.mock.calls[0][0];
    expect(waitUntilArg).toBeInstanceOf(Promise);
    
    // Wait for the background task to complete
    await waitUntilArg;
    
    // Verify refreshPlanCache was called
    expect(mockRefreshPlanCache).toHaveBeenCalledWith(
      expect.anything(),
      TEST_SHOP
    );
  });

  it("returns 200 without error for unexpected topic", async () => {
    const { action } = await import("../webhooks.app.subscriptions_update");
    const request = createMockRequest(
      { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
      "orders/create" // Wrong topic
    );

    const response = await action(createActionArgs(request));

    expect(response.status).toBe(200);
    expect(mockRefreshPlanCache).not.toHaveBeenCalled();
  });

  it("returns 500 when API secret not configured", async () => {
    process.env.SHOPIFY_API_SECRET = "";
    vi.resetModules();
    
    const { action } = await import("../webhooks.app.subscriptions_update");
    const request = createMockRequest(
      { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
      "app_subscriptions/update"
    );

    const response = await action(createActionArgs(request));
    expect(response.status).toBe(500);
  });

  describe("E9 HMAC-first verification (security)", () => {
    function createRequestWithMissingHeaders(
      body: object,
      options: {
        omitHmac?: boolean;
        omitTopic?: boolean;
        omitShop?: boolean;
        wrongHmac?: boolean;
      } = {}
    ): Request {
      const bodyStr = JSON.stringify(body);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Shopify-Webhook-Id": TEST_WEBHOOK_ID,
        "X-Shopify-API-Version": "2026-10",
      };

      if (!options.omitHmac) {
        headers["X-Shopify-Hmac-Sha256"] = options.wrongHmac
          ? "invalid-hmac-signature"
          : computeHmac(API_SECRET, bodyStr);
      }
      if (!options.omitTopic) {
        headers["X-Shopify-Topic"] = "app_subscriptions/update";
      }
      if (!options.omitShop) {
        headers["X-Shopify-Shop-Domain"] = TEST_SHOP;
      }

      return new Request("https://example.com/webhooks/app/subscriptions_update", {
        method: "POST",
        headers,
        body: bodyStr,
      });
    }

    it("returns 401 when HMAC missing, even if topic missing", async () => {
      const { action } = await import("../webhooks.app.subscriptions_update");
      const request = createRequestWithMissingHeaders(
        { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
        { omitHmac: true, omitTopic: true }
      );

      try {
        await action(createActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("returns 401 when HMAC wrong, even if shop missing", async () => {
      const { action } = await import("../webhooks.app.subscriptions_update");
      const request = createRequestWithMissingHeaders(
        { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
        { wrongHmac: true, omitShop: true }
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

    it("success path (plan refresh) logs no shop domain", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockReactivateGatedAccounts.mockResolvedValueOnce(0);

      const { action } = await import("../webhooks.app.subscriptions_update");
      const request = createMockRequest(
        { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
        "app_subscriptions/update"
      );

      const args = createActionArgs(request) as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
      const response = await action(args);
      expect(response.status).toBe(200);

      // Wait for the background task
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs(consoleSpy, TEST_SHOP);
    });

    it("reactivated accounts path logs shop_id not shop domain", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-456" }]);
      mockReactivateGatedAccounts.mockResolvedValueOnce(5);

      const { action } = await import("../webhooks.app.subscriptions_update");
      const request = createMockRequest(
        { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
        "app_subscriptions/update"
      );

      const args = createActionArgs(request) as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
      const response = await action(args);
      expect(response.status).toBe(200);

      // Wait for the background task
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs(consoleSpy, TEST_SHOP);
      expect(consoleSpy.log).toHaveBeenCalledWith(
        expect.stringContaining("shop_id=shop-456")
      );
    });

    it("unexpected topic path logs no shop domain", async () => {
      const { action } = await import("../webhooks.app.subscriptions_update");
      const request = createMockRequest(
        { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
        "orders/create" // Wrong topic
      );

      const response = await action(createActionArgs(request));
      expect(response.status).toBe(200);

      expectNoShopDomainInLogs(consoleSpy, TEST_SHOP);
    });

    it("error path logs error code not raw error", async () => {
      mockRefreshPlanCache.mockRejectedValueOnce(new Error("DB connection failed"));

      const { action } = await import("../webhooks.app.subscriptions_update");
      const request = createMockRequest(
        { app_subscription: { id: "gid://shopify/AppSubscription/123" } },
        "app_subscriptions/update"
      );

      const args = createActionArgs(request) as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
      const response = await action(args);
      expect(response.status).toBe(200);

      // Wait for the background task to complete (it catches the error)
      await args._waitUntil.mock.calls[0][0];

      expectNoShopDomainInLogs(consoleSpy, TEST_SHOP);

      // Verify error code is logged, not the full error message
      expect(consoleSpy.error).toHaveBeenCalledWith(
        expect.stringContaining("err=Error")
      );
      expect(consoleSpy.error).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Error)
      );
    });
  });
});
