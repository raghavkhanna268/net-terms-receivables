import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

/**
 * Tests for S8 webhook handlers (customers and draft_orders).
 *
 * Tests verify:
 * 1. HMAC rejection (401) when authentication fails
 * 2. Enqueue-and-200 for each topic
 * 3. Graceful handling of missing payload fields
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

// Mock the pgmq module
const mockSendSyncMessage = vi.fn().mockResolvedValue({ msgId: "msg-123" });

vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: mockSendSyncMessage,
}));

describe("S8 Webhook Handlers", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_WEBHOOK_ID = "wh-test-s8-123";
  const TEST_CUSTOMER_GID = "gid://shopify/Customer/123";
  const TEST_DRAFT_ORDER_GID = "gid://shopify/DraftOrder/456";

  const mockShopify = {
    authenticate: {
      webhook: vi.fn(),
    },
  };

  const createMockContext = () => ({
    shopify: mockShopify,
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

  describe("webhooks.customers", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.customers");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      await expect(
        action(createActionArgs("https://example.com/webhooks/customers", {}))
      ).rejects.toEqual(hmacError);
    });

    it("enqueues CUSTOMERS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.customers");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "CUSTOMERS_CREATE",
        payload: { admin_graphql_api_id: TEST_CUSTOMER_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/customers", {
          admin_graphql_api_id: TEST_CUSTOMER_GID,
        })
      );

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
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "CUSTOMERS_UPDATE",
        payload: { admin_graphql_api_id: TEST_CUSTOMER_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/customers")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "CUSTOMERS_UPDATE" })
      );
    });

    it("enqueues CUSTOMERS_DELETE and returns 200", async () => {
      const { action } = await import("../webhooks.customers");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "CUSTOMERS_DELETE",
        payload: { admin_graphql_api_id: TEST_CUSTOMER_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/customers")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "CUSTOMERS_DELETE" })
      );
    });

    it("returns 200 without enqueue when missing GID", async () => {
      const { action } = await import("../webhooks.customers");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "CUSTOMERS_CREATE",
        payload: {}, // Missing admin_graphql_api_id
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/customers")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });

  describe("webhooks.draft_orders", () => {
    it("returns 401 when HMAC validation fails", async () => {
      const { action } = await import("../webhooks.draft_orders");
      const hmacError = new Response("Unauthorized", { status: 401 });
      mockShopify.authenticate.webhook.mockRejectedValue(hmacError);

      await expect(
        action(createActionArgs("https://example.com/webhooks/draft_orders", {}))
      ).rejects.toEqual(hmacError);
    });

    it("enqueues DRAFT_ORDERS_CREATE and returns 200", async () => {
      const { action } = await import("../webhooks.draft_orders");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "DRAFT_ORDERS_CREATE",
        payload: { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/draft_orders", {
          admin_graphql_api_id: TEST_DRAFT_ORDER_GID,
        })
      );

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
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "DRAFT_ORDERS_UPDATE",
        payload: { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/draft_orders")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "DRAFT_ORDERS_UPDATE" })
      );
    });

    it("enqueues DRAFT_ORDERS_DELETE and returns 200", async () => {
      const { action } = await import("../webhooks.draft_orders");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "DRAFT_ORDERS_DELETE",
        payload: { admin_graphql_api_id: TEST_DRAFT_ORDER_GID },
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/draft_orders")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ topic: "DRAFT_ORDERS_DELETE" })
      );
    });

    it("returns 200 without enqueue when missing GID", async () => {
      const { action } = await import("../webhooks.draft_orders");
      mockShopify.authenticate.webhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "DRAFT_ORDERS_CREATE",
        payload: {}, // Missing admin_graphql_api_id
        webhookId: TEST_WEBHOOK_ID,
      });

      const response = await action(
        createActionArgs("https://example.com/webhooks/draft_orders")
      );

      expect(response.status).toBe(200);
      expect(mockSendSyncMessage).not.toHaveBeenCalled();
    });
  });
});
