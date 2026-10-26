/**
 * DB integration test: Confirm-then-re-import flow for bank statement reconciliation.
 *
 * This test exercises the REAL import action path for re-importing a statement
 * after a match has been confirmed:
 * 1. Import synthetic credits via real import action (with valid NEFT UTRs)
 * 2. Confirm the suggested match, which stores the payer alias
 * 3. Re-import the same credits via real import action
 * 4. (Separate) Explicit runMatcher to verify alias-boosted scores
 *
 * Key behavior tested:
 * - Duplicate detection: second import returns 0 inserted, 3 duplicates, matcher: null
 * - Payment count unchanged after re-import
 * - No new Match created for the confirmed payment
 * - Re-import with 0 inserted does NOT re-run matcher (old suggestions unchanged)
 * - Alias-boosted scores (80/70) only happen when matcher runs (tested separately)
 * - High band (≥80) still only suggests, never auto-confirms
 *
 * IMPORTANT: This test uses valid NEFT UTR format (HDFCN + 11 digits) so that:
 * - The ON CONFLICT ("shopId", utr) clause in app.imports.tsx:506 is exercised
 * - The "re-import detects all 3 as duplicates" test FAILS if ON CONFLICT is removed
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 * All data is FICTIONAL - no real bank data. Uses test- domains for isolation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { confirmMatch, runMatcher } from "../../app/services/matcher.server.js";
import { CONFIDENCE_THRESHOLD } from "../../app/lib/matching/score.js";
import { normalizeNarrationForLookup } from "../../app/lib/matching/normalize.js";
import { assertNoQueueLeftovers } from "../helpers/queue-leftovers.js";
import { action as importAction } from "../../app/routes/app.imports.js";
import { requestContext } from "../../app/lib/request-context.server.js";

vi.mock("../../app/services/credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function createMockRequest(body: unknown): Request {
  return new Request("http://localhost/app/imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createMockContext(shopDomain: string) {
  return {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({
          session: { shop: shopDomain },
        }),
      },
    },
  };
}

async function callImportAction(
  sql: ReturnType<typeof postgres>,
  shopDomain: string,
  body: unknown
): Promise<Response> {
  const request = createMockRequest(body);
  const context = createMockContext(shopDomain);
  const url = new URL(request.url);

  return requestContext.run({ getSql: () => sql }, async () => {
    return importAction({
      request,
      context: context as never,
      params: {},
      url,
      pattern: "/app/imports",
    });
  });
}

function getUtcDateString(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function makeValidNeftUtr(suffix: string): string {
  const paddedSuffix = suffix.replace(/[^0-9]/g, "").padStart(11, "0").slice(0, 11);
  return `HDFCN${paddedSuffix}`;
}

interface ImportResult {
  success: boolean;
  importId?: string;
  error?: string;
  details?: string[];
  counts?: {
    inserted: number;
    duplicates: number;
    rejected: number;
    total: number;
  };
  matcher?: {
    paymentsProcessed: number;
    matchesCreated: number;
    highConfidenceMatches: number;
    hasMore: boolean;
  } | null;
}

describeWithDb("Confirm-then-re-import flow: synthetic NEFT credits", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-confirm-reimport-${runId}.myshopify.com`;

  const buyerId = `buyer-confirm-reimport-${runId}`;
  const invoice1Id = `invoice-reimport-1-${runId}`;
  const invoice2Id = `invoice-reimport-2-${runId}`;

  const DEMO_BUYER = {
    name: "Test Buyer Co",
  };

  const UTR1 = makeValidNeftUtr("10000000001");
  const UTR2 = makeValidNeftUtr("10000000002");
  const UTR3 = makeValidNeftUtr("10000000003");

  function makeSyntheticCredits() {
    return [
      {
        date: getUtcDateString(5),
        amountPaise: 1000000,
        rail: "NEFT",
        utr: UTR1,
        payerName: "SYNT0001 TEST BUYER CO #1001",
        narration: `NEFT CR-SYNT0001-TEST BUYER CO-#1001`,
      },
      {
        date: getUtcDateString(4),
        amountPaise: 500000,
        rail: "NEFT",
        utr: UTR2,
        payerName: "TEST BUYER CO",
        narration: `NEFT CR-TEST BUYER CO-#1002`,
      },
      {
        date: getUtcDateString(3),
        amountPaise: 250000,
        rail: "NEFT",
        utr: UTR3,
        payerName: "TEST BUYER CO",
        narration: `NEFT CR-TEST BUYER CO-#1002 PART PAYMENT`,
      },
    ];
  }

  function makeImportPayload() {
    return {
      bank: "HDFC",
      fileName: "confirm-reimport-synthetic.csv",
      credits: makeSyntheticCredits(),
    };
  }

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
        'gid://shopify/Order/1001', '#1001', 10000, 'open', 10000,
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
        'gid://shopify/Order/1002', '#1002', 5000, 'open', 5000,
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

    await sql`
      UPDATE "Invoice"
      SET outstanding = total, status = 'open', "updatedAt" = NOW()
      WHERE "shopId" = ${testShopId}
    `;
  });

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

  async function getPaymentsByUtr(): Promise<
    Array<{
      id: string;
      utr: string;
      status: string;
      amount: number;
    }>
  > {
    const payments = await sql<
      Array<{ id: string; utr: string; status: string; amount: string }>
    >`
      SELECT id, utr, status, amount::text
      FROM "Payment"
      WHERE "shopId" = ${testShopId}
      ORDER BY utr
    `;
    return payments.map((p) => ({
      ...p,
      amount: parseFloat(p.amount),
    }));
  }

  async function getPayerAliases(): Promise<string[]> {
    const aliases = await sql<{ payer_key: string }[]>`
      SELECT "payerKey" AS payer_key FROM "PayerAlias"
      WHERE "buyerAccountId" = ${testBuyerId}
    `;
    return aliases.map((a) => a.payer_key);
  }

  describe("Step 1: Initial import via real action (no alias)", () => {
    /**
     * PINNED SCORES - Fresh store, no aliases:
     *
     * | Row | UTR  | Amount  | Top Candidate | Score | Band   |
     * |-----|------|---------|---------------|-------|--------|
     * | 1   | UTR1 | ₹10,000 | #1001         | 58    | medium |
     * | 2   | UTR2 | ₹5,000  | #1002         | 58    | medium |
     * | 3   | UTR3 | ₹2,500  | #1002         | 48    | low    |
     *
     * Score breakdown (no alias):
     * - invoice_ref: +30 (#1001/#1002 in narration)
     * - amount_exact: +20 (row 1, 2) / amount_partial: +10 (row 3)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO")
     */
    it("imports 3 credits via real action and pins scores 58/58/48", async () => {
      const importPayload = makeImportPayload();

      const response = await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
      expect(response.status).toBe(200);

      const data = (await response.json()) as ImportResult;
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(3);
      expect(data.counts?.duplicates).toBe(0);

      const payments = await getPaymentsByUtr();
      expect(payments.length).toBe(3);

      const p1 = payments.find((p) => p.utr === UTR1);
      const p2 = payments.find((p) => p.utr === UTR2);
      const p3 = payments.find((p) => p.utr === UTR3);

      expect(p1).toBeDefined();
      expect(p2).toBeDefined();
      expect(p3).toBeDefined();

      const m1 = await getMatchesForPayment(p1!.id, "suggested");
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      const m3 = await getMatchesForPayment(p3!.id, "suggested");

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
      const importPayload = makeImportPayload();
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      for (const payment of payments) {
        const matches = await getMatchesForPayment(payment.id);
        for (const m of matches) {
          expect(m.state).toBe("suggested");
        }
      }
    });

    it("no payer aliases exist before confirm", async () => {
      const importPayload = makeImportPayload();
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const aliases = await getPayerAliases();
      expect(aliases.length).toBe(0);
    });
  });

  describe("Step 2: Confirm row 2 match (stores alias)", () => {
    /**
     * Confirm row 2 (not row 1) because:
     * - Row 2 payerName: "TEST BUYER CO" → alias "test buyer"
     * - Row 1 payerName: "SYNT0001 TEST BUYER CO #1001" → different alias
     *
     * Confirming row 2 creates alias "test buyer" which helps both row 1 and row 3.
     */
    it("confirm creates payer alias from payment's payerText", async () => {
      const importPayload = makeImportPayload();
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      expect(p2).toBeDefined();

      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      expect(m2.length).toBeGreaterThan(0);

      const result = await confirmMatch(sql, testShopId, m2[0].id, "test-user");
      expect(result.success).toBe(true);

      const aliases = await getPayerAliases();
      expect(aliases.length).toBeGreaterThan(0);

      const expectedAlias = normalizeNarrationForLookup("TEST BUYER CO");
      expect(aliases).toContain(expectedAlias);
    });

    it("confirmed match state changes to 'confirmed'", async () => {
      const importPayload = makeImportPayload();
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [confirmedMatch] = await sql<{ state: string }[]>`
        SELECT state FROM "Match" WHERE id = ${m2[0].id}
      `;
      expect(confirmedMatch.state).toBe("confirmed");
    });

    it("payment status updates to 'matched' after full allocation", async () => {
      const importPayload = makeImportPayload();
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [payment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${p2!.id}
      `;
      expect(payment.status).toBe("matched");
    });
  });

  describe("Step 3: Re-import same statement via real action", () => {
    /**
     * CRITICAL ASSERTIONS for re-import via real import action:
     * 1. All 3 payments are duplicates (0 inserted, 3 duplicates)
     *    - This exercises ON CONFLICT ("shopId", utr) in app.imports.tsx:506
     *    - If that clause is removed, this test FAILS (would insert 3 more)
     * 2. matcher: null (only runs when inserted > 0, per app.imports.tsx:525)
     * 3. Payment count unchanged (still 3)
     * 4. No new Match for confirmed payment (row 2)
     * 5. Unconfirmed payments keep original scores (matcher didn't re-run)
     *
     * PINNED STATE - After confirm row 2 + re-import (matcher not re-run):
     *
     * | Row | UTR  | Amount  | Score | Band   | State     |
     * |-----|------|---------|-------|--------|-----------|
     * | 1   | UTR1 | ₹10,000 | 58    | medium | suggested | (unchanged)
     * | 2   | UTR2 | ₹5,000  | 58    | medium | confirmed |
     * | 3   | UTR3 | ₹2,500  | 48    | low    | suggested | (unchanged)
     */
    it("re-import detects all 3 as duplicates (exercises ON CONFLICT)", async () => {
      const importPayload = makeImportPayload();

      // First import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      // Confirm row 2
      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      // Re-import (same UTRs should hit ON CONFLICT)
      const response = await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
      expect(response.status).toBe(200);

      const data = (await response.json()) as ImportResult;
      expect(data.success).toBe(true);
      expect(data.counts?.inserted).toBe(0);
      expect(data.counts?.duplicates).toBe(3);
    });

    it("payment count unchanged after re-import", async () => {
      const importPayload = makeImportPayload();

      // First import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const [countBefore] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      expect(parseInt(countBefore.count, 10)).toBe(3);

      // Confirm row 2
      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      // Re-import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const [countAfter] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Payment" WHERE "shopId" = ${testShopId}
      `;
      expect(parseInt(countAfter.count, 10)).toBe(3);
    });

    it("no new Match created for confirmed payment after re-import", async () => {
      const importPayload = makeImportPayload();

      // First import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      // Confirm row 2
      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2Before = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2Before[0].id, "test-user");

      const [matchCountBefore] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "paymentId" = ${p2!.id} AND "shopId" = ${testShopId}
      `;

      // Re-import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const [matchCountAfter] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "paymentId" = ${p2!.id} AND "shopId" = ${testShopId}
      `;

      expect(parseInt(matchCountAfter.count, 10)).toBe(parseInt(matchCountBefore.count, 10));

      const m2After = await getMatchesForPayment(p2!.id);
      const confirmedCount = m2After.filter((m) => m.state === "confirmed").length;
      const suggestedCount = m2After.filter((m) => m.state === "suggested").length;
      expect(confirmedCount).toBe(1);
      expect(suggestedCount).toBe(0);
    });

    it("re-import with 0 inserted does not re-run matcher (suggestions unchanged)", async () => {
      const importPayload = makeImportPayload();

      // First import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      // Confirm row 2
      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      // Capture scores before re-import
      const p1 = payments.find((p) => p.utr === UTR1);
      const p3 = payments.find((p) => p.utr === UTR3);
      const m1Before = await getMatchesForPayment(p1!.id, "suggested");
      const m3Before = await getMatchesForPayment(p3!.id, "suggested");

      // Re-import (0 inserted = matcher does NOT run)
      const response = await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
      const data = (await response.json()) as ImportResult;

      // Verify matcher didn't run (null when 0 inserted)
      expect(data.matcher).toBeNull();

      // Suggestions should be unchanged (original scores, not alias-boosted)
      const m1After = await getMatchesForPayment(p1!.id, "suggested");
      const m3After = await getMatchesForPayment(p3!.id, "suggested");

      expect(m1After[0].score).toBe(m1Before[0].score);
      expect(m3After[0].score).toBe(m3Before[0].score);
    });
  });

  describe("Full E2E: confirm-then-re-import flow", () => {
    /**
     * Complete end-to-end test pinning the full flow:
     *
     * BEFORE CONFIRM (fresh store):
     * | UTR  | Score | Band   | State     |
     * |------|-------|--------|-----------|
     * | UTR1 | 58    | medium | suggested |
     * | UTR2 | 58    | medium | suggested |
     * | UTR3 | 48    | low    | suggested |
     *
     * AFTER CONFIRM ROW 2 + RE-IMPORT:
     * - Row 2 is confirmed (score 58)
     * - Rows 1 and 3 keep original suggestions (58/48) because:
     *   - Re-import detects all 3 as duplicates (0 inserted)
     *   - Matcher only runs when inserted > 0
     *   - Old suggestions remain unchanged
     */
    it("E2E: pins deduplication and confirm state through re-import", async () => {
      const importPayload = makeImportPayload();

      // First import
      const firstResponse = await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
      const firstData = (await firstResponse.json()) as ImportResult;
      expect(firstData.counts?.inserted).toBe(3);

      const payments = await getPaymentsByUtr();
      const p1 = payments.find((p) => p.utr === UTR1);
      const p2 = payments.find((p) => p.utr === UTR2);
      const p3 = payments.find((p) => p.utr === UTR3);

      // Pin scores before confirm
      const before1 = await getMatchesForPayment(p1!.id, "suggested");
      const before2 = await getMatchesForPayment(p2!.id, "suggested");
      const before3 = await getMatchesForPayment(p3!.id, "suggested");

      expect(before1[0].score).toBe(58);
      expect(before2[0].score).toBe(58);
      expect(before3[0].score).toBe(48);
      expect(getConfidenceBand(before1[0].score)).toBe("medium");
      expect(getConfidenceBand(before2[0].score)).toBe("medium");
      expect(getConfidenceBand(before3[0].score)).toBe("low");

      // Confirm row 2
      await confirmMatch(sql, testShopId, before2[0].id, "test-user");

      // Re-import (all duplicates, matcher doesn't run)
      const secondResponse = await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);
      const secondData = (await secondResponse.json()) as ImportResult;
      expect(secondData.counts?.inserted).toBe(0);
      expect(secondData.counts?.duplicates).toBe(3);
      expect(secondData.matcher).toBeNull();

      // Verify row 2 confirm is unchanged
      const after2 = await getMatchesForPayment(p2!.id);
      expect(after2.filter((m) => m.state === "confirmed").length).toBe(1);
      expect(after2.filter((m) => m.state === "confirmed")[0].score).toBe(58);

      // Rows 1 and 3 keep original suggested scores (matcher didn't run)
      const after1 = await getMatchesForPayment(p1!.id, "suggested");
      const after3 = await getMatchesForPayment(p3!.id, "suggested");
      expect(after1[0].score).toBe(58);
      expect(after3[0].score).toBe(48);
    });

    it("audit event is created for confirmed match only", async () => {
      const importPayload = makeImportPayload();
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      const p2 = payments.find((p) => p.utr === UTR2);
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      const [auditCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "AuditEvent"
        WHERE "shopId" = ${testShopId} AND type = 'match.confirmed'
      `;
      expect(parseInt(auditCount.count, 10)).toBe(1);
    });
  });

  describe("Alias-boosted scores (after explicit matcher run)", () => {
    /**
     * This tests what happens when the matcher runs AFTER an alias is created.
     * The re-import flow doesn't trigger this (0 inserted = no matcher run),
     * but a manual matcher run or a later import with new credits would.
     *
     * PINNED SCORES - After confirm row 2 + explicit matcher run:
     *
     * | UTR  | Amount  | Top Candidate | Score | Band   | State     |
     * |------|---------|---------------|-------|--------|-----------|
     * | UTR1 | ₹10,000 | #1001         | 80    | high   | suggested |
     * | UTR2 | ₹5,000  | #1002         | 58    | medium | confirmed |
     * | UTR3 | ₹2,500  | #1002         | 70    | medium | suggested |
     *
     * Score breakdown (with alias):
     * - invoice_ref: +30 (#1001/#1002 in narration)
     * - amount_exact: +20 (row 1) / amount_partial: +10 (row 3)
     * - payer_alias: +30 (confirmed alias match)
     */
    it("explicit runMatcher after confirm gives alias-boosted 80/70 scores", async () => {
      const importPayload = makeImportPayload();

      // First import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      const p1 = payments.find((p) => p.utr === UTR1);
      const p2 = payments.find((p) => p.utr === UTR2);
      const p3 = payments.find((p) => p.utr === UTR3);

      // Confirm row 2 (creates alias "test buyer")
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      // Explicitly run matcher (simulates what would happen if matcher is triggered)
      const matcherResult = await runMatcher(sql, testShopId);

      // Matcher processes unconfirmed payments with alias
      expect(matcherResult.paymentsProcessed).toBe(2);
      expect(matcherResult.highConfidenceMatches).toBe(1);

      // Pin alias-boosted scores
      const m1 = await getMatchesForPayment(p1!.id, "suggested");
      const m3 = await getMatchesForPayment(p3!.id, "suggested");

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
      const importPayload = makeImportPayload();

      // First import
      await callImportAction(sql, TEST_SHOP_DOMAIN, importPayload);

      const payments = await getPaymentsByUtr();
      const p1 = payments.find((p) => p.utr === UTR1);
      const p2 = payments.find((p) => p.utr === UTR2);

      // Confirm row 2
      const m2 = await getMatchesForPayment(p2!.id, "suggested");
      await confirmMatch(sql, testShopId, m2[0].id, "test-user");

      // Explicitly run matcher
      const matcherResult = await runMatcher(sql, testShopId);
      expect(matcherResult.highConfidenceMatches).toBe(1);

      // Row 1 has high score but is still suggested (not auto-confirmed)
      const m1 = await getMatchesForPayment(p1!.id, "suggested");
      expect(m1.length).toBeGreaterThan(0);
      expect(m1[0].score).toBe(80);
      expect(m1[0].state).toBe("suggested");

      // Total confirmed matches should still be 1 (only the manually confirmed one)
      const confirmedMatches = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'confirmed'
      `;
      expect(parseInt(confirmedMatches[0].count, 10)).toBe(1);
    });
  });
});
