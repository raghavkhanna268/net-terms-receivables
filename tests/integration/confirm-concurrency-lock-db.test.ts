/**
 * DB integration test: Deterministic concurrency proof for confirmMatch locking.
 *
 * This test PROVES that the Payment row lock in confirmMatch prevents over-allocation
 * by using two SEPARATE DB connections and forcing deterministic interleaving:
 *
 * Test 1 (full allocation):
 * 1. Connection A (max:1) begins a transaction and acquires the Payment row lock
 * 2. Connection B calls confirmMatch - it must block waiting for A's lock
 * 3. Test verifies B is blocked via pg_stat_activity (wait_event_type = 'Lock')
 * 4. A confirms match1 at full payment amount and commits
 * 5. B unblocks, sees A's allocation, fails with "Payment fully allocated"
 *
 * Test 2 (partial allocation):
 * 1. A acquires lock, confirms match1 at 10000 (partial of 15000 payment)
 * 2. B was waiting, now unblocks and sees 5000 remaining
 * 3. B confirms match2 but capped at 5000
 * 4. Total = 15000 = payment amount (no over-allocation)
 *
 * CRITICAL: This test FAILS if the FOR UPDATE lock on Payment is removed.
 *
 * All data is FICTIONAL with test-* names. Uses the "Sequential DB" project.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { confirmMatch } from "../../app/services/matcher.server.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";

vi.mock("../../app/services/credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("confirmMatch concurrency lock: deterministic interleave proof", () => {
  let sqlA: ReturnType<typeof postgres>;
  let sqlB: ReturnType<typeof postgres>;
  let sqlMain: ReturnType<typeof postgres>;

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-concurrency-lock-${runId}.myshopify.com`;
  let testShopId: string;
  let testBuyerId: string;

  const invoice1Id = `invoice-lock-1-${runId}`;
  const invoice2Id = `invoice-lock-2-${runId}`;

  beforeAll(async () => {
    sqlMain = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });
    sqlA = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1, onnotice: () => {} });
    sqlB = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });

    const [shop] = await sqlMain<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    const buyerId = `buyer-lock-${runId}`;
    const [buyer] = await sqlMain<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${testShopId}, 'COMPANY',
        ${"gid://shopify/Company/lock-" + runId},
        ${"gid://shopify/CompanyLocation/lock-" + runId},
        'Test Lock Proof Co', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    await sqlMain`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice1Id}, ${testShopId}, ${testBuyerId},
        ${"gid://shopify/Order/lock-1001-" + runId}, '#1001', 10000, 'open', 10000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sqlMain`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice2Id}, ${testShopId}, ${testBuyerId},
        ${"gid://shopify/Order/lock-1002-" + runId}, '#1002', 10000, 'open', 10000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sqlMain`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
    await sqlMain`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "Shop" WHERE id = ${testShopId}`;

    await assertNoQueueLeftovers(sqlMain, [TEST_SHOP_DOMAIN], "confirm-concurrency-lock-db.test.ts");

    await sqlMain.end();
    await sqlA.end();
    await sqlB.end();
  });

  it("confirmMatch B blocks on Payment lock; A confirms first, B fails with full allocation", async () => {
    const importId = `import-lock-${runId}`;
    const paymentId = `payment-lock-${runId}`;

    await sqlMain`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importId}, ${testShopId}, 'HDFC', 'test-lock.csv', 1, NOW())
    `;

    await sqlMain`
      INSERT INTO "Payment" (
        id, "shopId", "importId", amount, status, "payerText", narration, rail, utr,
        "valueDate", "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentId}, ${testShopId}, ${importId}, 10000, 'unmatched',
        'Test Lock Proof Co', 'NEFT CR-TEST LOCK PROOF CO', 'NEFT',
        ${"HDFCN" + String(runId).slice(-11).padStart(11, "0")},
        NOW(), NOW(), NOW()
      )
    `;

    await sqlMain`
      INSERT INTO "Match" ("shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES
        (${testShopId}, ${paymentId}, ${invoice1Id}, 10000, 80, '{"lock_test": true}'::jsonb, 'suggested', NOW(), NOW()),
        (${testShopId}, ${paymentId}, ${invoice2Id}, 10000, 70, '{"lock_test": true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    const [match1] = await sqlMain<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
    `;

    const [match2] = await sqlMain<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND "invoiceId" = ${invoice2Id} AND state = 'suggested'
    `;

    await sqlA`BEGIN`;

    await sqlA`
      SELECT id FROM "Payment"
      WHERE id = ${paymentId} AND "shopId" = ${testShopId}
      FOR UPDATE
    `;

    const confirmBPromise = confirmMatch(sqlB, testShopId, match2.id, "user-B");

    let bIsBlocked = false;
    const maxWaitMs = 5000;
    const pollIntervalMs = 50;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const waitingBackends = await sqlMain<{ pid: number; query: string; wait_event_type: string | null }[]>`
        SELECT pid, query, wait_event_type
        FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%Payment%'
          AND query LIKE '%FOR UPDATE%'
      `;

      if (waitingBackends.length > 0) {
        bIsBlocked = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    expect(
      bIsBlocked,
      "confirmMatch B must block on Payment row lock (proves the FOR UPDATE lock is working)"
    ).toBe(true);

    const confirmAResult = await confirmMatch(sqlA, testShopId, match1.id, "user-A");

    await sqlA`COMMIT`;

    const confirmBResult = await confirmBPromise;

    expect(confirmAResult.success).toBe(true);

    expect(confirmBResult.success).toBe(false);
    expect(
      ["Payment fully allocated", "Match not found or already processed"].includes(confirmBResult.error ?? ""),
      `B should fail with allocation or match state error, got: ${confirmBResult.error}`
    ).toBe(true);

    const confirmedMatches = await sqlMain<{ id: string; amount: string }[]>`
      SELECT id, amount::text FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${paymentId}
        AND state IN ('confirmed', 'pushed')
    `;

    expect(confirmedMatches.length).toBe(1);
    expect(confirmedMatches[0].id).toBe(match1.id);

    const totalConfirmedPaise = Math.round(parseFloat(confirmedMatches[0].amount) * 100);
    expect(totalConfirmedPaise).toBe(1000000);

    const [paymentAfter] = await sqlMain<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${paymentId}
    `;
    expect(paymentAfter.status).toBe("matched");
  }, 15000);

  it("confirmMatch B blocks then gets capped allocation when partial room remains", async () => {
    const importId2 = `import-partial-${runId}`;
    const paymentId = `payment-partial-${runId}`;

    await sqlMain`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sqlMain`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;

    await sqlMain`
      UPDATE "Invoice"
      SET outstanding = total, status = 'open', "updatedAt" = NOW()
      WHERE "shopId" = ${testShopId}
    `;

    await sqlMain`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importId2}, ${testShopId}, 'HDFC', 'test-partial.csv', 1, NOW())
    `;

    await sqlMain`
      INSERT INTO "Payment" (
        id, "shopId", "importId", amount, status, "payerText", narration, rail, utr,
        "valueDate", "createdAt", "updatedAt"
      )
      VALUES (
        ${paymentId}, ${testShopId}, ${importId2}, 15000, 'unmatched',
        'Test Lock Proof Co', 'NEFT CR-TEST LOCK PROOF CO PARTIAL', 'NEFT',
        ${"HDFCN" + String(runId + 1).slice(-11).padStart(11, "0")},
        NOW(), NOW(), NOW()
      )
    `;

    await sqlMain`
      INSERT INTO "Match" ("shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES
        (${testShopId}, ${paymentId}, ${invoice1Id}, 10000, 80, '{"partial_test": true}'::jsonb, 'suggested', NOW(), NOW()),
        (${testShopId}, ${paymentId}, ${invoice2Id}, 10000, 70, '{"partial_test": true}'::jsonb, 'suggested', NOW(), NOW())
    `;

    const [match1] = await sqlMain<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${paymentId} AND "invoiceId" = ${invoice1Id} AND state = 'suggested'
    `;

    const [match2] = await sqlMain<{ id: string }[]>`
      SELECT id FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${paymentId} AND "invoiceId" = ${invoice2Id} AND state = 'suggested'
    `;

    await sqlA`BEGIN`;

    await sqlA`
      SELECT id FROM "Payment"
      WHERE id = ${paymentId} AND "shopId" = ${testShopId}
      FOR UPDATE
    `;

    const confirmBPromise = confirmMatch(sqlB, testShopId, match2.id, "user-B");

    let bIsBlocked = false;
    const maxWaitMs = 5000;
    const pollIntervalMs = 50;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const waitingBackends = await sqlMain<{ pid: number }[]>`
        SELECT pid
        FROM pg_stat_activity
        WHERE state = 'active'
          AND wait_event_type = 'Lock'
          AND query LIKE '%Payment%'
          AND query LIKE '%FOR UPDATE%'
      `;

      if (waitingBackends.length > 0) {
        bIsBlocked = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    expect(bIsBlocked, "B must block on Payment lock").toBe(true);

    const confirmAResult = await confirmMatch(sqlA, testShopId, match1.id, "user-A");

    await sqlA`COMMIT`;

    const confirmBResult = await confirmBPromise;

    expect(confirmAResult.success).toBe(true);
    expect(confirmBResult.success).toBe(true);

    const confirmedMatches = await sqlMain<{ id: string; amount: string; invoice_id: string }[]>`
      SELECT id, amount::text, "invoiceId" AS invoice_id FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${paymentId}
        AND state IN ('confirmed', 'pushed')
      ORDER BY "confirmedAt"
    `;

    expect(confirmedMatches.length).toBe(2);

    const match1Confirmed = confirmedMatches.find((m) => m.invoice_id === invoice1Id);
    const match2Confirmed = confirmedMatches.find((m) => m.invoice_id === invoice2Id);

    expect(match1Confirmed).toBeDefined();
    expect(match2Confirmed).toBeDefined();

    const match1AmountPaise = Math.round(parseFloat(match1Confirmed!.amount) * 100);
    const match2AmountPaise = Math.round(parseFloat(match2Confirmed!.amount) * 100);

    expect(match1AmountPaise).toBe(1000000);
    expect(
      match2AmountPaise,
      "B's allocation must be capped at remaining (15000 - 10000 = 5000 INR = 500000 paise)"
    ).toBe(500000);

    const totalConfirmedPaise = match1AmountPaise + match2AmountPaise;
    expect(totalConfirmedPaise).toBe(1500000);

    const [paymentAfter] = await sqlMain<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${paymentId}
    `;
    expect(paymentAfter.status).toBe("matched");
  }, 15000);
});
