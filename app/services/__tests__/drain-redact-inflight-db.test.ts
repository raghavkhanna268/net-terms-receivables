/**
 * DB-backed integration test for drain processor + shop/redact race condition (#239).
 *
 * Tests the scenario where:
 * 1. A drain worker reads messages under visibility timeout (VT)
 * 2. shop/redact runs while the worker holds those messages
 * 3. The processor then tries to dead-letter the messages
 *
 * BUG: On main, moveToDeadLetter INSERTs into s6_dead_letter first and only then
 * calls pgmq.delete. If the redact already deleted the queue row, the INSERT
 * re-creates the shop's data after the redact cleaned it up.
 *
 * FIX: moveToDeadLetter should delete from pgmq first, and INSERT into
 * s6_dead_letter only if the delete returned true.
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36) + "-drain-inflight";

const A = {
  id: `shop-a-${SUFFIX}`,
  domain: `test-a-${SUFFIX}.myshopify.com`,
};
const B = {
  id: `shop-b-${SUFFIX}`,
  domain: `test-b-${SUFFIX}.myshopify.com`,
};

let sqlRef: ReturnType<typeof postgres>;

const redactTriggered = { done: false };

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (shop: string) => {
      if (shop === A.domain) {
        return {
          success: false,
          error: "no_session",
          errorCode: "no_session",
          retryable: false,
        };
      }
      return { success: true, data: { node: null } };
    }),
  };
});

vi.mock("~/services/sync/bulk-jsonl-processor.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/bulk-jsonl-processor.server")>();
  return {
    ...actual,
    processBulkOperation: vi.fn().mockImplementation(async (_sql: unknown, message: { shop: string }) => {
      if (message.shop === A.domain) {
        return {
          success: false,
          error: "shop_not_found",
          errorCode: "shop_not_found",
          errorType: "permanent" as const,
        };
      }
      return { success: true, action: "skipped" };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockImplementation(
      async (sql: unknown, webhookId: string, shop: string) => {
        if (shop === A.domain && !redactTriggered.done) {
          redactTriggered.done = true;
          const { LightSessionStorage } = await import("~/lib/session-storage-light.server");
          const { deleteWebhookReceiptsForShop } = await import("~/lib/webhook-receipts.server");
          const { deleteShop } = await import("~/services/compliance/compliance.server");

          await new LightSessionStorage(sqlRef).deleteAllForShop(A.domain);
          await deleteWebhookReceiptsForShop(sqlRef, A.domain);
          await deleteShop(sqlRef, A.domain);
        }
        return (actual.isWebhookProcessed as typeof actual.isWebhookProcessed)(
          sql as Parameters<typeof actual.isWebhookProcessed>[0],
          webhookId,
          shop
        );
      }
    ),
    markWebhookProcessed: actual.markWebhookProcessed,
    processCompanyWebhook: actual.processCompanyWebhook,
  };
});

describeWithDb("drain: in-flight message for a redacted shop (#239)", () => {
  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    const allDomains = [A.domain, B.domain];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_bulk_operations WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM order_outstanding_missing WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM webhook_receipts WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM "Session" WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM "Shop" WHERE id IN (${A.id}, ${B.id})`;

    await sqlRef.end();
  });

  beforeEach(() => {
    redactTriggered.done = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("leaves 0 rows for shop A everywhere and B untouched after drain processes in-flight messages during redact", async () => {
    const now = new Date();

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${A.id}, ${A.domain}, 'INR', ${now}, ${now})
    `;
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${B.id}, ${B.domain}, 'INR', ${now}, ${now})
    `;

    await sqlRef`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + A.domain}, ${A.domain}, 'test-state', false, 'test-token')
    `;
    await sqlRef`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + B.domain}, ${B.domain}, 'test-state', false, 'test-token')
    `;

    const syncMsgA_order: {
      shop: string;
      topic: string;
      webhookId: string;
      resourceGid: string;
      enqueuedAt: string;
    } = {
      shop: A.domain,
      topic: "ORDERS_UPDATED",
      webhookId: `wh-a-order-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/a-order-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };

    const syncMsgA_loc: {
      shop: string;
      topic: string;
      webhookId: string;
      resourceGid: string;
      enqueuedAt: string;
    } = {
      shop: A.domain,
      topic: "COMPANY_LOCATIONS_DELETE",
      webhookId: `wh-a-locdel-${SUFFIX}`,
      resourceGid: `gid://shopify/CompanyLocation/a-loc-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };

    const bulkMsgA: {
      shop: string;
      topic: string;
      webhookId: string;
      bulkOperationId: string;
      bulkType: string;
      enqueuedAt: string;
    } = {
      shop: A.domain,
      topic: "BULK_OPERATIONS_FINISH",
      webhookId: `wh-a-bulk-${SUFFIX}`,
      bulkOperationId: `gid://shopify/BulkOperation/a-bulk-${SUFFIX}`,
      bulkType: "orders",
      enqueuedAt: now.toISOString(),
    };

    await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(syncMsgA_order)})`;

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(syncMsgA_loc)}::jsonb)
    `;

    await sqlRef`SELECT pgmq.send('s6_bulk', ${sqlRef.json(bulkMsgA)})`;

    const syncMsgB: {
      shop: string;
      topic: string;
      webhookId: string;
      resourceGid: string;
      enqueuedAt: string;
    } = {
      shop: B.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-b-order-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/b-order-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };
    const bulkMsgB: {
      shop: string;
      topic: string;
      webhookId: string;
      bulkOperationId: string;
      bulkType: string;
      enqueuedAt: string;
    } = {
      shop: B.domain,
      topic: "BULK_OPERATIONS_FINISH",
      webhookId: `wh-b-bulk-${SUFFIX}`,
      bulkOperationId: `gid://shopify/BulkOperation/b-bulk-${SUFFIX}`,
      bulkType: "orders",
      enqueuedAt: now.toISOString(),
    };

    await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(syncMsgB)}, 3600)`;
    await sqlRef`SELECT pgmq.send('s6_bulk', ${sqlRef.json(bulkMsgB)}, 3600)`;

    await sqlRef`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES ('s6_sync', ${'msg-b-dlq-' + SUFFIX}, ${sqlRef.json({ shop: B.domain, topic: 'TEST', webhookId: 'wh-b-dlq' })}::jsonb, 'test_error', ${now})
    `;

    const [syncArchiveB] = await sqlRef<[{ send: string }]>`
      SELECT pgmq.send('s6_sync', ${sqlRef.json({ shop: B.domain, topic: 'ARCHIVED', webhookId: 'wh-b-archive-' + SUFFIX, resourceGid: 'test', enqueuedAt: now.toISOString() })})
    `;
    await sqlRef`SELECT pgmq.archive('s6_sync', ${syncArchiveB.send}::bigint)`;

    await sqlRef`
      INSERT INTO s10b_order_refetch_null (shop, day, count)
      VALUES (${B.domain}, ${now.toISOString().slice(0, 10)}::date, 5)
    `;

    const countsBefore_B = await getShopCounts(B.domain, B.id);
    expect(countsBefore_B.pgmq_q_s6_sync, "B sync queue before").toBeGreaterThanOrEqual(1);
    expect(countsBefore_B.pgmq_q_s6_bulk, "B bulk queue before").toBeGreaterThanOrEqual(1);
    expect(countsBefore_B.s6_dead_letter, "B dead letter before").toBe(1);
    expect(countsBefore_B.pgmq_a_s6_sync, "B sync archive before").toBe(1);
    expect(countsBefore_B.s10b_order_refetch_null, "B refetch null before").toBe(1);

    const { runDrain } = await import("~/services/drain/processor.server");

    for (let i = 0; i < 5; i++) {
      await runDrain(sqlRef, { batchSize: 50, timeBudgetMs: 10000 });
    }

    expect(redactTriggered.done).toBe(true);

    const countsAfter_A = await getShopCounts(A.domain, A.id);

    const dlqCountA = countsAfter_A.s6_dead_letter;
    const qSyncCountA = countsAfter_A.pgmq_q_s6_sync;
    const qBulkCountA = countsAfter_A.pgmq_q_s6_bulk;
    const aSyncCountA = countsAfter_A.pgmq_a_s6_sync;
    const aBulkCountA = countsAfter_A.pgmq_a_s6_bulk;

    expect(countsAfter_A.Shop, "Shop A should be deleted").toBe(0);

    expect(dlqCountA, "s6_dead_letter for shop A").toBe(0);
    expect(qSyncCountA, "pgmq.q_s6_sync for shop A").toBe(0);
    expect(qBulkCountA, "pgmq.q_s6_bulk for shop A").toBe(0);
    expect(aSyncCountA, "pgmq.a_s6_sync for shop A").toBe(0);
    expect(aBulkCountA, "pgmq.a_s6_bulk for shop A").toBe(0);

    const countsAfter_B = await getShopCounts(B.domain, B.id);
    expect(countsAfter_B.Shop, "Shop B should remain").toBe(1);
    expect(countsAfter_B.pgmq_q_s6_sync, "B sync queue unchanged").toBeGreaterThanOrEqual(1);
    expect(countsAfter_B.pgmq_q_s6_bulk, "B bulk queue unchanged").toBeGreaterThanOrEqual(1);
    expect(countsAfter_B.s6_dead_letter, "B dead letter unchanged").toBe(1);
    expect(countsAfter_B.pgmq_a_s6_sync, "B sync archive unchanged").toBe(1);
    expect(countsAfter_B.s10b_order_refetch_null, "B refetch null unchanged").toBe(1);
  });

  async function getShopCounts(
    shopDomain: string,
    shopId: string
  ): Promise<Record<string, number>> {
    const [result] = await sqlRef<
      [
        {
          pgmqSyncQueue: string;
          pgmqBulkQueue: string;
          pgmqSyncArchive: string;
          pgmqBulkArchive: string;
          deadLetter: string;
          refetchNull: string;
          shop: string;
        }
      ]
    >`
      SELECT
        (SELECT COUNT(*)::text FROM pgmq.q_s6_sync WHERE message->>'shop' = ${shopDomain}) as "pgmqSyncQueue",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${shopDomain}) as "pgmqBulkQueue",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_sync WHERE message->>'shop' = ${shopDomain}) as "pgmqSyncArchive",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${shopDomain}) as "pgmqBulkArchive",
        (SELECT COUNT(*)::text FROM s6_dead_letter WHERE message->>'shop' = ${shopDomain}) as "deadLetter",
        (SELECT COUNT(*)::text FROM s10b_order_refetch_null WHERE shop = ${shopDomain}) as "refetchNull",
        (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopId}) as shop
    `;

    return {
      pgmq_q_s6_sync: parseInt(result.pgmqSyncQueue, 10),
      pgmq_q_s6_bulk: parseInt(result.pgmqBulkQueue, 10),
      pgmq_a_s6_sync: parseInt(result.pgmqSyncArchive, 10),
      pgmq_a_s6_bulk: parseInt(result.pgmqBulkArchive, 10),
      s6_dead_letter: parseInt(result.deadLetter, 10),
      s10b_order_refetch_null: parseInt(result.refetchNull, 10),
      Shop: parseInt(result.shop, 10),
    };
  }
});

/**
 * Direct DB tests for the Shop existence guards (no mocks).
 * These verify that when Shop row doesn't exist, the guards prevent re-enqueue.
 */
