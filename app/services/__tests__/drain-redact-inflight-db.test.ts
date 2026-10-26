/**
 * DB-backed integration test for drain processor + shop/redact race condition (#239).
 *
 * Tests the scenario where:
 * 1. A drain worker reads messages under visibility timeout (VT)
 * 2. shop/redact runs while the worker holds those messages
 * 3. The processor then tries to dead-letter the messages
 *
 * FIX: moveToDeadLetter deletes from pgmq first, and INSERTs into s6_dead_letter
 * only if the delete returned true. Guards use FOR SHARE which serializes with
 * deleteShop's leading FOR UPDATE on the Shop row.
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

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
const C = {
  id: `shop-c-${SUFFIX}`,
  domain: `test-c-${SUFFIX}.myshopify.com`, // near-miss: different shop that exists during deleteShop
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
          const { deleteShop } = await import("~/services/compliance/compliance.server");

          // deleteShop now handles sessions and webhook_receipts internally
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
    const allDomains = [A.domain, B.domain, C.domain];

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
    await sqlRef`DELETE FROM "Shop" WHERE id IN (${A.id}, ${B.id}, ${C.id})`;

    await assertNoQueueLeftovers(sqlRef, allDomains, "drain-redact-inflight-db.test.ts (main)");

    await sqlRef.end();
  });

  beforeEach(() => {
    redactTriggered.done = false;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("leaves 0 rows for shop A, B untouched, C (near-miss) untouched, and counts deadLetterAlreadyGoneCount", async () => {
    const now = new Date();
    // Shops being redacted need uninstalledAt set, matching real Shopify behavior
    // where shop/redact arrives ~48h after uninstall
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Create shops A, B, and C (near-miss)
    // Shop A is being redacted, so set uninstalledAt
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${A.id}, ${A.domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
    `;
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${B.id}, ${B.domain}, 'INR', ${now}, ${now})
    `;
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${C.id}, ${C.domain}, 'INR', ${now}, ${now})
    `;

    await sqlRef`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + A.domain}, ${A.domain}, 'test-state', false, 'test-token')
    `;
    await sqlRef`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + B.domain}, ${B.domain}, 'test-state', false, 'test-token')
    `;

    // Shop A messages
    const syncMsgA_order = {
      shop: A.domain,
      topic: "ORDERS_UPDATED",
      webhookId: `wh-a-order-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/a-order-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };

    const syncMsgA_loc = {
      shop: A.domain,
      topic: "COMPANY_LOCATIONS_DELETE",
      webhookId: `wh-a-locdel-${SUFFIX}`,
      resourceGid: `gid://shopify/CompanyLocation/a-loc-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };

    const bulkMsgA = {
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

    // Shop B messages (delayed, won't be processed)
    const syncMsgB = {
      shop: B.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-b-order-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/b-order-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };
    const bulkMsgB = {
      shop: B.domain,
      topic: "BULK_OPERATIONS_FINISH",
      webhookId: `wh-b-bulk-${SUFFIX}`,
      bulkOperationId: `gid://shopify/BulkOperation/b-bulk-${SUFFIX}`,
      bulkType: "orders",
      enqueuedAt: now.toISOString(),
    };

    await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(syncMsgB)}, 3600)`;
    await sqlRef`SELECT pgmq.send('s6_bulk', ${sqlRef.json(bulkMsgB)}, 3600)`;

    // Shop B existing dead-letter and archive rows
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

    // Shop C (near-miss) messages
    const syncMsgC = {
      shop: C.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-c-order-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/c-order-${SUFFIX}`,
      enqueuedAt: now.toISOString(),
    };
    await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(syncMsgC)}, 3600)`;
    await sqlRef`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES ('s6_sync', ${'msg-c-dlq-' + SUFFIX}, ${sqlRef.json({ shop: C.domain, topic: 'TEST', webhookId: 'wh-c-dlq' })}::jsonb, 'test_error', ${now})
    `;

    const countsBefore_B = await getShopCounts(sqlRef, B.domain, B.id);
    const countsBefore_C = await getShopCounts(sqlRef, C.domain, C.id);
    expect(countsBefore_B.pgmq_q_s6_sync, "B sync queue before").toBeGreaterThanOrEqual(1);
    expect(countsBefore_B.pgmq_q_s6_bulk, "B bulk queue before").toBeGreaterThanOrEqual(1);
    expect(countsBefore_B.s6_dead_letter, "B dead letter before").toBe(1);
    expect(countsBefore_C.pgmq_q_s6_sync, "C sync queue before").toBeGreaterThanOrEqual(1);
    expect(countsBefore_C.s6_dead_letter, "C dead letter before").toBe(1);

    const { runDrain } = await import("~/services/drain/processor.server");

    let totalAlreadyGone = 0;
    for (let i = 0; i < 5; i++) {
      const result = await runDrain(sqlRef, { batchSize: 50, timeBudgetMs: 10000 });
      totalAlreadyGone += result.deadLetterAlreadyGoneCount;
    }

    expect(redactTriggered.done).toBe(true);

    // Shop A had two sync messages read under VT before deleteShop ran:
    // - ORDERS_UPDATED: With #239 extension, no_session + missing/uninstalled Shop
    //   is ACKed (success:true), so it tries to archive. But deleteShop already
    //   purged the queue, so pgmq.archive finds nothing. Not counted as already-gone.
    // - COMPANY_LOCATIONS_DELETE: DELETE topic doesn't have no_session check, so it
    //   fails and tries to DLQ. Since deleteShop purged q_s6_sync first,
    //   moveToDeadLetter returns false → deadLetterAlreadyGoneCount=1.
    expect(totalAlreadyGone, "deadLetterAlreadyGoneCount for shop A's leaked messages").toBe(1);

    const countsAfter_A = await getShopCounts(sqlRef, A.domain, A.id);
    expect(countsAfter_A.Shop, "Shop A should be deleted").toBe(0);
    expect(countsAfter_A.s6_dead_letter, "s6_dead_letter for shop A").toBe(0);
    expect(countsAfter_A.pgmq_q_s6_sync, "pgmq.q_s6_sync for shop A").toBe(0);
    expect(countsAfter_A.pgmq_q_s6_bulk, "pgmq.q_s6_bulk for shop A").toBe(0);
    expect(countsAfter_A.pgmq_a_s6_sync, "pgmq.a_s6_sync for shop A").toBe(0);
    expect(countsAfter_A.pgmq_a_s6_bulk, "pgmq.a_s6_bulk for shop A").toBe(0);

    const countsAfter_B = await getShopCounts(sqlRef, B.domain, B.id);
    expect(countsAfter_B.Shop, "Shop B should remain").toBe(1);
    expect(countsAfter_B.pgmq_q_s6_sync, "B sync queue unchanged").toBeGreaterThanOrEqual(1);
    expect(countsAfter_B.pgmq_q_s6_bulk, "B bulk queue unchanged").toBeGreaterThanOrEqual(1);
    expect(countsAfter_B.s6_dead_letter, "B dead letter unchanged").toBe(1);
    expect(countsAfter_B.pgmq_a_s6_sync, "B sync archive unchanged").toBe(1);

    const countsAfter_C = await getShopCounts(sqlRef, C.domain, C.id);
    expect(countsAfter_C.Shop, "Shop C (near-miss) should remain").toBe(1);
    expect(countsAfter_C.pgmq_q_s6_sync, "C sync queue unchanged").toBeGreaterThanOrEqual(1);
    expect(countsAfter_C.s6_dead_letter, "C dead letter unchanged").toBe(1);
  });
});

/**
 * Shop existence guard tests with real code paths.
 */
