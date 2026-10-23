import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * Tests for S6 webhook handlers.
 *
 * Tests verify:
 * 1. Valid HMAC enqueues and returns 200
 * 2. Bad HMAC returns 401
 * 3. Unexpected topic enqueues nothing and returns 200
 * 4. Missing GID returns 200 without enqueue
 */

// Mock SQL client that returns bulk operation type, with transaction support
const mockSql = Object.assign(
  vi.fn().mockResolvedValue([{ bulk_type: "companies" }]),
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
const mockSendBulkMessage = vi.fn().mockResolvedValue({ msgId: "msg-456" });

vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: mockSendSyncMessage,
  sendBulkMessage: mockSendBulkMessage,
}));

// Mock webhook receipts for S20 idempotency
const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);
const mockRecordAndEnqueueSync = vi.fn().mockImplementation(
  async (_sql, params: { webhookId: string; topic: string; shop: string; resourceGid: string }) => {
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

// Mock shopify context for bulk_operations.finish (still uses authenticate.webhook)
const mockShopify = {
  authenticate: {
    webhook: vi.fn(),
  },
};

const mockSessionStorage = {
  deleteAllForShop: vi.fn(),
};

describe("S6 Webhook Handlers", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_WEBHOOK_ID = "wh-test-123";
  const TEST_GID = "gid://shopify/Company/123";
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
        shopify: mockShopify,
        sessionStorage: mockSessionStorage,
        cloudflare: { env: {}, ctx: {} },
      },
      params: {},
      url: new URL(request.url),
      pattern: new URL(request.url).pathname,
    };
  }

  describe("webhooks.companies", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        { admin_graphql_api_id: TEST_GID },
        "companies/create",
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

    it("enqueues COMPANIES_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        { admin_graphql_api_id: TEST_GID },
        "companies/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: TEST_WEBHOOK_ID,
          resourceGid: TEST_GID,
        })
      );
    });

    it("enqueues COMPANIES_UPDATE and returns 200", async () => {
      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        { admin_graphql_api_id: TEST_GID },
        "companies/update"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "COMPANIES_UPDATE" })
      );
    });

    it("enqueues COMPANIES_DELETE and returns 200", async () => {
      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        { admin_graphql_api_id: TEST_GID },
        "companies/delete"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "COMPANIES_DELETE" })
      );
    });

    it("returns 200 without enqueue for unexpected topic", async () => {
      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        { admin_graphql_api_id: TEST_GID },
        "orders/create" // Wrong topic for this handler
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when missing GID", async () => {
      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        {}, // Missing admin_graphql_api_id
        "companies/create"
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

      const { action } = await import("../webhooks.companies");
      const request = createMockRequest(
        "https://example.com/webhooks/companies",
        { admin_graphql_api_id: TEST_GID },
        "companies/create"
      );

      await expect(action(createActionArgs(request))).rejects.toThrow(
        "Simulated enqueue failure"
      );
    });
  });

  describe("webhooks.company_locations", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.company_locations");
      const request = createMockRequest(
        "https://example.com/webhooks/company_locations",
        { admin_graphql_api_id: "gid://shopify/CompanyLocation/456" },
        "company_locations/create",
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

    it("enqueues COMPANY_LOCATIONS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.company_locations");
      const locationGid = "gid://shopify/CompanyLocation/456";
      const request = createMockRequest(
        "https://example.com/webhooks/company_locations",
        { admin_graphql_api_id: locationGid },
        "company_locations/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "COMPANY_LOCATIONS_CREATE",
          resourceGid: locationGid,
        })
      );
    });

    it("enqueues COMPANY_LOCATIONS_UPDATE and returns 200", async () => {
      const { action } = await import("../webhooks.company_locations");
      const request = createMockRequest(
        "https://example.com/webhooks/company_locations",
        { admin_graphql_api_id: "gid://shopify/CompanyLocation/789" },
        "company_locations/update"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "COMPANY_LOCATIONS_UPDATE" })
      );
    });

    it("returns 200 without enqueue for unexpected topic", async () => {
      const { action } = await import("../webhooks.company_locations");
      const request = createMockRequest(
        "https://example.com/webhooks/company_locations",
        { admin_graphql_api_id: "gid://shopify/CompanyLocation/456" },
        "companies/create" // Wrong topic for this handler
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("webhooks.orders", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.orders");
      const request = createMockRequest(
        "https://example.com/webhooks/orders",
        { admin_graphql_api_id: "gid://shopify/Order/1001" },
        "orders/create",
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

    it("enqueues ORDERS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      const orderGid = "gid://shopify/Order/1001";
      const request = createMockRequest(
        "https://example.com/webhooks/orders",
        { admin_graphql_api_id: orderGid },
        "orders/create"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "ORDERS_CREATE",
          resourceGid: orderGid,
        })
      );
    });

    it("enqueues ORDERS_UPDATED and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      const request = createMockRequest(
        "https://example.com/webhooks/orders",
        { admin_graphql_api_id: "gid://shopify/Order/1002" },
        "orders/updated"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "ORDERS_UPDATED" })
      );
    });

    it("enqueues ORDERS_CANCELLED and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      const request = createMockRequest(
        "https://example.com/webhooks/orders",
        { admin_graphql_api_id: "gid://shopify/Order/1003" },
        "orders/cancelled"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "ORDERS_CANCELLED" })
      );
    });

    it("enqueues ORDERS_PAID and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      const request = createMockRequest(
        "https://example.com/webhooks/orders",
        { admin_graphql_api_id: "gid://shopify/Order/1004" },
        "orders/paid"
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "ORDERS_PAID" })
      );
    });

    it("returns 200 without enqueue for unexpected topic", async () => {
      const { action } = await import("../webhooks.orders");
      const request = createMockRequest(
        "https://example.com/webhooks/orders",
        { admin_graphql_api_id: "gid://shopify/Order/1001" },
        "companies/create" // Wrong topic for this handler
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("webhooks.bulk_operations.finish", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.bulk_operations.finish");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      const request = new Request(
        "https://example.com/webhooks/bulk_operations/finish",
        { method: "POST" }
      );

      await expect(
        action(createActionArgs(request))
      ).rejects.toEqual(hmacError);
    });

    it("enqueues completed bulk operation and returns 200", async () => {
      const { action } = await import("../webhooks.bulk_operations.finish");
      const bulkOpGid = "gid://shopify/BulkOperation/123";
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "BULK_OPERATIONS_FINISH",
        payload: {
          admin_graphql_api_id: bulkOpGid,
          status: "COMPLETED",
          type: "query",
        },
        webhookId: TEST_WEBHOOK_ID,
      });

      const request = new Request(
        "https://example.com/webhooks/bulk_operations/finish",
        { method: "POST" }
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendBulkMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpGid,
        })
      );
    });

    it("skips non-completed bulk operations", async () => {
      const { action } = await import("../webhooks.bulk_operations.finish");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "BULK_OPERATIONS_FINISH",
        payload: {
          admin_graphql_api_id: "gid://shopify/BulkOperation/456",
          status: "FAILED",
        },
        webhookId: TEST_WEBHOOK_ID,
      });

      const request = new Request(
        "https://example.com/webhooks/bulk_operations/finish",
        { method: "POST" }
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendBulkMessage).not.toHaveBeenCalled();
    });

    it("returns 200 without enqueue when missing operation ID", async () => {
      const { action } = await import("../webhooks.bulk_operations.finish");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "BULK_OPERATIONS_FINISH",
        payload: { status: "COMPLETED" }, // Missing admin_graphql_api_id
        webhookId: TEST_WEBHOOK_ID,
      });

      const request = new Request(
        "https://example.com/webhooks/bulk_operations/finish",
        { method: "POST" }
      );

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSendBulkMessage).not.toHaveBeenCalled();
    });
  });
});
