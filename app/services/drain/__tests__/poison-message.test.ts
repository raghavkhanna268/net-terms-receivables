import { describe, it, expect, vi, beforeEach } from "vitest";

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
  getCompanyLocationQuery: vi.fn().mockReturnValue("query CompanyLocationById"),
  getCompanyLocationQueryWithoutContact: vi.fn().mockReturnValue("query CompanyLocationById"),
  ORDER_QUERY: "query OrderById",
  BULK_OPERATION_STATUS_QUERY: "query BulkOperationStatus",
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
  startReconcileBulkOperation: vi.fn().mockResolvedValue({
    success: true,
    action: "created",
    entityId: "gid://shopify/BulkOperation/123",
  }),
  incrementOrderRefetchNull: vi.fn().mockResolvedValue(undefined),
  enqueueReconcileOrders: vi.fn().mockResolvedValue(true),
}));

describe("Per-message isolation (poison message test)", () => {
  let mockAdminGraphQL: ReturnType<typeof vi.fn>;
  let mockProcessCompanyWebhook: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    // Get fresh references to mocked modules
    const { adminGraphQL } = await import("../admin-client.server");
    const { processCompanyWebhook } = await import("~/services/sync/company.server");
    mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;
    mockProcessCompanyWebhook = processCompanyWebhook as ReturnType<typeof vi.fn>;
  });

  it("processes both good messages when poison message is between them", async () => {
    // Set up three different responses: good, bad (schema error), good
    // Message 1: Good company
    mockAdminGraphQL.mockResolvedValueOnce({
      success: true,
      data: { node: { id: "gid://shopify/Company/1", name: "Good Co 1" } },
      retryable: false,
    });
    // Message 2: Schema error (non-retryable)
    mockAdminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "GraphQL query error: Cannot query field 'company' on type 'CompanyAddress'",
      retryable: false,
    });
    // Message 3: Good company
    mockAdminGraphQL.mockResolvedValueOnce({
      success: true,
      data: { node: { id: "gid://shopify/Company/3", name: "Good Co 3" } },
      retryable: false,
    });

    mockProcessCompanyWebhook.mockResolvedValue({
      success: true,
      action: "created",
      entityId: "account-123",
    });

    const { runDrain } = await import("../processor.server");

    // Track SQL calls to verify archive and DLQ operations
    const archiveCalls: string[] = [];
    const dlqCalls: { queue: string; msgId: string; error: string }[] = [];

    // Return 3 messages from the sync queue
    const queueMessages = [
      {
        msg_id: "1",
        read_ct: 1,
        enqueued_at: new Date(),
        vt: new Date(),
        message: {
          topic: "COMPANIES_UPDATE",
          shop: "test.myshopify.com",
          webhookId: "wh-good-1",
          resourceGid: "gid://shopify/Company/1",
          enqueuedAt: new Date().toISOString(),
        },
      },
      {
        msg_id: "2",
        read_ct: 1,
        enqueued_at: new Date(),
        vt: new Date(),
        message: {
          topic: "COMPANIES_UPDATE",
          shop: "test.myshopify.com",
          webhookId: "wh-poison",
          resourceGid: "gid://shopify/Company/2",
          enqueuedAt: new Date().toISOString(),
        },
      },
      {
        msg_id: "3",
        read_ct: 1,
        enqueued_at: new Date(),
        vt: new Date(),
        message: {
          topic: "COMPANIES_UPDATE",
          shop: "test.myshopify.com",
          webhookId: "wh-good-3",
          resourceGid: "gid://shopify/Company/3",
          enqueuedAt: new Date().toISOString(),
        },
      },
    ];

    let syncReadCalled = false;

    const createMockSqlFn = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        // Handle pgmq.read - check values for queue name
        if (query.includes("pgmq.read")) {
          const queueName = values[0] as string;
          if (queueName === "s6_sync") {
            if (!syncReadCalled) {
              syncReadCalled = true;
              return Promise.resolve(queueMessages);
            }
            return Promise.resolve([]);
          }
          if (queueName === "s6_bulk") {
            return Promise.resolve([]);
          }
        }

        // Track archives
        if (query.includes("pgmq.archive")) {
          archiveCalls.push(query);
          return Promise.resolve([{ archive: true }]);
        }

        // Track DLQ inserts
        if (query.includes("s6_dead_letter")) {
          dlqCalls.push({ queue: "s6_sync", msgId: "captured", error: "captured" });
          return Promise.resolve([]);
        }

        // Delete for DLQ - return { delete: true } to indicate success
        if (query.includes("pgmq.delete")) {
          return Promise.resolve([{ delete: true }]);
        }

        return Promise.resolve([]);
      });
      return fn;
    };

    const mockSql = Object.assign(
      createMockSqlFn(),
      {
        json: vi.fn((v: unknown) => v),
        begin: vi.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
          const txSql = Object.assign(createMockSqlFn(), { json: vi.fn((v: unknown) => v) });
          return callback(txSql);
        }),
      }
    );

    const result = await runDrain(mockSql as never);

    // Two good messages processed, one poison message to DLQ
    expect(result.processed).toBe(2);
    expect(result.deadLettered).toBe(1);
    expect(result.failed).toBe(0);

    // Both good messages should have been archived
    expect(archiveCalls.length).toBe(2);

    // Poison message went to DLQ (1 insert + 1 delete = 1 DLQ record)
    expect(dlqCalls.length).toBe(1);

    // processCompanyWebhook was called for both good companies
    expect(mockProcessCompanyWebhook).toHaveBeenCalledTimes(2);
  });

  it("non-retryable error returns retryable=false from handler", async () => {
    // Schema error should DLQ immediately, not wait for maxRetries
    mockAdminGraphQL.mockResolvedValue({
      success: false,
      error: "GraphQL query error: Cannot query field 'shopMoney' on type 'MoneyV2'",
      retryable: false,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("COMPANIES_UPDATE");

    const mockSql = Object.assign(
      vi.fn().mockResolvedValue([]),
      { json: vi.fn((v: unknown) => v) }
    );

    const message = {
      topic: "COMPANIES_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-schema-error",
      resourceGid: "gid://shopify/Company/123",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Handler should return failure with retryable=false
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("shopMoney");
  });

  it("retryable error returns retryable=true from handler", async () => {
    // Transient 503 error should NOT DLQ immediately
    mockAdminGraphQL.mockResolvedValue({
      success: false,
      error: "HTTP 503: Service Unavailable",
      retryable: true,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("COMPANIES_UPDATE");

    const mockSql = Object.assign(
      vi.fn().mockResolvedValue([]),
      { json: vi.fn((v: unknown) => v) }
    );

    const message = {
      topic: "COMPANIES_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-503",
      resourceGid: "gid://shopify/Company/123",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Handler should return failure with retryable=true
    expect(result.success).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).toContain("503");
  });
});
