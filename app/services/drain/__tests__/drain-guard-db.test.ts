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
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
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

  function findLogEntry(key: string): Record<string, unknown> | null {
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
            return JSON.parse(arg);
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

        const logEntry = findLogEntry("drain_shop_missing_deleted");
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

        const logEntry = findLogEntry("drain_shop_missing_deleted");
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
    it("drain_shop_missing_deleted contains no domain, webhookId, payload or token", async () => {
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

        const allOutput = getAllConsoleOutput().join("\n");

        expect(allOutput).not.toContain(missingDomain);
        expect(allOutput).not.toContain("myshopify.com");
        expect(allOutput).not.toContain(webhookId);
        expect(allOutput).not.toContain("sensitive-data");
        expect(allOutput).not.toContain("shpat_secret123");
        expect(allOutput).not.toContain("payload");
        expect(allOutput).not.toContain("token");

        expect(allOutput).toContain("drain_shop_missing_deleted");
      } finally {
        await cleanupTestData([missingDomain], suffix);
      }
    });
  });

  describe("Uninstalled-but-present shop", () => {
    it("sync: message for uninstalled-but-present shop goes to handler (NOT deleted by guard)", async () => {
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

        const guardLog = findLogEntry("drain_shop_missing_deleted");
        expect(guardLog).toBeNull();

        const [shopExists] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${shopId}
        `;
        expect(parseInt(shopExists.count, 10)).toBe(1);

        const [archivedOrFailed] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM (
            SELECT 1 FROM pgmq.a_s6_sync WHERE msg_id = ${msgId}::bigint
            UNION ALL
            SELECT 1 FROM pgmq.q_s6_sync WHERE msg_id = ${msgId}::bigint AND read_ct > 0
            UNION ALL
            SELECT 1 FROM s6_dead_letter WHERE original_msg_id = ${msgId}
          ) x
        `;
        expect(parseInt(archivedOrFailed.count, 10)).toBeGreaterThan(0);
      } finally {
        await cleanupTestData([uninstalledDomain], suffix);
      }
    });
  });

  describe("Near-miss domain", () => {
    it("near-miss domain (case variant) is unaffected", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-nearmiss-${suffix}.myshopify.com`;
      const nearMissDomain = `test-nearmiss-${suffix}x.myshopify.com`;
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
  });

  describe("DB error handling", () => {
    it("sync: exception log uses correct key and fields", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-err-sync-${suffix}.myshopify.com`;
      const shopId = `shop-err-sync-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;

        const webhookId = `wh-err-sync-${suffix}`;
        const message = {
          shop: existingDomain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: `gid://shopify/Order/err-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`
          INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
          VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(message)}::jsonb)
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

        const errorLog = findLogEntry("sync_message_failed");
        expect(errorLog).not.toBeNull();
        expect(errorLog!.topic).toBe("ORDERS_UPDATED");
        expect(errorLog!.queue).toBe("s6_sync");
        expect(errorLog!.errorCode).toBeDefined();
        expect(errorLog!.readCt).toBeDefined();
      } finally {
        await cleanupTestData([existingDomain], suffix);
      }
    });

    it("bulk: exception log uses correct key and fields", async () => {
      const suffix = testContext.suffix;
      const existingDomain = `test-err-bulk-${suffix}.myshopify.com`;
      const shopId = `shop-err-bulk-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${existingDomain}, 'INR', ${now}, ${now})
        `;

        const bulkOpId = `bulk-err-${suffix}`;
        const message = {
          shop: existingDomain,
          topic: "BULK_OPERATIONS_FINISH",
          bulkOperationId: bulkOpId,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`
          INSERT INTO s6_bulk_operations (
            bulk_operation_id, shop, bulk_type, started_at, origin, failure_count, chunk_size
          ) VALUES (
            ${bulkOpId}, ${existingDomain}, 'orders', NOW(), 'webhook', 0, 524288
          )
        `;

        await sqlRef`
          INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
          VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(message)}::jsonb)
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

        const errorLog = findLogEntry("bulk_message_failed");
        expect(errorLog).not.toBeNull();
        expect(errorLog!.topic).toBe("BULK_OPERATIONS_FINISH");
        expect(errorLog!.queue).toBe("s6_bulk");
        expect(errorLog!.errorCode).toBeDefined();
        expect(errorLog!.readCt).toBeDefined();
      } finally {
        await cleanupTestData([existingDomain], suffix);
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
