import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for handleCustomer with fallback behavior.
 *
 * These tests verify:
 * 1. ACCESS_DENIED on PII fields triggers fallback with null values
 * 2. Counter is incremented on fallback
 * 3. piiMode is passed correctly to processCustomerWebhook
 * 4. Counter failures don't break message processing (best-effort)
 */

// Use vi.hoisted to create configurable mocks at the top level
const mocks = vi.hoisted(() => ({
  processCustomerWebhook: vi.fn(),
  getTagRules: vi.fn(),
  shouldFetchCustomerPii: vi.fn(),
  isCustomerTracked: vi.fn(),
  isWebhookProcessed: vi.fn(),
  markWebhookProcessed: vi.fn(),
  incrementCounter: vi.fn(),
  fetchBaseFields: vi.fn(),
  fetchPiiFields: vi.fn(),
  adminGraphQL: vi.fn(),
  getRequestEnv: vi.fn(),
}));

// Mock all processor.server dependencies at the top level (before any imports)
vi.mock("~/lib/pgmq.server", () => ({
  S6_QUEUES: { SYNC: "s6_sync", BULK: "s6_bulk" },
}));

vi.mock("../admin-client.server", () => ({
  adminGraphQL: mocks.adminGraphQL,
  COMPANY_QUERY: "query CompanyById",
  ORDER_QUERY: "query OrderById",
  getCustomerQueryForDrain: vi.fn().mockReturnValue("query CustomerById"),
  getCompanyLocationQuery: vi.fn().mockReturnValue("query CompanyLocationById"),
  getCompanyLocationQueryWithoutContact: vi.fn().mockReturnValue("query CompanyLocationById"),
  DRAFT_ORDER_QUERY: "query DraftOrderById",
  BULK_OPERATION_STATUS_QUERY: "query BulkOperationStatus",
}));

vi.mock("~/services/sync/company.server", () => ({
  processCompanyWebhook: vi.fn().mockResolvedValue({ success: true, action: "created", entityId: "account-123" }),
  isWebhookProcessed: mocks.isWebhookProcessed,
  markWebhookProcessed: mocks.markWebhookProcessed,
}));

vi.mock("~/services/sync/company-location.server", () => ({
  processCompanyLocationWebhook: vi.fn().mockResolvedValue({ success: true, action: "created", entityId: "location-123" }),
}));

vi.mock("~/services/sync/order.server", () => ({
  processOrderWebhook: vi.fn().mockResolvedValue({ success: true, action: "created", entityId: "invoice-789" }),
}));

vi.mock("~/services/sync/customer.server", () => ({
  processCustomerWebhook: mocks.processCustomerWebhook,
  getTagRules: mocks.getTagRules,
  shouldFetchCustomerPii: mocks.shouldFetchCustomerPii,
  isCustomerTracked: mocks.isCustomerTracked,
  CustomerPiiMode: {} as never,
}));

vi.mock("~/services/sync/draft-order.server", () => ({
  processDraftOrderWebhook: vi.fn().mockResolvedValue({ success: true, action: "created", entityId: "draft-456" }),
}));

vi.mock("../customer-fetch.server", () => ({
  fetchCustomerBaseFields: mocks.fetchBaseFields,
  fetchCustomerPiiFields: mocks.fetchPiiFields,
  incrementCustomerPiiAccessDeniedFallback: mocks.incrementCounter,
  getCustomerPiiAccessDeniedFallbackCount: vi.fn().mockResolvedValue(0),
  fetchCustomerWithFallback: vi.fn().mockResolvedValue({ success: true, data: {} }),
  getCustomerByNodeQuery: vi.fn().mockReturnValue("query CustomerById"),
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestEnv: mocks.getRequestEnv,
  getRequestSql: vi.fn(() => null),
}));

