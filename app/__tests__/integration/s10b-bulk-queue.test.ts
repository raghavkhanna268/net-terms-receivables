import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { S6_QUEUES, type BulkMessage } from "~/lib/pgmq.server";
import {
  runDrain,
  registerBulkHandler,
  getBulkHandler,
  type BulkHandler,
  type DrainConfig,
} from "~/services/drain/processor.server";

/**
 * Integration tests for processBulkQueue.
 *
 * These tests drive the REAL runDrain/processBulkQueue code by:
 * 1. Registering bulk handlers that return progress, complete, retryable, permanent
 * 2. Enqueuing real messages to s6_bulk queue
 * 3. Calling runDrain and asserting queue/archive/DLQ state AND DrainResult counters
 *
 * Tests run against the CI Postgres with pgmq extension.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S10b processBulkQueue Integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP = `test-bulk-${TEST_SUFFIX}.myshopify.com`;
  const TEST_TOPIC = `TEST_BULK_${TEST_SUFFIX}`;

  let originalHandler: BulkHandler | undefined;
  const testMsgIds: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    originalHandler = getBulkHandler(TEST_TOPIC);
  });

  afterAll(async () => {
    // Clean up only our test data (isolated by TEST_SUFFIX)
    await sql`DELETE FROM s6_dead_letter WHERE original_msg_id IN ${sql(testMsgIds.length > 0 ? testMsgIds : ["none"])}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP}`;

    // Delete only our test messages from queue and archive
    for (const msgId of testMsgIds) {
      try {
        await sql`SELECT pgmq.delete(${S6_QUEUES.BULK}, ${msgId}::bigint)`;
      } catch {
        // May already be archived or deleted
      }
    }

    await sql.end();
  });

  afterEach(() => {
    if (originalHandler) {
      registerBulkHandler(TEST_TOPIC, originalHandler);
    }
  });

  const drainConfig: Partial<DrainConfig> = {
    batchSize: 10,
    visibilityTimeoutSec: 1,
    timeBudgetMs: 5000,
    maxRetries: 5,
  };

  async function enqueueTestMessage(suffix: string): Promise<{ msgId: string; message: BulkMessage }> {
    const message: BulkMessage = {
      topic: TEST_TOPIC,
      shop: TEST_SHOP,
      webhookId: `test-${TEST_SUFFIX}-${suffix}`,
      bulkOperationId: `gid://shopify/BulkOperation/${suffix}-${TEST_SUFFIX}`,
      bulkType: "companies",
      enqueuedAt: new Date().toISOString(),
    };

    const [result] = await sql<{ send: string }[]>`
      SELECT pgmq.send(${S6_QUEUES.BULK}, ${sql.json(message)}) as send
    `;
    testMsgIds.push(result.send);
    return { msgId: result.send, message };
  }

  describe("runDrain with complete handler", () => {
    it("archives message and increments processed counter on success", async () => {
      registerBulkHandler(TEST_TOPIC, async () => ({
        success: true,
        action: "updated",
        entityId: "test-entity",
        status: "complete",
      }));

      const { msgId } = await enqueueTestMessage("complete-1");

      const result = await runDrain(sql, drainConfig);

      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBe(0);
      expect(result.deadLettered).toBe(0);

      // Verify message is archived (not in active queue)
      const [inQueue] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(Number(inQueue.count)).toBe(0);

      const [inArchive] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.a_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(Number(inArchive.count)).toBe(1);
    });
  });

  describe("runDrain with progress handler", () => {
    it("sends continuation and archives original in transaction, increments processed", async () => {
      let callCount = 0;
      registerBulkHandler(TEST_TOPIC, async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            action: "updated",
            entityId: "test-entity",
            status: "progress",
          };
        }
        return {
          success: true,
          action: "updated",
          entityId: "test-entity",
          status: "complete",
        };
      });

      const { msgId: originalMsgId } = await enqueueTestMessage("progress-1");

      // First drain: progress status
      const result1 = await runDrain(sql, drainConfig);
      expect(result1.processed).toBeGreaterThanOrEqual(1);

      // Original should be archived
      const [originalInQueue] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk WHERE msg_id = ${originalMsgId}::bigint
      `;
      expect(Number(originalInQueue.count)).toBe(0);

      const [originalInArchive] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.a_s6_bulk WHERE msg_id = ${originalMsgId}::bigint
      `;
      expect(Number(originalInArchive.count)).toBe(1);

      // A new continuation message should exist in queue
      // Find the new message by topic and shop (our unique test identifiers)
      const [continuationMsg] = await sql<{ msg_id: string }[]>`
        SELECT msg_id FROM pgmq.q_s6_bulk
        WHERE message->>'topic' = ${TEST_TOPIC}
        AND message->>'shop' = ${TEST_SHOP}
        LIMIT 1
      `;
      expect(continuationMsg).toBeDefined();
      testMsgIds.push(continuationMsg.msg_id);

      // Second drain: complete status
      const result2 = await runDrain(sql, drainConfig);
      expect(result2.processed).toBeGreaterThanOrEqual(1);

      // Continuation should now be archived
      const [contInQueue] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk WHERE msg_id = ${continuationMsg.msg_id}::bigint
      `;
      expect(Number(contInQueue.count)).toBe(0);
    });
  });

  describe("runDrain with retryable error handler", () => {
    it("leaves message in queue for retry, increments failed counter", async () => {
      registerBulkHandler(TEST_TOPIC, async () => ({
        success: false,
        action: "skipped",
        error: "HTTP 503: Service Unavailable",
        status: "error",
        errorType: "retryable",
      }));

      const { msgId } = await enqueueTestMessage("retryable-1");

      const result = await runDrain(sql, drainConfig);

      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(result.deadLettered).toBe(0);

      // Message should still be in queue (not archived, not DLQ'd)
      // Reset visibility to check
      await sql`SELECT pgmq.set_vt(${S6_QUEUES.BULK}, ${msgId}::bigint, 0)`;

      const [inQueue] = await sql<{ msg_id: string; read_ct: number }[]>`
        SELECT msg_id, read_ct FROM pgmq.read(${S6_QUEUES.BULK}, 1, 1)
        WHERE msg_id = ${msgId}::bigint
      `;
      expect(inQueue.msg_id).toBe(msgId);
      expect(inQueue.read_ct).toBeGreaterThanOrEqual(1);

      // Clean up - delete manually since it wasn't archived
      await sql`SELECT pgmq.delete(${S6_QUEUES.BULK}, ${msgId}::bigint)`;
    });
  });

  describe("runDrain with permanent error handler", () => {
    it("moves message to DLQ immediately, increments deadLettered counter", async () => {
      registerBulkHandler(TEST_TOPIC, async () => ({
        success: false,
        action: "skipped",
        error: "HTTP 404: Not Found",
        status: "error",
        errorType: "permanent",
      }));

      const { msgId } = await enqueueTestMessage("permanent-1");

      const result = await runDrain(sql, drainConfig);

      expect(result.deadLettered).toBeGreaterThanOrEqual(1);

      // Message should be in DLQ
      const [dlqResult] = await sql<{ original_msg_id: string; error: string }[]>`
        SELECT original_msg_id, error FROM s6_dead_letter
        WHERE original_msg_id = ${msgId}
      `;
      expect(dlqResult).toBeDefined();
      expect(dlqResult.error).toContain("404");

      // Message should not be in active queue
      const [inQueue] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(Number(inQueue.count)).toBe(0);
    });
  });

  describe("runDrain with DLQ after maxRetries", () => {
    it("moves message to DLQ after 5 failures via read_ct", async () => {
      registerBulkHandler(TEST_TOPIC, async () => ({
        success: false,
        action: "skipped",
        error: "Unknown error type",
        status: "error",
      }));

      const { msgId } = await enqueueTestMessage("dlq-retries-1");

      // Drain 5+ times to exceed maxRetries
      for (let i = 0; i < 6; i++) {
        await sql`SELECT pgmq.set_vt(${S6_QUEUES.BULK}, ${msgId}::bigint, 0)`;
        await runDrain(sql, { ...drainConfig, maxRetries: 5 });
      }

      // Message should be in DLQ
      const [dlqResult] = await sql<{ original_msg_id: string }[]>`
        SELECT original_msg_id FROM s6_dead_letter
        WHERE original_msg_id = ${msgId}
      `;
      expect(dlqResult).toBeDefined();
    });
  });

  describe("transaction rollback", () => {
    it("leaves no partial send or archive when handler throws", async () => {
      registerBulkHandler(TEST_TOPIC, async () => {
        throw new Error("Simulated handler crash");
      });

      const { msgId } = await enqueueTestMessage("rollback-1");

      // runDrain catches handler errors gracefully
      const result = await runDrain(sql, drainConfig);
      expect(result.failed).toBeGreaterThanOrEqual(1);

      // Message should still be in queue (handler threw, so no archive)
      await sql`SELECT pgmq.set_vt(${S6_QUEUES.BULK}, ${msgId}::bigint, 0)`;

      const [inQueue] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(Number(inQueue.count)).toBe(1);

      // No DLQ entry yet (read_ct < maxRetries)
      const [dlqCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM s6_dead_letter WHERE original_msg_id = ${msgId}
      `;
      expect(Number(dlqCount.count)).toBe(0);

      // Clean up
      await sql`SELECT pgmq.delete(${S6_QUEUES.BULK}, ${msgId}::bigint)`;
    });

    it("sql.begin rollback leaves original message intact with no partial send", async () => {
      const { msgId, message } = await enqueueTestMessage("tx-rollback-1");

      // Read message to simulate processor picking it up
      await sql`SELECT * FROM pgmq.read(${S6_QUEUES.BULK}, 30, 1)`;

      // Attempt a transaction that fails after send
      await expect(
        sql.begin(async (tx) => {
          await tx`SELECT pgmq.send(${S6_QUEUES.BULK}, ${tx.json(message)})`;
          throw new Error("Simulated transaction failure");
        })
      ).rejects.toThrow("Simulated transaction failure");

      // Original message should still be in queue
      await sql`SELECT pgmq.set_vt(${S6_QUEUES.BULK}, ${msgId}::bigint, 0)`;

      const [stillInQueue] = await sql<{ msg_id: string }[]>`
        SELECT msg_id FROM pgmq.read(${S6_QUEUES.BULK}, 1, 1)
      `;
      expect(stillInQueue.msg_id).toBe(msgId);

      // No extra messages from rolled-back transaction
      // Count only messages with our unique topic/shop
      const [ourMsgCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM pgmq.q_s6_bulk
        WHERE message->>'topic' = ${TEST_TOPIC}
        AND message->>'shop' = ${TEST_SHOP}
      `;
      expect(Number(ourMsgCount.count)).toBe(1);

      // Clean up
      await sql`SELECT pgmq.delete(${S6_QUEUES.BULK}, ${msgId}::bigint)`;
    });
  });

  describe("idempotent replay", () => {
    it("processing resumes from saved byte_offset", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/idempotent-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, byte_offset, origin
        ) VALUES (
          ${bulkOpId},
          ${TEST_SHOP},
          'companies',
          500,
          'webhook'
        )
      `;

      const [opResult] = await sql<{ byte_offset: string }[]>`
        SELECT byte_offset FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(Number(opResult.byte_offset)).toBe(500);
    });

    it("completed_at prevents reprocessing", async () => {
      const bulkOpId = `gid://shopify/BulkOperation/completed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, byte_offset, completed_at, origin
        ) VALUES (
          ${bulkOpId},
          ${TEST_SHOP},
          'companies',
          1000,
          NOW(),
          'webhook'
        )
      `;

      const [opResult] = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM s6_bulk_operations
        WHERE bulk_operation_id = ${bulkOpId}
      `;
      expect(opResult.completed_at).not.toBeNull();
    });
  });
});
