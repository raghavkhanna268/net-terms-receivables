import { describe, it, expect, vi, beforeEach, Mock } from "vitest";
import type { ActionFunctionArgs } from "react-router";

function createMockActionArgs(
  request: Request,
  env: Record<string, unknown> = {}
): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: { cloudflare: { env } },
    url: new URL(request.url),
    pattern: "/webhooks/compliance",
  } as ActionFunctionArgs;
}

vi.mock("../../shopify.server", () => ({
  authenticate: {
    webhook: vi.fn(),
  },
  sessionStorage: {
    setNamespace: vi.fn(),
    findSessionsByShop: vi.fn(),
    deleteSessions: vi.fn(),
  },
}));

import { action } from "../webhooks.compliance";
import { authenticate, sessionStorage } from "../../shopify.server";

const mockWebhook = authenticate.webhook as Mock;
const mockSetNamespace = sessionStorage.setNamespace as Mock;
const mockFindSessionsByShop = sessionStorage.findSessionsByShop as Mock;
const mockDeleteSessions = sessionStorage.deleteSessions as Mock;

describe("webhooks.compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSessionsByShop.mockResolvedValue([]);
    mockDeleteSessions.mockResolvedValue(true);
  });

  describe("HMAC verification", () => {
    it("returns 200 for valid HMAC (customers/data_request)", async () => {
      mockWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "CUSTOMERS_DATA_REQUEST",
        payload: { webhook_id: "test-webhook-123" },
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
        payload: { webhook_id: "test-webhook-456" },
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123, customer: { id: 456 } }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
    });

    it("returns 200 for valid HMAC (shop/redact) and deletes sessions", async () => {
      const mockSessions = [{ id: "session-1" }, { id: "session-2" }];
      mockFindSessionsByShop.mockResolvedValue(mockSessions);

      mockWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "SHOP_REDACT",
        payload: { webhook_id: "test-webhook-789" },
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockFindSessionsByShop).toHaveBeenCalledWith(
        "test-shop.myshopify.com"
      );
      expect(mockDeleteSessions).toHaveBeenCalledWith([
        "session-1",
        "session-2",
      ]);
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

  describe("session namespace injection", () => {
    it("sets KV namespace when available", async () => {
      const mockNamespace = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
      mockWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "CUSTOMERS_DATA_REQUEST",
        payload: {},
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "{}",
      });

      await action(createMockActionArgs(request, { SESSIONS: mockNamespace }));

      expect(mockSetNamespace).toHaveBeenCalledWith(mockNamespace);
    });
  });
});
