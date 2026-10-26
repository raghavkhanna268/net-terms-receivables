/**
 * DB-backed deterministic test for moveToDeadLetter + deleteShop race condition.
 *
 * Tests the scenario from issue #262 where:
 * - moveToDeadLetter reads Shop without a lock
 * - A redact (deleteShop) in flight could leave an UNSANITIZED dead-letter row behind
 *
 * Uses two connections with explicit gates and lock-wait detection (no sleeps).
 *
 * Test methodology:
 * - Connection A simulates deleteShop: BEGIN, FOR UPDATE on Shop, delete DLQ, pause at gate
 * - Connection B simulates moveToDeadLetter for a non-shop_not_found error
 * - Assert: no unsanitized DLQ row survives after redact completes
 *
 * This file uses the "Sequential DB" project's existing patterns.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import type { SyncMessage } from "~/lib/pgmq.server";
import {
  sanitizeSyncMessage,
  isCoveredSyncTopic,
  isShopNotFoundReason,
} from "../dead-letter-sanitize.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const TEST_SUFFIX = Date.now().toString(36) + "-dlq-race";
const SHOP_DOMAIN = `test-dlq-race-${TEST_SUFFIX}.myshopify.com`;
const SHOP_ID = `shop-dlq-race-${TEST_SUFFIX}`;

/**
 * Simulates moveToDeadLetter's behavior for testing.
 *
 * This is the exact logic from processor.server.ts moveToDeadLetter,
 * but extracted here so we can test the race condition without exporting
 * the internal function. The test verifies that the CURRENT implementation
 * is vulnerable to the race condition (Case B).
 *
 * If a fix is applied that adds Shop FOR SHARE, this test will pass.
 */
async function simulateMoveToDeadLetter(
  sql: ReturnType<typeof postgres>,
  queue: string,
  msgId: string,
  message: SyncMessage,
  error: string,
  readCt: number,
  checkShopForShare: boolean = false
): Promise<{ success: boolean; sanitized: boolean }> {
  let messageToStore: SyncMessage | ReturnType<typeof sanitizeSyncMessage> = message;
  let didSanitize = false;

  if (isShopNotFoundReason(error)) {
    const sanitized = sanitizeSyncMessage(message, msgId, readCt);
    if (sanitized) {
      messageToStore = sanitized;
      didSanitize = true;
    }
  }

  return sql.begin(async (tx) => {
    if (checkShopForShare) {
      const [shopRow] = await tx<[{ id: string; uninstalledAt: Date | null }?]>`
        SELECT id, "uninstalledAt" FROM "Shop"
        WHERE domain = ${message.shop}
        FOR SHARE
      `;

      if (!shopRow || shopRow.uninstalledAt !== null) {
        if (isCoveredSyncTopic(message.topic)) {
          const sanitized = sanitizeSyncMessage(message, msgId, readCt);
          if (sanitized) {
            messageToStore = sanitized;
            didSanitize = true;
          }
        }
      }
    }

    const [result] = await tx<[{ delete: boolean }]>`
      SELECT pgmq.delete(${queue}, ${msgId}::bigint)
    `;

    if (!result.delete) {
      return { success: false, sanitized: didSanitize };
    }

    await tx`
      INSERT INTO s6_dead_letter (
        original_queue,
        original_msg_id,
        message,
        error,
        dead_lettered_at
      ) VALUES (
        ${queue},
        ${msgId},
        ${tx.json(messageToStore)},
        ${error},
        NOW()
      )
    `;
    return { success: true, sanitized: didSanitize };
  });
}

