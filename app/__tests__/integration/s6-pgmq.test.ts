import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

/**
 * Integration tests for S6 pgmq queue operations.
 *
 * These tests verify:
 * 1. pgmq extension is enabled and functional
 * 2. s6_sync and s6_bulk queues exist
 * 3. Messages can be sent and read from queues
 * 4. Webhook dedupe table works correctly
 *
 * Tests run against the CI Postgres with pgmq extension.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S6 pgmq Queue Operations", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36);
  const testMsgIds: string[] = [];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    // Clean up only THIS file's messages (filter by TEST_SUFFIX shop pattern)
    // Never use pgmq.purge on shared queues - other test files run in parallel
    const testShopPattern = `test-${TEST_SUFFIX}.myshopify.com`;
    try {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${testShopPattern}`;
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${testShopPattern}`;
    } catch {
      // Queues may not exist if migration hasn't run
    }
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${"test-" + TEST_SUFFIX + "%"}`;
    await sql.end();
  });

  describe("pgmq extension", () => {
    it("pgmq extension is enabled", async () => {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pg_extension WHERE extname = 'pgmq'
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });
  });

  describe("s6_sync queue", () => {
    it("queue exists", async () => {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pgmq.meta WHERE queue_name = 's6_sync'
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });

    it("can send and read messages", async () => {
      const testMessage = {
        topic: "COMPANIES_CREATE",
        shop: `test-${TEST_SUFFIX}.myshopify.com`,
        webhookId: `test-${TEST_SUFFIX}-wh1`,
        resourceGid: "gid://shopify/Company/123",
        enqueuedAt: new Date().toISOString(),
      };

      // Send message
      const [sendResult] = await sql<{ send: string }[]>`
        SELECT pgmq.send('s6_sync', ${sql.json(testMessage)}) as send
      `;
      expect(sendResult.send).toBeDefined();
      const msgId = sendResult.send;
      testMsgIds.push(msgId);

      // Read our specific message by msg_id from the queue table
      // (pgmq.read returns oldest message, not necessarily ours)
      const [readResult] = await sql<{
        msg_id: string;
        message: typeof testMessage;
      }[]>`
        SELECT msg_id, message FROM pgmq.q_s6_sync WHERE msg_id = ${msgId}::bigint
      `;
      expect(readResult).toBeDefined();
      expect(readResult.msg_id).toBe(msgId);
      expect(readResult.message.topic).toBe("COMPANIES_CREATE");
      expect(readResult.message.shop).toBe(testMessage.shop);

      // Delete message (cast to bigint to avoid function overload ambiguity)
      const [deleteResult] = await sql<{ delete: boolean }[]>`
        SELECT pgmq.delete('s6_sync', ${msgId}::bigint) as delete
      `;
      expect(deleteResult.delete).toBe(true);
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

      const [sendResult] = await sql<{ send: string }[]>`
        SELECT pgmq.send('s6_sync', ${sql.json(complexMessage)}) as send
      `;
      const msgId = sendResult.send;
      testMsgIds.push(msgId);

      // Read our specific message by msg_id from the queue table
      const [readResult] = await sql<{ message: typeof complexMessage }[]>`
        SELECT message FROM pgmq.q_s6_sync WHERE msg_id = ${msgId}::bigint
      `;

      expect(readResult.message.metadata.nested.value).toBe(123);
      expect(readResult.message.metadata.nested.array).toEqual([1, 2, 3]);

      await sql`SELECT pgmq.delete('s6_sync', ${msgId}::bigint)`;
    });
  });

  describe("s6_bulk queue", () => {
    it("queue exists", async () => {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM pgmq.meta WHERE queue_name = 's6_bulk'
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });

    it("can send bulk operation messages", async () => {
      const bulkMessage = {
        topic: "BULK_OPERATIONS_FINISH",
        shop: `test-${TEST_SUFFIX}.myshopify.com`,
        webhookId: `test-${TEST_SUFFIX}-bulk1`,
        bulkOperationId: "gid://shopify/BulkOperation/789",
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };

      const [sendResult] = await sql<{ send: string }[]>`
        SELECT pgmq.send('s6_bulk', ${sql.json(bulkMessage)}) as send
      `;
      const msgId = sendResult.send;

      // Read our specific message by msg_id from the queue table
      // (pgmq.read returns oldest message, not necessarily ours)
      const [readResult] = await sql<{
        msg_id: string;
        message: typeof bulkMessage;
      }[]>`
        SELECT msg_id, message FROM pgmq.q_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;

      expect(readResult.message.bulkType).toBe("companies");
      expect(readResult.message.bulkOperationId).toBe(bulkMessage.bulkOperationId);

      await sql`SELECT pgmq.delete('s6_bulk', ${msgId}::bigint)`;
    });
  });

  describe("s6_processed_webhooks dedupe table", () => {
    it("table exists", async () => {
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM information_schema.tables
          WHERE table_name = 's6_processed_webhooks'
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });

    it("can insert and check for duplicates", async () => {
      const webhookId = `test-${TEST_SUFFIX}-dedupe1`;

      // Insert
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid)
        VALUES (${webhookId}, 'COMPANIES_CREATE', 'gid://shopify/Company/123')
      `;

      // Check exists
      const [result] = await sql<{ exists: boolean }[]>`
        SELECT EXISTS(
          SELECT 1 FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}
        ) as exists
      `;
      expect(result.exists).toBe(true);
    });

    it("enforces unique webhook_id constraint", async () => {
      const webhookId = `test-${TEST_SUFFIX}-dedupe2`;

      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid)
        VALUES (${webhookId}, 'ORDERS_CREATE', 'gid://shopify/Order/456')
      `;

      // Second insert should fail
      await expect(
        sql`
          INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid)
          VALUES (${webhookId}, 'ORDERS_CREATE', 'gid://shopify/Order/456')
        `
      ).rejects.toThrow(/unique/i);
    });

    it("ON CONFLICT DO NOTHING works for idempotency", async () => {
      const webhookId = `test-${TEST_SUFFIX}-dedupe3`;

      // First insert
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid)
        VALUES (${webhookId}, 'COMPANY_LOCATIONS_CREATE', 'gid://shopify/CompanyLocation/789')
        ON CONFLICT (webhook_id) DO NOTHING
      `;

      // Second insert should not throw
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid)
        VALUES (${webhookId}, 'COMPANY_LOCATIONS_CREATE', 'gid://shopify/CompanyLocation/789')
        ON CONFLICT (webhook_id) DO NOTHING
      `;

      // Only one row should exist
      const [result] = await sql<{ count: string }[]>`
        SELECT COUNT(*) as count FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}
      `;
      expect(Number(result.count)).toBe(1);
    });
  });
});
