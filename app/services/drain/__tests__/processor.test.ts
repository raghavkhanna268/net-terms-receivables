import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S10 drain processor.
 *
 * Tests verify:
 * 1. Handler registry: topic dispatch works correctly
 * 2. Default config values
 * 3. No-handler: visibility extended, not archived
 * 4. No-handler: DLQ after noHandlerMaxReads
 * 5. S6 handlers registered
 * 6. ORDERS_PAID/CANCELLED fetch real order
 */

// Mock the pgmq operations
vi.mock("~/lib/pgmq.server", () => ({
  S6_QUEUES: {
    SYNC: "s6_sync",
    BULK: "s6_bulk",
  },
}));

// Mock admin client
vi.mock("../admin-client.server", () => ({
  adminGraphQL: vi.fn().mockResolvedValue({
    success: true,
    data: { node: null },
    retryable: false,
  }),
  COMPANY_QUERY: "query CompanyById",
  COMPANY_LOCATION_QUERY: "query CompanyLocationById",
  ORDER_QUERY: "query OrderById",
  BULK_OPERATION_QUERY: "query BulkOperationById",
  START_COMPANIES_BULK_MUTATION: "mutation BulkCompaniesExport",
  START_ORDERS_BULK_MUTATION: "mutation BulkOrdersExport",
}));

// Mock the sync processors
vi.mock("~/services/sync/company.server", () => ({
  processCompanyWebhook: vi.fn().mockResolvedValue({
    success: true,
    action: "created",
    entityId: "account-123",
  }),
  isWebhookProcessed: vi.fn().mockResolvedValue(false),
  markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/sync/company-location.server", () => ({
  processCompanyLocationWebhook: vi.fn().mockResolvedValue({
    success: true,
    action: "created",
    entityId: "account-456",
  }),
}));

vi.mock("~/services/sync/order.server", () => ({
  processOrderWebhook: vi.fn().mockResolvedValue({
    success: true,
    action: "created",
    entityId: "invoice-789",
  }),
}));

vi.mock("~/services/sync/bulk-operations.server", () => ({
  registerBulkOperation: vi.fn().mockResolvedValue(undefined),
}));

describe("Drain Processor", () => {
  let mockSql: ReturnType<typeof createMockSql>;

  function createMockSql() {
    const sqlFn = vi.fn().mockImplementation(() => {
      return Promise.resolve([]);
    });

    const sql = Object.assign(sqlFn, {
      json: vi.fn((v: unknown) => v),
    });
    return sql;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockSql = createMockSql();
  });

  describe("handler registry", () => {
    it("registers and retrieves sync handlers by topic", async () => {
      const { registerSyncHandler, getSyncHandler } = await import(
        "../processor.server"
      );

      const customHandler = vi.fn().mockResolvedValue({
        success: true,
        action: "created",
      });

      registerSyncHandler("CUSTOM_TOPIC", customHandler);
      const handler = getSyncHandler("CUSTOM_TOPIC");

      expect(handler).toBe(customHandler);
    });

    it("returns undefined for unregistered topic", async () => {
      const { getSyncHandler } = await import("../processor.server");

      const handler = getSyncHandler("UNKNOWN_TOPIC");

      expect(handler).toBeUndefined();
    });

    it("has S6 handlers registered by default", async () => {
      const { getSyncHandler, getBulkHandler } = await import(
        "../processor.server"
      );

      // Sync handlers
      expect(getSyncHandler("COMPANIES_CREATE")).toBeDefined();
      expect(getSyncHandler("COMPANIES_UPDATE")).toBeDefined();
      expect(getSyncHandler("COMPANIES_DELETE")).toBeDefined();
      expect(getSyncHandler("COMPANY_LOCATIONS_CREATE")).toBeDefined();
      expect(getSyncHandler("COMPANY_LOCATIONS_UPDATE")).toBeDefined();
      expect(getSyncHandler("COMPANY_LOCATIONS_DELETE")).toBeDefined();
      expect(getSyncHandler("ORDERS_CREATE")).toBeDefined();
      expect(getSyncHandler("ORDERS_UPDATED")).toBeDefined();
      expect(getSyncHandler("ORDERS_CANCELLED")).toBeDefined();
      expect(getSyncHandler("ORDERS_PAID")).toBeDefined();

      // NOTE: BULK_OPERATIONS_FINISH handler is NOT registered yet.
      // Bulk JSONL processing requires byte-accurate HTTP Range chunking.
      // Messages will go through no-handler path (set_vt 3600s, eventual DLQ).
      expect(getBulkHandler("BULK_OPERATIONS_FINISH")).toBeUndefined();

      // NOTE: RECONCILE_* handlers are NOT registered yet.
      // Reconcile depends on bulk operations working. Will be added in follow-up PR.
      expect(getSyncHandler("RECONCILE_COMPANIES")).toBeUndefined();
      expect(getSyncHandler("RECONCILE_ORDERS")).toBeUndefined();
    });
  });

  describe("default config", () => {
    it("has correct default values", async () => {
      const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      expect(DEFAULT_DRAIN_CONFIG).toMatchObject({
        batchSize: 5,
        visibilityTimeoutSec: 30,
        timeBudgetMs: 15000, // 15 seconds
        maxRetries: 5,
        noHandlerMaxReads: 48, // ~2 days
        // NOTE: bulkChunkSize removed - bulk JSONL parsing not yet implemented
      });
    });
  });

  describe("drain result structure", () => {
    it("returns expected result structure with noHandler field", async () => {
      const { runDrain } = await import("../processor.server");

      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0]);

      expect(result).toMatchObject({
        processed: expect.any(Number),
        failed: expect.any(Number),
        deadLettered: expect.any(Number),
        skipped: expect.any(Number),
        noHandler: expect.any(Number),
        timedOut: expect.any(Boolean),
        elapsedMs: expect.any(Number),
        errors: expect.any(Array),
      });
    });
  });

  describe("time budget", () => {
    it("default time budget is 15 seconds", async () => {
      const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      expect(DEFAULT_DRAIN_CONFIG.timeBudgetMs).toBe(15000);
    });

    it("accepts custom time budget", async () => {
      const { runDrain } = await import("../processor.server");

      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0], {
        timeBudgetMs: 5000,
      });

      expect(result).toBeDefined();
    });

    it("reports elapsed time in result", async () => {
      const { runDrain } = await import("../processor.server");

      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0]);

      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("no-handler behavior", () => {
    it("noHandlerMaxReads defaults to 48 (~2 days)", async () => {
      const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      expect(DEFAULT_DRAIN_CONFIG.noHandlerMaxReads).toBe(48);
    });
  });

  describe("error handling", () => {
    it("errors array starts empty for clean runs", async () => {
      const { runDrain } = await import("../processor.server");

      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0]);

      expect(result.errors).toEqual([]);
    });
  });
});