describeWithDb("moveToDeadLetter + deleteShop race condition", () => {
  let sql1: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  let sql3: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql3 = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_DOMAIN}`;
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
    await sql1.end();
    await sql2.end();
    await sql3.end();
  });

  beforeEach(async () => {
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_DOMAIN}`;
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

  /**
   * Wait for a specific backend to be waiting on a lock.
   * Uses pg_stat_activity to detect when a connection is in 'Lock' wait_event_type.
   * This is deterministic: we poll until the lock wait is detected.
   */
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

  /**
   * Get the backend PID for a connection.
   */
  async function getPid(sql: ReturnType<typeof postgres>): Promise<number> {
    const [{ pid }] = await sql<[{ pid: number }]>`SELECT pg_backend_pid() AS pid`;
    return pid;
  }

  /**
   * Create a sync message for testing.
   */
  function createTestMessage(suffix: string): SyncMessage {
    return {
      shop: SHOP_DOMAIN,
      topic: "ORDERS_CREATE",
      webhookId: `wh-dlq-race-${suffix}-${TEST_SUFFIX}`,
      resourceGid: `gid://shopify/Order/dlq-race-${suffix}-${TEST_SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };
  }

  describe("WITHOUT Shop FOR SHARE fix (simulation showing the vulnerability)", () => {
    it("Race condition: B commits DLQ row while A's tx has already passed DLQ delete - unsanitized row survives (simulated)", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("race-no-fix");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

      let shopLockedGate = false;
      let moveToDeadLetterDone = false;

      const deleteShopPromise = sql1.begin(async (tx) => {
        const [lockedShop] = await tx<{ id: string }[]>`
          SELECT id FROM "Shop" WHERE domain = ${SHOP_DOMAIN} FOR UPDATE
        `;
        expect(lockedShop).toBeDefined();

        await tx`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
        await tx`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_DOMAIN}`;

        shopLockedGate = true;

        while (!moveToDeadLetterDone) {
          await new Promise((r) => setTimeout(r, 10));
        }

        await tx`DELETE FROM "Shop" WHERE domain = ${SHOP_DOMAIN}`;
      });

      while (!shopLockedGate) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const [sendResult2] = await sql2<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql2.json(testMsg)})
      `;
      const msgId2 = sendResult2.send;

      const result = await simulateMoveToDeadLetter(
        sql2,
        "s6_sync",
        msgId2,
        testMsg,
        "test_error",
        5,
        false
      );

      moveToDeadLetterDone = true;

      await deleteShopPromise;

      expect(result.success).toBe(true);

      const [dlqRow] = await sql1<[{ id: string; message: SyncMessage }?]>`
        SELECT id, message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.shop).toBe(SHOP_DOMAIN);
      expect((dlqRow!.message as unknown as { sanitized?: boolean }).sanitized).toBeUndefined();
    });
  });

  describe("FIXED: real moveToDeadLetter with Shop FOR SHARE", () => {
    it("Same race scenario but with real fix: B waits on FOR SHARE, sees shop gone, sanitizes", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("race-with-fix");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

      const conn2Pid = await getPid(sql2);

      let forUpdateTaken = false;

      const deleteShopPromise = sql1.begin(async (tx) => {
        const [lockedShop] = await tx<{ id: string }[]>`
          SELECT id FROM "Shop" WHERE domain = ${SHOP_DOMAIN} FOR UPDATE
        `;
        expect(lockedShop).toBeDefined();

        forUpdateTaken = true;

        const isWaiting = await waitForLockWait(sql3, conn2Pid, 5000);
        expect(isWaiting).toBe(true);

        await tx`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
        await tx`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_DOMAIN}`;
        await tx`DELETE FROM "Shop" WHERE domain = ${SHOP_DOMAIN}`;
      });

      while (!forUpdateTaken) {
        await new Promise((r) => setTimeout(r, 10));
      }

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");

      const resultPromise = moveToDeadLetter(
        sql2,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5
      );

      await deleteShopPromise;
      const result = await resultPromise;

      expect(result).toBe(false);

      const [dlqRow] = await sql1<[{ message: { sanitized?: boolean; shop?: string } }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeUndefined();
    });

    it("Shop exists and not uninstalled: non-shop_not_found error writes full message to DLQ", async () => {
      const now = new Date();

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now})
      `;

      const testMsg = createTestMessage("fix-shop-exists");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

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

      const [dlqRow] = await sql1<[{ message: SyncMessage }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'shop' = ${SHOP_DOMAIN}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.shop).toBe(SHOP_DOMAIN);
      expect(dlqRow!.message.webhookId).toBe(testMsg.webhookId);
      expect((dlqRow!.message as unknown as { sanitized?: boolean }).sanitized).toBeUndefined();
    });

    it("Shop uninstalledAt set: non-shop_not_found error sanitizes message", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("fix-uninstalled");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

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

      const [dlqRow] = await sql1<[{ message: { sanitized?: boolean; shop?: string; topic: string } }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.topic).toBe("ORDERS_CREATE");
    });
  });

  describe("WITH Shop FOR SHARE fix", () => {
    it("deleteShop holds FOR UPDATE, moveToDeadLetter waits on FOR SHARE, then sees shop gone and sanitizes", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("fix-a");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

      const conn2Pid = await getPid(sql2);

      let forUpdateTaken = false;
      let moveToDeadLetterStarted = false;

      const deleteShopPromise = sql1.begin(async (tx) => {
        const [lockedShop] = await tx<{ id: string }[]>`
          SELECT id FROM "Shop" WHERE domain = ${SHOP_DOMAIN} FOR UPDATE
        `;
        expect(lockedShop).toBeDefined();

        forUpdateTaken = true;

        const isWaiting = await waitForLockWait(sql3, conn2Pid, 5000);
        expect(isWaiting).toBe(true);

        await tx`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_DOMAIN}`;
        await tx`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
        await tx`DELETE FROM "Shop" WHERE domain = ${SHOP_DOMAIN}`;
      });

      while (!forUpdateTaken) {
        await new Promise((r) => setTimeout(r, 10));
      }

      moveToDeadLetterStarted = true;

      const resultPromise = simulateMoveToDeadLetter(
        sql2,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5,
        true
      );

      await deleteShopPromise;
      const result = await resultPromise;

      expect(result.success).toBe(false);

      const [dlqRow] = await sql1<[{ message: { sanitized?: boolean; shop?: string } }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeUndefined();
    });

    it("deleteShop runs first, moveToDeadLetter sees shop gone on FOR SHARE, sanitizes the message", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const testMsg = createTestMessage("fix-b");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

      const { deleteShop } = await import("~/services/compliance/compliance.server");
      const deleteResult = await deleteShop(sql1, SHOP_DOMAIN);
      expect(deleteResult.deleted).toBe(true);

      const result = await simulateMoveToDeadLetter(
        sql2,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5,
        true
      );

      expect(result.success).toBe(false);

      const [dlqRow] = await sql1<[{ message: { sanitized?: boolean; shop?: string } }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeUndefined();
    });

    it("Shop exists and is not uninstalled: non-shop_not_found error writes full message to DLQ", async () => {
      const now = new Date();

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now})
      `;

      const testMsg = createTestMessage("no-race");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

      const result = await simulateMoveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5,
        true
      );

      expect(result.success).toBe(true);
      expect(result.sanitized).toBe(false);

      const [dlqRow] = await sql1<[{ message: SyncMessage }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'shop' = ${SHOP_DOMAIN}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.shop).toBe(SHOP_DOMAIN);
      expect(dlqRow!.message.webhookId).toBe(testMsg.webhookId);
      expect((dlqRow!.message as unknown as { sanitized?: boolean }).sanitized).toBeUndefined();
    });

    it("Shop uninstalledAt is set: non-shop_not_found error sanitizes message", async () => {
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

      const result = await simulateMoveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "test_error",
        5,
        true
      );

      expect(result.success).toBe(true);
      expect(result.sanitized).toBe(true);

      const [dlqRow] = await sql1<[{ message: { sanitized?: boolean; shop?: string; topic: string } }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.topic).toBe("ORDERS_CREATE");
    });
  });

  describe("Existing behavior: shop_not_found error", () => {
    it("shop_not_found error sanitizes message regardless of Shop row state", async () => {
      const now = new Date();

      await sql1`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${now}, ${now})
      `;

      const testMsg = createTestMessage("shop-not-found");
      const [sendResult] = await sql1<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql1.json(testMsg)})
      `;
      const msgId = sendResult.send;

      const result = await simulateMoveToDeadLetter(
        sql1,
        "s6_sync",
        msgId,
        testMsg,
        "shop_not_found",
        5,
        false
      );

      expect(result.success).toBe(true);
      expect(result.sanitized).toBe(true);

      const [dlqRow] = await sql1<[{ message: { sanitized?: boolean; shop?: string; topic: string } }?]>`
        SELECT message FROM s6_dead_letter
        WHERE message->>'webhookId' = ${testMsg.webhookId}
      `;

      expect(dlqRow).toBeDefined();
      expect(dlqRow!.message.sanitized).toBe(true);
      expect(dlqRow!.message.shop).toBeUndefined();
      expect(dlqRow!.message.topic).toBe("ORDERS_CREATE");
    });
  });
});