describeWithDb("drain guards: Shop existence check (#239)", () => {
  let sql: ReturnType<typeof postgres>;
  const GUARD_SUFFIX = Date.now().toString(36) + "-guard";
  const NO_SHOP_DOMAIN = `test-noexist-${GUARD_SUFFIX}.myshopify.com`;
  const LIVE_SHOP_ID = `shop-live-${GUARD_SUFFIX}`;
  const LIVE_SHOP_DOMAIN = `test-live-${GUARD_SUFFIX}.myshopify.com`;
  const UNINSTALLED_SHOP_ID = `shop-uninst-${GUARD_SUFFIX}`;
  const UNINSTALLED_SHOP_DOMAIN = `test-uninst-${GUARD_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create live shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${LIVE_SHOP_ID}, ${LIVE_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create uninstalled shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${UNINSTALLED_SHOP_ID}, ${UNINSTALLED_SHOP_DOMAIN}, 'INR', NOW(), NOW(), NOW())
    `;
  });

  afterAll(async () => {
    const allDomains = [NO_SHOP_DOMAIN, LIVE_SHOP_DOMAIN, UNINSTALLED_SHOP_DOMAIN];
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${GUARD_SUFFIX}%`}`;
    await sql`DELETE FROM "Shop" WHERE id IN (${LIVE_SHOP_ID}, ${UNINSTALLED_SHOP_ID})`;

    await assertNoQueueLeftovers(sql, allDomains, "drain-redact-inflight-db.test.ts (guards)");

    await sql.end();
  });

  describe("enqueueReconcileOrders", () => {
    it("returns false and does not enqueue when Shop row is missing", async () => {
      const { enqueueReconcileOrders } = await import("~/services/drain/reconcile-handlers.server");

      const result = await enqueueReconcileOrders(sql, NO_SHOP_DOMAIN);
      expect(result).toBe(false);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${NO_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
      `;
      expect(parseInt(count.count, 10)).toBe(0);
    });

    it("returns false and does not enqueue when Shop is uninstalled", async () => {
      const { enqueueReconcileOrders } = await import("~/services/drain/reconcile-handlers.server");

      const result = await enqueueReconcileOrders(sql, UNINSTALLED_SHOP_DOMAIN);
      expect(result).toBe(false);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${UNINSTALLED_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
      `;
      expect(parseInt(count.count, 10)).toBe(0);
    });

    it("returns true and enqueues when Shop exists and is not uninstalled", async () => {
      const { enqueueReconcileOrders } = await import("~/services/drain/reconcile-handlers.server");

      const result = await enqueueReconcileOrders(sql, LIVE_SHOP_DOMAIN);
      expect(result).toBe(true);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${LIVE_SHOP_DOMAIN}
          AND message->>'topic' = 'RECONCILE_ORDERS'
      `;
      expect(parseInt(count.count, 10)).toBe(1);
    });
  });

  describe("bulk progress continuation via runDrain", () => {
    it("no Shop row: drain guard deletes message (handler never runs)", async () => {
      // #239 PR1: With drain guard, messages for shops without a Shop row are
      // DELETED before reaching the handler. This is the correct behavior for
      // redacted shops - processing the message would re-create redacted data.
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const mockedProcessBulkOperation = vi.mocked(processBulkOperation);
      mockedProcessBulkOperation.mockImplementation(async () => ({
        success: true,
        action: "updated" as const,
        status: "progress" as const,
      }));

      const { runDrain } = await import("~/services/drain/processor.server");
      const { S6_QUEUES } = await import("~/lib/pgmq.server");

      const bulkMsg = {
        shop: NO_SHOP_DOMAIN,
        topic: "BULK_OPERATIONS_FINISH",
        webhookId: `wh-noshop-bulk-${GUARD_SUFFIX}`,
        bulkOperationId: `gid://shopify/BulkOperation/noshop-${GUARD_SUFFIX}`,
        bulkType: "orders",
        enqueuedAt: new Date().toISOString(),
      };

      const [sendResult] = await sql<[{ send: string }]>`
        SELECT pgmq.send(${S6_QUEUES.BULK}, ${sql.json(bulkMsg)})
      `;
      const msgId = sendResult.send;

      await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

      // Message deleted by drain guard (not in queue)
      const [queueCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${NO_SHOP_DOMAIN}
      `;
      expect(parseInt(queueCount.count, 10)).toBe(0);

      // Message NOT archived - drain guard uses pgmq.delete, not archive
      const [archiveCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(parseInt(archiveCount.count, 10)).toBe(0);

      // Handler was never called (drain guard intercepted first)
      expect(mockedProcessBulkOperation).not.toHaveBeenCalled();

      mockedProcessBulkOperation.mockRestore();
    });

    it("uninstalled Shop: no continuation sent, but archive still happens", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const mockedProcessBulkOperation = vi.mocked(processBulkOperation);
      mockedProcessBulkOperation.mockImplementation(async () => ({
        success: true,
        action: "updated" as const,
        status: "progress" as const,
      }));

      const { runDrain } = await import("~/services/drain/processor.server");
      const { S6_QUEUES } = await import("~/lib/pgmq.server");

      const bulkMsg = {
        shop: UNINSTALLED_SHOP_DOMAIN,
        topic: "BULK_OPERATIONS_FINISH",
        webhookId: `wh-uninst-bulk-${GUARD_SUFFIX}`,
        bulkOperationId: `gid://shopify/BulkOperation/uninst-${GUARD_SUFFIX}`,
        bulkType: "orders",
        enqueuedAt: new Date().toISOString(),
      };

      const [sendResult] = await sql<[{ send: string }]>`
        SELECT pgmq.send(${S6_QUEUES.BULK}, ${sql.json(bulkMsg)})
      `;
      const msgId = sendResult.send;

      await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

      // No continuation sent
      const [queueCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${UNINSTALLED_SHOP_DOMAIN}
      `;
      expect(parseInt(queueCount.count, 10)).toBe(0);

      // Message archived
      const [archiveCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(parseInt(archiveCount.count, 10)).toBe(1);

      mockedProcessBulkOperation.mockRestore();
    });

    it("live Shop: continuation IS sent, and archive happens", async () => {
      const { processBulkOperation } = await import("~/services/sync/bulk-jsonl-processor.server");
      const mockedProcessBulkOperation = vi.mocked(processBulkOperation);
      mockedProcessBulkOperation.mockImplementation(async () => ({
        success: true,
        action: "updated" as const,
        status: "progress" as const,
      }));

      const { runDrain } = await import("~/services/drain/processor.server");
      const { S6_QUEUES } = await import("~/lib/pgmq.server");

      const bulkMsg = {
        shop: LIVE_SHOP_DOMAIN,
        topic: "BULK_OPERATIONS_FINISH",
        webhookId: `wh-live-bulk-${GUARD_SUFFIX}`,
        bulkOperationId: `gid://shopify/BulkOperation/live-${GUARD_SUFFIX}`,
        bulkType: "orders",
        enqueuedAt: new Date().toISOString(),
      };

      const [sendResult] = await sql<[{ send: string }]>`
        SELECT pgmq.send(${S6_QUEUES.BULK}, ${sql.json(bulkMsg)})
      `;
      const msgId = sendResult.send;

      await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

      // Continuation sent (a new message in queue)
      const [queueCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${LIVE_SHOP_DOMAIN}
      `;
      expect(parseInt(queueCount.count, 10)).toBe(1);

      // Original message archived
      const [archiveCount] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE msg_id = ${msgId}::bigint
      `;
      expect(parseInt(archiveCount.count, 10)).toBe(1);

      mockedProcessBulkOperation.mockRestore();
    });
  });
});

