import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * Tests for S8 webhook handlers (customers and draft_orders).
 *
 * Tests verify:
 * 1. Valid HMAC enqueues and returns 200
 * 2. Bad HMAC returns 401
 * 3. Unexpected topic enqueues nothing and returns 200
 * 4. Missing GID returns 200 without enqueue
 */

// Mock SQL client with transaction support
const mockSql = Object.assign(
  vi.fn().mockResolvedValue([]),
  { 
    json: vi.fn((v) => v),
    // Mock sql.begin for S20 transactional edge idempotency
    begin: vi.fn(async (callback: (tx: typeof mockSql) => Promise<unknown>) => {
      return callback(mockSql);
    }),
  }
);

// Mock the request context module
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

// Mock the pgmq module
const mockSendSyncMessage = vi.fn().mockResolvedValue({ msgId: "msg-123" });

vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: mockSendSyncMessage,
}));

// Mock the webhook receipts module (S20)
const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);
const mockRecordAndEnqueueSync = vi.fn().mockImplementation(
  async (_sql, params: { webhookId: string; topic: string; shop: string; resourceGid: string }) => {
    // Call the sendSyncMessage mock to verify it's called with correct args
    await mockSendSyncMessage(
      {},
      {
        topic: params.topic,
        shop: params.shop,
        webhookId: params.webhookId,
        resourceGid: params.resourceGid,
        enqueuedAt: new Date().toISOString(),
      }
    );
    return { status: "enqueued" as const, msgId: "msg-123" };
  }
);

vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: vi.fn().mockResolvedValue(0),
  recordAndEnqueueSync: (...args: unknown[]) => mockRecordAndEnqueueSync(...args),
}));

describe("S8 Webhook Handlers", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_WEBHOOK_ID = "wh-test-s8-123";
  const TEST_CUSTOMER_GID = "gid://shopify/Customer/123";
  const TEST_DRAFT_ORDER_GID = "gid://shopify/DraftOrder/456";
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
    url: string,
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

    return new Request(url, {
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
        cloudflare: { env: {}, ctx: {} },
      },
      params: {},
      url: new URL(request.url),
      pattern: new URL(request.url).pathname,
    } as ActionFunctionArgs;
  }

  describe("webhooks.customers", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        { admin_graphql_api_id: TEST_CUSTOMER_GID },
        "customers/create",
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

    it("enqueues CUSTOMERS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        { admin_graphql_api_id: TEST_CUSTOMER_GID },
        "customers/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "CUSTOMERS_CREATE",
          shop: TEST_SHOP,
          webhookId: TEST_WEBHOOK_ID,
          resourceGid: TEST_CUSTOMER_GID,
        })
      );
    });

    it("enqueues CUSTOMERS_UPDATE and returns 200", async () => {
      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        { admin_graphql_api_id: TEST_CUSTOMER_GID },
        "customers/update"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "CUSTOMERS_UPDATE" })
      );
    });

    it("enqueues CUSTOMERS_DELETE and returns 200", async () => {
      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        { admin_graphql_api_id: TEST_CUSTOMER_GID },
        "customers/delete"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "CUSTOMERS_DELETE" })
      );
    });

    it("returns 200 without enqueue for unexpected topic", async () => {
      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        { admin_graphql_api_id: TEST_CUSTOMER_GID },
        "orders/create" // Wrong topic for this handler
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when missing GID", async () => {
      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        {}, // Missing admin_graphql_api_id
        "customers/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("throws when recordAndEnqueueSync returns error", async () => {
      mockRecordAndEnqueueSync.mockResolvedValueOnce({
        status: "error",
        error: new Error("Simulated enqueue failure"),
      });

      const { action } = await import("../webhooks.customers");
      const request = createMockRequest(
        "https://example.com/webhooks/customers",
        { admin_graphql_api_id: TEST_CUSTOMER_GID },
        "customers/create"
      );

      await expect(action(createActionArgs(request))).rejects.toThrow(
        "Simulated enqueue failure"
      );
    });
  });

  describe("webhooks.draft_orders", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        "draft_orders/create",
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

    it("enqueues DRAFT_ORDERS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        "draft_orders/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "DRAFT_ORDERS_CREATE",
          shop: TEST_SHOP,
          webhookId: TEST_WEBHOOK_ID,
          resourceGid: TEST_DRAFT_ORDER_GID,
        })
      );
    });

    it("enqueues DRAFT_ORDERS_UPDATE and returns 200", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        "draft_orders/update"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "DRAFT_ORDERS_UPDATE" })
      );
    });

    it("enqueues DRAFT_ORDERS_DELETE and returns 200", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        "draft_orders/delete"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "DRAFT_ORDERS_DELETE" })
      );
    });

    it("returns 200 without enqueue for unexpected topic", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        "customers/create" // Wrong topic for this handler
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when missing GID", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        {}, // Missing admin_graphql_api_id
        "draft_orders/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("throws when recordAndEnqueueSync returns error", async () => {
      mockRecordAndEnqueueSync.mockResolvedValueOnce({
        status: "error",
        error: new Error("Simulated enqueue failure"),
      });

      const { action } = await import("../webhooks.draft_orders");
      const request = createMockRequest(
        "https://example.com/webhooks/draft_orders",
        { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        "draft_orders/create"
      );

      await expect(action(createActionArgs(request))).rejects.toThrow(
        "Simulated enqueue failure"
      );
    });
  });
});
