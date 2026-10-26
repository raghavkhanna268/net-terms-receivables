/**
 * DB integration test: Confirm-then-re-import flow for bank statement reconciliation.
 *
 * This test exercises the REAL app path for re-importing a statement after
 * a match has been confirmed:
 * 1. Import synthetic statement (SYNT00999888777 fixture)
 * 2. Confirm the suggested match, which stores the payer alias
 * 3. Re-import the same statement
 *
 * Assertions:
 * - No duplicate suggestion or match is created for the already-confirmed payment
 * - Nothing is auto-confirmed (all suggestions remain in 'suggested' state)
 * - High band (≥80) still only suggests, never auto-confirms
 * - Scores and bands are pinned exactly as main produces them today
 *
 * NOTE: Row 2 is confirmed (not row 1) because row 2's payerText ("TEST BUYER CO")
 * produces an alias that helps both row 1 and row 3. Row 1's payerText is different
 * ("SYNT0001 TEST BUYER CO #1001") due to NEFT parsing extracting different segments.
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 * All data is FICTIONAL - no real bank data. Uses test- domains for isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import { runMatcher, confirmMatch } from "../../app/services/matcher.server.js";
import { CONFIDENCE_THRESHOLD } from "../../app/lib/matching/score.js";
import { normalizeNarrationForLookup } from "../../app/lib/matching/normalize.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

describeWithDb("Confirm-then-re-import flow: SYNT00999888777 fixture", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  const paymentIds: string[] = [];
  const importIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-confirm-reimport-${runId}.myshopify.com`;

  const buyerId = `buyer-confirm-reimport-${runId}`;
  const invoice1Id = `invoice-reimport-1-${runId}`;
  const invoice2Id = `invoice-reimport-2-${runId}`;

  const DEMO_BUYER = {
    name: "Test Buyer Co",
    email: "test.buyer@test-confirm-reimport.example",
  };

  const DEMO_AMOUNTS = {
    order1: 10000,
    order2: 5000,
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${testShopId}, 'COMPANY',
        ${"gid://shopify/Company/confirm-reimport-" + runId},
        ${"gid://shopify/CompanyLocation/confirm-reimport-" + runId},
        ${DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice1Id}, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/1001', '#1001', ${DEMO_AMOUNTS.order1}, 'open', ${DEMO_AMOUNTS.order1},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice2Id}, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/1002', '#1002', ${DEMO_AMOUNTS.order2}, 'open', ${DEMO_AMOUNTS.order2},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;

      await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "confirm-reimport-pin-db.test.ts");
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerId}`;
    await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
    importIds.length = 0;

    await sql`
      UPDATE "Invoice"
      SET outstanding = total, status = 'open', "updatedAt" = NOW()
      WHERE "shopId" = ${testShopId}
    `;
  });

  async function seedPaymentsFromCsv(): Promise<string> {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
    const file = new File([content], "hdfc-review-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${result.detection.bank}, 'hdfc-review-synthetic.csv', ${result.transactions.length}, NOW()
      )
      RETURNING id
    `;
    importIds.push(bankImport.id);

    const credits = result.transactions.filter((t) => t.direction === "CR");
    for (const txn of credits) {
      const [payment] = await sql<{ id: string }[]>`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${bankImport.id},
          ${txn.date}::date, ${txn.amountPaise / 100}::decimal, ${txn.parsed.rail}, ${txn.parsed.utr ?? null},
          ${txn.parsed.payerName ?? null}, ${txn.narration}, 'unmatched', NOW(), NOW()
        )
        RETURNING id
      `;
      paymentIds.push(payment.id);
    }

    return bankImport.id;
  }

  async function getMatchesForPayment(
    paymentId: string,
    state?: string
  ): Promise<
    Array<{
      id: string;
      invoiceId: string;
      invoiceName: string;
      score: number;
      amount: number;
      state: string;
    }>
  > {
    const stateFilter = state ? sql`AND m.state = ${state}` : sql``;
    const matches = await sql<
      Array<{
        id: string;
        invoiceId: string;
        invoiceName: string;
        score: number;
        amount: string;
        state: string;
      }>
    >`
      SELECT 
        m.id,
        m."invoiceId" AS "invoiceId",
        i.name AS "invoiceName",
        m.score,
        m.amount,
        m.state
      FROM "Match" m
      JOIN "Invoice" i ON i.id = m."invoiceId"
      WHERE m."paymentId" = ${paymentId}
        AND m."shopId" = ${testShopId}
        ${stateFilter}
      ORDER BY m.score DESC
    `;
    return matches.map((m) => ({
      ...m,
      amount: parseFloat(m.amount),
    }));
  }

  async function getPaymentStatus(paymentId: string): Promise<string> {
    const [row] = await sql<{ status: string }[]>`
      SELECT status FROM "Payment" WHERE id = ${paymentId}
    `;
    return row?.status ?? "unknown";
  }

  async function getPayerAliases(): Promise<string[]> {
    const aliases = await sql<{ payer_key: string }[]>`
      SELECT "payerKey" AS payer_key FROM "PayerAlias"
      WHERE "buyerAccountId" = ${testBuyerId}
    `;
    return aliases.map((a) => a.payer_key);
  }

  describe("Step 1: Initial import (no alias)", () => {
    /**
     * PINNED SCORES - Fresh store, no aliases:
     *
     * | Row | UTR      | Amount  | Top Candidate | Score | Band   |
     * |-----|----------|---------|---------------|-------|--------|
     * | 1   | SYNT0001 | ₹10,000 | #1001         | 58    | medium |
     * | 2   | SYNT0002 | ₹5,000  | #1002         | 58    | medium |
     * | 3   | SYNT0003 | ₹2,500  | #1002         | 48    | low    |
     *
     * Score breakdown (no alias):
     * - invoice_ref: +30 (#1001/#1002 in narration)
     * - amount_exact: +20 (row 1, 2) / amount_partial: +10 (row 3)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO")
     */
    it("pins 3 payments with scores 58/58/48 (no alias)", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      expect(paymentIds.length).toBe(3);

      const m1 = await getMatchesForPayment(paymentIds[0], "suggested");
      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      const m3 = await getMatchesForPayment(paymentIds[2], "suggested");

      expect(m1.length).toBeGreaterThan(0);
      expect(m2.length).toBeGreaterThan(0);
      expect(m3.length).toBeGreaterThan(0);

      expect(m1[0].invoiceName).toBe("#1001");
      expect(m1[0].score).toBe(58);
      expect(getConfidenceBand(m1[0].score)).toBe("medium");

      expect(m2[0].invoiceName).toBe("#1002");
      expect(m2[0].score).toBe(58);
      expect(getConfidenceBand(m2[0].score)).toBe("medium");

      expect(m3[0].invoiceName).toBe("#1002");
      expect(m3[0].score).toBe(48);
      expect(getConfidenceBand(m3[0].score)).toBe("low");
    });

    it("all matches are 'suggested' state, nothing auto-confirmed", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      for (const paymentId of paymentIds) {
        const matches = await getMatchesForPayment(paymentId);
        for (const m of matches) {
          expect(m.state).toBe("suggested");
        }
      }
    });

    it("no payer aliases exist before confirm", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const aliases = await getPayerAliases();
      expect(aliases.length).toBe(0);
    });
  });

  describe("Step 2: Confirm row 2 match (stores alias)", () => {
    /**
     * Confirm row 2 (not row 1) because:
     * - Row 2 payerText: "TEST BUYER CO" → alias "test buyer"
     * - Row 1 payerText: "SYNT0001 TEST BUYER CO #1001" → different alias
     *
     * Confirming row 2 creates alias "test buyer" which helps both row 1 and row 3.
     */
    it("confirm creates payer alias from payment's payerText", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      expect(m2.length).toBeGreaterThan(0);

      const result = await confirmMatch(sql, testShopId, m2[0].id, "test-user");
      expect(result.success).toBe(true);

      const aliases = await getPayerAliases();
      expect(aliases.length).toBeGreaterThan(0);

      const expectedAlias = normalizeNarrationForLookup("TEST BUYER CO");
      expect(aliases).toContain(expectedAlias);
    });

    it("confirmed match state changes to 'confirmed'", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [confirmedMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${m2[0].id}
      `;
      expect(confirmedMatch.state).toBe("confirmed");
    });

    it("payment status updates to 'matched' after full allocation", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const status = await getPaymentStatus(paymentIds[1]);
      expect(status).toBe("matched");
    });
  });

  describe("Step 3: Re-import same statement after confirm", () => {
    /**
     * CRITICAL ASSERTIONS for re-import:
     * 1. Confirmed payment (row 2) is deduplicated (no new payment created)
     * 2. Unconfirmed payments (rows 1 and 3) get alias-boosted scores
     * 3. High band (80) still only suggests, never auto-confirms
     *
     * PINNED SCORES - With alias after confirm row 2:
     *
     * | Row | UTR      | Amount  | Top Candidate | Score | Band   |
     * |-----|----------|---------|---------------|-------|--------|
     * | 1   | SYNT0001 | ₹10,000 | #1001         | 80    | high   |
     * | 2   | SYNT0002 | ₹5,000  | (already confirmed, deduplicated) |
     * | 3   | SYNT0003 | ₹2,500  | #1002         | 70    | medium |
     *
     * Score breakdown (with alias):
     * - invoice_ref: +30 (#1001/#1002 in narration)
     * - amount_exact: +20 (row 1) / amount_partial: +10 (row 3)
     * - payer_alias: +30 (confirmed alias match)
     */
    it("re-import does not create duplicate payment for confirmed row", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [preReimportCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      expect(parseInt(preReimportCount.count, 10)).toBe(3);

      const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
      const file = new File([content], "hdfc-review-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const existingUtrs = await sql<{ utr: string }[]>`
        SELECT utr FROM "Payment" WHERE "shopId" = ${testShopId} AND utr IS NOT NULL
      `;
      const existingUtrSet = new Set(existingUtrs.map((r) => r.utr));

      const credits = result.transactions.filter((t) => t.direction === "CR");
      const newCredits = credits.filter((t) => !existingUtrSet.has(t.parsed.utr ?? ""));

      expect(newCredits.length).toBe(0);
    });

    it("re-matching unconfirmed payments with alias gives High (80) score for row 1", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'`;

      await runMatcher(sql, testShopId);

      const m1 = await getMatchesForPayment(paymentIds[0], "suggested");
      const m3 = await getMatchesForPayment(paymentIds[2], "suggested");

      expect(m1.length).toBeGreaterThan(0);
      expect(m3.length).toBeGreaterThan(0);

      expect(m1[0].invoiceName).toBe("#1001");
      expect(m1[0].score).toBe(80);
      expect(getConfidenceBand(m1[0].score)).toBe("high");

      expect(m3[0].invoiceName).toBe("#1002");
      expect(m3[0].score).toBe(70);
      expect(getConfidenceBand(m3[0].score)).toBe("medium");
    });

    it("High band (80) still only suggests, never auto-confirms", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'`;

      const matcherResult = await runMatcher(sql, testShopId);
      expect(matcherResult.highConfidenceMatches).toBe(1);

      const m1 = await getMatchesForPayment(paymentIds[0], "suggested");
      expect(m1.length).toBeGreaterThan(0);
      expect(m1[0].score).toBe(80);
      expect(m1[0].state).toBe("suggested");

      const confirmedMatches = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'confirmed'
      `;
      expect(parseInt(confirmedMatches[0].count, 10)).toBe(1);
    });

    it("no duplicate suggestion created for already-confirmed payment", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      await runMatcher(sql, testShopId);
      await runMatcher(sql, testShopId);

      const payment2Matches = await getMatchesForPayment(paymentIds[1]);
      const confirmedCount = payment2Matches.filter((m) => m.state === "confirmed").length;
      const suggestedCount = payment2Matches.filter((m) => m.state === "suggested").length;

      expect(confirmedCount).toBe(1);
      expect(suggestedCount).toBe(0);
    });
  });

  describe("Full E2E: confirm-then-re-import flow", () => {
    /**
     * Complete end-to-end test pinning the full flow:
     *
     * BEFORE CONFIRM (fresh store):
     * | UTR      | Score | Band   | State     |
     * |----------|-------|--------|-----------|
     * | SYNT0001 | 58    | medium | suggested |
     * | SYNT0002 | 58    | medium | suggested |
     * | SYNT0003 | 48    | low    | suggested |
     *
     * AFTER CONFIRM ROW 2 + RE-MATCH:
     * | UTR      | Score | Band   | State     |
     * |----------|-------|--------|-----------|
     * | SYNT0001 | 80    | high   | suggested | (alias boost)
     * | SYNT0002 | 58    | medium | confirmed | (no change)
     * | SYNT0003 | 70    | medium | suggested | (alias boost)
     */
    it("E2E: pins scores and bands through confirm-then-re-import", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const before1 = await getMatchesForPayment(paymentIds[0], "suggested");
      const before2 = await getMatchesForPayment(paymentIds[1], "suggested");
      const before3 = await getMatchesForPayment(paymentIds[2], "suggested");

      expect(before1[0].score).toBe(58);
      expect(before2[0].score).toBe(58);
      expect(before3[0].score).toBe(48);
      expect(getConfidenceBand(before1[0].score)).toBe("medium");
      expect(getConfidenceBand(before2[0].score)).toBe("medium");
      expect(getConfidenceBand(before3[0].score)).toBe("low");

      await confirmMatch(sql, testShopId, before2[0].id, "test-user");

      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'`;
      await runMatcher(sql, testShopId);

      const after1 = await getMatchesForPayment(paymentIds[0], "suggested");
      const after2 = await getMatchesForPayment(paymentIds[1]);
      const after3 = await getMatchesForPayment(paymentIds[2], "suggested");

      expect(after1[0].score).toBe(80);
      expect(getConfidenceBand(after1[0].score)).toBe("high");
      expect(after1[0].state).toBe("suggested");

      expect(after2.filter((m) => m.state === "confirmed").length).toBe(1);
      expect(after2.filter((m) => m.state === "confirmed")[0].score).toBe(58);

      expect(after3[0].score).toBe(70);
      expect(getConfidenceBand(after3[0].score)).toBe("medium");
      expect(after3[0].state).toBe("suggested");
    });

    it("audit event is created for confirmed match only", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [auditCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
      `;
      expect(parseInt(auditCount.count, 10)).toBe(1);
    });

    it("matcher idempotency: re-run does not create duplicates", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const m2 = await getMatchesForPayment(paymentIds[1], "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [countBefore] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match" WHERE "shopId" = ${testShopId}
      `;

      await runMatcher(sql, testShopId);
      await runMatcher(sql, testShopId);

      const [countAfter] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match" WHERE "shopId" = ${testShopId}
      `;

      expect(countBefore.count).toBe(countAfter.count);
    });
  });
});
