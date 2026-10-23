import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * Tests for APP_SUBSCRIPTIONS_UPDATE webhook handler (S21).
 *
 * Tests verify:
 * 1. Valid HMAC triggers plan cache refresh
 * 2. Bad HMAC returns 401
 * 3. Uses waitUntil for background refresh
 */

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

vi.mock("~/services/plan.server", () => ({
  refreshPlanCache: mockRefreshPlanCache,
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
});
