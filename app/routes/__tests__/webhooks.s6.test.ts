import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

/**
 * Tests for S6 webhook handlers.
 *
 * Tests verify:
 * 1. HMAC rejection (401) when authentication fails
 * 2. Enqueue-and-200 for each topic
 * 3. Graceful handling of missing payload fields
 */

// Mock SQL client that returns bulk operation type
const mockSql = Object.assign(
  vi.fn().mockResolvedValue([{ bulk_type: "companies" }]),
  { json: vi.fn((v) => v) }
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

describe("S6 Webhook Handlers", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_WEBHOOK_ID = "wh-test-123";
  const TEST_GID = "gid://shopify/Company/123";

  const mockShopify = {
    authenticate: {
      webhook: vi.fn(),
    },
  };

  const mockSessionStorage = {
    deleteAllForShop: vi.fn(),
  };

  const createMockContext = () => ({
    shopify: mockShopify,
    sessionStorage: mockSessionStorage,
    cloudflare: { env: {}, ctx: {} },
  });

  const createMockRequest = (url: string, body: object = {}) =>
    new Request(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-Sha256": "test-hmac",
        "X-Shopify-Shop-Domain": TEST_SHOP,
        "X-Shopify-Webhook-Id": TEST_WEBHOOK_ID,
      },
      body: JSON.stringify(body),
    });

  const createActionArgs = (url: string, body?: object): ActionFunctionArgs => ({
    request: createMockRequest(url, body),
    context: createMockContext(),
    params: {},
    url: new URL(url),
    pattern: new URL(url).pathname,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("webhooks.companies", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.companies");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      await expect(
        action(createActionArgs("https://example.com/webhooks/companies", {}))
      ).rejects.toEqual(hmacError);
    });

    it("enqueues COMPANIES_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.companies");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "COMPANIES_CREATE",
        payload: { admin_graphql_api_id: TEST_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/companies", {
          admin_graphql_api_id: TEST_GID,
        })
      );

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
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "COMPANIES_UPDATE",
        payload: { admin_graphql_api_id: TEST_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/companies")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "COMPANIES_UPDATE" })
      );
    });

    it("enqueues COMPANIES_DELETE and returns 200", async () => {
      const { action } = await import("../webhooks.companies");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "COMPANIES_DELETE",
        payload: { admin_graphql_api_id: TEST_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/companies")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "COMPANIES_DELETE" })
      );
    });

    it("returns 200 without enqueue when missing GID", async () => {
      const { action } = await import("../webhooks.companies");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "COMPANIES_CREATE",
        payload: {}, // Missing admin_graphql_api_id
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/companies")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("webhooks.company_locations", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.company_locations");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      await expect(
        action(createActionArgs("https://example.com/webhooks/company_locations"))
      ).rejects.toEqual(hmacError);
    });

    it("enqueues COMPANY_LOCATIONS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.company_locations");
      const locationGid = "gid://shopify/CompanyLocation/456";
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "COMPANY_LOCATIONS_CREATE",
        payload: { admin_graphql_api_id: locationGid },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/company_locations")
      );

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
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "COMPANY_LOCATIONS_UPDATE",
        payload: { admin_graphql_api_id: "gid://shopify/CompanyLocation/789" },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/company_locations")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "COMPANY_LOCATIONS_UPDATE" })
      );
    });
  });

  describe("webhooks.orders", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.orders");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      await expect(
        action(createActionArgs("https://example.com/webhooks/orders"))
      ).rejects.toEqual(hmacError);
    });

    it("enqueues ORDERS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      const orderGid = "gid://shopify/Order/1001";
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "ORDERS_CREATE",
        payload: { admin_graphql_api_id: orderGid },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/orders")
      );

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
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "ORDERS_UPDATED",
        payload: { admin_graphql_api_id: "gid://shopify/Order/1002" },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/orders")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "ORDERS_UPDATED" })
      );
    });

    it("enqueues ORDERS_CANCELLED and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "ORDERS_CANCELLED",
        payload: { admin_graphql_api_id: "gid://shopify/Order/1003" },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/orders")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "ORDERS_CANCELLED" })
      );
    });

    it("enqueues ORDERS_PAID and returns 200", async () => {
      const { action } = await import("../webhooks.orders");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "ORDERS_PAID",
        payload: { admin_graphql_api_id: "gid://shopify/Order/1004" },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/orders")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "ORDERS_PAID" })
      );
    });
  });

  describe("webhooks.bulk_operations.finish", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.bulk_operations.finish");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      await expect(
        action(createActionArgs("https://example.com/webhooks/bulk_operations/finish"))
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

      const response = await action(
        createActionArgs("https://example.com/webhooks/bulk_operations/finish")
      );

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

      const response = await action(
        createActionArgs("https://example.com/webhooks/bulk_operations/finish")
      );

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

      const response = await action(
        createActionArgs("https://example.com/webhooks/bulk_operations/finish")
      );

      expect(response.status).toBe(200);
      expect(mockSendBulkMessage).not.toHaveBeenCalled();
    });
  });
});
