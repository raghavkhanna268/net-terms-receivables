/**
 * #292 G6: Currency guard follow-up unit tests (QA 2 fail-closed audit).
 *
 * Unit tests (mocked dependencies) for:
 * - G8: Terminal topics (PAID, CANCELLED, DRAFT_DELETE) pass through drain for non-INR shops
 * - G4: NULL currency in drain fails closed (treated as non-INR)
 *
 * DB-backed tests are in currency-guard-followups-db.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// UNIT TESTS (mocked dependencies)
// ============================================================================

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
  getCustomerQueryForDrain: vi.fn().mockReturnValue("query CustomerById"),
  DRAFT_ORDER_QUERY: "query DraftOrderById",
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
    action: "updated",
    entityId: "invoice-789",
  }),
}));

vi.mock("~/services/sync/draft-order.server", () => ({
  processDraftOrderWebhook: vi.fn().mockResolvedValue({
    success: true,
    action: "deleted",
    entityId: "draft-456",
  }),
}));

vi.mock("~/services/sync/customer.server", () => ({
  processCustomerWebhook: vi.fn().mockResolvedValue({
    success: true,
    action: "created",
    entityId: "contact-123",
  }),
}));

vi.mock("../customer-fetch.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../customer-fetch.server")>();
  return {
    ...actual,
    incrementCustomerPiiAccessDeniedFallback: vi.fn().mockResolvedValue(undefined),
  };
});

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
  enqueueReconcileStage: vi.fn().mockResolvedValue(true),
  getManualKeyForBulkOp: vi.fn().mockResolvedValue(undefined),
}));

describe("#292 G8: Terminal topics pass through drain for non-INR shops", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  it("ORDERS_PAID is processed for non-INR shop (not skipped at drain level)", async () => {
    const { processOrderWebhook } = await import("~/services/sync/order.server");
    const mockProcessOrderWebhook = processOrderWebhook as ReturnType<typeof vi.fn>;
    const { adminGraphQL } = await import("../admin-client.server");
    const mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;

    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: {
        node: {
          id: "gid://shopify/Order/123",
          name: "#1001",
          createdAt: new Date().toISOString(),
          displayFinancialStatus: "PAID",
          paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
      },
      retryable: false,
    });

    const { runDrain } = await import("../processor.server");

    let pgmqReadCalls = 0;
    const createMockSql = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        // Handle sql(array) calls for IN clauses - return the array for interpolation
        if (Array.isArray(strings) && !('raw' in strings)) {
          return strings;
        }
        const query = strings.join("?");
        // pgmq.read: first call is sync queue, second is bulk queue
        if (query.includes("pgmq.read")) {
          pgmqReadCalls++;
          if (pgmqReadCalls === 1) {
            // Sync queue: return ORDERS_PAID message
            return Promise.resolve([{
              msg_id: "1",
              read_ct: 1,
              enqueued_at: new Date(),
              vt: new Date(),
              message: {
                topic: "ORDERS_PAID",
                shop: "test-usd-shop.myshopify.com",
                webhookId: "wh-paid-1",
                resourceGid: "gid://shopify/Order/123",
                enqueuedAt: new Date().toISOString(),
              },
            }]);
          }
          return Promise.resolve([]); // Bulk queue empty
        }
        if (query.includes("pgmq.archive")) {
          return Promise.resolve([{ archive: true }]);
        }
        // G8: Shop currency lookup returns USD (non-INR)
        if (query.includes('"Shop"') && query.includes("currency")) {
          return Promise.resolve([{ domain: "test-usd-shop.myshopify.com", currency: "USD" }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(fn, { json: vi.fn((v: unknown) => v) });
    };

    const mockSql = createMockSql();
    await runDrain(mockSql as never);

    // ORDERS_PAID should reach the handler (not skipped at drain level)
    expect(mockProcessOrderWebhook).toHaveBeenCalled();
    expect(mockProcessOrderWebhook).toHaveBeenCalledWith(
      expect.anything(),
      "test-usd-shop.myshopify.com",
      "ORDERS_PAID",
      expect.any(Object),
      "wh-paid-1",
      null
    );
  });

  it("ORDERS_CANCELLED is processed for non-INR shop", async () => {
    const { processOrderWebhook } = await import("~/services/sync/order.server");
    const mockProcessOrderWebhook = processOrderWebhook as ReturnType<typeof vi.fn>;
    const { adminGraphQL } = await import("../admin-client.server");
    const mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;

    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: {
        node: {
          id: "gid://shopify/Order/456",
          name: "#1002",
          createdAt: new Date().toISOString(),
          cancelledAt: new Date().toISOString(),
          paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
      },
      retryable: false,
    });

    const { runDrain } = await import("../processor.server");

    let pgmqReadCalls = 0;
    const createMockSql = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        if (Array.isArray(strings) && !('raw' in strings)) {
          return strings;
        }
        const query = strings.join("?");
        if (query.includes("pgmq.read")) {
          pgmqReadCalls++;
          if (pgmqReadCalls === 1) {
            return Promise.resolve([{
              msg_id: "2",
              read_ct: 1,
              enqueued_at: new Date(),
              vt: new Date(),
              message: {
                topic: "ORDERS_CANCELLED",
                shop: "test-eur-shop.myshopify.com",
                webhookId: "wh-cancelled-1",
                resourceGid: "gid://shopify/Order/456",
                enqueuedAt: new Date().toISOString(),
              },
            }]);
          }
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.archive")) {
          return Promise.resolve([{ archive: true }]);
        }
        if (query.includes('"Shop"') && query.includes("currency")) {
          return Promise.resolve([{ domain: "test-eur-shop.myshopify.com", currency: "EUR" }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(fn, { json: vi.fn((v: unknown) => v) });
    };

    const mockSql = createMockSql();
    await runDrain(mockSql as never);

    expect(mockProcessOrderWebhook).toHaveBeenCalled();
    expect(mockProcessOrderWebhook).toHaveBeenCalledWith(
      expect.anything(),
      "test-eur-shop.myshopify.com",
      "ORDERS_CANCELLED",
      expect.any(Object),
      "wh-cancelled-1",
      null
    );
  });

  it("DRAFT_ORDERS_DELETE is processed for non-INR shop", async () => {
    const { processDraftOrderWebhook } = await import("~/services/sync/draft-order.server");
    const mockProcessDraftOrder = processDraftOrderWebhook as ReturnType<typeof vi.fn>;

    const { runDrain } = await import("../processor.server");

    let pgmqReadCalls = 0;
    const createMockSql = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        if (Array.isArray(strings) && !('raw' in strings)) {
          return strings;
        }
        const query = strings.join("?");
        if (query.includes("pgmq.read")) {
          pgmqReadCalls++;
          if (pgmqReadCalls === 1) {
            return Promise.resolve([{
              msg_id: "3",
              read_ct: 1,
              enqueued_at: new Date(),
              vt: new Date(),
              message: {
                topic: "DRAFT_ORDERS_DELETE",
                shop: "test-gbp-shop.myshopify.com",
                webhookId: "wh-draft-del-1",
                resourceGid: "gid://shopify/DraftOrder/789",
                enqueuedAt: new Date().toISOString(),
              },
            }]);
          }
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.archive")) {
          return Promise.resolve([{ archive: true }]);
        }
        if (query.includes('"Shop"') && query.includes("currency")) {
          return Promise.resolve([{ domain: "test-gbp-shop.myshopify.com", currency: "GBP" }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(fn, { json: vi.fn((v: unknown) => v) });
    };

    const mockSql = createMockSql();
    await runDrain(mockSql as never);

    expect(mockProcessDraftOrder).toHaveBeenCalled();
    expect(mockProcessDraftOrder).toHaveBeenCalledWith(
      expect.anything(),
      "test-gbp-shop.myshopify.com",
      "DRAFT_ORDERS_DELETE",
      expect.any(Object),
      "wh-draft-del-1"
    );
  });

  it("ORDERS_CREATE is skipped for non-INR shop (non-terminal topic)", async () => {
    const { processOrderWebhook } = await import("~/services/sync/order.server");
    const mockProcessOrderWebhook = processOrderWebhook as ReturnType<typeof vi.fn>;

    const { runDrain } = await import("../processor.server");

    let pgmqReadCalls = 0;
    const createMockSql = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        if (Array.isArray(strings) && !('raw' in strings)) {
          return strings;
        }
        const query = strings.join("?");
        if (query.includes("pgmq.read")) {
          pgmqReadCalls++;
          if (pgmqReadCalls === 1) {
            return Promise.resolve([{
              msg_id: "4",
              read_ct: 1,
              enqueued_at: new Date(),
              vt: new Date(),
              message: {
                topic: "ORDERS_CREATE",
                shop: "test-usd-shop.myshopify.com",
                webhookId: "wh-create-1",
                resourceGid: "gid://shopify/Order/999",
                enqueuedAt: new Date().toISOString(),
              },
            }]);
          }
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.archive")) {
          return Promise.resolve([{ archive: true }]);
        }
        if (query.includes('"Shop"') && query.includes("currency")) {
          return Promise.resolve([{ domain: "test-usd-shop.myshopify.com", currency: "USD" }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(fn, { json: vi.fn((v: unknown) => v) });
    };

    const mockSql = createMockSql();
    const result = await runDrain(mockSql as never);

    // ORDERS_CREATE should be SKIPPED (archived without processing)
    expect(mockProcessOrderWebhook).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });
});

describe("#292 G4: NULL currency in drain fails closed", () => {
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleInfoSpy.mockRestore();
  });

  it("Shop with NULL currency skips non-terminal topics (fail closed)", async () => {
    const { processOrderWebhook } = await import("~/services/sync/order.server");
    const mockProcessOrderWebhook = processOrderWebhook as ReturnType<typeof vi.fn>;

    const { runDrain } = await import("../processor.server");

    let pgmqReadCalls = 0;
    const createMockSql = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        if (Array.isArray(strings) && !('raw' in strings)) {
          return strings;
        }
        const query = strings.join("?");
        if (query.includes("pgmq.read")) {
          pgmqReadCalls++;
          if (pgmqReadCalls === 1) {
            return Promise.resolve([{
              msg_id: "5",
              read_ct: 1,
              enqueued_at: new Date(),
              vt: new Date(),
              message: {
                topic: "ORDERS_CREATE",
                shop: "test-null-currency-shop.myshopify.com",
                webhookId: "wh-null-currency-1",
                resourceGid: "gid://shopify/Order/555",
                enqueuedAt: new Date().toISOString(),
              },
            }]);
          }
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.archive")) {
          return Promise.resolve([{ archive: true }]);
        }
        // G4: Shop exists but has NULL currency
        if (query.includes('"Shop"') && query.includes("currency")) {
          return Promise.resolve([{ domain: "test-null-currency-shop.myshopify.com", currency: null }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(fn, { json: vi.fn((v: unknown) => v) });
    };

    const mockSql = createMockSql();
    const result = await runDrain(mockSql as never);

    // ORDERS_CREATE should be SKIPPED because NULL currency fails closed
    expect(mockProcessOrderWebhook).not.toHaveBeenCalled();
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it("Shop with NULL currency allows terminal topics (ORDERS_PAID)", async () => {
    const { processOrderWebhook } = await import("~/services/sync/order.server");
    const mockProcessOrderWebhook = processOrderWebhook as ReturnType<typeof vi.fn>;
    const { adminGraphQL } = await import("../admin-client.server");
    const mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;

    mockAdminGraphQL.mockResolvedValue({
      success: true,
      data: {
        node: {
          id: "gid://shopify/Order/666",
          name: "#1003",
          createdAt: new Date().toISOString(),
          displayFinancialStatus: "PAID",
          paymentTerms: { id: "pt-1", paymentTermsName: "Net 30", paymentTermsType: "NET" },
        },
      },
      retryable: false,
    });

    const { runDrain } = await import("../processor.server");

    let pgmqReadCalls = 0;
    const createMockSql = () => {
      const fn = vi.fn().mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        if (Array.isArray(strings) && !('raw' in strings)) {
          return strings;
        }
        const query = strings.join("?");
        if (query.includes("pgmq.read")) {
          pgmqReadCalls++;
          if (pgmqReadCalls === 1) {
            return Promise.resolve([{
              msg_id: "6",
              read_ct: 1,
              enqueued_at: new Date(),
              vt: new Date(),
              message: {
                topic: "ORDERS_PAID",
                shop: "test-null-currency-shop.myshopify.com",
                webhookId: "wh-null-paid-1",
                resourceGid: "gid://shopify/Order/666",
                enqueuedAt: new Date().toISOString(),
              },
            }]);
          }
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.archive")) {
          return Promise.resolve([{ archive: true }]);
        }
        // G4: Shop exists but has NULL currency
        if (query.includes('"Shop"') && query.includes("currency")) {
          return Promise.resolve([{ domain: "test-null-currency-shop.myshopify.com", currency: null }]);
        }
        return Promise.resolve([]);
      });
      return Object.assign(fn, { json: vi.fn((v: unknown) => v) });
    };

    const mockSql = createMockSql();
    await runDrain(mockSql as never);

    // ORDERS_PAID should still be processed (terminal topic passes through)
    expect(mockProcessOrderWebhook).toHaveBeenCalled();
    expect(mockProcessOrderWebhook).toHaveBeenCalledWith(
      expect.anything(),
      "test-null-currency-shop.myshopify.com",
      "ORDERS_PAID",
      expect.any(Object),
      "wh-null-paid-1",
      null
    );
  });
});
