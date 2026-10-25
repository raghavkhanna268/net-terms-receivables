/**
 * Route-level compliance webhook tests with REAL HMAC signatures.
 *
 * These tests call the compliance route action with a synthetic test secret,
 * WITHOUT mocking the webhook verifier. This ensures the full HMAC verification
 * path is exercised end-to-end.
 *
 * Test cases per issue #39:
 * - Valid signature returns 200 for customers/data_request, customers/redact, shop/redact
 * - Bad or missing HMAC returns 401
 * - Missing shop or topic headers return 400
 * - Non-POST request returns 405
 * - shop/redact with header shop mismatch from signed shop_domain is rejected
 *
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/39
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

const SYNTHETIC_TEST_SECRET = "synthetic-test-secret-s22-compliance";
const TEST_SHOP = "test-qa-unmocked.myshopify.com";

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function createSignedRequest(
  body: string,
  topic: string,
  secret: string,
  options: {
    method?: string;
    shopDomain?: string;
    omitHmac?: boolean;
    wrongHmac?: string;
    omitTopic?: boolean;
    omitShop?: boolean;
    webhookId?: string;
  } = {}
): Request {
  const hmac = options.wrongHmac ?? (options.omitHmac ? undefined : generateShopifyHmac(body, secret));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-API-Version": "2026-10",
    "X-Shopify-Webhook-Id": options.webhookId ?? `unmocked-${Date.now()}`,
  };

  if (!options.omitTopic) {
    headers["X-Shopify-Topic"] = topic;
  }
  if (!options.omitShop) {
    headers["X-Shopify-Shop-Domain"] = options.shopDomain ?? TEST_SHOP;
  }
  if (hmac) {
    headers["X-Shopify-Hmac-Sha256"] = hmac;
  }

  return new Request("https://example.com/webhooks/compliance", {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : body,
  });
}

const mockSessionStorage = {
  deleteAllForShop: vi.fn().mockResolvedValue(0),
};

const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => v) }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockDeleteShop = vi.fn().mockResolvedValue({ deleted: true, shopId: "shop-123", refetchNullPurged: 0 });
const mockPurgePgmqMessages = vi.fn().mockResolvedValue({ purged: false, reason: "documented limitation" });
const mockRedactCustomer = vi.fn().mockResolvedValue({
  taggedCustomersDeleted: 0,
  draftOrdersDeleted: 0,
  dataRequestsDeleted: 0,
  payerAliasesDeleted: 0,
  buyerAccountAnonymized: false,
  paymentsRedacted: 0,
});
const mockGenerateCustomerDataExport = vi.fn().mockResolvedValue({
  customerGid: "gid://shopify/Customer/456",
  requestId: "req-123",
  requestedAt: new Date().toISOString(),
  data: { taggedCustomer: null, draftOrders: [], buyerAccount: null, invoices: [], paymentMatches: [] },
});
const mockPersistDataRequest = vi.fn().mockResolvedValue({ id: "dr-1", alreadyExists: false });
const mockPurgeExpiredDataRequests = vi.fn().mockResolvedValue(0);
const mockSendDataRequestNotification = vi.fn().mockResolvedValue({ sent: false, skippedReason: "no_api_key" });

vi.mock("~/services/compliance", () => ({
  deleteShop: (...args: unknown[]) => mockDeleteShop(...args),
  purgePgmqMessages: (...args: unknown[]) => mockPurgePgmqMessages(...args),
  redactCustomer: (...args: unknown[]) => mockRedactCustomer(...args),
  generateCustomerDataExport: (...args: unknown[]) => mockGenerateCustomerDataExport(...args),
  persistDataRequest: (...args: unknown[]) => mockPersistDataRequest(...args),
  purgeExpiredDataRequests: (...args: unknown[]) => mockPurgeExpiredDataRequests(...args),
  sendDataRequestNotification: (...args: unknown[]) => mockSendDataRequestNotification(...args),
}));

const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);
const mockDeleteWebhookReceiptsForShop = vi.fn().mockResolvedValue(0);
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

const mockGraphql = vi.fn().mockResolvedValue({
  json: async () => ({ data: { shop: { email: "owner@shop.com", contactEmail: null } } }),
});
const mockUnauthenticatedAdmin = vi.fn().mockResolvedValue({ admin: { graphql: mockGraphql } });
vi.mock("~/shopify.server", () => ({
  getShopifyApp: () => ({
    unauthenticated: {
      admin: mockUnauthenticatedAdmin,
    },
  }),
}));

import { action } from "../webhooks.compliance";

function createMockActionArgs(request: Request): ActionFunctionArgs {
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

describe("webhooks.compliance unmocked HMAC tests (#39)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue(mockSqlResult);
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("valid signature returns 200 for all three topics", () => {
    it("customers/data_request with valid HMAC returns 200", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = {
        shop_id: 123,
        shop_domain: TEST_SHOP,
        customer: { id: 456 },
        data_request: { id: 789 },
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "customers/data_request", SYNTHETIC_TEST_SECRET);

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockGenerateCustomerDataExport).toHaveBeenCalled();
      expect(mockPersistDataRequest).toHaveBeenCalled();
    });

    it("customers/redact with valid HMAC returns 200", async () => {
      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);

      const payload = {
        shop_id: 123,
        shop_domain: TEST_SHOP,
        customer: { id: 456 },
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "customers/redact", SYNTHETIC_TEST_SECRET);

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockRedactCustomer).toHaveBeenCalled();
    });

    it("shop/redact with valid HMAC returns 200", async () => {
      const payload = {
        shop_id: 123,
        shop_domain: TEST_SHOP,
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockDeleteShop).toHaveBeenCalledWith(expect.anything(), TEST_SHOP);
    });
  });

  describe("bad or missing HMAC returns 401", () => {
    it("missing HMAC header returns 401", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        omitHmac: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("wrong HMAC signature returns 401", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        wrongHmac,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("tampered body with original HMAC returns 401", async () => {
      const originalPayload = { shop_id: 123, shop_domain: TEST_SHOP };
      const originalBody = JSON.stringify(originalPayload);
      const hmac = generateShopifyHmac(originalBody, SYNTHETIC_TEST_SECRET);

      const tamperedPayload = { shop_id: 999, shop_domain: TEST_SHOP };
      const tamperedBody = JSON.stringify(tamperedPayload);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "shop/redact",
          "X-Shopify-Shop-Domain": TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "test-123",
          "X-Shopify-API-Version": "2026-10",
        },
        body: tamperedBody,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe("missing required headers return 400 (after valid HMAC)", () => {
    it("missing X-Shopify-Topic returns 400 when HMAC is valid", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        omitTopic: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });
    });

    it("missing X-Shopify-Shop-Domain returns 400 when HMAC is valid", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        omitShop: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe("HMAC-first verification (E9 security fix)", () => {
    it("returns 401 when HMAC is missing, even if topic is also missing", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        omitHmac: true,
        omitTopic: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when HMAC is missing, even if shop domain is also missing", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        omitHmac: true,
        omitShop: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when HMAC is wrong, even if topic is missing", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        wrongHmac,
        omitTopic: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when HMAC is wrong, even if shop domain is missing", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        wrongHmac,
        omitShop: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when HMAC is wrong with all other headers missing (no info leak)", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Hmac-Sha256": wrongHmac,
        },
        body,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("error response body does not reveal which header was missing", async () => {
      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        omitTopic: true,
      });

      try {
        await action(createMockActionArgs(request));
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        const response = error as Response;
        expect(response.status).toBe(400);
        expect(response.statusText).toBe("Bad Request");
        expect(response.statusText).not.toContain("Topic");
        expect(response.statusText).not.toContain("topic");
        expect(response.statusText).not.toContain("header");
      }
    });
  });

  describe("non-POST request returns 405", () => {
    it("GET request returns 405", async () => {
      const request = new Request("https://example.com/webhooks/compliance", {
        method: "GET",
        headers: {
          "X-Shopify-Topic": "shop/redact",
          "X-Shopify-Shop-Domain": TEST_SHOP,
          "X-Shopify-Webhook-Id": "test-123",
          "X-Shopify-API-Version": "2026-10",
        },
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 405,
      });
    });
  });

  describe("shop/redact rejects header shop mismatch from signed shop_domain", () => {
    it("returns 400 when header shop differs from payload shop_domain", async () => {
      const payload = {
        shop_id: 123,
        shop_domain: "test-other-shop.myshopify.com",
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });

      expect(mockDeleteShop).not.toHaveBeenCalled();
    });

    it("returns 400 when payload shop_domain is missing", async () => {
      const payload = {
        shop_id: 123,
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });

      expect(mockDeleteShop).not.toHaveBeenCalled();
    });
  });

  describe("customers/redact shop mismatch rejection", () => {
    it("returns 400 when header shop differs from payload shop_domain", async () => {
      const payload = {
        shop_id: 123,
        shop_domain: "test-other-shop.myshopify.com",
        customer: { id: 456 },
      };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "customers/redact", SYNTHETIC_TEST_SECRET, {
        shopDomain: TEST_SHOP,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });

      expect(mockRedactCustomer).not.toHaveBeenCalled();
    });
  });

  describe("invalid JSON payload returns 400", () => {
    it("malformed JSON returns 400", async () => {
      const body = "not-valid-json{";
      const hmac = generateShopifyHmac(body, SYNTHETIC_TEST_SECRET);

      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "shop/redact",
          "X-Shopify-Shop-Domain": TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "test-123",
          "X-Shopify-API-Version": "2026-10",
        },
        body,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe("SHOPIFY_API_SECRET not configured returns 500", () => {
    it("returns 500 when secret is missing", async () => {
      delete process.env.SHOPIFY_API_SECRET;

      const payload = { shop_id: 123, shop_domain: TEST_SHOP };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(500);
    });
  });
});
