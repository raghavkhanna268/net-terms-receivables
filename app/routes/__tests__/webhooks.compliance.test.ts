import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mockShopify = {
  authenticate: {
    webhook: vi.fn(),
  },
};

const mockSessionStorage = {
  deleteAllForShop: vi.fn(),
};

function createMockActionArgs(
  request: Request,
  env: Record<string, unknown> = {}
): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      cloudflare: { env, ctx: {} },
      shopify: mockShopify,
      sessionStorage: mockSessionStorage,
    },
    url: new URL(request.url),
    pattern: "/webhooks/compliance",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.compliance";

const mockWebhook = mockShopify.authenticate.webhook as Mock;
const mockDeleteAllForShop = mockSessionStorage.deleteAllForShop as Mock;

describe("webhooks.compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteAllForShop.mockResolvedValue(0);
  });

  describe("HMAC verification", () => {
    it("returns 200 for valid HMAC (customers/data_request)", async () => {
      mockWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "CUSTOMERS_DATA_REQUEST",
        webhookId: "test-webhook-123",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockWebhook).toHaveBeenCalledWith(request);
    });

    it("returns 200 for valid HMAC (customers/redact)", async () => {
      mockWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "CUSTOMERS_REDACT",
        webhookId: "test-webhook-456",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123, customer: { id: 456 } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
    });

    it("returns 401 for invalid HMAC", async () => {
      const unauthorizedResponse = new Response(undefined, {
        status: 401,
        statusText: "Unauthorized",
      });
      mockWebhook.mockRejectedValue(unauthorizedResponse);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-SHA256": "invalid-hmac-signature",
        },
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });
  });

  describe("shop/redact", () => {
    it("deletes sessions via sessionStorage.deleteAllForShop", async () => {
      mockDeleteAllForShop.mockResolvedValue(3);

      mockWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "SHOP_REDACT",
        webhookId: "test-webhook-789",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).toHaveBeenCalledWith("test-shop.myshopify.com");
    });

    it("returns 200 even when no sessions exist (idempotent)", async () => {
      mockDeleteAllForShop.mockResolvedValue(0);

      mockWebhook.mockResolvedValue({
        shop: "no-sessions-shop.myshopify.com",
        topic: "SHOP_REDACT",
        webhookId: "test-webhook-idempotent",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 999 }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).toHaveBeenCalledWith("no-sessions-shop.myshopify.com");
    });

    it("handles multiple sessions for the same shop", async () => {
      mockDeleteAllForShop.mockResolvedValue(5);

      mockWebhook.mockResolvedValue({
        shop: "multi-session-shop.myshopify.com",
        topic: "SHOP_REDACT",
        webhookId: "test-webhook-multi",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "{}",
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).toHaveBeenCalledWith("multi-session-shop.myshopify.com");
    });
  });

  describe("context injection", () => {
    it("uses sessionStorage from context (not module-level state)", async () => {
      mockDeleteAllForShop.mockResolvedValue(1);

      mockWebhook.mockResolvedValue({
        shop: "context-test.myshopify.com",
        topic: "SHOP_REDACT",
        webhookId: "context-webhook",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "{}",
      });

      await action(createMockActionArgs(request));

      expect(mockDeleteAllForShop).toHaveBeenCalled();
    });
  });
});
