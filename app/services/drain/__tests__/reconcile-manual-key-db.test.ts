/**
 * DB-backed integration tests for manual key propagation in reconcile flow.
 *
 * These tests verify that manual sync (triggered from UI) uses a different
 * idempotency key than the cron path, allowing retries even after the nightly
 * reconcile has claimed the day-based key.
 *
 * Key scenarios:
 * 1. Manual run's orders webhookId is different from day key
 * 2. Redelivered manual message (same key) is deduped
 * 3. Cron path still produces day-based orders key
 * 4. End-to-end: manual run chains with non-day orders key
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

vi.mock("../admin-client.server", () => ({
  adminGraphQL: vi.fn().mockResolvedValue({
    success: true,
    data: {
      bulkOperationRunQuery: {
        bulkOperation: {
          id: "gid://shopify/BulkOperation/mock-123",
          status: "CREATED",
        },
        userErrors: [],
      },
    },
    retryable: false,
  }),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("reconcile manual key propagation (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-manual-key";
  const TEST_SHOP_ID = `shop-manual-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `manual-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`reconcile:${TEST_SHOP_DOMAIN}%`}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s6_bulk_operations WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`reconcile:${TEST_SHOP_DOMAIN}%`}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
  });

  describe("extractManualKey", () => {
    it("extracts manual key from manual webhookId", async () => {
      const { extractManualKey } = await import("../reconcile-handlers.server");

      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:manual:1729785600000:companies`;
      const result = extractManualKey(webhookId);

      expect(result).toBe("manual:1729785600000");
    });

    it("returns undefined for day-based webhookId", async () => {
      const { extractManualKey } = await import("../reconcile-handlers.server");

      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:2026-10-24:companies`;
      const result = extractManualKey(webhookId);

      expect(result).toBeUndefined();
    });

    it("extracts manual key from orders stage webhookId", async () => {
      const { extractManualKey } = await import("../reconcile-handlers.server");

      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:manual:1729785600000:orders`;
      const result = extractManualKey(webhookId);

      expect(result).toBe("manual:1729785600000");
    });
  });

  describe("getManualKeyForBulkOp", () => {
    it("returns manualKey when bulk op was triggered by manual companies run", async () => {
      const { getManualKeyForBulkOp } = await import("../reconcile-handlers.server");

      const bulkOpId = `gid://shopify/BulkOperation/manual-${TEST_SUFFIX}`;
      const manualWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:manual:1729785600000:companies`;

      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${manualWebhookId}, 'RECONCILE_COMPANIES', ${bulkOpId}, NOW())
      `;

      const result = await getManualKeyForBulkOp(sql, bulkOpId);

      expect(result).toBe("manual:1729785600000");
    });

    it("returns undefined when bulk op was triggered by cron (day-based key)", async () => {
      const { getManualKeyForBulkOp } = await import("../reconcile-handlers.server");

      const bulkOpId = `gid://shopify/BulkOperation/cron-${TEST_SUFFIX}`;
      const cronWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:2026-10-24:companies`;

      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${cronWebhookId}, 'RECONCILE_COMPANIES', ${bulkOpId}, NOW())
      `;

      const result = await getManualKeyForBulkOp(sql, bulkOpId);

      expect(result).toBeUndefined();
    });

    it("returns undefined when bulk op has no matching webhookId", async () => {
      const { getManualKeyForBulkOp } = await import("../reconcile-handlers.server");

      const bulkOpId = `gid://shopify/BulkOperation/unknown-${TEST_SUFFIX}`;

      const result = await getManualKeyForBulkOp(sql, bulkOpId);

      expect(result).toBeUndefined();
    });
  });

  describe("enqueueReconcileOrders", () => {
    it("uses manual key when provided", async () => {
      const { enqueueReconcileOrders } = await import("../reconcile-handlers.server");

      const manualKey = "manual:1729785600000";
      await enqueueReconcileOrders(sql, TEST_SHOP_DOMAIN, manualKey);

      const [queuedMsg] = await sql<{ message: { webhookId: string; manualKey?: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
        ORDER BY enqueued_at DESC
        LIMIT 1
      `;

      expect(queuedMsg).toBeDefined();
      expect(queuedMsg.message.webhookId).toBe(`reconcile:${TEST_SHOP_DOMAIN}:manual:1729785600000:orders`);
      expect(queuedMsg.message.manualKey).toBe("manual:1729785600000");
    });

    it("uses day-based key when no manual key provided (cron path)", async () => {
      const { enqueueReconcileOrders } = await import("../reconcile-handlers.server");

      await enqueueReconcileOrders(sql, TEST_SHOP_DOMAIN);

      const [queuedMsg] = await sql<{ message: { webhookId: string; manualKey?: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
        ORDER BY enqueued_at DESC
        LIMIT 1
      `;

      const today = new Date().toISOString().split("T")[0];

      expect(queuedMsg).toBeDefined();
      expect(queuedMsg.message.webhookId).toBe(`reconcile:${TEST_SHOP_DOMAIN}:${today}:orders`);
      expect(queuedMsg.message.manualKey).toBeUndefined();
    });

    it("manual and day-based keys are different for the same day", async () => {
      const { enqueueReconcileOrders } = await import("../reconcile-handlers.server");

      const manualKey = `manual:${Date.now()}`;
      await enqueueReconcileOrders(sql, TEST_SHOP_DOMAIN, manualKey);
      await enqueueReconcileOrders(sql, TEST_SHOP_DOMAIN);

      const messages = await sql<{ message: { webhookId: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
        ORDER BY enqueued_at ASC
      `;

      expect(messages).toHaveLength(2);
      expect(messages[0].message.webhookId).toContain(":manual:");
      expect(messages[1].message.webhookId).not.toContain(":manual:");
      expect(messages[0].message.webhookId).not.toBe(messages[1].message.webhookId);
    });
  });

  describe("redelivered manual message deduplication", () => {
    it("second message with same manual webhookId is deduped", async () => {
      const { getSyncHandler } = await import("../processor.server");

      const manualKey = `manual:${Date.now()}`;
      const webhookId = `reconcile:${TEST_SHOP_DOMAIN}:${manualKey}:companies`;

      const handler = getSyncHandler("RECONCILE_COMPANIES");
      expect(handler).toBeDefined();

      const message = {
        shop: TEST_SHOP_DOMAIN,
        topic: "RECONCILE_COMPANIES" as const,
        resourceGid: "not-used",
        webhookId,
        enqueuedAt: new Date().toISOString(),
        manualKey,
      };

      const result1 = await handler!(sql, message);
      expect(result1.success).toBe(true);
      expect(result1.action).toBe("created");

      const result2 = await handler!(sql, message);
      expect(result2.success).toBe(true);
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("already processed");
    });

    it("cron and manual webhookIds are processed independently", async () => {
      const { getSyncHandler } = await import("../processor.server");

      const today = new Date().toISOString().split("T")[0];
      const manualKey = `manual:${Date.now()}`;

      const cronWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:${today}:companies`;
      const manualWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:${manualKey}:companies`;

      const handler = getSyncHandler("RECONCILE_COMPANIES");
      expect(handler).toBeDefined();

      const cronMessage = {
        shop: TEST_SHOP_DOMAIN,
        topic: "RECONCILE_COMPANIES" as const,
        resourceGid: "not-used",
        webhookId: cronWebhookId,
        enqueuedAt: new Date().toISOString(),
      };

      const result1 = await handler!(sql, cronMessage);
      expect(result1.success).toBe(true);
      expect(result1.action).toBe("created");

      const manualMessage = {
        shop: TEST_SHOP_DOMAIN,
        topic: "RECONCILE_COMPANIES" as const,
        resourceGid: "not-used",
        webhookId: manualWebhookId,
        enqueuedAt: new Date().toISOString(),
        manualKey,
      };

      const result2 = await handler!(sql, manualMessage);
      expect(result2.success).toBe(true);
      expect(result2.action).toBe("created");
    });
  });

  describe("end-to-end manual run chains with non-day orders key", () => {
    it("manual companies completion enqueues orders with same manual key", async () => {
      const { getManualKeyForBulkOp, enqueueReconcileOrders } = await import(
        "../reconcile-handlers.server"
      );

      const manualKey = `manual:${Date.now()}`;
      const bulkOpId = `gid://shopify/BulkOperation/e2e-${TEST_SUFFIX}-${Date.now()}`;
      const manualWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:${manualKey}:companies`;

      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${manualWebhookId}, 'RECONCILE_COMPANIES', ${bulkOpId}, NOW())
      `;

      const lookupKey = await getManualKeyForBulkOp(sql, bulkOpId);
      expect(lookupKey).toBe(manualKey);

      await enqueueReconcileOrders(sql, TEST_SHOP_DOMAIN, lookupKey);

      const [queuedMsg] = await sql<{ message: { webhookId: string; manualKey?: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
        ORDER BY enqueued_at DESC
        LIMIT 1
      `;

      expect(queuedMsg).toBeDefined();
      expect(queuedMsg.message.webhookId).toBe(`reconcile:${TEST_SHOP_DOMAIN}:${manualKey}:orders`);
      expect(queuedMsg.message.manualKey).toBe(manualKey);
    });

    it("manual retry works even when day key is already processed", async () => {
      const { getSyncHandler } = await import("../processor.server");

      const today = new Date().toISOString().split("T")[0];
      const cronWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:${today}:orders`;

      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${cronWebhookId}, 'RECONCILE_ORDERS', 'gid://shopify/BulkOperation/cron-done', NOW())
      `;

      const manualKey = `manual:${Date.now()}`;
      const manualWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:${manualKey}:orders`;

      const handler = getSyncHandler("RECONCILE_ORDERS");
      expect(handler).toBeDefined();

      const manualMessage = {
        shop: TEST_SHOP_DOMAIN,
        topic: "RECONCILE_ORDERS" as const,
        resourceGid: "not-used",
        webhookId: manualWebhookId,
        enqueuedAt: new Date().toISOString(),
        manualKey,
      };

      const result = await handler!(sql, manualMessage);

      expect(result.success).toBe(true);
      expect(result.action).toBe("created");
    });

    it("cron companies completion enqueues orders with day key (no manual key)", async () => {
      const { getManualKeyForBulkOp, enqueueReconcileOrders } = await import(
        "../reconcile-handlers.server"
      );

      const today = new Date().toISOString().split("T")[0];
      const bulkOpId = `gid://shopify/BulkOperation/cron-e2e-${TEST_SUFFIX}`;
      const cronWebhookId = `reconcile:${TEST_SHOP_DOMAIN}:${today}:companies`;

      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${cronWebhookId}, 'RECONCILE_COMPANIES', ${bulkOpId}, NOW())
      `;

      const lookupKey = await getManualKeyForBulkOp(sql, bulkOpId);
      expect(lookupKey).toBeUndefined();

      await enqueueReconcileOrders(sql, TEST_SHOP_DOMAIN, lookupKey);

      const [queuedMsg] = await sql<{ message: { webhookId: string; manualKey?: string } }[]>`
        SELECT message FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
        ORDER BY enqueued_at DESC
        LIMIT 1
      `;

      expect(queuedMsg).toBeDefined();
      expect(queuedMsg.message.webhookId).toBe(`reconcile:${TEST_SHOP_DOMAIN}:${today}:orders`);
      expect(queuedMsg.message.manualKey).toBeUndefined();
    });
  });
});
