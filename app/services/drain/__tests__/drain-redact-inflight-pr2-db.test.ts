/**
 * DB-backed integration tests for #239 PR2: in-flight residual guards.
 *
 * Tests the guards that prevent shop-text writes (non-FK tables) from
 * committing after deleteShop has removed the Shop row. Each guard uses
 * SELECT ... FROM "Shop" WHERE domain = $shop FOR SHARE in a CTE or
 * transaction, which serializes with deleteShop's leading FOR UPDATE.
 *
 * Covered functions:
 * - incrementOrderRefetchNull (s10b_order_refetch_null)
 * - incrementOrderOutstandingMissing (order_outstanding_missing)
 * - incrementCustomerPiiAccessDeniedFallback (s10b_customer_pii_fallback)
 * - enqueueCreditStatusRecompute / enqueueRecomputeForInvoice (pgmq.send)
 *
 * Also covers buildReconcileMutation returning shop_not_found for
 * RECONCILE_CUSTOMERS when the Shop row is missing.
 *
 * Uses describeWithDb for real database integration.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-pr2`;
}

describeWithDb("PR2: in-flight residual guards (#239)", () => {
  let sql: ReturnType<typeof postgres>;
  let testContext: { suffix: string };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(() => {
    testContext = { suffix: makeTestId() };
  });

  async function createShop(
    id: string,
    domain: string,
    opts?: { uninstalledAt?: Date }
  ): Promise<void> {
    const now = new Date();
    if (opts?.uninstalledAt) {
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${id}, ${domain}, 'INR', ${now}, ${now}, ${opts.uninstalledAt})
      `;
    } else {
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${id}, ${domain}, 'INR', ${now}, ${now})
      `;
    }
  }

  async function cleanupTestData(suffix: string): Promise<void> {
    const allDomains = [
      `test-redact-pr2-a-${suffix}.myshopify.com`,
      `test-redact-pr2-b-${suffix}.myshopify.com`,
      `test-redact-pr2-ax-${suffix}.myshopify.com`,
      `TEST-REDACT-PR2-A-${suffix}.MYSHOPIFY.COM`,
    ];
    const allIds = [
      `shop-pr2-a-${suffix}`,
      `shop-pr2-b-${suffix}`,
      `shop-pr2-ax-${suffix}`,
      `shop-pr2-upper-${suffix}`,
    ];

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${suffix}%`}`;
    await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "Shop" WHERE id IN ${sql(allIds)}`;

    await assertNoQueueLeftovers(sql, allDomains, "drain-redact-inflight-pr2-db.test.ts");
  }

  describe("incrementOrderRefetchNull", () => {
    const SHOP_A_ID = () => `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = () => `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const SHOP_B_ID = () => `shop-pr2-b-${testContext.suffix}`;
    const SHOP_B_DOMAIN = () => `test-redact-pr2-b-${testContext.suffix}.myshopify.com`;
    const SHOP_AX_ID = () => `shop-pr2-ax-${testContext.suffix}`;
    const SHOP_AX_DOMAIN = () => `test-redact-pr2-ax-${testContext.suffix}.myshopify.com`;
    const SHOP_UPPER_ID = () => `shop-pr2-upper-${testContext.suffix}`;
    const SHOP_UPPER_DOMAIN = () => `TEST-REDACT-PR2-A-${testContext.suffix}.MYSHOPIFY.COM`;

    afterEach(async () => {
      await cleanupTestData(testContext.suffix);
    });

    it("shop A deleted: 0 rows for A, shop B unchanged, near-misses untouched", async () => {
      await createShop(SHOP_B_ID(), SHOP_B_DOMAIN());
      await createShop(SHOP_AX_ID(), SHOP_AX_DOMAIN());
      await createShop(SHOP_UPPER_ID(), SHOP_UPPER_DOMAIN());

      const { incrementOrderRefetchNull } = await import("../reconcile-handlers.server");

      const resultA = await incrementOrderRefetchNull(sql, SHOP_A_DOMAIN());
      expect(resultA).toBe(false);

      const resultB = await incrementOrderRefetchNull(sql, SHOP_B_DOMAIN());
      expect(resultB).toBe(true);

      const resultAx = await incrementOrderRefetchNull(sql, SHOP_AX_DOMAIN());
      expect(resultAx).toBe(true);

      const resultUpper = await incrementOrderRefetchNull(sql, SHOP_UPPER_DOMAIN());
      expect(resultUpper).toBe(true);

      const [countA] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
        WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(countA.count, 10)).toBe(0);

      const [countB] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
        WHERE shop = ${SHOP_B_DOMAIN()}
      `;
      expect(parseInt(countB.count, 10)).toBe(1);

      const [countAx] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
        WHERE shop = ${SHOP_AX_DOMAIN()}
      `;
      expect(parseInt(countAx.count, 10)).toBe(1);

      const [countUpper] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
        WHERE shop = ${SHOP_UPPER_DOMAIN()}
      `;
      expect(parseInt(countUpper.count, 10)).toBe(1);
    });

    it("shop present: row is written (positive case)", async () => {
      await createShop(SHOP_A_ID(), SHOP_A_DOMAIN());

      const { incrementOrderRefetchNull } = await import("../reconcile-handlers.server");

      const result = await incrementOrderRefetchNull(sql, SHOP_A_DOMAIN());
      expect(result).toBe(true);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
        WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(count.count, 10)).toBe(1);

      const result2 = await incrementOrderRefetchNull(sql, SHOP_A_DOMAIN());
      expect(result2).toBe(true);

      const [count2] = await sql<[{ count: string; total: string }]>`
        SELECT COUNT(*)::text AS count, COALESCE(SUM(count), 0)::text AS total
        FROM s10b_order_refetch_null WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(count2.count, 10)).toBe(1);
      expect(parseInt(count2.total, 10)).toBe(2);
    });
  });

  describe("incrementOrderOutstandingMissing", () => {
    const SHOP_A_ID = () => `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = () => `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const SHOP_B_ID = () => `shop-pr2-b-${testContext.suffix}`;
    const SHOP_B_DOMAIN = () => `test-redact-pr2-b-${testContext.suffix}.myshopify.com`;
    const SHOP_AX_ID = () => `shop-pr2-ax-${testContext.suffix}`;
    const SHOP_AX_DOMAIN = () => `test-redact-pr2-ax-${testContext.suffix}.myshopify.com`;

    afterEach(async () => {
      await cleanupTestData(testContext.suffix);
    });

    it("shop A deleted: 0 rows for A, shop B unchanged, near-misses untouched", async () => {
      await createShop(SHOP_B_ID(), SHOP_B_DOMAIN());
      await createShop(SHOP_AX_ID(), SHOP_AX_DOMAIN());

      const { incrementOrderOutstandingMissing } = await import("../reconcile-handlers.server");

      const resultA = await incrementOrderOutstandingMissing(sql, SHOP_A_DOMAIN(), 5);
      expect(resultA).toBe(false);

      const resultB = await incrementOrderOutstandingMissing(sql, SHOP_B_DOMAIN(), 3);
      expect(resultB).toBe(true);

      const resultAx = await incrementOrderOutstandingMissing(sql, SHOP_AX_DOMAIN(), 2);
      expect(resultAx).toBe(true);

      const [countA] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM order_outstanding_missing
        WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(countA.count, 10)).toBe(0);

      const [countB] = await sql<[{ count: string; total: string }]>`
        SELECT COUNT(*)::text AS count, COALESCE(SUM(count), 0)::text AS total
        FROM order_outstanding_missing WHERE shop = ${SHOP_B_DOMAIN()}
      `;
      expect(parseInt(countB.count, 10)).toBe(1);
      expect(parseInt(countB.total, 10)).toBe(3);

      const [countAx] = await sql<[{ count: string; total: string }]>`
        SELECT COUNT(*)::text AS count, COALESCE(SUM(count), 0)::text AS total
        FROM order_outstanding_missing WHERE shop = ${SHOP_AX_DOMAIN()}
      `;
      expect(parseInt(countAx.count, 10)).toBe(1);
      expect(parseInt(countAx.total, 10)).toBe(2);
    });

    it("shop present: row is written (positive case)", async () => {
      await createShop(SHOP_A_ID(), SHOP_A_DOMAIN());

      const { incrementOrderOutstandingMissing } = await import("../reconcile-handlers.server");

      const result = await incrementOrderOutstandingMissing(sql, SHOP_A_DOMAIN(), 7);
      expect(result).toBe(true);

      const [count] = await sql<[{ total: string }]>`
        SELECT COALESCE(SUM(count), 0)::text AS total
        FROM order_outstanding_missing WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(count.total, 10)).toBe(7);
    });

    it("n <= 0 returns false without write (no-op)", async () => {
      const { incrementOrderOutstandingMissing } = await import("../reconcile-handlers.server");

      const result = await incrementOrderOutstandingMissing(sql, "test-nonexistent-shop.myshopify.com", 0);
      expect(result).toBe(false);
    });
  });

  describe("incrementCustomerPiiAccessDeniedFallback", () => {
    const SHOP_A_ID = () => `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = () => `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const SHOP_B_ID = () => `shop-pr2-b-${testContext.suffix}`;
    const SHOP_B_DOMAIN = () => `test-redact-pr2-b-${testContext.suffix}.myshopify.com`;
    const SHOP_AX_ID = () => `shop-pr2-ax-${testContext.suffix}`;
    const SHOP_AX_DOMAIN = () => `test-redact-pr2-ax-${testContext.suffix}.myshopify.com`;

    afterEach(async () => {
      await cleanupTestData(testContext.suffix);
    });

    it("shop A deleted: 0 rows for A, shop B unchanged, near-misses untouched", async () => {
      await createShop(SHOP_B_ID(), SHOP_B_DOMAIN());
      await createShop(SHOP_AX_ID(), SHOP_AX_DOMAIN());

      const { incrementCustomerPiiAccessDeniedFallback } = await import("../customer-fetch.server");

      const resultA = await incrementCustomerPiiAccessDeniedFallback(sql, SHOP_A_DOMAIN());
      expect(resultA).toBe(false);

      const resultB = await incrementCustomerPiiAccessDeniedFallback(sql, SHOP_B_DOMAIN());
      expect(resultB).toBe(true);

      const resultAx = await incrementCustomerPiiAccessDeniedFallback(sql, SHOP_AX_DOMAIN());
      expect(resultAx).toBe(true);

      const [countA] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_customer_pii_fallback
        WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(countA.count, 10)).toBe(0);

      const [countB] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_customer_pii_fallback
        WHERE shop = ${SHOP_B_DOMAIN()}
      `;
      expect(parseInt(countB.count, 10)).toBe(1);

      const [countAx] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_customer_pii_fallback
        WHERE shop = ${SHOP_AX_DOMAIN()}
      `;
      expect(parseInt(countAx.count, 10)).toBe(1);
    });

    it("shop present: row is written (positive case)", async () => {
      await createShop(SHOP_A_ID(), SHOP_A_DOMAIN());

      const { incrementCustomerPiiAccessDeniedFallback } = await import("../customer-fetch.server");

      const result = await incrementCustomerPiiAccessDeniedFallback(sql, SHOP_A_DOMAIN());
      expect(result).toBe(true);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM s10b_customer_pii_fallback
        WHERE shop = ${SHOP_A_DOMAIN()}
      `;
      expect(parseInt(count.count, 10)).toBe(1);
    });
  });

  describe("enqueueCreditStatusRecompute", () => {
    const SHOP_A_ID = () => `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = () => `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const SHOP_B_ID = () => `shop-pr2-b-${testContext.suffix}`;
    const SHOP_B_DOMAIN = () => `test-redact-pr2-b-${testContext.suffix}.myshopify.com`;

    afterEach(async () => {
      await cleanupTestData(testContext.suffix);
    });

    it("shop A deleted: 0 messages for A, shop B message is enqueued", async () => {
      await createShop(SHOP_B_ID(), SHOP_B_DOMAIN());

      const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");

      const resultA = await enqueueCreditStatusRecompute(
        sql,
        SHOP_A_DOMAIN(),
        `buyer-a-${testContext.suffix}`,
        "invoice_change"
      );
      expect(resultA).toBe(false);

      const resultB = await enqueueCreditStatusRecompute(
        sql,
        SHOP_B_DOMAIN(),
        `buyer-b-${testContext.suffix}`,
        "invoice_change"
      );
      expect(resultB).toBe(true);

      const [countA] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_A_DOMAIN()}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      `;
      expect(parseInt(countA.count, 10)).toBe(0);

      const [countB] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_B_DOMAIN()}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      `;
      expect(parseInt(countB.count, 10)).toBe(1);
    });

    it("shop present: message is enqueued (positive case)", async () => {
      await createShop(SHOP_A_ID(), SHOP_A_DOMAIN());

      const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");

      const result = await enqueueCreditStatusRecompute(
        sql,
        SHOP_A_DOMAIN(),
        `buyer-a-${testContext.suffix}`,
        "daily_sweep"
      );
      expect(result).toBe(true);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_A_DOMAIN()}
          AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
      `;
      expect(parseInt(count.count, 10)).toBe(1);
    });
  });

  describe("enqueueRecomputeForInvoice", () => {
    it("returns false when invoice not found", async () => {
      const { enqueueRecomputeForInvoice } = await import("~/services/credit-status-recompute.server");

      const result = await enqueueRecomputeForInvoice(sql, `nonexistent-invoice-${testContext.suffix}`);
      expect(result).toBe(false);
    });
  });
});

describeWithDb("PR2: credit recompute race with deleteShop (#239)", () => {
  let sql1: ReturnType<typeof postgres>;
  let sql2: ReturnType<typeof postgres>;
  let testContext: { suffix: string };

  beforeAll(async () => {
    sql1 = postgres(TEST_DATABASE_URL!, sqlOptions);
    sql2 = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql1.end();
    await sql2.end();
  });

  beforeEach(() => {
    testContext = { suffix: makeTestId() };
  });

  async function cleanupTestData(suffix: string): Promise<void> {
    const allDomains = [
      `test-redact-pr2-a-${suffix}.myshopify.com`,
      `test-redact-pr2-b-${suffix}.myshopify.com`,
    ];
    const allIds = [
      `shop-pr2-a-${suffix}`,
      `shop-pr2-b-${suffix}`,
    ];

    await sql1`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql1(allDomains)}`;
    await sql1`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql1(allDomains)}`;
    await sql1`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql1(allDomains)}`;
    await sql1`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${suffix}%`}`;
    await sql1`DELETE FROM s6_reconcile_stage_claims WHERE shop IN ${sql1(allDomains)}`;
    await sql1`DELETE FROM "Shop" WHERE id IN ${sql1(allIds)}`;

    await assertNoQueueLeftovers(sql1, allDomains, "drain-redact-inflight-pr2-db.test.ts (race)");
  }

  it("(d-lock) FOR SHARE blocks until deleteShop FOR UPDATE releases, no deadlock", async () => {
    const SHOP_A_ID = `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW(), ${uninstalledAt})
    `;

    let deleteHoldsLock = false;
    let enqueueStarted = false;
    let enqueueCompleted = false;
    let deadlockDetected = false;

    const deletePromise = sql1.begin(async (tx) => {
      await tx`SELECT id FROM "Shop" WHERE domain = ${SHOP_A_DOMAIN} FOR UPDATE`;
      deleteHoldsLock = true;

      await new Promise<void>((resolve) => {
        const checkStarted = setInterval(() => {
          if (enqueueStarted) {
            clearInterval(checkStarted);
            resolve();
          }
        }, 10);
      });

      await new Promise((r) => setTimeout(r, 200));
      expect(enqueueCompleted).toBe(false);

      await tx`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;
    });

    while (!deleteHoldsLock) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");

    enqueueStarted = true;
    const enqueuePromise = enqueueCreditStatusRecompute(
      sql2,
      SHOP_A_DOMAIN,
      `buyer-a-${testContext.suffix}`,
      "invoice_change"
    ).then((result) => {
      enqueueCompleted = true;
      return result;
    }).catch((err: Error) => {
      enqueueCompleted = true;
      if (err.message.includes("40P01") || err.message.toLowerCase().includes("deadlock")) {
        deadlockDetected = true;
      }
      throw err;
    });

    await deletePromise;

    const result = await enqueuePromise;
    expect(result).toBe(false);
    expect(enqueueCompleted).toBe(true);
    expect(deadlockDetected).toBe(false);

    const [msgCount] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
    `;
    expect(parseInt(msgCount.count, 10)).toBe(0);

    await cleanupTestData(testContext.suffix);
  }, 10000);

  it("(d-conn) rollback undoes pgmq.send when using tx (proves atomicity)", async () => {
    const SHOP_A_ID = `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const buyerAccountId = `buyer-conn-rollback-${testContext.suffix}`;

    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    let rolledBack = false;
    let messageVisibleAfterSend = false;

    try {
      await sql1.begin(async (tx) => {
        const [shopRow] = await tx<[{ id: string }?]>`
          SELECT id FROM "Shop" WHERE domain = ${SHOP_A_DOMAIN} FOR SHARE
        `;
        expect(shopRow).toBeDefined();

        const message = {
          topic: "CREDIT_STATUS_RECOMPUTE",
          shop: SHOP_A_DOMAIN,
          buyerAccountId,
          source: "manual",
          webhookId: `credit_recompute:${buyerAccountId}:${Date.now()}`,
          resourceGid: buyerAccountId,
        };

        await tx`SELECT pgmq.send('s6_sync', ${tx.json(message)})`;

        const [outsideCount] = await sql2<[{ count: string }]>`
          SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${SHOP_A_DOMAIN}
            AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
            AND message->>'buyerAccountId' = ${buyerAccountId}
        `;
        messageVisibleAfterSend = parseInt(outsideCount.count, 10) > 0;

        throw new Error("intentional_rollback_for_test");
      });
    } catch (err) {
      if ((err as Error).message === "intentional_rollback_for_test") {
        rolledBack = true;
      } else {
        throw err;
      }
    }

    expect(rolledBack).toBe(true);
    expect(messageVisibleAfterSend).toBe(false);

    const [afterRollback] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        AND message->>'buyerAccountId' = ${buyerAccountId}
    `;
    expect(parseInt(afterRollback.count, 10)).toBe(0);

    await cleanupTestData(testContext.suffix);
  }, 10000);

  it("(d-conn-mutation) enqueueCreditStatusRecompute message not visible while waiting for FOR SHARE", async () => {
    const SHOP_A_ID = `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const buyerAccountId = `buyer-mutation-${testContext.suffix}`;

    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    let forUpdateAcquired = false;
    let enqueueStarted = false;
    let messageVisibleDuringBlock = false;
    let checksDone = 0;

    const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");

    const blockerPromise = sql1.begin(async (tx) => {
      await tx`SELECT id FROM "Shop" WHERE domain = ${SHOP_A_DOMAIN} FOR UPDATE`;
      forUpdateAcquired = true;

      while (!enqueueStarted && checksDone < 50) {
        await new Promise((r) => setTimeout(r, 20));
        checksDone++;
      }

      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 30));
        const [visibleCount] = await sql2<[{ count: string }]>`
          SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${SHOP_A_DOMAIN}
            AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
            AND message->>'buyerAccountId' = ${buyerAccountId}
        `;
        if (parseInt(visibleCount.count, 10) > 0) {
          messageVisibleDuringBlock = true;
          break;
        }
      }
    });

    while (!forUpdateAcquired) {
      await new Promise((r) => setTimeout(r, 10));
    }

    enqueueStarted = true;
    const enqueuePromise = enqueueCreditStatusRecompute(
      sql2,
      SHOP_A_DOMAIN,
      buyerAccountId,
      "manual"
    );

    await blockerPromise;
    const result = await enqueuePromise;

    expect(result).toBe(true);
    expect(messageVisibleDuringBlock).toBe(false);

    const [afterComplete] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        AND message->>'buyerAccountId' = ${buyerAccountId}
    `;
    expect(parseInt(afterComplete.count, 10)).toBe(1);

    await cleanupTestData(testContext.suffix);
  }, 15000);

  it("(d-conn-real) enqueueCreditStatusRecompute sends atomically with shop check", async () => {
    const SHOP_A_ID = `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const buyerAccountId = `buyer-atomicity-${testContext.suffix}`;

    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");

    const result = await enqueueCreditStatusRecompute(
      sql1,
      SHOP_A_DOMAIN,
      buyerAccountId,
      "invoice_change"
    );
    expect(result).toBe(true);

    const [count] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        AND message->>'buyerAccountId' = ${buyerAccountId}
    `;
    expect(parseInt(count.count, 10)).toBe(1);

    await sql1`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;

    const resultAfterDelete = await enqueueCreditStatusRecompute(
      sql1,
      SHOP_A_DOMAIN,
      `buyer-after-delete-${testContext.suffix}`,
      "invoice_change"
    );
    expect(resultAfterDelete).toBe(false);

    const [countAfterDelete] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        AND message->>'buyerAccountId' = ${`buyer-after-delete-${testContext.suffix}`}
    `;
    expect(parseInt(countAfterDelete.count, 10)).toBe(0);

    await cleanupTestData(testContext.suffix);
  });

  it("enqueue succeeds when FOR SHARE acquires before deleteShop", async () => {
    const SHOP_A_ID = `shop-pr2-a-${testContext.suffix}`;
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;

    await sql1`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', NOW(), NOW())
    `;

    const { enqueueCreditStatusRecompute } = await import("~/services/credit-status-recompute.server");

    const result = await enqueueCreditStatusRecompute(
      sql1,
      SHOP_A_DOMAIN,
      `buyer-a-${testContext.suffix}`,
      "invoice_change"
    );
    expect(result).toBe(true);

    const [msgCount] = await sql1<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_A_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
    `;
    expect(parseInt(msgCount.count, 10)).toBe(1);

    await cleanupTestData(testContext.suffix);
  });
});

describeWithDb("PR2: RECONCILE_CUSTOMERS shop_not_found (#239)", () => {
  let sql: ReturnType<typeof postgres>;
  let testContext: { suffix: string };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(() => {
    testContext = { suffix: makeTestId() };
    vi.clearAllMocks();
  });

  async function cleanupTestData(suffix: string): Promise<void> {
    const allDomains = [
      `test-redact-pr2-a-${suffix}.myshopify.com`,
      `test-redact-pr2-ax-${suffix}.myshopify.com`,
    ];
    const allIds = [
      `shop-pr2-ax-${suffix}`,
    ];

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${suffix}%`}`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM "Shop" WHERE id IN ${sql(allIds)}`;

    await assertNoQueueLeftovers(sql, allDomains, "drain-redact-inflight-pr2-db.test.ts (reconcile)");
  }

  afterEach(async () => {
    await cleanupTestData(testContext.suffix);
  });

  it("shop missing: no s6_processed_webhooks row with reconcile:<A> prefix", async () => {
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const webhookId = `reconcile:${SHOP_A_DOMAIN}:2026-10-26:customers`;

    const { startReconcileBulkOperation } = await import("../reconcile-handlers.server");

    const result = await startReconcileBulkOperation(sql, SHOP_A_DOMAIN, "customers", webhookId);

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("shop_not_found");

    const [count] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s6_processed_webhooks
      WHERE webhook_id LIKE ${`reconcile:${SHOP_A_DOMAIN}%`}
    `;
    expect(parseInt(count.count, 10)).toBe(0);

    const [claimCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s6_reconcile_stage_claims
      WHERE shop = ${SHOP_A_DOMAIN}
    `;
    expect(parseInt(claimCount.count, 10)).toBe(0);
  });

  it("near-miss domain unaffected: shop_not_found for A, AX succeeds (skips: no tag rules)", async () => {
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const SHOP_AX_ID = `shop-pr2-ax-${testContext.suffix}`;
    const SHOP_AX_DOMAIN = `test-redact-pr2-ax-${testContext.suffix}.myshopify.com`;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_AX_ID}, ${SHOP_AX_DOMAIN}, 'INR', NOW(), NOW())
    `;

    const { startReconcileBulkOperation } = await import("../reconcile-handlers.server");

    const resultA = await startReconcileBulkOperation(
      sql,
      SHOP_A_DOMAIN,
      "customers",
      `reconcile:${SHOP_A_DOMAIN}:2026-10-26:customers`
    );
    expect(resultA.success).toBe(false);
    expect(resultA.errorCode).toBe("shop_not_found");

    const resultAx = await startReconcileBulkOperation(
      sql,
      SHOP_AX_DOMAIN,
      "customers",
      `reconcile:${SHOP_AX_DOMAIN}:2026-10-26:customers`
    );
    expect(resultAx.success).toBe(true);
    expect(resultAx.action).toBe("skipped");
    expect((resultAx as { skipped?: boolean }).skipped).toBe(true);

    const [countA] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s6_processed_webhooks
      WHERE webhook_id LIKE ${`reconcile:${SHOP_A_DOMAIN}%`}
    `;
    expect(parseInt(countA.count, 10)).toBe(0);
  });
});

describeWithDb("PR2: counter guards use exact domain match (#239)", () => {
  let sql: ReturnType<typeof postgres>;
  let testContext: { suffix: string };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(() => {
    testContext = { suffix: makeTestId() };
  });

  async function cleanupTestData(suffix: string): Promise<void> {
    const allDomains = [
      `test-redact-pr2-a-${suffix}.myshopify.com`,
      `test-redact-pr2-a-${suffix}.myshopify.com-extra`,
      `test-redact-pr2-a-${suffix}.myshopify.co`,
    ];
    const allIds = [
      `shop-pr2-a-${suffix}`,
      `shop-pr2-a-extra-${suffix}`,
      `shop-pr2-a-short-${suffix}`,
    ];

    await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM "Shop" WHERE id IN ${sql(allIds)}`;
  }

  afterEach(async () => {
    await cleanupTestData(testContext.suffix);
  });

  it("LIKE/ILIKE would match, but exact equality does not", async () => {
    const SHOP_A_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com`;
    const SHOP_EXTRA_ID = `shop-pr2-a-extra-${testContext.suffix}`;
    const SHOP_EXTRA_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.com-extra`;
    const SHOP_SHORT_ID = `shop-pr2-a-short-${testContext.suffix}`;
    const SHOP_SHORT_DOMAIN = `test-redact-pr2-a-${testContext.suffix}.myshopify.co`;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_EXTRA_ID}, ${SHOP_EXTRA_DOMAIN}, 'INR', NOW(), NOW())
    `;
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_SHORT_ID}, ${SHOP_SHORT_DOMAIN}, 'INR', NOW(), NOW())
    `;

    const { incrementOrderRefetchNull } = await import("../reconcile-handlers.server");

    const resultA = await incrementOrderRefetchNull(sql, SHOP_A_DOMAIN);
    expect(resultA).toBe(false);

    const resultExtra = await incrementOrderRefetchNull(sql, SHOP_EXTRA_DOMAIN);
    expect(resultExtra).toBe(true);

    const resultShort = await incrementOrderRefetchNull(sql, SHOP_SHORT_DOMAIN);
    expect(resultShort).toBe(true);

    const [countA] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
      WHERE shop = ${SHOP_A_DOMAIN}
    `;
    expect(parseInt(countA.count, 10)).toBe(0);

    const [countExtra] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
      WHERE shop = ${SHOP_EXTRA_DOMAIN}
    `;
    expect(parseInt(countExtra.count, 10)).toBe(1);

    const [countShort] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s10b_order_refetch_null
      WHERE shop = ${SHOP_SHORT_DOMAIN}
    `;
    expect(parseInt(countShort.count, 10)).toBe(1);
  });
});