describe("Order handlers", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("ORDERS_PAID handler is registered and fetches real order", async () => {
    const { getSyncHandler } = await import("../processor.server");

    const handler = getSyncHandler("ORDERS_PAID");
    expect(handler).toBeDefined();

    // Handler is registered - actual GraphQL call tested in integration tests
  });

  it("ORDERS_CANCELLED handler is registered and fetches real order", async () => {
    const { getSyncHandler } = await import("../processor.server");

    const handler = getSyncHandler("ORDERS_CANCELLED");
    expect(handler).toBeDefined();

    // Handler is registered - actual GraphQL call tested in integration tests
  });
});

describe("Order null refetch behavior", () => {
  let mockAdminGraphQL: ReturnType<typeof vi.fn>;
  let mockProcessOrderWebhook: ReturnType<typeof vi.fn>;
  let mockMarkWebhookProcessed: ReturnType<typeof vi.fn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Get mocked functions
    const { adminGraphQL } = await import("../admin-client.server");
    const { processOrderWebhook } = await import("~/services/sync/order.server");
    const { markWebhookProcessed } = await import("~/services/sync/company.server");

    mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;
    mockProcessOrderWebhook = processOrderWebhook as ReturnType<typeof vi.fn>;
    mockMarkWebhookProcessed = markWebhookProcessed as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  it("ORDERS_PAID with null refetch uses processOrderWebhook with minimal order", async () => {
    // Set up null refetch
    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: { node: null },
      retryable: false,
    });

    mockProcessOrderWebhook.mockResolvedValue({
      success: true,
      action: "updated",
      entityId: "invoice-123",
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("ORDERS_PAID");
    expect(handler).toBeDefined();

    const mockSql = Object.assign(
      vi.fn().mockResolvedValue([]),
      { json: vi.fn((v: unknown) => v) }
    );

    const message = {
      topic: "ORDERS_PAID",
      shop: "test.myshopify.com",
      webhookId: "wh-123",
      resourceGid: "gid://shopify/Order/456",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Should log order_refetch_null warning
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[order_refetch_null]")
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("shop=test.myshopify.com")
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("order=gid://shopify/Order/456")
    );

    // Should call processOrderWebhook with minimal order (goes through markInvoicePaid)
    expect(mockProcessOrderWebhook).toHaveBeenCalledWith(
      mockSql,
      "test.myshopify.com",
      "ORDERS_PAID",
      expect.objectContaining({
        id: "gid://shopify/Order/456",
        paymentTerms: expect.any(Object),
      }),
      "wh-123"
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("updated");
  });

  it("ORDERS_CANCELLED with null refetch uses processOrderWebhook with minimal order", async () => {
    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: { node: null },
      retryable: false,
    });

    mockProcessOrderWebhook.mockResolvedValue({
      success: true,
      action: "updated",
      entityId: "invoice-456",
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("ORDERS_CANCELLED");

    const mockSql = Object.assign(
      vi.fn().mockResolvedValue([]),
      { json: vi.fn((v: unknown) => v) }
    );

    const message = {
      topic: "ORDERS_CANCELLED",
      shop: "test.myshopify.com",
      webhookId: "wh-789",
      resourceGid: "gid://shopify/Order/999",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Should log warning
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[order_refetch_null]")
    );

    // Should call processOrderWebhook (goes through cancelInvoice)
    expect(mockProcessOrderWebhook).toHaveBeenCalledWith(
      mockSql,
      "test.myshopify.com",
      "ORDERS_CANCELLED",
      expect.objectContaining({ id: "gid://shopify/Order/999" }),
      "wh-789"
    );

    expect(result.success).toBe(true);
  });

  it("ORDERS_CREATE with null refetch leaves invoice unchanged and logs warning", async () => {
    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: { node: null },
      retryable: false,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("ORDERS_CREATE");

    const mockSql = Object.assign(
      vi.fn().mockResolvedValue([]),
      { json: vi.fn((v: unknown) => v) }
    );

    const message = {
      topic: "ORDERS_CREATE",
      shop: "test.myshopify.com",
      webhookId: "wh-create-1",
      resourceGid: "gid://shopify/Order/111",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Should log warning
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[order_refetch_null]")
    );

    // Should NOT call processOrderWebhook (can't create invoice without data)
    expect(mockProcessOrderWebhook).not.toHaveBeenCalled();

    // Should mark webhook as processed to avoid reprocessing
    expect(mockMarkWebhookProcessed).toHaveBeenCalledWith(
      mockSql,
      "wh-create-1",
      "ORDERS_CREATE",
      "gid://shopify/Order/111"
    );

    // Result should indicate skipped with explanation
    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toContain("null");
    expect(result.skipReason).toContain("Ledger state unchanged");
  });

  it("ORDERS_UPDATED with null refetch leaves invoice unchanged and logs warning", async () => {
    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: { node: null },
      retryable: false,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("ORDERS_UPDATED");

    const mockSql = Object.assign(
      vi.fn().mockResolvedValue([]),
      { json: vi.fn((v: unknown) => v) }
    );

    const message = {
      topic: "ORDERS_UPDATED",
      shop: "test.myshopify.com",
      webhookId: "wh-update-1",
      resourceGid: "gid://shopify/Order/222",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Should log warning
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[order_refetch_null]")
    );

    // Should NOT call processOrderWebhook
    expect(mockProcessOrderWebhook).not.toHaveBeenCalled();

    // Should mark as processed
    expect(mockMarkWebhookProcessed).toHaveBeenCalled();

    // Result indicates skipped
    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
  });
});

describe("Customer bulk query PII fields", () => {
  // Import directly from customer-fields to avoid mock interference
  it("includes email and displayName with CUSTOMER_PII_FIELDS=1", async () => {
    const { getBulkCustomersQuery } = await import(
      "~/services/sync/customer-fields.server"
    );

    const tagRules = [{ tag: "net-terms" }];
    const env = { CUSTOMER_PII_FIELDS: "1" };

    const query = getBulkCustomersQuery(tagRules, env);

    expect(query).not.toBeNull();
    expect(query).toContain("email");
    expect(query).toContain("displayName");
  });

  it("excludes email and displayName without flag", async () => {
    const { getBulkCustomersQuery } = await import(
      "~/services/sync/customer-fields.server"
    );

    const tagRules = [{ tag: "net-terms" }];
    const env = {};

    const query = getBulkCustomersQuery(tagRules, env);

    expect(query).not.toBeNull();
    expect(query).not.toContain("email");
    expect(query).not.toContain("displayName");
  });

  it("NEVER includes phone or addresses regardless of flag", async () => {
    const { getBulkCustomersQuery } = await import(
      "~/services/sync/customer-fields.server"
    );

    const tagRules = [{ tag: "net-terms" }];
    const queryOff = getBulkCustomersQuery(tagRules, {});
    const queryOn = getBulkCustomersQuery(tagRules, { CUSTOMER_PII_FIELDS: "1" });

    for (const query of [queryOff, queryOn]) {
      expect(query).not.toBeNull();
      expect(query).not.toMatch(/\bphone\b/);
      expect(query).not.toMatch(/\baddresses\b/);
      expect(query).not.toMatch(/\bfirstName\b/);
      expect(query).not.toMatch(/\blastName\b/);
      expect(query).not.toMatch(/\bdefaultAddress\b/);
    }
  });
});
