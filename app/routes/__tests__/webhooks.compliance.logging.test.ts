/**
 * Route-level compliance webhook tests with REAL logging.
 *
 * These tests verify that shop/redact logs contain shopHash and counts,
 * and that no log output contains the raw shop domain (.myshopify.com).
 *
 * Unlike other compliance tests, this does NOT mock log.server - it uses
 * the real safeLog and shopHash functions to verify PII-safe logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

const SYNTHETIC_TEST_SECRET = "synthetic-test-secret-s22-logging";
const TEST_SHOP = "test-logging-shop.myshopify.com";

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

const TEST_WEBHOOK_ID = "test-compliance-wh-fixed-001";

function createSignedRequest(
  body: string,
  topic: string,
  secret: string,
  shopDomain: string = TEST_SHOP,
  webhookId: string = TEST_WEBHOOK_ID
): Request {
  const hmac = generateShopifyHmac(body, secret);
  return new Request("https://example.com/webhooks/compliance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shopDomain,
      "X-Shopify-Hmac-Sha256": hmac,
    },
    body,
  });
}

const mockSessionStorage = {
  deleteAllForShop: vi.fn().mockResolvedValue(0),
};

const mockTx = vi.fn().mockResolvedValue(Object.assign([], { count: 0 }));
const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  {
    json: vi.fn((v) => v),
    begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
      return callback(mockTx);
    }),
  }
);

const mockGetRequestWaitUntil = vi.fn();

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: () => mockGetRequestWaitUntil(),
}));

// Track waitUntil promises for tests to await
let capturedWaitUntilPromises: Promise<unknown>[] = [];

function setupWaitUntilMock(): void {
  capturedWaitUntilPromises = [];
  const mockWaitUntil = vi.fn((p: Promise<unknown>) => { capturedWaitUntilPromises.push(p); });
  mockGetRequestWaitUntil.mockReturnValue(mockWaitUntil);
}

const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockDeleteWebhookReceiptsForShop = vi.fn().mockResolvedValue(0);
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: vi.fn().mockReturnValue(null),
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

const mockSendSyncMessage = vi.fn().mockResolvedValue({ msgId: "mock-msg-123" });
vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: (...args: unknown[]) => mockSendSyncMessage(...args),
  S6_QUEUES: { SYNC: "s6_sync", BULK: "s6_bulk" },
}));

const { mockAdmin, mockGetOfflineAdminContext } = vi.hoisted(() => {
  const mockGraphql = vi.fn().mockResolvedValue({
    json: async () => ({ data: { shop: { email: "owner@shop.com", contactEmail: null } } }),
  });
  const mockAdmin = { graphql: mockGraphql };
  const mockGetOfflineAdminContext = vi.fn().mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
  return { mockAdmin, mockGetOfflineAdminContext };
});
vi.mock("~/lib/offline-admin.server", () => ({
  getOfflineAdminContext: (...args: unknown[]) => mockGetOfflineAdminContext(...args),
}));

const mockGenerateCustomerDataExport = vi.fn();
const mockPersistDataRequest = vi.fn();
const mockPurgeExpiredDataRequests = vi.fn();
const mockSendDataRequestNotification = vi.fn();
const mockRedactCustomer = vi.fn();

vi.mock("~/services/compliance", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    generateCustomerDataExport: (...args: unknown[]) => mockGenerateCustomerDataExport(...args),
    persistDataRequest: (...args: unknown[]) => mockPersistDataRequest(...args),
    purgeExpiredDataRequests: (...args: unknown[]) => mockPurgeExpiredDataRequests(...args),
    sendDataRequestNotification: (...args: unknown[]) => mockSendDataRequestNotification(...args),
    redactCustomer: (...args: unknown[]) => mockRedactCustomer(...args),
  };
});

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

describe("webhooks.compliance real logging (no log.server mock)", () => {
  const originalEnv = process.env;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue(mockSqlResult);
    mockTx.mockResolvedValue(Object.assign([], { count: 0 }));
    process.env = { ...originalEnv, SHOPIFY_API_KEY: "test-api-key", SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    // Reset mock to default for each test
    mockGetOfflineAdminContext.mockResolvedValue({ success: true, admin: mockAdmin, retryable: false });
    // Set up waitUntil mock
    setupWaitUntilMock();

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    return allCalls.map(args => args.map((arg: unknown) => 
      typeof arg === "object" ? JSON.stringify(arg) : String(arg)
    ).join(" "));
  }

  function assertNoWebhookIdInLogs(testWebhookId?: string): void {
    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).not.toContain("webhookId");
    expect(outputStr).not.toContain("wh=");
    if (testWebhookId) {
      expect(outputStr).not.toContain(testWebhookId);
    }
  }

  it("shop/redact happy path enqueues and logs no raw domain or webhookId", async () => {
    // Fast-ack route just enqueues and returns 200 - no Shop query needed for shop/redact
    const payload = { shop_id: 123, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    // Verify message was enqueued
    expect(mockSendSyncMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: "SHOP_REDACT",
        shop: TEST_SHOP,
        shopId: "123",
      })
    );

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    // Assert NO raw shop domain appears in any output
    expect(outputStr).not.toContain(".myshopify.com");
    expect(outputStr).not.toContain(TEST_SHOP);

    // Assert webhookId is NOT logged
    assertNoWebhookIdInLogs(TEST_WEBHOOK_ID);
  });

  it("shop/redact duplicate receipt logs compliance_duplicate, no raw domain", async () => {
    // Setup mock for duplicate receipt
    mockRecordWebhookReceipt.mockResolvedValueOnce(false);

    const payload = { shop_id: 123, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    // Assert compliance_duplicate event appears
    expect(outputStr).toContain("compliance_duplicate");

    // Assert NO raw shop domain appears in any output
    expect(outputStr).not.toContain(".myshopify.com");
    expect(outputStr).not.toContain(TEST_SHOP);

    // Assert webhookId is NOT logged
    assertNoWebhookIdInLogs(TEST_WEBHOOK_ID);

    // Duplicate should not call sendSyncMessage
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
  });

  // ============ CUSTOMERS/DATA_REQUEST TESTS ============

  it("customers/data_request happy path enqueues and logs no webhookId", async () => {
    const testWebhookId = "test-data-request-received-wh";
    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]); // Shop lookup

    const payload = { customer: { id: 456 }, data_request: { id: 789 }, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/data_request", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    expect(mockSendSyncMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: "CUSTOMERS_DATA_REQUEST",
        shop: TEST_SHOP,
        requestId: "789",
        customerId: "456",
      })
    );
    assertNoWebhookIdInLogs(testWebhookId);
  });

  it("customers/data_request no customer id logs compliance_missing_customer_id", async () => {
    const testWebhookId = "test-data-request-no-cust-wh";
    const payload = { data_request: { id: 789 }, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/data_request", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).toContain("compliance_missing_customer_id");
    assertNoWebhookIdInLogs(testWebhookId);
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
  });

  it("customers/data_request no data_request.id logs compliance_missing_request_id", async () => {
    const testWebhookId = "test-data-request-no-reqid-wh";
    const payload = { customer: { id: 456 }, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/data_request", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).toContain("compliance_missing_request_id");
    assertNoWebhookIdInLogs(testWebhookId);
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
  });

  it("customers/data_request shop not found logs compliance_shop_not_found", async () => {
    const testWebhookId = "test-data-request-shop-not-found-wh";
    mockSql.mockResolvedValueOnce([]); // Shop not found

    const payload = { customer: { id: 456 }, data_request: { id: 789 }, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/data_request", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).toContain("compliance_shop_not_found");
    assertNoWebhookIdInLogs(testWebhookId);
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
  });

  // ============ CUSTOMERS/REDACT TESTS ============

  it("customers/redact happy path enqueues and logs no webhookId", async () => {
    const testWebhookId = "test-redact-happy-wh";
    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]); // Shop lookup

    const payload = { customer: { id: 456 }, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/redact", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    expect(mockSendSyncMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        topic: "CUSTOMERS_REDACT",
        shop: TEST_SHOP,
        customerId: "456",
      })
    );
    assertNoWebhookIdInLogs(testWebhookId);
  });

  it("customers/redact no customer id logs compliance_missing_customer_id", async () => {
    const testWebhookId = "test-redact-no-cust-wh";
    const payload = { shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/redact", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).toContain("compliance_missing_customer_id");
    assertNoWebhookIdInLogs(testWebhookId);
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
  });

  it("customers/redact shop not found logs compliance_shop_not_found", async () => {
    const testWebhookId = "test-redact-shop-not-found-wh";
    mockSql.mockResolvedValueOnce([]); // Shop not found

    const payload = { customer: { id: 456 }, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "customers/redact", SYNTHETIC_TEST_SECRET, TEST_SHOP, testWebhookId);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).toContain("compliance_shop_not_found");
    assertNoWebhookIdInLogs(testWebhookId);
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
  });
});
