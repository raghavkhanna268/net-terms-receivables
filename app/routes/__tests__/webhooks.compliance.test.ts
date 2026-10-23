import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mockVerifyWebhook = vi.fn();
const mockVerifyPayloadShopMatch = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  verifyPayloadShopMatch: (...args: unknown[]) => mockVerifyPayloadShopMatch(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockSessionStorage = {
  deleteAllForShop: vi.fn(),
};

function createMockActionArgs(
  request: Request
): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: {}, ctx: {} },
      shopify: {},
      sessionStorage: mockSessionStorage,
    },
    url: new URL(request.url),
    pattern: "/webhooks/compliance",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.compliance";

const mockDeleteAllForShop = mockSessionStorage.deleteAllForShop as Mock;

describe("webhooks.compliance", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteAllForShop.mockResolvedValue(0);
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("HMAC verification", () => {
    it("returns 200 for valid HMAC (customers/data_request)", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-123",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockVerifyWebhook).toHaveBeenCalledWith(
        request,
        "test-secret",
        { requireValidJson: true }
      );
    });

    it("returns 200 for valid HMAC (customers/redact)", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-456",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
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
      mockVerifyWebhook.mockRejectedValue(unauthorizedResponse);

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

    it("returns 401 for missing HMAC header (Shopify App Store compliance)", async () => {
      const unauthorizedResponse = new Response(undefined, {
        status: 401,
        statusText: "Unauthorized",
      });
      mockVerifyWebhook.mockRejectedValue(unauthorizedResponse);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: { "Content-Type": "application/json" },
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("returns 400 for invalid JSON payload (could hide redact)", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Invalid JSON payload",
      });
      mockVerifyWebhook.mockRejectedValue(badRequestResponse);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "not-valid-json",
        headers: { "Content-Type": "application/json" },
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }
    });

    it("returns 500 when SHOPIFY_API_SECRET is not configured", async () => {
      delete process.env.SHOPIFY_API_SECRET;

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "{}",
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);
      expect(mockVerifyWebhook).not.toHaveBeenCalled();
    });
  });

  describe("no DB access for no-op compliance topics", () => {
    it("does NOT touch sessionStorage for customers/data_request", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "{}",
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).not.toHaveBeenCalled();
    });

    it("does NOT touch sessionStorage for customers/redact", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: "{}",
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).not.toHaveBeenCalled();
    });
  });

  describe("shop/redact", () => {
    beforeEach(() => {
      mockVerifyPayloadShopMatch.mockImplementation((headerShop: string) => headerShop);
    });

    it("deletes sessions via sessionStorage.deleteAllForShop", async () => {
      mockDeleteAllForShop.mockResolvedValue(3);
      const payload = { shop_domain: "test-shop.myshopify.com", shop_id: 123 };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-789",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockVerifyPayloadShopMatch).toHaveBeenCalledWith("test-shop.myshopify.com", payload);
      expect(mockDeleteAllForShop).toHaveBeenCalledWith("test-shop.myshopify.com");
    });

    it("returns 200 even when no sessions exist (idempotent)", async () => {
      mockDeleteAllForShop.mockResolvedValue(0);
      const payload = { shop_domain: "no-sessions-shop.myshopify.com", shop_id: 999 };

      mockVerifyWebhook.mockResolvedValue({
        shop: "no-sessions-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-idempotent",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).toHaveBeenCalledWith("no-sessions-shop.myshopify.com");
    });

    it("handles multiple sessions for the same shop", async () => {
      mockDeleteAllForShop.mockResolvedValue(5);
      const payload = { shop_domain: "multi-session-shop.myshopify.com" };

      mockVerifyWebhook.mockResolvedValue({
        shop: "multi-session-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-multi",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteAllForShop).toHaveBeenCalledWith("multi-session-shop.myshopify.com");
    });

    it("returns 400 when payload shop_domain does not match header shop", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Payload shop_domain does not match header shop",
      });
      mockVerifyPayloadShopMatch.mockImplementation(() => {
        throw badRequestResponse;
      });

      const payload = { shop_domain: "other-shop.myshopify.com", shop_id: 123 };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-mismatch",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }

      expect(mockDeleteAllForShop).not.toHaveBeenCalled();
    });

    it("returns 400 when payload shop_domain is missing", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Missing shop_domain in payload",
      });
      mockVerifyPayloadShopMatch.mockImplementation(() => {
        throw badRequestResponse;
      });

      const payload = { shop_id: 123 };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-missing",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }

      expect(mockDeleteAllForShop).not.toHaveBeenCalled();
    });
  });

  describe("context injection", () => {
    beforeEach(() => {
      mockVerifyPayloadShopMatch.mockImplementation((headerShop: string) => headerShop);
    });

    it("uses sessionStorage from context (not module-level state)", async () => {
      mockDeleteAllForShop.mockResolvedValue(1);
      const payload = { shop_domain: "context-test.myshopify.com" };

      mockVerifyWebhook.mockResolvedValue({
        shop: "context-test.myshopify.com",
        topic: "shop/redact",
        webhookId: "context-webhook",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await action(createMockActionArgs(request));

      expect(mockDeleteAllForShop).toHaveBeenCalled();
    });
  });
});