vi.mock("~/services/sync/bulk-operations.server", () => ({
  registerBulkOperation: vi.fn().mockResolvedValue(undefined),
  getBulkCompaniesQuery: vi.fn().mockReturnValue("mutation BulkCompaniesExport"),
  BULK_ORDERS_QUERY: "mutation BulkOrdersExport",
  parseBulkOperationResult: vi.fn().mockReturnValue({
    success: true,
    bulkOperationId: "gid://shopify/BulkOperation/123",
    status: "CREATED",
  }),
}));

vi.mock("~/services/sync/bulk-jsonl-processor.server", () => ({
  processBulkOperation: vi.fn().mockResolvedValue({
    success: true,
    action: "updated",
    entityId: "gid://shopify/BulkOperation/123",
    status: "complete",
  }),
}));

vi.mock("../reconcile-handlers.server", () => ({
  startReconcileBulkOperation: vi.fn().mockResolvedValue({ success: true, action: "created", entityId: "gid://shopify/BulkOperation/123" }),
  incrementOrderRefetchNull: vi.fn().mockResolvedValue(undefined),
  enqueueReconcileStage: vi.fn().mockResolvedValue(true),
  enqueueReconcileOrders: vi.fn().mockResolvedValue(true),
  getManualKeyForBulkOp: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/sync/customer-fields.server", () => ({
  validateCustomerQuery: vi.fn().mockReturnValue({ valid: true }),
}));

vi.mock("~/lib/shop-currency.server", () => ({
  isShopCurrencySupported: vi.fn().mockReturnValue(true),
}));

vi.mock("../dead-letter-sanitize.server", () => ({
  isShopNotFoundReason: vi.fn().mockReturnValue(false),
  sanitizeSyncMessage: vi.fn((msg) => msg),
  sanitizeBulkMessage: vi.fn((msg) => msg),
}));

// Import after mocks are set up
import { getSyncHandler } from "../processor.server";

