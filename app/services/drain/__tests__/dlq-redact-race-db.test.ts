/**
 * DB-backed deterministic test for moveToDeadLetter + deleteShop race condition.
 *
 * Problem: moveToDeadLetter previously read Shop without a lock. When a redact
 * (deleteShop) was in flight, an unsanitized DLQ row could survive.
 *
 * Fix: Add Shop FOR SHARE as the first statement in moveToDeadLetter's transaction.
 * This serializes with deleteShop's FOR UPDATE (compliance.server.ts:144) and ensures
 * moveToDeadLetter sees the shop-gone state after deleteShop commits.
 *
 * Behavior change: On covered topics (orders, companies, company_locations, bulk),
 * non-shop_not_found failures are now sanitized when the Shop row is missing or
 * uninstalledAt is set. This includes the 48h pre-redact window after uninstall.
 *
 * Test methodology:
 * - Two-connection tests with explicit gates and lock-wait detection via pg_stat_activity
 * - No sleeps - deterministic lock coordination
 * - Connection A is a STAND-IN for deleteShop's statement sequence (not the real deleteShop)
 * - Uses REAL moveToDeadLetter code
 *
 * The real leak scenario (in deleteShop's statement order per compliance.server.ts):
 * 1. deleteShop: BEGIN → SELECT Shop FOR UPDATE (line 144)
 * 2. deleteShop: DELETE FROM pgmq.q_s6_sync (line 218)
 * 3. deleteShop: DELETE FROM pgmq.q_s6_bulk (line 222)
 * 4. deleteShop: DELETE FROM pgmq.a_s6_sync (line 226)
 * 5. deleteShop: DELETE FROM pgmq.a_s6_bulk (line 230)
 * 6. deleteShop: DELETE FROM s6_dead_letter (line 238)
 * 7. [NEW MESSAGE ENQUEUED BY ANOTHER CONNECTION - after queue delete but before Shop delete]
 * 8. moveToDeadLetter (without fix): reads Shop (no lock) → sees shop still exists
 * 9. moveToDeadLetter: DELETE from queue → INSERT DLQ (unsanitized) → COMMIT
 * 10. deleteShop: DELETE FROM "Shop" (line 274) → COMMIT
 * Result: Unsanitized DLQ row survives because it was inserted AFTER deleteShop's DLQ delete.
 *
 * The fix ensures moveToDeadLetter takes FOR SHARE on Shop first (processor.server.ts:1209),
 * which blocks until deleteShop commits, then sees the shop is gone and sanitizes.
 *
 * Replay of sanitized messages: tested in dlq-sanitize-db.test.ts
 * ("already-sanitized message is skipped and archived" test using driveUntilArchived).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import type { SyncMessage } from "~/lib/pgmq.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const TEST_SUFFIX = Date.now().toString(36) + "-dlq-race";
const SHOP_DOMAIN = `test-dlq-race-${TEST_SUFFIX}.myshopify.com`;
const SHOP_ID = `shop-dlq-race-${TEST_SUFFIX}`;

describeWithDb("moveToDeadLetter + deleteShop race condition", () => {
  let sql1: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  let sql3: ReturnType<typeof postgres>;

  const createdQueueMsgIds: string[] = [];

  beforeAll(async () => {
    sql1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql3 = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${TEST_SUFFIX}%`}`;
    if (createdQueueMsgIds.length > 0) {
      const msgIdNums = createdQueueMsgIds.map(Number);
      await sql1`DELETE FROM pgmq.q_s6_sync WHERE msg_id IN ${sql1(msgIdNums)}`;
      await sql1`DELETE FROM pgmq.a_s6_sync WHERE msg_id IN ${sql1(msgIdNums)}`;
    }
    await sql1`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${TEST_SUFFIX}%`}`;
    await sql1`DELETE FROM webhook_receipts WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM "Session" WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s10b_order_refetch_null WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s6_bulk_operations WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM order_outstanding_missing WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s10b_customer_pii_fallback WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;

    const [remainingDlq] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s6_dead_letter
      WHERE message->>'webhookId' LIKE ${`%${TEST_SUFFIX}%`}
    `;
    expect(parseInt(remainingDlq.count, 10)).toBe(0);

    await sql1.end();
    await sql2.end();
    await sql3.end();
  });

  beforeEach(async () => {
    createdQueueMsgIds.length = 0;
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${TEST_SUFFIX}%`}`;
    await sql1`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${TEST_SUFFIX}%`}`;
    await sql1`DELETE FROM webhook_receipts WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM "Session" WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s10b_order_refetch_null WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s6_bulk_operations WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM order_outstanding_missing WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM s10b_customer_pii_fallback WHERE shop = ${SHOP_DOMAIN}`;
    await sql1`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
  });

  afterEach(async () => {
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${TEST_SUFFIX}%`}`;
  });

  async function waitForLockWait(
    observerSql: ReturnType<typeof postgres>,
    targetPid: number,
    timeoutMs: number = 5000
  ): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const [status] = await observerSql<[{ waiting: boolean }?]>`
        SELECT wait_event_type = 'Lock' AS waiting
        FROM pg_stat_activity
        WHERE pid = ${targetPid}
      `;
      if (status?.waiting) {
        return true;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  async function getPid(sql: ReturnType<typeof postgres>): Promise<number> {
    const [{ pid }] = await sql<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
    return pid;
  }

  function createTestMessage(suffix: string): SyncMessage {
    return {
      shop: SHOP_DOMAIN,
      topic: "ORDERS_CREATE",
      webhookId: `wh-dlq-race-${suffix}-${TEST_SUFFIX}`,
      resourceGid: `gid://shopify/Order/dlq-race-${suffix}-${TEST_SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };
  }

  describe("Race condition: message dead-lettered during shop delete is stored sanitized", () => {
    it("message enqueued after queue delete but before shop delete is sanitized (not unsanitized)", async () => {
      const now = new Date();

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now})
      `;

      const testMsg = createTestMessage("race-sanitized");
      const conn2Pid = await getPid(sql2);

      let deleteShopPassedDlqDelete = false;
      let moveToDeadLetterStarted = false;
      let moveToDeadLetterDone = false;

      const deleteShopTx = sql1.begin(async (tx) => {
        const [lockedShop] = await tx<{ id: string }[]>`
          SELECT id FROM "Shop" WHERE domain = ${SHOP_DOMAIN} FOR UPDATE
        `;
        expect(lockedShop).toBeDefined();

        await tx`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
        await tx`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_DOMAIN}`;

        deleteShopPassedDlqDelete = true;

        while (!moveToDeadLetterStarted) {
          await new Promise((r) => setTimeout(r, 5));
        }

        const isWaiting = await waitForLockWait(sql3, conn2Pid, 500);

        if (!isWaiting) {
          while (!moveToDeadLetterDone) {
            await new Promise((r) => setTimeout(r, 5));
          }
        }

        await tx`DELETE FROM "Shop" WHERE domain = ${SHOP_DOMAIN}`;
      });

      while (!deleteShopPassedDlqDelete) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const [sendResult] = await sql2<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql2.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      moveToDeadLetterStarted = true;
      const resultPromise = moveToDeadLetter(
        sql2,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5
      ).then((r) => {
        moveToDeadLetterDone = true;
        return r;
      });

      await deleteShopTx;
      const result = await resultPromise;

      expect(result).toBe(true);

      const [dlqRow] = await sql1<[{ id: number; message: { sanitized?: boolean; shop?: string; reason?: string } }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.reason).toBe("shop_row_missing");
      expect(dlqRow!.message.shop).toBeUndefined();
    });
  });

  describe("Shop state affects sanitization behavior", () => {
    it("shop exists and not uninstalled: non-shop_not_found error keeps full message", async () => {
      const now = new Date();

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now})
      `;

      const testMsg = createTestMessage("shop-exists");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const result = await moveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5
      );

      expect(result).toBe(true);

      const [dlqRow] = await sql1<[{ id: number; message: SyncMessage }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.shop).toBe(SHOP_DOMAIN);
      expect((dlqRow!.message as unknown as { sanitized?: boolean }).sanitized).toBeUndefined();
    });

    it("shop uninstalled (pre-redact window): non-shop_not_found error sanitizes with reason shop_uninstalled", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("uninstalled");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const result = await moveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5
      );

      expect(result).toBe(true);

      const [dlqRow] = await sql1<[{ id: number; message: { sanitized?: boolean; shop?: string; reason?: string; topic: string } }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.reason).toBe("shop_uninstalled");
      expect(dlqRow!.message.topic).toBe("ORDERS_CREATE");
    });

    it("shop row missing: non-shop_not_found error sanitizes with reason shop_row_missing", async () => {
      const testMsg = createTestMessage("no-shop");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const result = await moveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5
      );

      expect(result).toBe(true);

      const [dlqRow] = await sql1<[{ id: number; message: { sanitized?: boolean; shop?: string; reason?: string } }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.reason).toBe("shop_row_missing");
    });
  });

  describe("Existing shop_not_found behavior unchanged", () => {
    it("shop_not_found error sanitizes with reason shop_not_found", async () => {
      const now = new Date();

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now})
      `;

      const testMsg = createTestMessage("shop-not-found-error");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const result = await moveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "shop_not_found",
        5
      );

      expect(result).toBe(true);

      const [dlqRow] = await sql1<[{ id: number; message: { sanitized?: boolean; shop?: string; reason?: string } }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.reason).toBe("shop_not_found");
    });
  });

  describe("Sanitized row keeps exactly: topic, reason, attemptCount, timestamps, shopId (UUID)", () => {
    it("shop_uninstalled sanitization preserves shopId (UUID) and drops shop (domain)", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("exact-fields");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const result = await moveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5
      );

      expect(result).toBe(true);

      interface ExactSanitizedMessage {
        sanitized: boolean;
        reason: string;
        topic: string;
        originalMsgId: string;
        shopId?: string;
        webhookId?: string;
        resourceGid?: string;
        attemptCount: number;
        enqueuedAt?: string;
        failedAt: string;
        shop?: string;
        payload?: unknown;
      }

      const [dlqRow] = await sql1<[{ id: number; message: ExactSanitizedMessage; error: string }?]>`
        SELECT id, message, error FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      const msg = dlqRow!.message;

      expect(msg.sanitized).toBe(true);
      expect(msg.reason).toBe("shop_uninstalled");
      expect(msg.topic).toBe("ORDERS_CREATE");
      expect(msg.originalMsgId).toBe(msgId);
      expect(msg.attemptCount).toBe(5);
      expect(msg.enqueuedAt).toBe(testMsg.enqueuedAt);
      expect(typeof msg.failedAt).toBe("string");
      expect(msg.webhookId).toBe(testMsg.webhookId);
      expect(msg.resourceGid).toBe(testMsg.resourceGid);

      expect(msg.shopId).toBe(SHOP_ID);
      expect(msg.shop).toBeUndefined();
      expect(msg.payload).toBeUndefined();

      expect(dlqRow!.error).toBe("test_error");
    });

    it("shop_row_missing: sanitized row has no shopId", async () => {
      const testMsg = createTestMessage("no-shop-fields");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;
      createdQueueMsgIds.push(msgId);

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const result = await moveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        3
      );

      expect(result).toBe(true);

      const [dlqRow] = await sql1<[{ id: number; message: { shopId?: string; shop?: string; attemptCount: number; reason?: string } }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.shopId).toBeUndefined();
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.attemptCount).toBe(3);
      expect(dlqRow!.message.reason).toBe("shop_row_missing");
    });
  });
});
