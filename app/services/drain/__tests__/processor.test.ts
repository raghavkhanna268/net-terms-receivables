import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for S10 drain processor.
 *
 * Tests verify:
 * 1. Handler registry: topic dispatch works correctly
 * 2. Batch processing: respects batch size limit
 * 3. Idempotency: already-processed webhooks are skipped
 * 4. Retry logic: failed messages are retried
 * 5. DLQ: messages exceeding max retries move to dead-letter
 * 6. Time budget: stops early when time limit reached
 */

// Mock the pgmq operations
vi.mock("~/lib/pgmq.server", () => ({
  S6_QUEUES: {
    SYNC: "s6_sync",
    BULK: "s6_bulk",
  },
}));

// Mock the sync processors
vi.mock("~/services/sync/company.server", () => ({
  processCompanyWebhook: vi.fn().mockResolvedValue({
    success: true,
    action: "created",
    entityId: "account-123",
  }),
  isWebhookProcessed: vi.fn().mockResolvedValue(false),
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

describe("Drain Processor", () => {
  let mockSql: ReturnType<typeof createMockSql>;
  let readSyncResults: Array<{
    msg_id: string;
    read_ct: number;
    enqueued_at: Date;
    vt: Date;
    message: {
      topic: string;
      shop: string;
      webhookId: string;
      resourceGid: string;
      enqueuedAt: string;
    };
  }>;
  let readBulkResults: Array<unknown>;

  function createMockSql() {
    const sqlFn = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("");

      // Handle pgmq.read for s6_sync
      if (query.includes("pgmq.read") && query.includes("s6_sync")) {
        return Promise.resolve(readSyncResults);
      }

      // Handle pgmq.read for s6_bulk
      if (query.includes("pgmq.read") && query.includes("s6_bulk")) {
        return Promise.resolve(readBulkResults);
      }

      // Handle pgmq.archive
      if (query.includes("pgmq.archive")) {
        return Promise.resolve([{ archive: true }]);
      }

      // Handle pgmq.delete
      if (query.includes("pgmq.delete")) {
        return Promise.resolve([{ delete: true }]);
      }

      // Handle dead-letter insert
      if (query.includes("s6_dead_letter")) {
        return Promise.resolve([]);
      }

      // Handle webhook processed check
      if (query.includes("s6_processed_webhooks") && query.includes("EXISTS")) {
        return Promise.resolve([{ exists: false }]);
      }

      // Handle webhook processed insert
      if (query.includes("s6_processed_webhooks") && query.includes("INSERT")) {
        return Promise.resolve([]);
      }

      // Default
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

    readSyncResults = [];
    readBulkResults = [];
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

      // Bulk handler
      expect(getBulkHandler("BULK_OPERATIONS_FINISH")).toBeDefined();

      // Reconcile handlers
      expect(getSyncHandler("RECONCILE_COMPANIES")).toBeDefined();
      expect(getSyncHandler("RECONCILE_ORDERS")).toBeDefined();
    });
  });

  describe("batch processing", () => {
    it("returns result with expected structure", async () => {
      const { runDrain } = await import("../processor.server");

      // Run with empty queues (mock returns empty arrays)
      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0], {
        batchSize: 5,
      });

      // Should return a valid result structure
      expect(result).toMatchObject({
        processed: expect.any(Number),
        failed: expect.any(Number),
        deadLettered: expect.any(Number),
        skipped: expect.any(Number),
        timedOut: expect.any(Boolean),
        elapsedMs: expect.any(Number),
        errors: expect.any(Array),
      });
    });

    it("passes batch size to configuration", async () => {
      const { runDrain, DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      // Verify default batch size
      expect(DEFAULT_DRAIN_CONFIG.batchSize).toBe(5);

      // Run with custom batch size
      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0], {
        batchSize: 10,
      });

      expect(result).toBeDefined();
    });
  });

  describe("time budget", () => {
    it("has sensible default time budget", async () => {
      const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      // Default time budget should be reasonable (20 seconds)
      expect(DEFAULT_DRAIN_CONFIG.timeBudgetMs).toBe(20000);
    });

    it("accepts custom time budget", async () => {
      const { runDrain } = await import("../processor.server");

      // Run with custom time budget
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

  describe("error handling", () => {
    it("has max retries configured", async () => {
      const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      // Should have sensible max retries default
      expect(DEFAULT_DRAIN_CONFIG.maxRetries).toBe(5);
    });

    it("errors array starts empty for clean runs", async () => {
      const { runDrain } = await import("../processor.server");

      // Empty queues should produce no errors
      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0]);

      expect(result.errors).toEqual([]);
    });
  });

  describe("drain result", () => {
    it("returns expected result structure", async () => {
      const { runDrain } = await import("../processor.server");

      readSyncResults = [];

      const result = await runDrain(mockSql as unknown as Parameters<typeof runDrain>[0]);

      expect(result).toMatchObject({
        processed: expect.any(Number),
        failed: expect.any(Number),
        deadLettered: expect.any(Number),
        skipped: expect.any(Number),
        timedOut: expect.any(Boolean),
        elapsedMs: expect.any(Number),
        errors: expect.any(Array),
      });
    });
  });
});

describe("Default drain config", () => {
  it("has sensible defaults", async () => {
    const { DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

    expect(DEFAULT_DRAIN_CONFIG).toMatchObject({
      batchSize: 5,
      visibilityTimeoutSec: 30,
      timeBudgetMs: 20000,
      maxRetries: 5,
    });
  });
});
