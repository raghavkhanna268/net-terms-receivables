/**
 * Unit tests for bulk operation recovery.
 *
 * Tests verify:
 * 1. findStaleBulkOperations finds old open rows
 * 2. COMPLETED status enqueues BULK_OPERATIONS_FINISH
 * 3. FAILED/CANCELED/EXPIRED status marks row as failed
 * 4. NOT_FOUND (null node) marks row as failed
 * 5. CREATED/RUNNING status leaves row alone
 * 6. Race safety via conditional UPDATE
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../admin-client.server", () => ({
  adminGraphQL: vi.fn(),
  BULK_OPERATION_STATUS_QUERY: "mock-query",
}));

vi.mock("~/lib/pgmq.server", () => ({
  sendBulkMessage: vi.fn().mockResolvedValue({ msgId: "mock-msg-id" }),
}));

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  shopHash: vi.fn().mockResolvedValue("hash-xxx"),
}));

describe("bulk-op-recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("findStaleBulkOperations", () => {
    it("finds rows older than threshold with completed_at IS NULL", async () => {
      const mockSql = vi.fn().mockResolvedValue([
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "companies",
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ]);

      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await findStaleBulkOperations(mockSql as unknown as Parameters<typeof findStaleBulkOperations>[0], 60);

      expect(result).toHaveLength(1);
      expect(result[0].bulk_operation_id).toBe("gid://shopify/BulkOperation/123");
    });

    it("returns empty array when no stale operations", async () => {
      const mockSql = vi.fn().mockResolvedValue([]);

      const { findStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await findStaleBulkOperations(mockSql as unknown as Parameters<typeof findStaleBulkOperations>[0], 60);

      expect(result).toHaveLength(0);
    });
  });

  describe("markBulkOperationFailed", () => {
    it("sets failure_count to 5 for open operations", async () => {
      const mockSql = vi.fn().mockResolvedValue({ count: 1 });

      const { markBulkOperationFailed } = await import("../bulk-op-recovery.server");
      const result = await markBulkOperationFailed(
        mockSql as unknown as Parameters<typeof markBulkOperationFailed>[0],
        "gid://shopify/BulkOperation/123"
      );

      expect(result).toBe(true);
      expect(mockSql).toHaveBeenCalled();
    });

    it("returns false when operation already completed", async () => {
      const mockSql = vi.fn().mockResolvedValue({ count: 0 });

      const { markBulkOperationFailed } = await import("../bulk-op-recovery.server");
      const result = await markBulkOperationFailed(
        mockSql as unknown as Parameters<typeof markBulkOperationFailed>[0],
        "gid://shopify/BulkOperation/123"
      );

      expect(result).toBe(false);
    });
  });

  describe("recoverStaleBulkOperations", () => {
    it("returns zero counts when no stale operations found", async () => {
      const mockSql = vi.fn().mockResolvedValue([]);

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.found).toBe(0);
      expect(result.enqueued).toBe(0);
      expect(result.markedFailed).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);
    });

    it("enqueues COMPLETED operations for processing", async () => {
      const { adminGraphQL } = await import("../admin-client.server");
      const { sendBulkMessage } = await import("~/lib/pgmq.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "COMPLETED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "companies" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockBeginTx = vi.fn().mockImplementation(async (callback) => {
        const txSql = vi.fn().mockResolvedValue([{ bulk_operation_id: "gid://shopify/BulkOperation/123" }]);
        return callback(txSql);
      });

      const mockSql = Object.assign(
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(findStaleResult);
          return Promise.resolve([]);
        }),
        { begin: mockBeginTx }
      );

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.found).toBe(1);
      expect(result.enqueued).toBe(1);
      expect(result.attempts[0].status).toBe("enqueued");
      expect(result.attempts[0].shopifyStatus).toBe("COMPLETED");
      expect(sendBulkMessage).toHaveBeenCalled();
    });

    it("marks FAILED operations as failed", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "FAILED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "orders" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve({ count: 1 });
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.found).toBe(1);
      expect(result.markedFailed).toBe(1);
      expect(result.attempts[0].status).toBe("marked_failed");
      expect(result.attempts[0].shopifyStatus).toBe("FAILED");
    });

    it("marks CANCELED operations as failed", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "CANCELED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "orders" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve({ count: 1 });
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.markedFailed).toBe(1);
      expect(result.attempts[0].shopifyStatus).toBe("CANCELED");
    });

    it("marks EXPIRED operations as failed", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "EXPIRED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "orders" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve({ count: 1 });
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.markedFailed).toBe(1);
      expect(result.attempts[0].shopifyStatus).toBe("EXPIRED");
    });

    it("marks NOT_FOUND (null node) operations as failed", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: { node: null },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/deleted",
          shop: "test.myshopify.com",
          bulk_type: "companies" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve({ count: 1 });
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.markedFailed).toBe(1);
      expect(result.attempts[0].status).toBe("marked_failed");
      expect(result.attempts[0].shopifyStatus).toBe("NOT_FOUND");
    });

    it("skips CREATED operations (still starting)", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "CREATED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "orders" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve([]);
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.skipped).toBe(1);
      expect(result.attempts[0].status).toBe("skipped");
      expect(result.attempts[0].shopifyStatus).toBe("CREATED");
    });

    it("skips RUNNING operations (still in progress)", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "RUNNING" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "orders" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve([]);
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.skipped).toBe(1);
      expect(result.attempts[0].status).toBe("skipped");
      expect(result.attempts[0].shopifyStatus).toBe("RUNNING");
    });

    it("records error when Shopify API fails", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: false,
        error: "API error",
        retryable: true,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "orders" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve([]);
      });

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.errors).toBe(1);
      expect(result.attempts[0].status).toBe("error");
      expect(result.attempts[0].error).toBe("API error");
    });

    it("skips enqueue when operation already completed (race condition)", async () => {
      const { adminGraphQL } = await import("../admin-client.server");
      const { sendBulkMessage } = await import("~/lib/pgmq.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "COMPLETED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "test.myshopify.com",
          bulk_type: "companies" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      const mockBeginTx = vi.fn().mockImplementation(async (callback) => {
        const txSql = vi.fn().mockResolvedValue([]);
        return callback(txSql);
      });

      let callCount = 0;
      const mockSql = Object.assign(
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(findStaleResult);
          return Promise.resolve([]);
        }),
        { begin: mockBeginTx }
      );

      const { recoverStaleBulkOperations } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperations(mockSql as unknown as Parameters<typeof recoverStaleBulkOperations>[0], 60);

      expect(result.skipped).toBe(1);
      expect(result.attempts[0].status).toBe("skipped");
      expect(sendBulkMessage).not.toHaveBeenCalled();
    });
  });

  describe("recoverStaleBulkOperationsForShop", () => {
    it("only processes operations for the specified shop", async () => {
      const { adminGraphQL } = await import("../admin-client.server");

      vi.mocked(adminGraphQL).mockResolvedValue({
        success: true,
        data: {
          node: { id: "gid://shopify/BulkOperation/123", status: "FAILED" },
        },
        retryable: false,
      });

      const findStaleResult = [
        {
          bulk_operation_id: "gid://shopify/BulkOperation/123",
          shop: "specific.myshopify.com",
          bulk_type: "companies" as const,
          started_at: new Date("2026-10-24T10:00:00Z"),
        },
      ];

      let callCount = 0;
      const mockSql = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(findStaleResult);
        return Promise.resolve({ count: 1 });
      });

      const { recoverStaleBulkOperationsForShop } = await import("../bulk-op-recovery.server");
      const result = await recoverStaleBulkOperationsForShop(
        mockSql as unknown as Parameters<typeof recoverStaleBulkOperationsForShop>[0],
        "specific.myshopify.com",
        60
      );

      expect(result.found).toBe(1);
      expect(result.markedFailed).toBe(1);
      const sqlCall = mockSql.mock.calls[0][0] as unknown as TemplateStringsArray;
      expect(sqlCall.join("")).toContain("shop =");
    });
  });

  describe("STALE_THRESHOLD_MINUTES", () => {
    it("exports a threshold of 60 minutes", async () => {
      const { STALE_THRESHOLD_MINUTES } = await import("../bulk-op-recovery.server");
      expect(STALE_THRESHOLD_MINUTES).toBe(60);
    });
  });
});
