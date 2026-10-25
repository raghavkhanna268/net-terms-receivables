import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for S10 reconcile functionality.
 *
 * Tests verify:
 * 1. Enqueues reconcile messages for all installed shops
 * 2. Returns 0 when no shops installed
 * 3. Enqueues RECONCILE_COMPANIES per shop (orders enqueued after completion)
 * 4. isReconcileMessage type guard works correctly
 */

// Mock pgmq
vi.mock("~/lib/pgmq.server", () => ({
  S6_QUEUES: {
    SYNC: "s6_sync",
    BULK: "s6_bulk",
  },
}));

describe("Reconcile", () => {
  let mockSql: ReturnType<typeof createMockSql>;
  let shopResults: Array<{ domain: string }>;
  let enqueuedMessages: Array<unknown>;

  function createMockSql() {
    const sqlFn = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("");

      // Handle shop query
      if (query.includes("Shop")) {
        return Promise.resolve(shopResults);
      }

      // Handle pgmq.send
      if (query.includes("pgmq.send")) {
        enqueuedMessages.push({ query });
        return Promise.resolve([{ send: "msg-" + enqueuedMessages.length }]);
      }

      return Promise.resolve([]);
    });

    const sql = Object.assign(sqlFn, {
      json: vi.fn((v: unknown) => {
        enqueuedMessages.push(v);
        return v;
      }),
    });
    return sql;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    shopResults = [];
    enqueuedMessages = [];
    mockSql = createMockSql();
  });

  describe("enqueueReconcileForAllShops", () => {
    it("returns 0 when no shops installed", async () => {
      const { enqueueReconcileForAllShops } = await import("../reconcile.server");
      shopResults = [];

      const count = await enqueueReconcileForAllShops(
        mockSql as unknown as Parameters<typeof enqueueReconcileForAllShops>[0]
      );

      expect(count).toBe(0);
    });

    it("enqueues 1 RECONCILE_COMPANIES message per shop (orders enqueued after completion)", async () => {
      const { enqueueReconcileForAllShops } = await import("../reconcile.server");
      shopResults = [
        { domain: "shop1.myshopify.com" },
        { domain: "shop2.myshopify.com" },
      ];

      const count = await enqueueReconcileForAllShops(
        mockSql as unknown as Parameters<typeof enqueueReconcileForAllShops>[0]
      );

      // 2 shops × 1 RECONCILE_COMPANIES each = 2 total
      // RECONCILE_ORDERS is enqueued after companies complete (in processor.server.ts)
      expect(count).toBe(2);
    });

    it("creates messages with RECONCILE_COMPANIES topic only", async () => {
      const { enqueueReconcileForAllShops } = await import("../reconcile.server");
      shopResults = [{ domain: "test.myshopify.com" }];
      enqueuedMessages = [];

      await enqueueReconcileForAllShops(
        mockSql as unknown as Parameters<typeof enqueueReconcileForAllShops>[0]
      );

      // Find messages with correct structure
      const messages = enqueuedMessages.filter(
        (m) => typeof m === "object" && m !== null && "topic" in m
      ) as Array<{ topic: string; shop: string }>;

      // Only RECONCILE_COMPANIES - orders are enqueued after companies complete
      expect(messages).toHaveLength(1);
      expect(messages[0].topic).toBe("RECONCILE_COMPANIES");
      expect(messages[0].shop).toBe("test.myshopify.com");
    });

    it("creates unique webhookIds for each message", async () => {
      const { enqueueReconcileForAllShops } = await import("../reconcile.server");
      shopResults = [
        { domain: "shop1.myshopify.com" },
        { domain: "shop2.myshopify.com" },
      ];
      enqueuedMessages = [];

      await enqueueReconcileForAllShops(
        mockSql as unknown as Parameters<typeof enqueueReconcileForAllShops>[0]
      );

      const messages = enqueuedMessages.filter(
        (m) => typeof m === "object" && m !== null && "webhookId" in m
      ) as Array<{ webhookId: string }>;

      const webhookIds = messages.map((m) => m.webhookId);
      const uniqueIds = new Set(webhookIds);
      expect(uniqueIds.size).toBe(webhookIds.length);
    });
  });

  describe("isReconcileMessage", () => {
    it("returns true for RECONCILE_COMPANIES topic", async () => {
      const { isReconcileMessage } = await import("../reconcile.server");

      expect(isReconcileMessage({ topic: "RECONCILE_COMPANIES" })).toBe(true);
    });

    it("returns true for RECONCILE_CUSTOMERS topic", async () => {
      const { isReconcileMessage } = await import("../reconcile.server");

      expect(isReconcileMessage({ topic: "RECONCILE_CUSTOMERS" })).toBe(true);
    });

    it("returns true for RECONCILE_ORDERS topic", async () => {
      const { isReconcileMessage } = await import("../reconcile.server");

      expect(isReconcileMessage({ topic: "RECONCILE_ORDERS" })).toBe(true);
    });

    it("returns false for other topics", async () => {
      const { isReconcileMessage } = await import("../reconcile.server");

      expect(isReconcileMessage({ topic: "COMPANIES_CREATE" })).toBe(false);
      expect(isReconcileMessage({ topic: "ORDERS_CREATE" })).toBe(false);
      expect(isReconcileMessage({ topic: "BULK_OPERATIONS_FINISH" })).toBe(false);
    });
  });
});