describeWithDb("drain guards: Shop existence check (#239)", () => {
  let sql: ReturnType<typeof postgres>;
  const GUARD_SUFFIX = Date.now().toString(36) + "-guard";
  const NO_SHOP_DOMAIN = `test-noexist-${GUARD_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${NO_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${NO_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${NO_SHOP_DOMAIN}`;
    await sql.end();
  });

  it("enqueueReconcileOrders returns false and does not enqueue when Shop row is missing", async () => {
    const { enqueueReconcileOrders } = await import("~/services/drain/reconcile-handlers.server");

    const [beforeCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${NO_SHOP_DOMAIN}
        AND message->>'topic' = 'RECONCILE_ORDERS'
    `;
    expect(parseInt(beforeCount.count, 10)).toBe(0);

    const result = await enqueueReconcileOrders(sql, NO_SHOP_DOMAIN);
    expect(result).toBe(false);

    const [afterCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${NO_SHOP_DOMAIN}
        AND message->>'topic' = 'RECONCILE_ORDERS'
    `;
    expect(parseInt(afterCount.count, 10)).toBe(0);
  });

  it("bulk progress continuation: no Shop row → no continuation sent, but archive still happens", async () => {
    const now = new Date();
    const bulkMsg = {
      shop: NO_SHOP_DOMAIN,
      topic: "BULK_OPERATIONS_FINISH",
      webhookId: `wh-guard-bulk-${GUARD_SUFFIX}`,
      bulkOperationId: `gid://shopify/BulkOperation/guard-${GUARD_SUFFIX}`,
      bulkType: "orders",
      enqueuedAt: now.toISOString(),
    };

    const [sendResult] = await sql<[{ send: string }]>`
      SELECT pgmq.send('s6_bulk', ${sql.json(bulkMsg)})
    `;
    const msgId = sendResult.send;

    const [queueBefore] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk WHERE msg_id = ${msgId}::bigint
    `;
    expect(parseInt(queueBefore.count, 10)).toBe(1);

    const { S6_QUEUES } = await import("~/lib/pgmq.server");

    await sql.begin(async (tx) => {
      const [shopRow] = await tx<[{ id: string }?]>`
        SELECT id FROM "Shop" WHERE domain = ${NO_SHOP_DOMAIN} FOR SHARE
      `;
      if (shopRow) {
        await tx`SELECT pgmq.send(${S6_QUEUES.BULK}, ${tx.json(bulkMsg)})`;
      }
      await tx`SELECT pgmq.archive(${S6_QUEUES.BULK}, ${msgId}::bigint)`;
    });

    const [queueAfter] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
      WHERE message->>'shop' = ${NO_SHOP_DOMAIN}
    `;
    expect(parseInt(queueAfter.count, 10)).toBe(0);

    const [archiveAfter] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE msg_id = ${msgId}::bigint
    `;
    expect(parseInt(archiveAfter.count, 10)).toBe(1);
  });
});
