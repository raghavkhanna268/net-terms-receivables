import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * Tests for APP_SCOPES_UPDATE webhook handler.
 *
 * Tests verify:
 * 1. Valid HMAC triggers scope update
 * 2. Bad HMAC returns 401
 * 3. E9: HMAC is verified before header validation (no info leak)
 */

describe("webhooks.app.scopes_update", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_WEBHOOK_ID = "wh-test-scopes-123";
  const API_SECRET = "test-api-secret";
  const originalEnv = process.env;

  const mockUpdateScopeForShop = vi.fn();
  const mockSessionStorage = {
    updateScopeForShop: mockUpdateScopeForShop,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: API_SECRET };
    mockUpdateScopeForShop.mockResolvedValue(1);
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

    return new Request("https://example.com/webhooks/app/scopes_update", {
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
    return {
      request,
      context: {
        sessionStorage: mockSessionStorage,
        cloudflare: { env: {}, ctx: {} },
      },
      params: {},
      url: new URL(request.url),
      pattern: new URL(request.url).pathname,
    } as unknown as ActionFunctionArgs;
  }

  it("returns 401 when HMAC validation fails", async () => {
    const { action } = await import("../webhooks.app.scopes_update");
    const request = createMockRequest(
      { current: ["read_orders", "write_orders"] },
      "app/scopes_update",
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

  it("returns 200 and updates scopes on valid webhook", async () => {
    const { action } = await import("../webhooks.app.scopes_update");
    const request = createMockRequest(
      { current: ["read_orders", "write_orders"] },
      "app/scopes_update"
    );

    const response = await action(createActionArgs(request));

    expect(response.status).toBe(200);
    expect(mockUpdateScopeForShop).toHaveBeenCalledWith(
      TEST_SHOP,
      "read_orders,write_orders"
    );
  });

  it("returns 200 without error for unexpected topic", async () => {
    const { action } = await import("../webhooks.app.scopes_update");
    const request = createMockRequest(
      { current: ["read_orders"] },
      "orders/create"
    );

    const response = await action(createActionArgs(request));

    expect(response.status).toBe(200);
    expect(mockUpdateScopeForShop).not.toHaveBeenCalled();
  });

  it("returns 500 when API secret not configured", async () => {
    process.env.SHOPIFY_API_SECRET = "";
    vi.resetModules();

    const { action } = await import("../webhooks.app.scopes_update");
    const request = createMockRequest(
      { current: ["read_orders"] },
      "app/scopes_update"
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
        headers["X-Shopify-Topic"] = "app/scopes_update";
      }
      if (!options.omitShop) {
        headers["X-Shopify-Shop-Domain"] = TEST_SHOP;
      }

      return new Request("https://example.com/webhooks/app/scopes_update", {
        method: "POST",
        headers,
        body: bodyStr,
      });
    }

    it("returns 401 when HMAC missing, even if topic missing", async () => {
      const { action } = await import("../webhooks.app.scopes_update");
      const request = createRequestWithMissingHeaders(
        { current: ["read_orders"] },
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
      const { action } = await import("../webhooks.app.scopes_update");
      const request = createRequestWithMissingHeaders(
        { current: ["read_orders"] },
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

    it("returns 401 when HMAC missing with all other headers also missing", async () => {
      const { action } = await import("../webhooks.app.scopes_update");
      const request = createRequestWithMissingHeaders(
        { current: ["read_orders"] },
        { omitHmac: true, omitTopic: true, omitShop: true }
      );

      try {
        await action(createActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("returns 400 when HMAC valid but topic missing", async () => {
      const { action } = await import("../webhooks.app.scopes_update");
      const request = createRequestWithMissingHeaders(
        { current: ["read_orders"] },
        { omitTopic: true }
      );

      try {
        await action(createActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
        expect((error as Response).statusText).toBe("Bad Request");
      }
    });
  });
});
