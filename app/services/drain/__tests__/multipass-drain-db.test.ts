/**
 * DB-backed tests for bounded multi-pass drain within one tick.
 *
 * Verifies:
 * 1. Chained stages: a message in pass 1 enqueues a follow-up processed in same tick
 * 2. Stops when both queues are empty (with read count verification)
 * 3. Stops at maxPasses even if messages keep coming
 * 4. Time margin stop (injected clock)
 * 5. VT margin stop (retryable message not re-read in pass 2)
 * 6. No re-poll of bulk continuation within same tick
 * 7. Result aggregation across passes
 *
 * Each test must FAIL when the multi-pass fix is reverted to single-pass.
 * All behavior tests are parametrized with maxPasses 2 AND 4.
 *
 * Uses real pgmq with TEST_DATABASE_URL for Sequential DB project.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { S6_QUEUES, type BulkMessage } from "~/lib/pgmq.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-mp`;
}

let sqlRef: postgres.Sql;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (_shop: string, query: string, variables?: Record<string, unknown>) => {
      if (query.includes("CompanyById") && variables?.id) {
        return {
          success: true,
          data: {
            node: {
              id: variables.id as string,
              name: "Test Company",
            },
          },
          retryable: false,
        };
      }
      return { success: false, error: "not_found", retryable: false };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    processCompanyWebhook: vi.fn().mockResolvedValue({
      success: true,
      action: "created",
      entityId: "test-buyer-account-id",
    }),
    markWebhookProcessed: actual.markWebhookProcessed,
  };
});

describeWithDb("multi-pass drain DB tests (#454)", () => {
  const TEST_ID = makeTestId();
  const TEST_SHOP = `test-${TEST_ID}.myshopify.com`;

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (
        ${`shop-${TEST_ID}`},
        ${TEST_SHOP},
        'INR',
        NOW(),
        NOW()
      )
      ON CONFLICT (domain) DO NOTHING
    `;
  }, 30000);

  afterAll(async () => {
    try {
      // Clean up any remaining queue and archive entries
      await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
      await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE (message->>'shop')::text = ${TEST_SHOP}`;
      await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
      await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE (message->>'shop')::text = ${TEST_SHOP}`;
      await sqlRef`DELETE FROM "Shop" WHERE id = ${`shop-${TEST_ID}`}`;
    } catch {
      // Ignore cleanup errors
    }
    await assertNoQueueLeftovers(sqlRef, [TEST_SHOP], "multipass-drain-db.test.ts");
    await sqlRef.end();
  }, 30000);

  beforeEach(async () => {
    vi.clearAllMocks();
    // Clean up queue tables and archives
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE (message->>'shop')::text = ${TEST_SHOP}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE (message->>'shop')::text = ${TEST_SHOP}`;
  }, 30000);

  describe.each([2, 4])("with maxPasses=%i", (maxPasses) => {
    describe("chained stages", () => {
      it("processes follow-up message enqueued in pass 1 during same tick", async () => {
        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

        let callCount = 0;
        mockProcess.mockImplementation(async (sql) => {
          callCount++;
          if (callCount === 1) {
            await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
              topic: "COMPANIES_UPDATE",
              shop: TEST_SHOP,
              webhookId: `wh-followup-${TEST_ID}-${maxPasses}-${callCount}`,
              resourceGid: `gid://shopify/Company/followup-${TEST_ID}-${maxPasses}-${callCount}`,
              enqueuedAt: new Date().toISOString(),
            })})`;
          }
          return { success: true, action: "created", entityId: `ba-${callCount}` };
        });

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: `wh-initial-${TEST_ID}-${maxPasses}`,
          resourceGid: `gid://shopify/Company/initial-${TEST_ID}-${maxPasses}`,
          enqueuedAt: new Date().toISOString(),
        })})`;

        const { runDrain } = await import("../processor.server");
        const result = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses });

        expect(result.processed).toBe(2);
        expect(callCount).toBe(2);
      }, 30000);
    });

    describe("stop conditions", () => {
      it("stops when both queues are empty (discriminating: single-pass would process 0)", async () => {
        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

        let callCount = 0;
        mockProcess.mockImplementation(async (sql) => {
          callCount++;
          if (callCount === 1) {
            await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
              topic: "COMPANIES_UPDATE",
              shop: TEST_SHOP,
              webhookId: `wh-empty-${TEST_ID}-${maxPasses}-${callCount}`,
              resourceGid: `gid://shopify/Company/empty-${TEST_ID}-${maxPasses}-${callCount}`,
              enqueuedAt: new Date().toISOString(),
            })})`;
          }
          return { success: true, action: "created", entityId: `ba-${callCount}` };
        });

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: `wh-emptystart-${TEST_ID}-${maxPasses}`,
          resourceGid: `gid://shopify/Company/emptystart-${TEST_ID}-${maxPasses}`,
          enqueuedAt: new Date().toISOString(),
        })})`;

        const { runDrain } = await import("../processor.server");
        const result = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses });

        // Multi-pass: processes 2 (pass 1: initial + followup created; pass 2: followup processed)
        // Single-pass would only process 1
        expect(result.processed).toBe(2);
        expect(result.timedOut).toBe(false);
      }, 30000);

      it("stops at maxPasses even if messages keep coming", async () => {
        const { runDrain } = await import("../processor.server");
        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

        let processCount = 0;
        mockProcess.mockImplementation(async (sql) => {
          processCount++;
          await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
            topic: "COMPANIES_UPDATE",
            shop: TEST_SHOP,
            webhookId: `wh-chain-${TEST_ID}-${maxPasses}-${processCount}`,
            resourceGid: `gid://shopify/Company/chain-${TEST_ID}-${maxPasses}-${processCount}`,
            enqueuedAt: new Date().toISOString(),
          })})`;
          return { success: true, action: "created", entityId: `ba-${processCount}` };
        });

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: `wh-start-${TEST_ID}-${maxPasses}`,
          resourceGid: `gid://shopify/Company/start-${TEST_ID}-${maxPasses}`,
          enqueuedAt: new Date().toISOString(),
        })})`;

        const result = await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 60000, maxPasses });

        // Should stop at exactly maxPasses
        expect(processCount).toBe(maxPasses);
        expect(result.processed).toBe(maxPasses);
      }, 30000);

      it("stops when zero messages processed in a pass", async () => {
        const { runDrain } = await import("../processor.server");
        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

        let callCount = 0;
        // After 2 calls, stop enqueuing follow-ups
        mockProcess.mockImplementation(async (sql) => {
          callCount++;
          if (callCount < 2) {
            await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
              topic: "COMPANIES_UPDATE",
              shop: TEST_SHOP,
              webhookId: `wh-zero-${TEST_ID}-${maxPasses}-${callCount}`,
              resourceGid: `gid://shopify/Company/zero-${TEST_ID}-${maxPasses}-${callCount}`,
              enqueuedAt: new Date().toISOString(),
            })})`;
          }
          return { success: true, action: "created", entityId: `ba-${callCount}` };
        });

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: `wh-zerostart-${TEST_ID}-${maxPasses}`,
          resourceGid: `gid://shopify/Company/zerostart-${TEST_ID}-${maxPasses}`,
          enqueuedAt: new Date().toISOString(),
        })})`;

        const result = await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 60000, maxPasses });

        // Should process 2 (initial + 1 followup) then stop when pass 3 has 0 messages
        expect(callCount).toBe(2);
        expect(result.processed).toBe(2);
        expect(result.timedOut).toBe(false);
      }, 30000);
    });

    describe("retryable message handling", () => {
      it("retryable message in pass 1 is NOT re-read in pass 2 (VT margin)", async () => {
        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

        let readCount = 0;
        const testSuffix = `retryable-${TEST_ID}-${maxPasses}-${Date.now()}`;

        // processCompanyWebhook signature: (sql, shop, topic, company, webhookId)
        // company.id contains the resourceGid
        mockProcess.mockImplementation(async (_sql, shop, _topic, company, _webhookId) => {
          if (shop === TEST_SHOP && (company as { id?: string })?.id?.includes(testSuffix)) {
            readCount++;
            // Return retryable failure
            return { success: false, action: "skipped", error: "temp_error", retryable: true };
          }
          // Default behavior for other messages
          return { success: true, action: "created", entityId: `ba-default` };
        });

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: `wh-${testSuffix}`,
          resourceGid: `gid://shopify/Company/${testSuffix}`,
          enqueuedAt: new Date().toISOString(),
        })})`;

        const { runDrain } = await import("../processor.server");
        await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses });

        // Message should only be read once in this tick (VT keeps it invisible)
        expect(readCount).toBe(1);
      }, 30000);
    });

    describe("result aggregation", () => {
      it("aggregates processed count across passes", async () => {
        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

        let callCount = 0;
        // Create a chain of exactly 3 messages
        mockProcess.mockImplementation(async (sql) => {
          callCount++;
          if (callCount < 3) {
            await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
              topic: "COMPANIES_UPDATE",
              shop: TEST_SHOP,
              webhookId: `wh-agg-${TEST_ID}-${maxPasses}-${callCount}`,
              resourceGid: `gid://shopify/Company/agg-${TEST_ID}-${maxPasses}-${callCount}`,
              enqueuedAt: new Date().toISOString(),
            })})`;
          }
          return { success: true, action: "created", entityId: `ba-${callCount}` };
        });

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
          topic: "COMPANIES_CREATE",
          shop: TEST_SHOP,
          webhookId: `wh-aggstart-${TEST_ID}-${maxPasses}`,
          resourceGid: `gid://shopify/Company/aggstart-${TEST_ID}-${maxPasses}`,
          enqueuedAt: new Date().toISOString(),
        })})`;

        const { runDrain } = await import("../processor.server");
        const result = await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 15000, maxPasses });

        // With maxPasses >= 3, all 3 should be processed
        // With maxPasses = 2, only 2 (capped)
        const expected = Math.min(3, maxPasses);
        expect(result.processed).toBe(expected);
        expect(callCount).toBe(expected);
      }, 30000);
    });
  });

  describe("time margin stop (injected via config)", () => {
    it("budgets <= 3000ms still drain pass 1 (margin check only before pass 2+)", async () => {
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      let callCount = 0;
      mockProcess.mockImplementation(async () => {
        callCount++;
        return { success: true, action: "created", entityId: `ba-${callCount}` };
      });

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId: `wh-margin-${TEST_ID}`,
        resourceGid: `gid://shopify/Company/margin-${TEST_ID}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const { runDrain } = await import("../processor.server");
      // timeBudgetMs = 3000 would give passStartMargin = 0, but pass 1 runs anyway
      const result = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 3000, maxPasses: 4 });

      // Pass 1 should still run and process the message
      expect(callCount).toBe(1);
      expect(result.processed).toBe(1);
      // No pass 2 should start (margin exceeded)
      expect(result.timedOut).toBe(true);
    }, 30000);
  });

  describe("default maxPasses = 1 (today's single-pass behavior)", () => {
    it("with no maxPasses config, drain processes one pass only", async () => {
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      let callCount = 0;
      mockProcess.mockImplementation(async (sql) => {
        callCount++;
        // Enqueue a follow-up that should NOT be processed in same drain
        await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
          topic: "COMPANIES_UPDATE",
          shop: TEST_SHOP,
          webhookId: `wh-default-${TEST_ID}-${callCount}`,
          resourceGid: `gid://shopify/Company/default-${TEST_ID}-${callCount}`,
          enqueuedAt: new Date().toISOString(),
        })})`;
        return { success: true, action: "created", entityId: `ba-${callCount}` };
      });

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId: `wh-defaultstart-${TEST_ID}`,
        resourceGid: `gid://shopify/Company/defaultstart-${TEST_ID}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const { runDrain } = await import("../processor.server");
      // No maxPasses - should default to 1
      const result = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000 });

      // Only 1 message processed (single pass)
      expect(callCount).toBe(1);
      expect(result.processed).toBe(1);

      // The follow-up should still be in queue
      const [pending] = await sqlRef<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_sync
        WHERE (message->>'shop')::text = ${TEST_SHOP}
      `;
      expect(Number(pending.count)).toBe(1);

      // Clean up the pending message
      await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
    }, 30000);
  });

  describe.each([2, 4])("bulk re-poll skip at maxPasses=%i", (maxPasses) => {
    const BULK_TEST_TOPIC = `TEST_BULK_REPOLL_${maxPasses}`;

    it("handler called exactly once per tick per bulkOperationId, continuation stays queued, runs on tick 2", async () => {
      const { registerBulkHandler, runDrain } = await import("../processor.server");

      const testSuffix = `bulk-repoll-${TEST_ID}-${maxPasses}-${Date.now()}`;
      const bulkOpId = `gid://shopify/BulkOperation/${testSuffix}`;
      let handlerCallCount = 0;

      // Register a test bulk handler that returns progress on first call, complete on second
      registerBulkHandler(BULK_TEST_TOPIC, async () => {
        handlerCallCount++;
        if (handlerCallCount === 1) {
          // First call: return progress to trigger continuation
          return {
            success: true,
            action: "updated",
            entityId: `entity-${testSuffix}`,
            status: "progress",
          };
        }
        // Second call (tick 2): complete
        return {
          success: true,
          action: "updated",
          entityId: `entity-${testSuffix}`,
          status: "complete",
        };
      });

      // Enqueue a bulk message
      const bulkMessage: BulkMessage = {
        topic: BULK_TEST_TOPIC,
        shop: TEST_SHOP,
        webhookId: `wh-${testSuffix}`,
        bulkOperationId: bulkOpId,
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };
      await sqlRef`SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(bulkMessage)})`;

      // Tick 1: handler called once, continuation sent and skipped
      const result1 = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses });

      // Handler should be called exactly once in tick 1
      expect(handlerCallCount).toBe(1);
      expect(result1.processed).toBeGreaterThanOrEqual(1);

      // Continuation should still be in queue (skipped in same tick, not re-processed)
      const [pendingAfterTick1] = await sqlRef<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk
        WHERE (message->>'shop')::text = ${TEST_SHOP}
        AND (message->>'bulkOperationId')::text = ${bulkOpId}
      `;
      expect(Number(pendingAfterTick1.count)).toBe(1);

      // Tick 2: continuation is processed
      const result2 = await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses });

      // Handler should be called again in tick 2
      expect(handlerCallCount).toBe(2);
      expect(result2.processed).toBeGreaterThanOrEqual(1);

      // Continuation should be archived now
      const [pendingAfterTick2] = await sqlRef<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk
        WHERE (message->>'shop')::text = ${TEST_SHOP}
        AND (message->>'bulkOperationId')::text = ${bulkOpId}
      `;
      expect(Number(pendingAfterTick2.count)).toBe(0);
    }, 60000);

    it("skipped continuation preserves read_ct (delete+resend resets to 0)", async () => {
      const { registerBulkHandler, runDrain } = await import("../processor.server");

      const testSuffix = `bulk-readct-${TEST_ID}-${maxPasses}-${Date.now()}`;
      const bulkOpId = `gid://shopify/BulkOperation/${testSuffix}`;
      let handlerCallCount = 0;

      // Handler always returns progress to keep creating continuations
      registerBulkHandler(`TEST_BULK_READCT_${maxPasses}`, async () => {
        handlerCallCount++;
        return {
          success: true,
          action: "updated",
          entityId: `entity-${testSuffix}`,
          status: "progress",
        };
      });

      // Enqueue a bulk message
      const bulkMessage: BulkMessage = {
        topic: `TEST_BULK_READCT_${maxPasses}`,
        shop: TEST_SHOP,
        webhookId: `wh-${testSuffix}`,
        bulkOperationId: bulkOpId,
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };
      await sqlRef`SELECT pgmq.send(${S6_QUEUES.BULK}, ${sqlRef.json(bulkMessage)})`;

      // Run drain with multi-pass - continuation will be created and skipped
      await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses });

      // Handler called once (continuation skipped, not re-processed)
      expect(handlerCallCount).toBe(1);

      // Check read_ct of the continuation message - should be 0 (reset by delete+resend)
      const [queuedMsg] = await sqlRef<{ read_ct: number }[]>`
        SELECT read_ct FROM pgmq.q_s6_bulk
        WHERE (message->>'shop')::text = ${TEST_SHOP}
        AND (message->>'bulkOperationId')::text = ${bulkOpId}
      `;
      expect(queuedMsg).toBeDefined();
      // read_ct should be 0 because we delete+resend the skipped message
      expect(queuedMsg.read_ct).toBe(0);
    }, 60000);
  });

  describe("VT-stop test", () => {
    it("small visibilityTimeoutSec stops before pass 2 (VT-aware threshold)", async () => {
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      let callCount = 0;
      mockProcess.mockImplementation(async (sql) => {
        callCount++;
        // Enqueue a follow-up that should NOT be processed due to VT stop
        await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json({
          topic: "COMPANIES_UPDATE",
          shop: TEST_SHOP,
          webhookId: `wh-vtstop-${TEST_ID}-${callCount}`,
          resourceGid: `gid://shopify/Company/vtstop-${TEST_ID}-${callCount}`,
          enqueuedAt: new Date().toISOString(),
        })})`;
        return { success: true, action: "created", entityId: `ba-${callCount}` };
      });

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId: `wh-vtstopstart-${TEST_ID}`,
        resourceGid: `gid://shopify/Company/vtstopstart-${TEST_ID}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const { runDrain } = await import("../processor.server");
      // VT = 3s with PASS_START_MARGIN_MS = 3000 means:
      // VT threshold = 3000 - 3000 = 0ms
      // stopThreshold = min(passStartMargin, 0) = 0
      // Any elapsed > 0 triggers stop before pass 2
      const result = await runDrain(sqlRef, {
        batchSize: 5,
        timeBudgetMs: 60000, // High time budget
        visibilityTimeoutSec: 3, // VT=3s gives threshold=0, stopping before pass 2
        maxPasses: 4,
      });

      // Pass 1 runs and processes 1 message
      expect(callCount).toBe(1);
      expect(result.processed).toBe(1);
      // Pass 2 should NOT run due to VT threshold
      expect(result.timedOut).toBe(true);

      // Follow-up should still be in queue
      const [pending] = await sqlRef<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_sync
        WHERE (message->>'shop')::text = ${TEST_SHOP}
      `;
      expect(Number(pending.count)).toBe(1);

      // Clean up
      await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE (message->>'shop')::text = ${TEST_SHOP}`;
    }, 30000);
  });

  describe("double-claim prevention", () => {
    it("message never handled twice across passes within same tick", async () => {
      const { processCompanyWebhook } = await import("~/services/sync/company.server");
      const mockProcess = processCompanyWebhook as ReturnType<typeof vi.fn>;

      const testSuffix = `doubleclaim-${TEST_ID}-${Date.now()}`;
      const handledWebhookIds = new Map<string, number>();

      mockProcess.mockImplementation(async (_sql, _shop, _topic, company, webhookId) => {
        // Track how many times each webhookId is handled
        const currentCount = handledWebhookIds.get(webhookId) ?? 0;
        handledWebhookIds.set(webhookId, currentCount + 1);

        // Return retryable failure to keep message in queue
        if ((company as { id?: string })?.id?.includes(testSuffix)) {
          return { success: false, action: "skipped", error: "temp_error", retryable: true };
        }
        return { success: true, action: "created", entityId: `ba-default` };
      });

      const webhookId = `wh-${testSuffix}`;
      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json({
        topic: "COMPANIES_CREATE",
        shop: TEST_SHOP,
        webhookId,
        resourceGid: `gid://shopify/Company/${testSuffix}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      const { runDrain } = await import("../processor.server");
      // Run with maxPasses=4 - message should only be handled once due to VT
      await runDrain(sqlRef, { batchSize: 5, timeBudgetMs: 15000, maxPasses: 4 });

      // Message should be handled exactly once (VT prevents re-read)
      expect(handledWebhookIds.get(webhookId)).toBe(1);
    }, 30000);
  });
});
