/**
 * DB integration test: Real matcher path for reviewer CSV (v3).
 *
 * This test exercises the ACTUAL app path through matchSinglePayment:
 * 1. Buyer identification via findBestBuyerMatch
 * 2. Candidate filtering via 0.5x-2x amount window (when no buyer found)
 * 3. Scoring via scoreMultiInvoiceMatch
 *
 * Unlike the unit-level test (review-csv-scorer.test.ts), this test:
 * - Seeds real DB rows (Shop, BuyerAccount, Invoice, BankImport, Payment)
 * - Runs the actual runMatcher function
 * - Pins whatever the matcher produces (no tuning)
 *
 * The test uses the reviewer demo amounts from scripts/seed.ts:
 * - Invoice #1001: ₹10,000 (exact match for CSV row 1)
 * - Invoice #1002: ₹5,000 (exact match for CSV row 2, partial for row 3)
 *
 * CSV v3 changes:
 * - Row 2: UPI-TEST BUYER CO-SYNT0002-#1002, ₹5,000.00 (was ₹4,000)
 * - Row 3: IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT, ₹2,500.00
 *
 * All data is FICTIONAL - no real bank data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import { runMatcher } from "../../app/services/matcher.server.js";
import { CONFIDENCE_THRESHOLD } from "../../app/lib/matching/score.js";
import { normalizeNarrationForLookup } from "../../app/lib/matching/normalize.js";
import { REVIEWER_DEMO_AMOUNTS, REVIEWER_DEMO_BUYER } from "../fixtures/reviewer-demo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

describeWithDb("Reviewer CSV v3: Real matcher DB path", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  // Use test-* style domain with unique suffix to avoid collisions
  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-reviewer-demo-${runId}.myshopify.com`;
  
  // Per-run unique IDs to avoid collisions from crashed runs
  const buyerId = `buyer-reviewer-demo-${runId}`;
  const invoice1Id = `invoice-reviewer-1-${runId}`;
  const invoice2Id = `invoice-reviewer-2-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create buyer account (no aliases - fresh store behavior)
    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/reviewer-demo', 'gid://shopify/CompanyLocation/reviewer-demo',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create Invoice #1001: ₹10,000
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice1Id}, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/1001', '#1001', ${REVIEWER_DEMO_AMOUNTS.order1}, 'open', ${REVIEWER_DEMO_AMOUNTS.order1},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    // Create Invoice #1002: ₹5,000
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice2Id}, ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/1002', '#1002', ${REVIEWER_DEMO_AMOUNTS.order2}, 'open', ${REVIEWER_DEMO_AMOUNTS.order2},
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up test data
    if (sql) {
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    // Clear payments and matches before each test
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
  });

  /**
   * Seed payments from the reviewer CSV using the real parser.
   */
  async function seedPaymentsFromCsv(): Promise<void> {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
    const file = new File([content], "hdfc-review-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    // Create bank import
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${result.detection.bank}, 'hdfc-review-synthetic.csv', ${result.transactions.length}, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // Create payments for credits only
    const credits = result.transactions.filter((t) => t.direction === "CR");
    for (const txn of credits) {
      const [payment] = await sql<{ id: string }[]>`
        INSERT INTO "Payment" (
          id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${testImportId},
          ${txn.date}::date, ${txn.amountPaise / 100}::decimal, ${txn.parsed.rail}, ${txn.parsed.utr ?? null},
          ${txn.parsed.payerName ?? null}, ${txn.narration}, 'unmatched', NOW(), NOW()
        )
        RETURNING id
      `;
      paymentIds.push(payment.id);
    }
  }

  /**
   * Get match results for a payment.
   */
  async function getMatchesForPayment(paymentId: string): Promise<Array<{
    invoiceId: string;
    invoiceName: string;
    score: number;
    amount: number;
  }>> {
    const matches = await sql<Array<{
      invoiceId: string;
      invoiceName: string;
      score: number;
      amount: string;
    }>>`
      SELECT 
        m."invoiceId" AS "invoiceId",
        i.name AS "invoiceName",
        m.score,
        m.amount
      FROM "Match" m
      JOIN "Invoice" i ON i.id = m."invoiceId"
      WHERE m."paymentId" = ${paymentId}
        AND m.state = 'suggested'
      ORDER BY m.score DESC
    `;
    return matches.map((m) => ({
      ...m,
      amount: parseFloat(m.amount),
    }));
  }

  it("seeds 3 credit payments from CSV v3", async () => {
    await seedPaymentsFromCsv();
    expect(paymentIds.length).toBe(3);
  });

  it("runs matcher and produces results", async () => {
    await seedPaymentsFromCsv();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(3);
  });

  /**
   * Row 1: NEFT-SYNT0001-TEST BUYER CO-#1001, ₹10,000.00
   *
   * Buyer identified via findBestBuyerMatch ("TEST BUYER CO" fuzzy matches buyer name).
   * Scoring against buyer's invoices:
   * - invoice_ref: +30 (#1001 in narration matches invoice name)
   * - amount_exact: +20 (payment ₹10,000 = invoice ₹10,000)
   * - payer_name: +8 (fuzzy match)
   * - Total: 58 points, MEDIUM band
   */
  it("Row 1: pins ₹10,000 payment → #1001, score 58, medium", async () => {
    await seedPaymentsFromCsv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[0]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1001");
    expect(topMatch.score).toBe(58);
    expect(getConfidenceBand(topMatch.score)).toBe("medium");
    expect(topMatch.amount).toBe(10000);
  });

  /**
   * Row 2: UPI-TEST BUYER CO-SYNT0002-#1002, ₹5,000.00 (CSV v3)
   *
   * Buyer identified via findBestBuyerMatch ("TEST BUYER CO" in narration).
   * Scoring:
   * - invoice_ref: +30 (#1002 in narration matches invoice name)
   * - amount_exact: +20 (payment ₹5,000 = invoice ₹5,000)
   * - payer_name: +8 (fuzzy match)
   * - Total: 58 points, MEDIUM band
   */
  it("Row 2: pins ₹5,000 payment → #1002, score 58, medium", async () => {
    await seedPaymentsFromCsv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[1]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(58);
    expect(getConfidenceBand(topMatch.score)).toBe("medium");
    expect(topMatch.amount).toBe(5000);
  });

  /**
   * Row 3: IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT, ₹2,500.00 (CSV v3)
   *
   * Buyer identified via findBestBuyerMatch ("TEST BUYER CO" in narration).
   * Scoring:
   * - invoice_ref: +30 (#1002 in narration matches invoice name)
   * - amount_partial: +10 (payment ₹2,500 < invoice ₹5,000)
   * - payer_name: +8 (fuzzy match)
   * - Total: 48 points, LOW band
   */
  it("Row 3: pins ₹2,500 payment → #1002, score 48, low", async () => {
    await seedPaymentsFromCsv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[2]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(48);
    expect(getConfidenceBand(topMatch.score)).toBe("low");
    expect(topMatch.amount).toBe(2500);
  });

  /**
   * Summary of pinned real matcher results (CSV v3):
   *
   * | Row | Amount  | PayerText          | Top Candidate | Score | Band   | Allocation |
   * |-----|---------|-------------------|---------------|-------|--------|------------|
   * | 1   | ₹10,000 | TEST BUYER CO...  | #1001         | 58    | medium | ₹10,000    |
   * | 2   | ₹5,000  | TEST BUYER CO...  | #1002         | 58    | medium | ₹5,000     |
   * | 3   | ₹2,500  | TEST BUYER CO...  | #1002         | 48    | low    | ₹2,500     |
   *
   * KEY FINDINGS:
   * - All rows now have "TEST BUYER CO" in the narration for buyer identification
   * - Rows 1 and 2 are MEDIUM (58), Row 3 is LOW (48) due to partial payment
   * - High (80) requires a confirmed payer alias (+30); without one the best is Medium (58)
   */
  it("documents pinned results table", async () => {
    await seedPaymentsFromCsv();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(3);
    expect(result.highConfidenceMatches).toBe(0);
  });

  /**
   * Test with confirmed payer alias seeded.
   *
   * When a PayerAlias is seeded for the buyer (simulating a previously confirmed match),
   * the payer_alias signal provides +30 points instead of payer_name's +8 points.
   *
   * Score breakdown with alias:
   * - invoice_ref: +30 (#1001 in narration matches invoice name)
   * - amount_exact: +20 (payment ₹10,000 = invoice ₹10,000)
   * - payer_alias: +30 (confirmed alias match)
   * - Total: 80 points, HIGH band
   *
   * Unaliased rows remain unchanged (58/58/48).
   */
  describe("with confirmed alias seeded", () => {
    const aliasId = `alias-reviewer-demo-${Date.now()}`;
    // Payer text extracted from fixture's narration by the parser
    const FIXTURE_PAYER_TEXT = "TEST BUYER CO";
    // Compute the alias value the same way confirmMatch does
    const aliasKey = normalizeNarrationForLookup(FIXTURE_PAYER_TEXT);

    beforeEach(async () => {
      // Seed a confirmed alias for the buyer using the normalized value
      // that confirmMatch would actually store
      await sql`
        INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
        VALUES (${aliasId}, ${testBuyerId}, ${aliasKey}, NOW())
        ON CONFLICT DO NOTHING
      `;
    });

    afterEach(async () => {
      await sql`DELETE FROM "PayerAlias" WHERE id = ${aliasId}`;
    });

    it("Row 1 with alias: pins ₹10,000 payment → #1001, score 80, high", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const matches = await getMatchesForPayment(paymentIds[0]);
      expect(matches.length).toBeGreaterThan(0);

      const topMatch = matches[0];
      expect(topMatch.invoiceName).toBe("#1001");
      expect(topMatch.score).toBe(80);
      expect(getConfidenceBand(topMatch.score)).toBe("high");
      expect(topMatch.amount).toBe(10000);
    });

    it("Row 2 with alias: pins ₹5,000 payment → #1002, score 80, high", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const matches = await getMatchesForPayment(paymentIds[1]);
      expect(matches.length).toBeGreaterThan(0);

      const topMatch = matches[0];
      expect(topMatch.invoiceName).toBe("#1002");
      expect(topMatch.score).toBe(80);
      expect(getConfidenceBand(topMatch.score)).toBe("high");
      expect(topMatch.amount).toBe(5000);
    });

    it("Row 3 with alias: pins ₹2,500 payment → #1002, score 70, medium", async () => {
      await seedPaymentsFromCsv();
      await runMatcher(sql, testShopId);

      const matches = await getMatchesForPayment(paymentIds[2]);
      expect(matches.length).toBeGreaterThan(0);

      const topMatch = matches[0];
      expect(topMatch.invoiceName).toBe("#1002");
      expect(topMatch.score).toBe(70);
      expect(getConfidenceBand(topMatch.score)).toBe("medium");
      expect(topMatch.amount).toBe(2500);
    });

    it("with alias: highConfidenceMatches = 2 (exact amounts only)", async () => {
      await seedPaymentsFromCsv();
      const result = await runMatcher(sql, testShopId);
      expect(result.paymentsProcessed).toBe(3);
      expect(result.highConfidenceMatches).toBe(2);
    });
  });

  /**
   * End-to-end pin test for alias learning and re-import behavior.
   *
   * This test verifies the full flow through the real app path:
   * 1. Import statement → creates suggested matches
   * 2. Confirm a match → stores PayerAlias via confirmMatch
   * 3. Re-import same statement → new payments get alias bonus
   * 4. Assert: already-matched payment has no duplicate suggestion
   * 5. Assert: High band still only suggests, never auto-confirms
   *
   * Uses SYNT00999888777 fixture (the account number in hdfc-review-synthetic.csv).
   */
  describe("end-to-end: confirm → re-import → no duplicate, no auto-confirm", () => {
    it("confirms a match, stores alias, re-import gets High but stays suggested", async () => {
      // STEP 1: First import - seed payments from CSV
      await seedPaymentsFromCsv();
      expect(paymentIds.length).toBe(3);
      const firstPaymentId = paymentIds[0];

      // STEP 2: Run matcher - creates suggested matches
      const firstRun = await runMatcher(sql, testShopId);
      expect(firstRun.paymentsProcessed).toBe(3);

      // Get the suggested match for first payment
      const [suggestedMatch] = await sql<{ id: string; score: number; state: string }[]>`
        SELECT id, score, state
        FROM "Match"
        WHERE "paymentId" = ${firstPaymentId}
          AND "shopId" = ${testShopId}
          AND state = 'suggested'
        ORDER BY score DESC
        LIMIT 1
      `;
      expect(suggestedMatch).toBeDefined();
      expect(suggestedMatch.state).toBe("suggested");
      expect(suggestedMatch.score).toBe(58); // Medium: invoice_ref(30) + amount_exact(20) + payer_name(8)

      // STEP 3: Confirm the match - this stores the alias
      const { confirmMatch } = await import("../../app/services/matcher.server.js");
      const confirmResult = await confirmMatch(sql, testShopId, suggestedMatch.id, "test-user");
      expect(confirmResult.success).toBe(true);

      // Verify the payment is now matched
      const [matchedPayment] = await sql<{ status: string }[]>`
        SELECT status FROM "Payment" WHERE id = ${firstPaymentId}
      `;
      expect(matchedPayment.status).toBe("matched");

      // Verify alias was stored (the exact value depends on what the parser extracts as payerText)
      const [storedAlias] = await sql<{ payer_key: string }[]>`
        SELECT "payerKey" AS payer_key
        FROM "PayerAlias"
        WHERE "buyerAccountId" = ${testBuyerId}
        ORDER BY "createdAt" DESC
        LIMIT 1
      `;
      expect(storedAlias).toBeDefined();
      expect(storedAlias.payer_key.length).toBeGreaterThan(0);

      // STEP 4: Simulate re-import - create NEW payments from the same CSV
      // (This simulates a user re-uploading the same statement)
      const reimportPaymentIds: string[] = [];
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
      const file = new File([content], "hdfc-review-synthetic-reimport.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      // Create a new bank import for the re-import
      const [reimport] = await sql<{ id: string }[]>`
        INSERT INTO "BankImport" (
          id, "shopId", bank, "fileName", "rowCount", "createdAt"
        )
        VALUES (
          gen_random_uuid()::text, ${testShopId}, ${result.detection.bank}, 'hdfc-review-synthetic-reimport.csv', ${result.transactions.length}, NOW()
        )
        RETURNING id
      `;

      // Create new payments for credits only
      const credits = result.transactions.filter((t) => t.direction === "CR");
      for (const txn of credits) {
        const [payment] = await sql<{ id: string }[]>`
          INSERT INTO "Payment" (
            id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
          )
          VALUES (
            gen_random_uuid()::text, ${testShopId}, ${reimport.id},
            ${txn.date}::date, ${txn.amountPaise / 100}::decimal, ${txn.parsed.rail}, ${txn.parsed.utr ?? null},
            ${txn.parsed.payerName ?? null}, ${txn.narration}, 'unmatched', NOW(), NOW()
          )
          RETURNING id
        `;
        reimportPaymentIds.push(payment.id);
      }
      expect(reimportPaymentIds.length).toBe(3);

      // STEP 5: Run matcher again
      const secondRun = await runMatcher(sql, testShopId);

      // ASSERT: Original matched payment is NOT reprocessed (only 'unmatched' payments are processed)
      // The secondRun should only process the 3 new payments
      expect(secondRun.paymentsProcessed).toBe(3);

      // ASSERT: New payments get the alias bonus (score should be 80 = High)
      const reimportMatches = await sql<{ payment_id: string; score: number; state: string }[]>`
        SELECT "paymentId" AS payment_id, score, state
        FROM "Match"
        WHERE "paymentId" IN ${sql(reimportPaymentIds)}
          AND "shopId" = ${testShopId}
          AND state = 'suggested'
        ORDER BY score DESC
      `;

      // Find matches for exact-amount payments (should be High with alias)
      const highMatches = reimportMatches.filter((m) => m.score >= 80);
      expect(highMatches.length).toBe(2); // Two exact-amount payments get High

      // ASSERT: High band still only suggests, NEVER auto-confirms
      for (const match of highMatches) {
        expect(match.state).toBe("suggested"); // NOT 'confirmed'
      }

      // ASSERT: No duplicate suggestions for the original matched payment
      const originalPaymentSuggestions = await sql<{ id: string }[]>`
        SELECT id
        FROM "Match"
        WHERE "paymentId" = ${firstPaymentId}
          AND "shopId" = ${testShopId}
          AND state = 'suggested'
      `;
      expect(originalPaymentSuggestions.length).toBe(0); // No new suggestions for already-matched payment

      // Verify the confirmed match is still there
      const [confirmedMatch] = await sql<{ state: string }[]>`
        SELECT state
        FROM "Match"
        WHERE id = ${suggestedMatch.id}
      `;
      expect(confirmedMatch.state).toBe("confirmed");
    });
  });
});