/**
 * Interleaving tests with two postgres connections.
 * Tests that FOR SHARE serializes with deleteShop's FOR UPDATE.
 */
describeWithDb("drain guards: interleaving with deleteShop (#239)", () => {
  let sql1: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  const INTERLEAVE_SUFFIX = Date.now().toString(36) + "-interleave";
  const SHOP_A_ID = `shop-interleave-a-${INTERLEAVE_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-interleave-a-${INTERLEAVE_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql1`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${INTERLEAVE_SUFFIX}%`}`;
    await sql1`DELETE FROM s10b_order_refetch_null WHERE shop = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM s6_bulk_operations WHERE shop = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM order_outstanding_missing WHERE shop = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM s10b_customer_pii_fallback WHERE shop = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;

    await assertNoQueueLeftovers(sql1, [SHOP_A_DOMAIN], "drain-redact-inflight-db.test.ts (interleave)");

    await sql1.end();
    await sql2.end();
  });

  it("Case (a): guard holds FOR SHARE on installed shop, deleteShop waits then skips (reinstall guard)", async () => {
    // Create shop with uninstalledAt NULL (shop is installed / has reinstalled)
    // This tests the reinstall guard: shop/redact arrives but shop has reinstalled
    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    let guardTxDone = false;
    let deleteShopStarted = false;
    let deleteShopDone = false;

    // Connection 1: Start transaction, take FOR SHARE, send message, hold open
    // This mirrors the drain's real guard query (uninstalledAt IS NULL)
    const guardPromise = sql1.begin(async (tx) => {
      const [shopRow] = await tx<[{ id: string }?]>`
        SELECT id FROM "Shop"
        WHERE domain = ${SHOP_A_DOMAIN}
          AND "uninstalledAt" IS NULL
        FOR SHARE
      `;
      expect(shopRow).toBeDefined();

      // Send a message while holding the lock
      await tx`SELECT pgmq.send('s6_sync', ${tx.json({
        shop: SHOP_A_DOMAIN,
        topic: "RECONCILE_ORDERS",
        webhookId: `wh-interleave-${INTERLEAVE_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      })})`;

      // Wait for deleteShop to start (it should block)
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (deleteShopStarted) {
            clearInterval(check);
            resolve();
          }
        }, 50);
      });

      // Wait 300ms to verify deleteShop is blocked
      await new Promise((r) => setTimeout(r, 300));
      expect(deleteShopDone).toBe(false);

      guardTxDone = true;
      // Transaction commits here
    });

    // Wait a bit for guard to take the lock
    await new Promise((r) => setTimeout(r, 100));

    // Connection 2: Start deleteShop (should block on FOR UPDATE)
    const { deleteShop } = await import("~/services/compliance/compliance.server");
    deleteShopStarted = true;
    const deletePromise = deleteShop(sql2, SHOP_A_DOMAIN).then((result) => {
      deleteShopDone = true;
      return result;
    });

    // Wait for guard to finish
    await guardPromise;
    expect(guardTxDone).toBe(true);

    // Now deleteShop should complete - but it should SKIP because uninstalledAt IS NULL
    const deleteResult = await deletePromise;
    expect(deleteShopDone).toBe(true);
    expect(deleteResult.deleted).toBe(false);
    expect(deleteResult.skippedReinstalled).toBe(true);
    expect(deleteResult.shopId).toBe(SHOP_A_ID);

    // Shop row should still exist (not deleted)
    const [shopCount] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${SHOP_A_ID}
    `;
    expect(parseInt(shopCount.count, 10)).toBe(1);

    // The message sent during the guard should still exist (not purged)
    const [msgCount] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
    `;
    expect(parseInt(msgCount.count, 10)).toBe(1);

    // Clean up shop and message for next test
    await sql1`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
    await sql1`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;
  });

  it("Case (a2): guard sees no row for uninstalled shop, deleteShop erases", async () => {
    // Create shop with uninstalledAt set (shop was uninstalled)
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW(), ${uninstalledAt})
    `;

    // Send a message for this shop
    await sql1`SELECT pgmq.send('s6_sync', ${sql1.json({
      shop: SHOP_A_DOMAIN,
      topic: "RECONCILE_ORDERS",
      webhookId: `wh-interleave-a2-${INTERLEAVE_SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    })})`;

    // Guard query (uninstalledAt IS NULL) should NOT find this shop
    const [guardResult] = await sql1<[{ id: string }?]>`
      SELECT id FROM "Shop"
      WHERE domain = ${SHOP_A_DOMAIN}
        AND "uninstalledAt" IS NULL
      FOR SHARE
    `;
    expect(guardResult).toBeUndefined();

    // deleteShop should delete the shop (uninstalledAt is set)
    const { deleteShop } = await import("~/services/compliance/compliance.server");
    const deleteResult = await deleteShop(sql1, SHOP_A_DOMAIN);
    expect(deleteResult.deleted).toBe(true);
    expect(deleteResult.skippedReinstalled).toBe(false);
    expect(deleteResult.shopId).toBe(SHOP_A_ID);

    // Shop row should be gone
    const [shopCount] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${SHOP_A_ID}
    `;
    expect(parseInt(shopCount.count, 10)).toBe(0);

    // Message should be purged
    const [msgCount] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
    `;
    expect(parseInt(msgCount.count, 10)).toBe(0);
  });

  it("Case (b): deleteShop runs first, guard sees no row and enqueues nothing", async () => {
    // Create shop with uninstalledAt set (matches real Shopify behavior where
    // shop/redact arrives ~48h after uninstall)
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW(), ${uninstalledAt})
    `;

    // Run deleteShop first
    const { deleteShop } = await import("~/services/compliance/compliance.server");
    const deleteResult = await deleteShop(sql1, SHOP_A_DOMAIN);
    expect(deleteResult.deleted).toBe(true);

    // Now call the real enqueueReconcileOrders - it should see no shop
    const { enqueueReconcileOrders } = await import("~/services/drain/reconcile-handlers.server");
    const enqueued = await enqueueReconcileOrders(sql2, SHOP_A_DOMAIN);
    expect(enqueued).toBe(false);

    // No message should be in the queue
    const [count] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
    `;
    expect(parseInt(count.count, 10)).toBe(0);
  });
});

async function getShopCounts(
  sql: ReturnType<typeof postgres>,
  shopDomain: string,
  shopId: string
): Promise<Record<string, number>> {
  const [result] = await sql<
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
