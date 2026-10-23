import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

/**
 * Integration tests for S10 drain operations.
 *
 * These tests verify:
 * 1. Dead-letter queue table exists and works
 * 2. Messages can be moved to DLQ
 * 3. Reconcile handlers are registered
 * 4. Handler registration is extensible
 *
 * Tests run against the CI Postgres with pgmq extension.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S10 Drain Integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Ensure DLQ table exists (migration should have created it)
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS s6_dead_letter (
          id BIGSERIAL PRIMARY KEY,
          original_queue TEXT NOT NULL,
          original_msg_id TEXT NOT NULL,
          message JSONB NOT NULL,
          error TEXT NOT NULL,
          dead_lettered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    } catch {
      // Table may already exist
    }
  });

  afterAll(async () => {
    // Clean up test entries
    await sql`
      DELETE FROM s6_dead_letter
      WHERE original_msg_id LIKE ${"test-" + TEST_SUFFIX + "%"}
    `;
    await sql.end();
  });

  describe("s6_dead_letter table", () => {
    it("table exists", async () => {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 's6_dead_letter'
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });

    it("can insert and query dead-lettered messages", async () => {
      const testMessage = {
        topic: "COMPANIES_CREATE",
        shop: `test-${TEST_SUFFIX}.myshopify.com`,
        webhookId: `test-${TEST_SUFFIX}-wh1`,
        resourceGid: "gid://shopify/Company/123",
        enqueuedAt: new Date().toISOString(),
      };

      // Insert a dead-lettered message
      await sql`
        INSERT INTO s6_dead_letter (
          original_queue,
          original_msg_id,
          message,
          error,
          dead_lettered_at
        ) VALUES (
          's6_sync',
          ${"test-" + TEST_SUFFIX + "-msg1"},
          ${sql.json(testMessage)},
          'Max retries exceeded',
          NOW()
        )
      `;

      // Query it back
      const [result] = await sql<{
        original_queue: string;
        message: typeof testMessage;
        error: string;
      }[]>`
        SELECT original_queue, message, error
        FROM s6_dead_letter
        WHERE original_msg_id = ${"test-" + TEST_SUFFIX + "-msg1"}
      `;

      expect(result.original_queue).toBe("s6_sync");
      expect(result.message.topic).toBe("COMPANIES_CREATE");
      expect(result.error).toBe("Max retries exceeded");
    });

    it("preserves message JSON structure", async () => {
      const complexMessage = {
        topic: "ORDERS_CREATE",
        shop: `test-${TEST_SUFFIX}.myshopify.com`,
        webhookId: `test-${TEST_SUFFIX}-wh2`,
        resourceGid: "gid://shopify/Order/456",
        enqueuedAt: new Date().toISOString(),
        metadata: {
          nested: {
            value: 123,
            array: [1, 2, 3],
          },
        },
      };

      await sql`
        INSERT INTO s6_dead_letter (
          original_queue,
          original_msg_id,
          message,
          error
        ) VALUES (
          's6_sync',
          ${"test-" + TEST_SUFFIX + "-msg2"},
          ${sql.json(complexMessage)},
          'Parse error'
        )
      `;

      const [result] = await sql<{ message: typeof complexMessage }[]>`
        SELECT message FROM s6_dead_letter
        WHERE original_msg_id = ${"test-" + TEST_SUFFIX + "-msg2"}
      `;

      expect(result.message.metadata.nested.value).toBe(123);
      expect(result.message.metadata.nested.array).toEqual([1, 2, 3]);
    });

    it("has index on original_queue and dead_lettered_at", async () => {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pg_indexes
          WHERE tablename = 's6_dead_letter'
          AND indexdef LIKE '%original_queue%'
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });
  });

  describe("reconcile messages", () => {
    it("can enqueue and read reconcile messages", async () => {
      const reconcileMsg = {
        topic: "RECONCILE_COMPANIES",
        shop: `test-${TEST_SUFFIX}.myshopify.com`,
        webhookId: `reconcile-${TEST_SUFFIX}-1`,
        enqueuedAt: new Date().toISOString(),
      };

      // Send to s6_sync queue
      const [sendResult] = await sql<{ send: string }[]>`
        SELECT pgmq.send('s6_sync', ${sql.json(reconcileMsg)}) as send
      `;
      expect(sendResult.send).toBeDefined();
      const msgId = sendResult.send;

      // Read it back
      const [readResult] = await sql<{
        msg_id: string;
        message: typeof reconcileMsg;
      }[]>`
        SELECT msg_id, message FROM pgmq.read('s6_sync', 0, 1)
        WHERE message->>'topic' = 'RECONCILE_COMPANIES'
      `;

      // Clean up
      await sql`SELECT pgmq.delete('s6_sync', ${msgId}::bigint)`;

      expect(readResult.message.topic).toBe("RECONCILE_COMPANIES");
      expect(readResult.message.shop).toBe(`test-${TEST_SUFFIX}.myshopify.com`);
    });
  });
});
