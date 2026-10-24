import { describe, it, expect, vi, beforeEach, afterEach, Mock } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mockVerifyWebhook = vi.fn();
const mockVerifyPayloadShopMatch = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  verifyPayloadShopMatch: (...args: unknown[]) => mockVerifyPayloadShopMatch(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockRecordWebhookReceipt = vi.fn();
const mockParseTriggeredAt = vi.fn();
const mockDeleteWebhookReceiptsForShop = vi.fn();
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

const mockSessionStorage = {
  deleteAllForShop: vi.fn(),
};

const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => v) }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockDeleteShop = vi.fn();
const mockPurgePgmqMessages = vi.fn();
const mockRedactCustomer = vi.fn();
const mockGenerateCustomerDataExport = vi.fn();
const mockPersistDataRequest = vi.fn();
const mockPurgeExpiredDataRequests = vi.fn();
const mockSendDataRequestNotification = vi.fn();

vi.mock("~/services/compliance", () => ({
  deleteShop: (...args: unknown[]) => mockDeleteShop(...args),
  purgePgmqMessages: (...args: unknown[]) => mockPurgePgmqMessages(...args),
  redactCustomer: (...args: unknown[]) => mockRedactCustomer(...args),
  generateCustomerDataExport: (...args: unknown[]) => mockGenerateCustomerDataExport(...args),
  persistDataRequest: (...args: unknown[]) => mockPersistDataRequest(...args),
  purgeExpiredDataRequests: (...args: unknown[]) => mockPurgeExpiredDataRequests(...args),
  sendDataRequestNotification: (...args: unknown[]) => mockSendDataRequestNotification(...args),
}));

