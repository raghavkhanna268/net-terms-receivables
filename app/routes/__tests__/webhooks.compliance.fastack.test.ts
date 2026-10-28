import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { ActionFunctionArgs } from "react-router";

/**
 * Helper to assert that no shop domains appear in console output.
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

const mockVerifyWebhook = vi.fn();
const mockVerifyPayloadShopMatch = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  verifyPayloadShopMatch: (...args: unknown[]) => mockVerifyPayloadShopMatch(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockRecordWebhookReceipt = vi.fn();
const mockParseTriggeredAt = vi.fn();
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
}));

const mockSendSyncMessage = vi.fn();
vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: (...args: unknown[]) => mockSendSyncMessage(...args),
}));

const mockSqlResult = Object.assign([], { count: 0 });
const mockTx = vi.fn().mockResolvedValue(mockSqlResult);
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  {
    json: vi.fn((v) => v),
    begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
      return callback(mockTx);
    }),
  }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

function createMockActionArgs(request: Request): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: {}, ctx: {} },
      shopify: {},
    },
    url: new URL(request.url),
    pattern: "/webhooks/compliance",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.compliance";

describe("webhooks.compliance fast-ack", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      SHOPIFY_API_KEY: "test-api-key",
      SHOPIFY_API_SECRET: "test-secret",
    };
    mockRecordWebhookReceipt.mockResolvedValue(true);
    mockParseTriggeredAt.mockReturnValue(null);
    mockSendSyncMessage.mockResolvedValue({ msgId: "msg-123" });
    mockVerifyPayloadShopMatch.mockImplementation((headerShop: string) => headerShop);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("CUSTOMERS_DATA_REQUEST", () => {
    it("returns 200 fast and enqueues (no export/persist runs in route)", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-123",
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
      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      expect(mockRecordWebhookReceipt).toHaveBeenCalledWith(
        expect.anything(),
        "test-shop.myshopify.com",
        "test-webhook-123",
        "CUSTOMERS_DATA_REQUEST",
        null
      );
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "CUSTOMERS_DATA_REQUEST",
          shop: "test-shop.myshopify.com",
          webhookId: "test-webhook-123",
          requestId: "789",
          customerId: "456",
        })
      );
    });

    it("returns 200 with no enqueue for duplicate webhook", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockRecordWebhookReceipt.mockResolvedValueOnce(false);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-duplicate",
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
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 500 on enqueue error so Shopify retries", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockSql.begin.mockRejectedValueOnce(new Error("DB connection failed"));

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-error",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);
    });

    it("returns 200 without enqueue when shop not found", async () => {
      mockSql.mockResolvedValueOnce([]);

      const payload = {
        shop_domain: "test-unknown-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-unknown-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-noshop",
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
      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when customer.id is missing", async () => {
      const payload = { shop_domain: "test-shop.myshopify.com", data_request: { id: 789 } };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-nocust",
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
      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when data_request.id is missing", async () => {
      const payload = { shop_domain: "test-shop.myshopify.com", customer: { id: 456 } };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-noreq",
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
      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("CUSTOMERS_REDACT", () => {
    it("returns 200 fast and enqueues (no redact runs in route)", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-redact",
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
      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "CUSTOMERS_REDACT",
          shop: "test-shop.myshopify.com",
          customerId: "456",
        })
      );
    });

    it("returns 200 with no enqueue for duplicate webhook", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockRecordWebhookReceipt.mockResolvedValueOnce(false);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-dup-redact",
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
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 500 on enqueue error so Shopify retries", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockSql.begin.mockRejectedValueOnce(new Error("DB error"));

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-redact-err",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);
    });

    it("returns 200 without enqueue when shop not found", async () => {
      mockSql.mockResolvedValueOnce([]);

      const payload = {
        shop_domain: "test-unknown.myshopify.com",
        customer: { id: 456 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-unknown.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-noshop-redact",
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
      expect(mockSql.begin).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when customer.id is missing", async () => {
      const payload = { shop_domain: "test-shop.myshopify.com" };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-nocust-redact",
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
      expect(mockSql.begin).not.toHaveBeenCalled();
    });
  });

  describe("SHOP_REDACT", () => {
    it("returns 200 fast and enqueues (no delete runs in route)", async () => {
      const payload = {
        shop_domain: "test-shop.myshopify.com",
        shop_id: 123,
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-shop-redact",
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
      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "SHOP_REDACT",
          shop: "test-shop.myshopify.com",
          shopId: "123",
        })
      );
    });

    it("returns 200 with no enqueue for duplicate webhook", async () => {
      mockRecordWebhookReceipt.mockResolvedValueOnce(false);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        shop_id: 123,
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-dup-shop",
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
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 500 on enqueue error so Shopify retries", async () => {
      mockSql.begin.mockRejectedValueOnce(new Error("Network error"));

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        shop_id: 123,
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "test-webhook-shop-err",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);
    });
  });

  describe("HMAC verification", () => {
    it("returns 401 for invalid HMAC with no SQL and no enqueue", async () => {
      const unauthorizedResponse = new Response(undefined, {
        status: 401,
        statusText: "Unauthorized",
      });
      mockVerifyWebhook.mockRejectedValue(unauthorizedResponse);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
        headers: { "X-Shopify-Hmac-SHA256": "invalid-hmac" },
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 401 for missing HMAC header with no SQL and no enqueue", async () => {
      const unauthorizedResponse = new Response(undefined, {
        status: 401,
        statusText: "Unauthorized",
      });
      mockVerifyWebhook.mockRejectedValue(unauthorizedResponse);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify({ shop_id: 123 }),
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }

      expect(mockSql).not.toHaveBeenCalled();
      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("400 cases", () => {
    it("returns 400 when shop_domain mismatch and doesn't enqueue", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
      });
      mockVerifyPayloadShopMatch.mockImplementation(() => {
        throw badRequestResponse;
      });

      const payload = {
        shop_domain: "wrong-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-mismatch",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }

      expect(mockSql.begin).not.toHaveBeenCalled();
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("logging safety", () => {
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

    it("logs no shop domain in success path", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      const TEST_SHOP = "test-logging-shop.myshopify.com";

      const payload = {
        shop_domain: TEST_SHOP,
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "customers/data_request",
        webhookId: "test-webhook-log",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await action(createMockActionArgs(request));

      expectNoShopDomainInLogs(consoleSpy, TEST_SHOP);
    });

    it("logs no shop domain in error path", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockSql.begin.mockRejectedValueOnce(new Error("DB error"));
      const TEST_SHOP = "test-err-shop.myshopify.com";

      const payload = {
        shop_domain: TEST_SHOP,
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "customers/data_request",
        webhookId: "test-webhook-err-log",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await action(createMockActionArgs(request));

      expectNoShopDomainInLogs(consoleSpy, TEST_SHOP);
    });
  });

  describe("message minimisation", () => {
    it("message carries only topic, requestId, customerId - no payload, emails, shop domains", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: {
          id: 456,
          email: "customer@example.com",
          phone: "+1234567890",
        },
        data_request: { id: 789 },
        orders_requested: [123, 456],
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook-minimal",
        payload,
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        body: JSON.stringify(payload),
      });

      await action(createMockActionArgs(request));

      const sentMessage = mockSendSyncMessage.mock.calls[0][1];

      expect(sentMessage).toHaveProperty("topic", "CUSTOMERS_DATA_REQUEST");
      expect(sentMessage).toHaveProperty("requestId", "789");
      expect(sentMessage).toHaveProperty("customerId", "456");
      expect(sentMessage).not.toHaveProperty("email");
      expect(sentMessage).not.toHaveProperty("phone");
      expect(sentMessage).not.toHaveProperty("orders_requested");

      const messageJson = JSON.stringify(sentMessage);
      expect(messageJson).not.toContain("customer@example.com");
      expect(messageJson).not.toContain("+1234567890");
      expect(messageJson).not.toContain("orders_requested");
    });
  });
});
