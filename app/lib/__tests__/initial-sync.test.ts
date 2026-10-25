import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Sql } from "../db-light.server";
import type { ReconcileMessage } from "~/services/drain/reconcile.server";

/**
 * Tests for initial-sync.server.ts (S23-04).
 *
 * Tests verify:
 * 1. getInitialSyncState derives status from current run (latest companies op + orders ops at/after it)
 * 2. enqueueInitialSync uses manual idempotency key with in-flight protection
 * 3. canStartSync logic
 * 4. Logs use shopHash, no PII (no domain or webhookId)
 * 5. Message shape matches reconcile.server.ts
 */

const mockSql = Object.assign(vi.fn(), {
  unsafe: vi.fn((s) => s),
  json: vi.fn((obj) => JSON.stringify(obj)),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestEnv: vi.fn(() => ({ LOG_HASH_KEY: "test-key-for-initial-sync-tests" })),
}));

vi.mock("~/lib/pgmq.server", () => ({
  S6_QUEUES: { SYNC: "s6_sync", BULK: "s6_bulk" },
}));

describe("initial-sync.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  describe("getInitialSyncState", () => {
    it("returns not_started when no bulk operations exist", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("not_started");
    });

    it("returns in_progress when companies operation exists without completed_at", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: null,
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("in_progress");
    });

    it("returns in_progress when companies complete but no orders op yet", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: new Date("2026-10-24T10:05:00Z"),
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("in_progress");
    });

    it("returns done when both companies and orders are completed in current run", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: new Date("2026-10-24T10:05:00Z"),
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/2",
              reconcile_stage: "orders",
              completed_at: new Date("2026-10-24T10:10:00Z"),
              failure_count: 0,
              started_at: new Date("2026-10-24T10:06:00Z"),
            },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("done");
    });

    it("returns failed when companies failure_count >= 5", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: null,
              failure_count: 5,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("failed");
    });

    it("returns failed when DLQ entries exist for current run's bulk_op_id", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: null,
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter") && query.includes("bulkOperationId")) {
          return Promise.resolve([{ count: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("failed");
    });

    it("companies in_progress + OLD failed orders = in_progress (not failed), retry blocked", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/2",
              reconcile_stage: "companies",
              completed_at: null,
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState, enqueueInitialSync } = await import("../initial-sync.server");
      const state = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");
      expect(state.status).toBe("in_progress");

      const enqueueResult = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");
      expect(enqueueResult.enqueued).toBe(false);
      expect(enqueueResult.reason).toBe("in_progress");
    });

    it("companies done + newer orders failed = failed", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: new Date("2026-10-24T10:05:00Z"),
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/2",
              reconcile_stage: "orders",
              completed_at: null,
              failure_count: 5,
              started_at: new Date("2026-10-24T10:06:00Z"),
            },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("failed");
    });

    it("an older failure followed by a newer success gives done", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/2",
              reconcile_stage: "companies",
              completed_at: new Date("2026-10-24T10:05:00Z"),
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/3",
              reconcile_stage: "orders",
              completed_at: new Date("2026-10-24T10:10:00Z"),
              failure_count: 0,
              started_at: new Date("2026-10-24T10:06:00Z"),
            },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("done");
    });
  });

  describe("enqueueInitialSync", () => {
    it("returns in_progress when latest run is still running", async () => {
      const companiesStarted = new Date("2026-10-24T10:00:00Z");
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: null,
              failure_count: 0,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("in_progress");
    });

    it("returns already_queued when manual message already in queue", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([{ msg_id: "123" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("already_queued");
    });

    it("enqueues message when latest run failed (even if day-key processed)", async () => {
      let enqueued = false;
      let sentMessage: ReconcileMessage | null = null;
      const companiesStarted = new Date("2026-10-24T10:00:00Z");

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([
            {
              bulk_op_id: "gid://shopify/BulkOperation/1",
              reconcile_stage: "companies",
              completed_at: null,
              failure_count: 5,
              started_at: companiesStarted,
            },
          ]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("orders")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("pgmq.send")) {
          enqueued = true;
          const jsonArg = values.find((v) => typeof v === "string" && v.includes("RECONCILE"));
          if (jsonArg) {
            sentMessage = JSON.parse(jsonArg as string);
          }
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.enqueued).toBe(true);
      expect(enqueued).toBe(true);
      expect(sentMessage).not.toBeNull();
      expect(sentMessage!.webhookId).toMatch(/^reconcile:.*:manual:\d+:companies$/);
    });

    it("enqueues with manual webhookId format", async () => {
      let sentMessage: ReconcileMessage | null = null;

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          const jsonArg = values.find((v) => typeof v === "string" && v.includes("RECONCILE"));
          if (jsonArg) {
            sentMessage = JSON.parse(jsonArg as string);
          }
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(sentMessage).not.toBeNull();
      expect(sentMessage!.webhookId).toMatch(/^reconcile:test\.myshopify\.com:manual:\d+:companies$/);
    });

    it("logs use shopHash, no domain or webhookId", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");

      expect(allLogs).toContain('"shopHash":');
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain("webhookId");

      consoleSpy.mockRestore();
    });
  });

  describe("canStartSync", () => {
    it("returns true for not_started", async () => {
      const { canStartSync } = await import("../initial-sync.server");
      expect(canStartSync("not_started")).toBe(true);
    });

    it("returns true for failed", async () => {
      const { canStartSync } = await import("../initial-sync.server");
      expect(canStartSync("failed")).toBe(true);
    });

    it("returns false for in_progress", async () => {
      const { canStartSync } = await import("../initial-sync.server");
      expect(canStartSync("in_progress")).toBe(false);
    });

    it("returns false for done", async () => {
      const { canStartSync } = await import("../initial-sync.server");
      expect(canStartSync("done")).toBe(false);
    });
  });

  describe("message shape", () => {
    it("matches ReconcileMessage shape from reconcile.server.ts", async () => {
      let sentMessage: unknown = null;

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("pgmq.q_s6_sync") && query.includes("manual")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_bulk_operations") && query.includes("companies")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          const jsonArg = values.find((v) => typeof v === "string" && v.includes("RECONCILE"));
          if (jsonArg) {
            sentMessage = JSON.parse(jsonArg as string);
          }
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(sentMessage).not.toBeNull();
      const msg = sentMessage as ReconcileMessage;

      expect(msg.topic).toBe("RECONCILE_COMPANIES");
      expect(msg.shop).toBe("test.myshopify.com");
      expect(msg.webhookId).toMatch(/^reconcile:.*:manual:\d+:companies$/);
      expect(msg.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      expect(typeof msg.topic).toBe("string");
      expect(typeof msg.shop).toBe("string");
      expect(typeof msg.webhookId).toBe("string");
      expect(typeof msg.enqueuedAt).toBe("string");
    });
  });
});