const mockGraphql = vi.fn();
const mockUnauthenticatedAdmin = vi.fn();
vi.mock("~/shopify.server", () => ({
  getShopifyApp: () => ({
    unauthenticated: {
      admin: mockUnauthenticatedAdmin,
    },
  }),
}));

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
    mockRecordWebhookReceipt.mockResolvedValue(true);
    mockParseTriggeredAt.mockReturnValue(null);
    mockDeleteWebhookReceiptsForShop.mockResolvedValue(0);
    // Mock unauthenticated.admin to return shop email
    mockGraphql.mockResolvedValue({
      json: async () => ({ data: { shop: { email: "owner@shop.com", contactEmail: null } } }),
    });
    mockUnauthenticatedAdmin.mockResolvedValue({ admin: { graphql: mockGraphql } });
    mockDeleteShop.mockResolvedValue({ deleted: true, shopId: "shop-123" });
    mockPurgePgmqMessages.mockResolvedValue({ purged: false, reason: "documented limitation" });
    mockRedactCustomer.mockResolvedValue({
      taggedCustomersDeleted: 1,
      draftOrdersDeleted: 0,
      dataRequestsDeleted: 0,
      payerAliasesDeleted: 0,
      buyerAccountAnonymized: true,
      paymentsRedacted: 0,
    });
    mockGenerateCustomerDataExport.mockResolvedValue({
      customerGid: "gid://shopify/Customer/456",
      requestId: "req-123",
      requestedAt: new Date().toISOString(),
      data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [], paymentMatches: [] },
    });
    mockPersistDataRequest.mockResolvedValue({ id: "dr-1", alreadyExists: false });
    mockPurgeExpiredDataRequests.mockResolvedValue(0);
    mockSendDataRequestNotification.mockResolvedValue({ sent: false, skippedReason: "no_api_key" });
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
        statusText: "Bad Request",
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

  describe("customers/data_request (S22)", () => {
    beforeEach(() => {
      mockVerifyPayloadShopMatch.mockImplementation((headerShop: string) => headerShop);
    });

    it("persists a data request row with correct fields for a known customer", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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
      expect(mockVerifyPayloadShopMatch).toHaveBeenCalledWith(
        "test-shop.myshopify.com",
        payload
      );
      expect(mockGenerateCustomerDataExport).toHaveBeenCalledWith(
        expect.anything(),
        "shop-123",
        "gid://shopify/Customer/456",
        "789"
      );
      expect(mockPersistDataRequest).toHaveBeenCalledWith(
        expect.anything(),
        "shop-123",
        "gid://shopify/Customer/456",
        "789",
        expect.objectContaining({ customerGid: "gid://shopify/Customer/456" })
      );
    });

    it("persists an empty export for an unknown customer", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const exportData = {
        customerGid: "gid://shopify/Customer/999",
        requestId: "req-unknown",
        requestedAt: new Date().toISOString(),
        data: {
          taggedCustomer: null,
          draftOrders: [],
          buyerAccount: null,
          invoices: [],
        },
      };
      mockGenerateCustomerDataExport.mockResolvedValue(exportData);

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 999 },
        data_request: { id: 100 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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
      expect(mockPersistDataRequest).toHaveBeenCalledWith(
        expect.anything(),
        "shop-123",
        "gid://shopify/Customer/999",
        "100",
        expect.objectContaining({
          data: expect.objectContaining({
            taggedCustomer: null,
            buyerAccount: null,
          }),
        })
      );
    });

    it("returns 400 when shop mismatch (via verifyPayloadShopMatch)", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
      });
      mockVerifyPayloadShopMatch.mockImplementation(() => {
        throw badRequestResponse;
      });

      const payload = {
        shop_domain: "other-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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

      expect(mockGenerateCustomerDataExport).not.toHaveBeenCalled();
      expect(mockPersistDataRequest).not.toHaveBeenCalled();
    });

    it("skips email when RESEND_API_KEY is not set but still persists export", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockSendDataRequestNotification.mockResolvedValue({ sent: false, skippedReason: "no_api_key" });

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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
      expect(mockPersistDataRequest).toHaveBeenCalled();
      expect(mockSendDataRequestNotification).toHaveBeenCalledWith(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "789"
      );
    });

    it("calls email notification with shop owner email fetched via admin API", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockSendDataRequestNotification.mockResolvedValue({ sent: true });

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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
      expect(mockUnauthenticatedAdmin).toHaveBeenCalledWith("test-shop.myshopify.com");
      expect(mockSendDataRequestNotification).toHaveBeenCalledWith(
        "test-shop.myshopify.com",
        "owner@shop.com",
        "789"
      );
    });

    it("returns 200 even when email notification fails", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      mockSendDataRequestNotification.mockResolvedValue({ 
        sent: false, 
        error: "resend_api_error_500" 
      });

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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
      expect(mockPersistDataRequest).toHaveBeenCalled();
    });

    it("skips email when shop email cannot be fetched", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      // Mock admin API failure
      mockUnauthenticatedAdmin.mockRejectedValueOnce(new Error("No session"));
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const payload = {
        shop_domain: "test-shop.myshopify.com",
        customer: { id: 456 },
        data_request: { id: 789 },
      };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/data_request",
        webhookId: "test-webhook",
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
      expect(mockPersistDataRequest).toHaveBeenCalled();
      expect(mockSendDataRequestNotification).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("data_request_email_skipped")
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("reason=no_shop_email")
      );
      consoleSpy.mockRestore();
    });
  });

  describe("customers/redact (S22)", () => {
    beforeEach(() => {
      mockVerifyPayloadShopMatch.mockImplementation((headerShop: string) => headerShop);
    });

    it("returns 400 when header shop differs from payload shop_domain (no deletes)", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
      });
      mockVerifyPayloadShopMatch.mockImplementation(() => {
        throw badRequestResponse;
      });

      const payload = { shop_domain: "other-shop.myshopify.com", customer: { id: 456 } };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
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

      expect(mockRedactCustomer).not.toHaveBeenCalled();
    });

    it("purges or anonymises every table for the customer", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = { shop_domain: "test-shop.myshopify.com", customer: { id: 456 } };

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
        headers: { "Content-Type": "application/json" },
      });

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockVerifyPayloadShopMatch).toHaveBeenCalledWith("test-shop.myshopify.com", payload);
      expect(mockRedactCustomer).toHaveBeenCalledWith(
        expect.anything(),
        "shop-123",
        "gid://shopify/Customer/456"
      );
    });

    it("returns 200 without redact when shop not found", async () => {
      mockSql.mockResolvedValueOnce([]);

      const payload = { shop_domain: "unknown-shop.myshopify.com", customer: { id: 456 } };

      mockVerifyWebhook.mockResolvedValue({
        shop: "unknown-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-unknown",
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
      expect(mockRedactCustomer).not.toHaveBeenCalled();
    });

    it("returns 200 without redact when customer.id is missing (safe no-op)", async () => {
      const payload = { shop_domain: "test-shop.myshopify.com" };

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-shop.myshopify.com",
        topic: "customers/redact",
        webhookId: "test-webhook-no-customer",
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
      expect(mockRedactCustomer).not.toHaveBeenCalled();
    });
  });

  describe("shop/redact (S22)", () => {
    beforeEach(() => {
      mockVerifyPayloadShopMatch.mockImplementation((headerShop: string) => headerShop);
    });

    it("deletes sessions and the Shop row (cascade deletes all data)", async () => {
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
      expect(mockDeleteShop).toHaveBeenCalledWith(
        expect.anything(),
        "test-shop.myshopify.com"
      );
    });

    it("returns 200 even when no sessions exist (idempotent)", async () => {
      mockDeleteAllForShop.mockResolvedValue(0);
      mockDeleteShop.mockResolvedValue({ deleted: false, shopId: null });

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
      expect(mockDeleteShop).toHaveBeenCalled();
    });

    it("returns 400 when payload shop_domain does not match header shop", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
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
      expect(mockDeleteShop).not.toHaveBeenCalled();
    });

    it("returns 400 when payload shop_domain is missing", async () => {
      const badRequestResponse = new Response(undefined, {
        status: 400,
        statusText: "Bad Request",
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
      expect(mockDeleteShop).not.toHaveBeenCalled();
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