describe("handleCustomer with fallback behavior", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();

    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Set default mock implementations
    mocks.getRequestEnv.mockReturnValue({ CUSTOMER_PII_FIELDS: "1" });
    mocks.processCustomerWebhook.mockResolvedValue({
      success: true,
      action: "created",
      entityId: "contact-123",
    });
    mocks.getTagRules.mockResolvedValue([{ tag: "net-terms", defaultTermsDays: 30 }]);
    mocks.shouldFetchCustomerPii.mockResolvedValue(true);
    mocks.isCustomerTracked.mockResolvedValue(false);
    mocks.isWebhookProcessed.mockResolvedValue(false);
    mocks.markWebhookProcessed.mockResolvedValue(undefined);
    mocks.incrementCounter.mockResolvedValue(undefined);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("fallback succeeds: logs warning, increments counter, passes 'fallback' piiMode", async () => {
    mocks.fetchBaseFields.mockResolvedValue({
      success: true,
      data: { id: "gid://shopify/Customer/123", tags: ["net-terms"] },
      retryable: false,
    });
    mocks.fetchPiiFields.mockResolvedValue({
      success: true,
      email: null,
      displayName: null,
      retryable: false,
      usedFallback: true,
    });

    const handler = getSyncHandler("CUSTOMERS_UPDATE");

    // isWebhookProcessed is mocked, so first SQL call is shop query
    const mockSql = vi.fn().mockResolvedValue([{ id: "shop-123" }]);
    Object.assign(mockSql, { json: vi.fn((v: unknown) => v) });

    const message = {
      topic: "CUSTOMERS_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-fallback-1",
      resourceGid: "gid://shopify/Customer/123",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(true);

    expect(consoleWarnSpy).toHaveBeenCalled();
    const warnCalls = consoleWarnSpy.mock.calls.map((c: unknown[]) => c[0]);
    const fallbackLog = warnCalls.find((c: unknown) =>
      typeof c === "string" && c.includes('"event":"customer_pii_access_denied_fallback"')
    );
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog).not.toContain("myshopify.com");
    expect(fallbackLog).toContain('"shopHash"');
    expect(fallbackLog).toContain('"fields"');

    expect(mocks.incrementCounter).toHaveBeenCalledWith(mockSql, "test.myshopify.com");

    expect(mocks.processCustomerWebhook).toHaveBeenCalledWith(
      mockSql,
      "test.myshopify.com",
      "CUSTOMERS_UPDATE",
      expect.objectContaining({ id: "gid://shopify/Customer/123" }),
      "wh-fallback-1",
      "fallback"
    );
  });

  it("base fetch denied: returns failure, no counter increment", async () => {
    mocks.fetchBaseFields.mockResolvedValue({
      success: false,
      error: "Access denied",
      retryable: false,
    });

    const handler = getSyncHandler("CUSTOMERS_CREATE");

    // Base fetch fails before shop query, but we still need mockSql
    const mockSql = vi.fn().mockResolvedValue([{ id: "shop-123" }]);
    Object.assign(mockSql, { json: vi.fn((v: unknown) => v) });

    const message = {
      topic: "CUSTOMERS_CREATE",
      shop: "test.myshopify.com",
      webhookId: "wh-both-denied-1",
      resourceGid: "gid://shopify/Customer/456",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Access denied");

    expect(mocks.incrementCounter).not.toHaveBeenCalled();
    expect(mocks.processCustomerWebhook).not.toHaveBeenCalled();
  });

  it("both calls succeed: no warning, no counter, 'fetched' piiMode", async () => {
    mocks.fetchBaseFields.mockResolvedValue({
      success: true,
      data: { id: "gid://shopify/Customer/789", tags: ["premium"] },
      retryable: false,
    });
    mocks.fetchPiiFields.mockResolvedValue({
      success: true,
      email: "test-fallback@test-cust.example.com",
      displayName: "Test Fallback User",
      retryable: false,
      usedFallback: false,
    });

    const handler = getSyncHandler("CUSTOMERS_UPDATE");

    // isWebhookProcessed is mocked, so first SQL call is shop query
    const mockSql = vi.fn().mockResolvedValue([{ id: "shop-123" }]);
    Object.assign(mockSql, { json: vi.fn((v: unknown) => v) });

    const message = {
      topic: "CUSTOMERS_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-success-1",
      resourceGid: "gid://shopify/Customer/789",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(true);

    const warnCalls = consoleWarnSpy.mock.calls.map((c: unknown[]) => c[0]);
    const fallbackLog = warnCalls.find((c: unknown) =>
      typeof c === "string" && c.includes('"event":"customer_pii_access_denied_fallback"')
    );
    expect(fallbackLog).toBeUndefined();

    expect(mocks.incrementCounter).not.toHaveBeenCalled();

    expect(mocks.processCustomerWebhook).toHaveBeenCalledWith(
      mockSql,
      "test.myshopify.com",
      "CUSTOMERS_UPDATE",
      expect.objectContaining({
        id: "gid://shopify/Customer/789",
        email: "test-fallback@test-cust.example.com",
      }),
      "wh-success-1",
      "fetched"
    );
  });

  it("counter insert throws: message still succeeds (best-effort)", async () => {
    mocks.fetchBaseFields.mockResolvedValue({
      success: true,
      data: { id: "gid://shopify/Customer/999", tags: [] },
      retryable: false,
    });
    mocks.fetchPiiFields.mockResolvedValue({
      success: true,
      email: null,
      displayName: null,
      retryable: false,
      usedFallback: true,
    });

    mocks.incrementCounter.mockRejectedValueOnce(new Error("relation s10b_customer_pii_fallback does not exist"));

    const handler = getSyncHandler("CUSTOMERS_UPDATE");

    // isWebhookProcessed is mocked, so first SQL call is shop query
    const mockSql = vi.fn().mockResolvedValue([{ id: "shop-123" }]);
    Object.assign(mockSql, { json: vi.fn((v: unknown) => v) });

    const message = {
      topic: "CUSTOMERS_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-counter-fail-1",
      resourceGid: "gid://shopify/Customer/999",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(true);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("customer_pii_access_denied_fallback_counter_failed")
    );

    expect(mocks.processCustomerWebhook).toHaveBeenCalled();
  });
});
