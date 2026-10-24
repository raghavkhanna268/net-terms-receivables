import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Sql } from "../db-light.server";

/**
 * Tests for initial-sync.server.ts (S23-04).
 *
 * Tests verify:
 * 1. getInitialSyncState derives status correctly from s6_bulk_operations
 * 2. enqueueInitialSync idempotency (no duplicate enqueue)
 * 3. canStartSync logic
 * 4. Logs use shopHash, no PII
 */

const mockSql = Object.assign(vi.fn(), {
  unsafe: vi.fn((s) => s),
  json: vi.fn((obj) => JSON.stringify(obj)),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
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
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("not_started");
    });

    it("returns in_progress when companies operation exists without completed_at", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 0 },
          ]);
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

    it("returns in_progress when companies complete but orders not", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: new Date(), failure_count: 0 },
          ]);
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

    it("returns done when both companies and orders are completed", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: new Date(), failure_count: 0 },
            { reconcile_stage: "orders", completed_at: new Date(), failure_count: 0 },
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

    it("returns failed when failure_count >= 5", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 5 },
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

    it("returns failed when DLQ entries exist", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("failed");
    });

    it("failed takes precedence over in_progress", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_bulk_operations")) {
          return Promise.resolve([
            { reconcile_stage: "companies", completed_at: null, failure_count: 0 },
          ]);
        }
        if (query.includes("s6_dead_letter")) {
          return Promise.resolve([{ count: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { getInitialSyncState } = await import("../initial-sync.server");
      const result = await getInitialSyncState(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.status).toBe("failed");
    });
  });

  describe("enqueueInitialSync", () => {
    it("enqueues message when not already processed or queued", async () => {
      let enqueued = false;
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.send")) {
          enqueued = true;
          return Promise.resolve([{ send: "1" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.enqueued).toBe(true);
      expect(enqueued).toBe(true);
    });

    it("returns already_processed when webhook already processed", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([{ webhook_id: "existing" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("already_processed");
    });

    it("returns already_queued when message already in queue", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
          return Promise.resolve([{ msg_id: "123" }]);
        }
        return Promise.resolve([]);
      });

      const { enqueueInitialSync } = await import("../initial-sync.server");
      const result = await enqueueInitialSync(mockSql as unknown as Sql, "test.myshopify.com");

      expect(result.enqueued).toBe(false);
      expect(result.reason).toBe("already_queued");
    });

    it("logs use shopHash, not raw domain", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("s6_processed_webhooks") && query.includes("webhook_id")) {
          return Promise.resolve([]);
        }
        if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
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
      expect(allLogs).not.toContain("test");

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
});
