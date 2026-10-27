/**
 * DB-backed integration tests for #239 drain guard: messages for redacted shops.
 *
 * Tests the safety argument:
 * - deleteShop purges the queues in its own transaction
 * - Any message the guard sees arrived after the redact (late old-install delivery
 *   or new-install webhook before Shop row existed)
 * - Main never processed these either, and the new install's initial sync plus
 *   the nightly reconcile cover them
 * - Deleting loses nothing that would otherwise be processed and never re-creates
 *   redacted data
 *
 * Uses REAL log.server (no mock) with console spies to verify logging.
 * Uses describeWithDb for real database integration.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";
import { S6_QUEUES } from "~/lib/pgmq.server";
import { toErrorCode } from "~/lib/log.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-dg`;
}

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (shop: string, query: string, variables?: Record<string, unknown>) => {
      if (query.includes("OrderById") && variables?.id) {
        return {
          success: true,
          data: {
            node: {
              id: variables.id as string,
              name: "#TEST-1001",
              createdAt: new Date().toISOString(),
              processedAt: null,
              cancelledAt: null,
              closedAt: null,
              displayFinancialStatus: "PENDING",
              totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
              totalOutstandingSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
              paymentTerms: {
                id: "gid://shopify/PaymentTerms/test-123",
                paymentTermsName: "Net 30",
                paymentTermsType: "NET",
                dueInDays: 30,
              },
            },
          },
          retryable: false,
        };
      }
      return {
        success: false,
        error: "no_session",
        errorCode: "no_session",
        retryable: false,
      };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
    processCompanyWebhook: actual.processCompanyWebhook,
  };
});

vi.mock("~/services/sync/bulk-jsonl-processor.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/bulk-jsonl-processor.server")>();
  return {
    ...actual,
    processBulkOperation: vi.fn().mockImplementation(async () => {
      return {
        success: false,
        error: "shop_not_found",
        errorCode: "shop_not_found",
        errorType: "permanent" as const,
      };
    }),
  };
});

describeWithDb("drain guard: messages for redacted shops (#239)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  const testContext = {
    suffix: "",
  };

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    testContext.suffix = makeTestId();

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    // Archive any leftover messages from other tests to prevent cross-test pollution
    await sqlRef`
      WITH visible AS (
        SELECT msg_id FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' NOT LIKE ${`%${testContext.suffix}%`}
      )
      SELECT pgmq.archive('s6_sync', msg_id) FROM visible WHERE msg_id IS NOT NULL
    `;
    await sqlRef`
      WITH visible AS (
        SELECT msg_id FROM pgmq.q_s6_bulk
        WHERE message->>'bulkOperationId' NOT LIKE ${`%${testContext.suffix}%`}
      )
      SELECT pgmq.archive('s6_bulk', msg_id) FROM visible WHERE msg_id IS NOT NULL
    `;
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  function _getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    return allCalls.map((args) =>
      args.map((arg: unknown) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")
    );
  }

  function findLogEntry(key: string, msgId?: string): Record<string, unknown> | null {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    for (const args of allCalls) {
      for (const arg of args) {
        if (typeof arg === "string" && arg.includes(`"event":"${key}"`)) {
          try {
            const parsed = JSON.parse(arg);
            if (msgId && parsed.msgId !== msgId) {
              continue;
            }
            return parsed;
          } catch {
            continue;
          }
        }
      }
    }
    return null;
  }

  async function cleanupTestData(domains: string[], suffix: string): Promise<void> {
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${suffix}%`}`;
    await sqlRef`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s6_bulk_operations WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM order_outstanding_missing WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s6_reconcile_stage_claims WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM webhook_receipts WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM "Session" WHERE shop IN ${sqlRef(domains)}`;
    for (const domain of domains) {
      await sqlRef`DELETE FROM "Shop" WHERE domain = ${domain}`;
    }
    await assertNoQueueLeftovers(sqlRef, domains, "drain-guard-db.test.ts");
  }

  describe("Safety argument: message enqueued AFTER shop redact", () => {
    it("sync: late message for redacted shop is DELETED by drain guard", async () => {
      const suffix = testContext.suffix;
      const redactedDomain = `test-redacted-${suffix}.myshopify.com`;
      const shopId = `shop-redacted-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${redactedDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        const { deleteShop } = await import("~/services/compliance/compliance.server");
        const deleteResult = await deleteShop(sqlRef, redactedDomain);
        expect(deleteResult.deleted).toBe(true);

        // Verify Shop row is actually gone
        const [shopCheck] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "Shop" WHERE domain = ${redactedDomain}
        `;
        expect(parseInt(shopCheck.count, 10)).toBe(0);

        const webhookId = `wh-late-sync-${suffix}`;
        const message = {
          shop: redactedDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/late-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [queueCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(queueCount.count, 10)).toBe(0);

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(archiveCount.count, 10)).toBe(0);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10)).toBe(0);

        const logEntry = findLogEntry("drain_shop_missing_deleted", msgId);
        expect(logEntry).not.toBeNull();
        expect(logEntry!.queue).toBe("sync");
        expect(logEntry!.topic).toBe("ORDERS_UPDATED");
        expect(logEntry!.msgId).toBe(msgId);
        expect(logEntry!.count).toBe(1);
        expect(Object.keys(logEntry!).sort()).toEqual(["count", "event", "msgId", "queue", "topic"]);
      } finally {
        await cleanupTestData([redactedDomain], suffix);
      }
    });

    it("bulk: late message for redacted shop is DELETED by drain guard", async () => {
      const suffix = testContext.suffix;
      const redactedDomain = `test-redacted-bulk-${suffix}.myshopify.com`;
      const shopId = `shop-redacted-bulk-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${redactedDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        const { deleteShop } = await import("~/services/compliance/compliance.server");
        const deleteResult = await deleteShop(sqlRef, redactedDomain);
        expect(deleteResult.deleted).toBe(true);

        // Verify Shop row is actually gone
        const [shopCheck] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "Shop" WHERE domain = ${redactedDomain}
        `;
        expect(parseInt(shopCheck.count, 10)).toBe(0);

        const bulkOpId = `bulk-late-${suffix}`;
        const message = {
          shop: redactedDomain,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(message)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [queueCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(queueCount.count, 10)).toBe(0);

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(archiveCount.count, 10)).toBe(0);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(dlqCount.count, 10)).toBe(0);

        const logEntry = findLogEntry("drain_shop_missing_deleted", msgId);
        expect(logEntry).not.toBeNull();
        expect(logEntry!.queue).toBe("bulk");
        expect(logEntry!.topic).toBe("BULK_OPERATIONS_FINISH");
        expect(logEntry!.msgId).toBe(msgId);
        expect(logEntry!.count).toBe(1);
        expect(Object.keys(logEntry!).sort()).toEqual(["count", "event", "msgId", "queue", "topic"]);
      } finally {
        await cleanupTestData([redactedDomain], suffix);
      }
    });
  });

  describe("Safety argument: message for EXISTING shop", () => {
    it("sync: message for existing shop is KEPT and processed normally", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-existing-${suffix}.myshopify.com`;
      const shopId = `shop-existing-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + existingDomain}, ${existingDomain}, 'test-state', false, 'test-token')
        `;

        const webhookId = `wh-existing-${suffix}`;
        const message = {
          shop: existingDomain,
          topic: "COMPANIES_DELETE",
          webhookId,
          resourceGid: `gid://shopify/Company/existing-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`
          SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(archiveCount.count, 10)).toBe(1);

        const guardLog = findLogEntry("drain_shop_missing_deleted");
        expect(guardLog).toBeNull();
      } finally {
        await cleanupTestData([existingDomain], suffix);
      }
    });
  });

  describe("Topic coverage: sync queue", () => {
    const syncTopics = [
      "COMPANIES_CREATE",
      "COMPANIES_UPDATE",
      "COMPANIES_DELETE",
      "COMPANY_LOCATIONS_CREATE",
      "COMPANY_LOCATIONS_UPDATE",
      "COMPANY_LOCATIONS_DELETE",
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "ORDERS_CANCELLED",
      "ORDERS_PAID",
      "CUSTOMERS_CREATE",
      "CUSTOMERS_UPDATE",
      "CUSTOMERS_DELETE",
      "DRAFT_ORDERS_CREATE",
      "DRAFT_ORDERS_UPDATE",
      "DRAFT_ORDERS_DELETE",
      "RECONCILE_COMPANIES",
      "RECONCILE_CUSTOMERS",
      "RECONCILE_ORDERS",
      "CREDIT_STATUS_RECOMPUTE",
      "REMINDER_SEND",
      "REMINDER_CATCHUP",
    ];

    for (const topic of syncTopics) {
      it(`${topic}: message for missing shop is DELETED`, async () => {
        const suffix = testContext.suffix;
        const missingDomain = `test-missing-${topic.toLowerCase()}-${suffix}.myshopify.com`;

        try {
          const webhookId = `wh-${topic.toLowerCase()}-${suffix}`;
          const message = {
            shop: missingDomain,
            topic,
            webhookId,
            resourceGid: `gid://shopify/Resource/${topic.toLowerCase()}-${suffix}`,
            enqueuedAt: new Date().toISOString(),
          };

          const [sendResult] = await sqlRef<[{ send: string }]>`
            SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
          `;
          const msgId = sendResult.send;

          const { runDrain } = await import("~/services/drain/processor.server");
          await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

          const [queueCount] = await sqlRef<[{ count: string }]>`
            SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
            WHERE message->>'webhookId' = ${webhookId}
          `;
          expect(parseInt(queueCount.count, 10)).toBe(0);

          const [archiveCount] = await sqlRef<[{ count: string }]>`
            SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
            WHERE message->>'webhookId' = ${webhookId}
          `;
          expect(parseInt(archiveCount.count, 10)).toBe(0);

          const [dlqCount] = await sqlRef<[{ count: string }]>`
            SELECT COUNT(*)::text as count FROM s6_dead_letter
            WHERE message->>'webhookId' = ${webhookId}
          `;
          expect(parseInt(dlqCount.count, 10)).toBe(0);

          const logEntry = findLogEntry("drain_shop_missing_deleted");
          expect(logEntry).not.toBeNull();
          expect(logEntry!.queue).toBe("sync");
          expect(logEntry!.topic).toBe(topic);
          expect(logEntry!.msgId).toBe(msgId);
          expect(logEntry!.count).toBe(1);
        } finally {
          await cleanupTestData([missingDomain], suffix);
        }
      });
    }
  });

  describe("Topic coverage: bulk queue", () => {
    it("BULK_OPERATIONS_FINISH: message for missing shop is DELETED", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-missing-bulk-${suffix}.myshopify.com`;

      try {
        const bulkOpId = `bulk-missing-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(message)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [queueCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(queueCount.count, 10)).toBe(0);

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(archiveCount.count, 10)).toBe(0);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(dlqCount.count, 10)).toBe(0);

        const logEntry = findLogEntry("drain_shop_missing_deleted");
        expect(logEntry).not.toBeNull();
        expect(logEntry!.queue).toBe("bulk");
        expect(logEntry!.topic).toBe("BULK_OPERATIONS_FINISH");
        expect(logEntry!.msgId).toBe(msgId);
        expect(logEntry!.count).toBe(1);
      } finally {
        await cleanupTestData([missingDomain], suffix);
      }
    });

    it("bulk: sanitized message is archived BEFORE guard (catches guard-before-sanitized mutation)", async () => {
      const suffix = testContext.suffix;
      const bulkOpId = `bulk-sanitized-${suffix}`;

      try {
        const message = {
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
          sanitized: true,
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(archiveCount.count, 10)).toBe(1);

        const [queueCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(queueCount.count, 10)).toBe(0);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(dlqCount.count, 10)).toBe(0);

        const skipLog = findLogEntry("drain_skip_sanitized_message");
        expect(skipLog).not.toBeNull();
        expect(skipLog!.queue).toBe("s6_bulk");
      } finally {
        await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' = ${bulkOpId}`;
        await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'bulkOperationId' = ${bulkOpId}`;
      }
    });
  });

  describe("Log field verification", () => {
    it("drain_shop_missing_deleted has EXACTLY {queue, topic, msgId, count} fields", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-fields-${suffix}.myshopify.com`;

      try {
        const webhookId = `wh-fields-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/fields-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const logEntry = findLogEntry("drain_shop_missing_deleted");
        expect(logEntry).not.toBeNull();

        const fieldKeys = Object.keys(logEntry!).filter((k) => k !== "event").sort();
        expect(fieldKeys).toEqual(["count", "msgId", "queue", "topic"]);

        expect(logEntry!.msgId).toBe(msgId);
      } finally {
        await cleanupTestData([missingDomain], suffix);
      }
    });
  });

  describe("Leak test: no PII in logs", () => {
    it("drain_shop_missing_deleted contains no domain, webhookId, payload or token (raw mock.calls)", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-leak-${suffix}.myshopify.com`;
      const webhookId = `wh-leak-secret-token-${suffix}`;

      try {
        const message = {
          shop: missingDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/leak-${suffix}`,
          enqueuedAt: new Date().toISOString(),
          payload: { secret: "sensitive-data", token: "shpat_secret123" },
        };

        await sqlRef`
          SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const allCalls = [
          ...consoleLogSpy.mock.calls,
          ...consoleInfoSpy.mock.calls,
          ...consoleWarnSpy.mock.calls,
          ...consoleErrorSpy.mock.calls,
          ...consoleDebugSpy.mock.calls,
        ];

        const drainLogCall = allCalls.find((call) => {
          const arg = call[0];
          return typeof arg === "string" && arg.includes("drain_shop_missing_deleted");
        });

        expect(drainLogCall).toBeDefined();

        const logStr = drainLogCall![0] as string;
        const logObj = JSON.parse(logStr);

        expect(Object.keys(logObj).sort()).toEqual(["count", "event", "msgId", "queue", "topic"]);

        expect(logStr).not.toContain(missingDomain);
        expect(logStr).not.toContain("myshopify.com");
        expect(logStr).not.toContain(webhookId);
        expect(logStr).not.toContain("sensitive-data");
        expect(logStr).not.toContain("shpat_secret123");
        expect(logStr).not.toContain("payload");
      } finally {
        await cleanupTestData([missingDomain], suffix);
      }
    });

    it("drain_shop_missing_deleted exact key set (fails if field added/removed)", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-keycheck-${suffix}.myshopify.com`;

      try {
        const webhookId = `wh-keycheck-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/keycheck-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`
          SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const allCalls = [
          ...consoleLogSpy.mock.calls,
          ...consoleInfoSpy.mock.calls,
        ];

        const drainLogCall = allCalls.find((call) => {
          const arg = call[0];
          return typeof arg === "string" && arg.includes("drain_shop_missing_deleted");
        });

        expect(drainLogCall).toBeDefined();

        const logObj = JSON.parse(drainLogCall![0] as string);

        expect(Object.keys(logObj).sort()).toEqual(["count", "event", "msgId", "queue", "topic"]);

        expect(logObj.event).toBe("drain_shop_missing_deleted");
        expect(logObj.queue).toMatch(/^(sync|bulk)$/);
        expect(typeof logObj.topic).toBe("string");
        expect(typeof logObj.msgId).toBe("string");
        expect(typeof logObj.count).toBe("number");
      } finally {
        await cleanupTestData([missingDomain], suffix);
      }
    });
  });

  describe("Uninstalled-but-present shop", () => {
    // #515: Uninstalled-but-present shops are now skipped BEFORE any Admin call.
    // The guard (for MISSING shops) does NOT delete the message - the new skip logic archives it.
    // This is the expected behavior: zero Admin API calls, message archived, no DLQ entry.
    it("sync: message for uninstalled-but-present shop is SKIPPED and archived (NOT deleted by guard, NOT sent to handler)", async () => {
      const suffix = testContext.suffix;
      const uninstalledDomain = `test-uninstalled-${suffix}.myshopify.com`;
      const shopId = `shop-uninstalled-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${uninstalledDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        const webhookId = `wh-uninstalled-${suffix}`;
        const message = {
          shop: uninstalledDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/uninstalled-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 1 });

        // Guard log should NOT appear (shop exists, guard is for missing shops)
        const guardLog = findLogEntry("drain_shop_missing_deleted");
        expect(guardLog).toBeNull();

        // Shop row should still exist
        const [shopExists] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${shopId}
        `;
        expect(parseInt(shopExists.count, 10)).toBe(1);

        // #515: NO DLQ entry - message is skipped before handler
        const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
          SELECT message, error FROM s6_dead_letter WHERE original_msg_id = ${msgId}
        `;
        expect(dlqRow).toBeUndefined();

        // Message should NOT be in queue
        const [notInQueue] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE msg_id = ${msgId}::bigint
        `;
        expect(parseInt(notInQueue.count, 10)).toBe(0);

        // #515: Message IS archived (skipped without Admin call)
        const [archived] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE msg_id = ${msgId}::bigint
        `;
        expect(parseInt(archived.count, 10)).toBe(1);

        // Verify the uninstalled shop skip log
        const skipLog = findLogEntry("order_webhook_uninstalled_shop_acked");
        expect(skipLog).not.toBeNull();
        expect(skipLog!.reason).toBe("shop_uninstalled");
      } finally {
        await cleanupTestData([uninstalledDomain], suffix);
      }
    });
  });

  describe("Near-miss domain", () => {
    it("suffix mismatch: similar domain is deleted (not archived)", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-nearmiss-${suffix}.myshopify.com`;
      const suffixPart = suffix + "x";
      const nearMissDomain = `test-nearmiss-${suffixPart}.myshopify.com`;
      const shopId = `shop-nearmiss-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + existingDomain}, ${existingDomain}, 'test-state', false, 'test-token')
        `;

        const existingWebhookId = `wh-existing-nearmiss-${suffix}`;
        const nearMissWebhookId = `wh-nearmiss-${suffix}`;

        const existingMessage = {
          shop: existingDomain,
          topic: "COMPANIES_DELETE",
          webhookId: existingWebhookId,
          resourceGid: `gid://shopify/Company/existing-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        const nearMissMessage = {
          shop: nearMissDomain,
          topic: "COMPANIES_DELETE",
          webhookId: nearMissWebhookId,
          resourceGid: `gid://shopify/Company/nearmiss-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(existingMessage)})`;
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(nearMissMessage)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [existingArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${existingWebhookId}
        `;
        expect(parseInt(existingArchive.count, 10)).toBe(1);

        const [nearMissDeleted] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${nearMissWebhookId}
        `;
        expect(parseInt(nearMissDeleted.count, 10)).toBe(0);

        const [nearMissArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${nearMissWebhookId}
        `;
        expect(parseInt(nearMissArchive.count, 10)).toBe(0);
      } finally {
        await cleanupTestData([existingDomain, nearMissDomain], suffix);
      }
    });

    it("upper-case variant: domain query is case-sensitive", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-casetest-${suffix}.myshopify.com`;
      const upperSuffix = suffix.toUpperCase();
      const upperDomain = `test-CASETEST-${upperSuffix}.myshopify.com`;
      const shopId = `shop-casetest-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + existingDomain}, ${existingDomain}, 'test-state', false, 'test-token')
        `;

        const existingWebhookId = `wh-existing-case-${suffix}`;
        const upperWebhookId = `wh-upper-case-${suffix}`;

        const existingMessage = {
          shop: existingDomain,
          topic: "COMPANIES_DELETE",
          webhookId: existingWebhookId,
          resourceGid: `gid://shopify/Company/existing-case-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        const upperMessage = {
          shop: upperDomain,
          topic: "COMPANIES_DELETE",
          webhookId: upperWebhookId,
          resourceGid: `gid://shopify/Company/upper-case-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(existingMessage)})`;
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(upperMessage)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [existingArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${existingWebhookId}
        `;
        expect(parseInt(existingArchive.count, 10)).toBe(1);

        const [upperDeleted] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${upperWebhookId}
        `;
        expect(parseInt(upperDeleted.count, 10)).toBe(0);

        const [upperArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${upperWebhookId}
        `;
        expect(parseInt(upperArchive.count, 10)).toBe(0);
      } finally {
        await cleanupTestData([existingDomain, upperDomain], suffix);
      }
    });

    it("underscore in message shop: exact match required (catches = to LIKE mutation)", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-underXscore-${suffix}.myshopify.com`;
      const messageShop = `test-under_score-${suffix}.myshopify.com`;
      const shopId = `shop-underscore-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + existingDomain}, ${existingDomain}, 'test-state', false, 'test-token')
        `;

        const wildcardWebhookId = `wh-wildcard-underscore-${suffix}`;
        const wildcardMessage = {
          shop: messageShop,
          topic: "COMPANIES_DELETE",
          webhookId: wildcardWebhookId,
          resourceGid: `gid://shopify/Company/wildcard-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(wildcardMessage)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [wildcardDeleted] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${wildcardWebhookId}
        `;
        expect(parseInt(wildcardDeleted.count, 10)).toBe(0);

        const [wildcardArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${wildcardWebhookId}
        `;
        expect(parseInt(wildcardArchive.count, 10)).toBe(0);
      } finally {
        await cleanupTestData([existingDomain, messageShop], suffix);
      }
    });

    it("percent in message shop: exact match required (catches = to LIKE mutation)", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-pctxyz-${suffix}.myshopify.com`;
      const messageShop = `test-pct%-${suffix}.myshopify.com`;
      const shopId = `shop-pct-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + existingDomain}, ${existingDomain}, 'test-state', false, 'test-token')
        `;

        const wildcardWebhookId = `wh-wildcard-pct-${suffix}`;
        const wildcardMessage = {
          shop: messageShop,
          topic: "COMPANIES_DELETE",
          webhookId: wildcardWebhookId,
          resourceGid: `gid://shopify/Company/wildcard-pct-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(wildcardMessage)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [wildcardDeleted] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${wildcardWebhookId}
        `;
        expect(parseInt(wildcardDeleted.count, 10)).toBe(0);

        const [wildcardArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${wildcardWebhookId}
        `;
        expect(parseInt(wildcardArchive.count, 10)).toBe(0);
      } finally {
        await cleanupTestData([existingDomain, messageShop], suffix);
      }
    });

    it("bulk: underscore in message shop: exact match required (catches = to LIKE mutation)", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-bulk-underXscore-${suffix}.myshopify.com`;
      const messageShop = `test-bulk-under_score-${suffix}.myshopify.com`;
      const shopId = `shop-bulk-underscore-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;

        const bulkOpId = `bulk-wildcard-underscore-${suffix}`;
        const wildcardMessage = {
          shop: messageShop,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(wildcardMessage)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [wildcardDeleted] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(wildcardDeleted.count, 10)).toBe(0);

        const [wildcardArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(wildcardArchive.count, 10)).toBe(0);

        const logEntry = findLogEntry("drain_shop_missing_deleted", msgId);
        expect(logEntry).not.toBeNull();
        expect(logEntry!.queue).toBe("bulk");
      } finally {
        await cleanupTestData([existingDomain, messageShop], suffix);
      }
    });

    it("bulk: percent in message shop: exact match required (catches = to LIKE mutation)", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-bulk-pctxyz-${suffix}.myshopify.com`;
      const messageShop = `test-bulk-pct%-${suffix}.myshopify.com`;
      const shopId = `shop-bulk-pct-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;

        const bulkOpId = `bulk-wildcard-pct-${suffix}`;
        const wildcardMessage = {
          shop: messageShop,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`
          SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(wildcardMessage)})
        `;
        const msgId = sendResult.send;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [wildcardDeleted] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(wildcardDeleted.count, 10)).toBe(0);

        const [wildcardArchive] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(wildcardArchive.count, 10)).toBe(0);

        const logEntry = findLogEntry("drain_shop_missing_deleted", msgId);
        expect(logEntry).not.toBeNull();
        expect(logEntry!.queue).toBe("bulk");
      } finally {
        await cleanupTestData([existingDomain, messageShop], suffix);
      }
    });
  });

  describe("DB error handling in guard", () => {
    it("sync: guard exception logs sync_message_exception with correct fields", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-guard-err-sync-${suffix}.myshopify.com`;

      try {
        const webhookId = `wh-guard-err-sync-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/guard-err-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;
        await sqlRef`UPDATE pgmq.q_s6_sync SET vt = NOW() - interval '1 second' WHERE message->>'webhookId' = ${webhookId}`;

        let callCount = 0;
        const errorOnce = new Error("Simulated DB error");
        const proxiedSql = new Proxy(sqlRef, {
          apply(target, thisArg, args) {
            const queryStr = args[0]?.raw?.join?.("") ?? "";
            if (queryStr.includes('SELECT id FROM "Shop"') && queryStr.includes("WHERE domain")) {
              callCount++;
              if (callCount === 1) {
                throw errorOnce;
              }
            }
            return Reflect.apply(target, thisArg, args);
          },
        }) as typeof sqlRef;

        const { runDrain } = await import("~/services/drain/processor.server");
        const result = await runDrain(proxiedSql, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

        expect(result.failed).toBe(1);
        expect(result.deadLettered).toBe(0);

        const errorLog = findLogEntry("sync_message_exception");
        expect(errorLog).not.toBeNull();
        expect(errorLog!.topic).toBe("ORDERS_UPDATED");
        expect(errorLog!.queue).toBe("s6_sync");
        expect(errorLog!.errorCode).toBe(toErrorCode(errorOnce));
        expect(errorLog!.readCt).toBe(1);

        const [stillInQueue] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(stillInQueue.count, 10)).toBe(1);
      } finally {
        await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'webhookId' LIKE ${`%${suffix}%`}`;
        await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'webhookId' LIKE ${`%${suffix}%`}`;
      }
    });

    it("sync: persistent guard error goes to DLQ at maxRetries", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-guard-dlq-sync-${suffix}.myshopify.com`;

      try {
        const webhookId = `wh-guard-dlq-sync-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/guard-dlq-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;
        const msgId = sendResult.send;
        for (let i = 0; i < 4; i++) {
          await sqlRef`SELECT pgmq.read(${S6_QUEUES.SYNC}, 0, 1)`;
        }
        await sqlRef`UPDATE pgmq.q_s6_sync SET vt = NOW() - interval '1 second' WHERE msg_id = ${msgId}::bigint`;

        const alwaysThrow = new Error("Persistent DB error");
        const proxiedSql = new Proxy(sqlRef, {
          apply(target, thisArg, args) {
            const queryStr = args[0]?.raw?.join?.("") ?? "";
            if (queryStr.includes('SELECT id FROM "Shop"') && queryStr.includes("WHERE domain")) {
              throw alwaysThrow;
            }
            return Reflect.apply(target, thisArg, args);
          },
        }) as typeof sqlRef;

        const { runDrain } = await import("~/services/drain/processor.server");
        const result = await runDrain(proxiedSql, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

        expect(result.deadLettered).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.processed).toBe(0);
        expect(result.deadLetterAlreadyGoneCount).toBe(0);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10)).toBe(1);

        const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
          SELECT message, error FROM s6_dead_letter WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(dlqRow).toBeDefined();
        expect(dlqRow!.message.webhookId).toBe(webhookId);
        expect(dlqRow!.error).toBe(`permanent:${toErrorCode(alwaysThrow)}`);

        const errorLog = findLogEntry("sync_message_exception");
        expect(errorLog).not.toBeNull();
        expect(errorLog!.errorCode).toBe(toErrorCode(alwaysThrow));
        expect(errorLog!.readCt).toBe(5);

        const [notInQueue] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(notInQueue.count, 10)).toBe(0);
      } finally {
        await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'webhookId' LIKE ${`%${suffix}%`}`;
        await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'webhookId' LIKE ${`%${suffix}%`}`;
        await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${suffix}%`}`;
      }
    });

    it("bulk: guard exception logs bulk_message_exception with correct fields", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-guard-err-bulk-${suffix}.myshopify.com`;

      try {
        const bulkOpId = `bulk-guard-err-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(message)})`;
        await sqlRef`UPDATE pgmq.q_s6_bulk SET vt = NOW() - interval '1 second' WHERE message->>'bulkOperationId' = ${bulkOpId}`;

        let callCount = 0;
        const errorOnce = new Error("Simulated DB error");
        const proxiedSql = new Proxy(sqlRef, {
          apply(target, thisArg, args) {
            const queryStr = args[0]?.raw?.join?.("") ?? "";
            if (queryStr.includes('SELECT id FROM "Shop"') && queryStr.includes("WHERE domain")) {
              callCount++;
              if (callCount === 1) {
                throw errorOnce;
              }
            }
            return Reflect.apply(target, thisArg, args);
          },
        }) as typeof sqlRef;

        const { runDrain } = await import("~/services/drain/processor.server");
        const result = await runDrain(proxiedSql, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

        expect(result.failed).toBe(1);
        expect(result.deadLettered).toBe(0);

        const errorLog = findLogEntry("bulk_message_exception");
        expect(errorLog).not.toBeNull();
        expect(errorLog!.topic).toBe("BULK_OPERATIONS_FINISH");
        expect(errorLog!.queue).toBe("s6_bulk");
        expect(errorLog!.errorCode).toBe(toErrorCode(errorOnce));
        expect(errorLog!.readCt).toBe(1);

        const [stillInQueue] = await sqlRef<[{ count: string; read_ct: string }?]>`
          SELECT COUNT(*)::text as count, MAX(read_ct)::text as read_ct FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(stillInQueue!.count, 10)).toBe(1);
        expect(parseInt(stillInQueue!.read_ct, 10)).toBe(1);

        const [noDlq] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(noDlq.count, 10)).toBe(0);
      } finally {
        await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' LIKE ${`%${suffix}%`}`;
        await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'bulkOperationId' LIKE ${`%${suffix}%`}`;
      }
    });

    it("bulk: persistent guard error goes to DLQ at maxRetries", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-guard-dlq-bulk-${suffix}.myshopify.com`;

      try {
        const bulkOpId = `bulk-guard-dlq-${suffix}`;
        const message = {
          shop: missingDomain,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        const [sendResult] = await sqlRef<[{ send: string }]>`SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(message)})`;
        const msgId = sendResult.send;
        for (let i = 0; i < 4; i++) {
          await sqlRef`SELECT pgmq.read(${S6_QUEUES.BULK}, 0, 1)`;
        }
        await sqlRef`UPDATE pgmq.q_s6_bulk SET vt = NOW() - interval '1 second' WHERE msg_id = ${msgId}::bigint`;

        const alwaysThrow = new Error("Persistent DB error");
        const proxiedSql = new Proxy(sqlRef, {
          apply(target, thisArg, args) {
            const queryStr = args[0]?.raw?.join?.("") ?? "";
            if (queryStr.includes('SELECT id FROM "Shop"') && queryStr.includes("WHERE domain")) {
              throw alwaysThrow;
            }
            return Reflect.apply(target, thisArg, args);
          },
        }) as typeof sqlRef;

        const { runDrain } = await import("~/services/drain/processor.server");
        const result = await runDrain(proxiedSql, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

        expect(result.deadLettered).toBe(1);
        expect(result.failed).toBe(0);
        expect(result.processed).toBe(0);
        expect(result.deadLetterAlreadyGoneCount).toBe(0);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(dlqCount.count, 10)).toBe(1);

        const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
          SELECT message, error FROM s6_dead_letter WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(dlqRow).toBeDefined();
        expect(dlqRow!.message.bulkOperationId).toBe(bulkOpId);
        expect(dlqRow!.error).toBe(`permanent:${toErrorCode(alwaysThrow)}`);

        const errorLog = findLogEntry("bulk_message_exception");
        expect(errorLog).not.toBeNull();
        expect(errorLog!.errorCode).toBe(toErrorCode(alwaysThrow));
        expect(errorLog!.readCt).toBe(5);

        const [notInQueue] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
          WHERE message->>'bulkOperationId' = ${bulkOpId}
        `;
        expect(parseInt(notInQueue.count, 10)).toBe(0);
      } finally {
        await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' LIKE ${`%${suffix}%`}`;
        await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'bulkOperationId' LIKE ${`%${suffix}%`}`;
        await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'bulkOperationId' LIKE ${`%${suffix}%`}`;
      }
    });
  });

  describe("Reconcile: shop_not_found", () => {
    it("buildReconcileMutation returns shop_not_found when Shop is absent", async () => {
      const suffix = testContext.suffix;
      const missingDomain = `test-reconcile-${suffix}.myshopify.com`;

      try {
        const { startReconcileBulkOperation } = await import("~/services/drain/reconcile-handlers.server");
        const webhookId = `reconcile:${missingDomain}:2026-10-26:customers`;

        const result = await startReconcileBulkOperation(sqlRef, missingDomain, "customers", webhookId);

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe("shop_not_found");

        const [claimCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims
          WHERE shop = ${missingDomain}
        `;
        expect(parseInt(claimCount.count, 10)).toBe(0);

        const [processedCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_processed_webhooks
          WHERE webhook_id LIKE ${`reconcile:${missingDomain}%`}
        `;
        expect(parseInt(processedCount.count, 10)).toBe(0);

        const [ordersEnqueueCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${missingDomain}
            AND message->>'topic' = 'RECONCILE_ORDERS'
        `;
        expect(parseInt(ordersEnqueueCount.count, 10)).toBe(0);
      } finally {
        await cleanupTestData([missingDomain], suffix);
      }
    });
  });
});
