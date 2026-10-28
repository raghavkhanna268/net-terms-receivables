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
});

/**
 * Amount window fallback tests.
 *
 * When a company has multiple location accounts with similar names (e.g.
 * 'Test Buyer Co' and 'Test Buyer Co - Net-30'), fuzzy name matching may
 * resolve to an account with no open invoices while a sibling account has
 * the correct invoice. The matcher should fall back to the amount window
 * to find candidates from other accounts.
 */
describeWithDb("Amount window fallback: resolved buyer with no invoices", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let _buyerAId: string;
  let buyerBId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-fallback-${runId}.myshopify.com`;

  const buyerAIdValue = `buyer-a-fallback-${runId}`;
  const buyerBIdValue = `buyer-b-fallback-${runId}`;
  const invoice1001Id = `invoice-fallback-1001-${runId}`;
  const invoice1002Id = `invoice-fallback-1002-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create buyer A: 'Test Buyer Co' - exact name match, will win buyer resolution
    // Created FIRST so it appears first in query results (tests ORDER BY)
    const [buyerA] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerAIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/fallback-a', 'gid://shopify/CompanyLocation/fallback-a',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    _buyerAId = buyerA.id;

    // Create buyer B: 'Test Buyer Co - Net-30' - will have invoices
    // Created SECOND with slightly later timestamp
    const [buyerB] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerBIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/fallback-b', 'gid://shopify/CompanyLocation/fallback-b',
        'Test Buyer Co - Net-30', 100000, 'OK', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second'
      )
      RETURNING id
    `;
    buyerBId = buyerB.id;

    // Buyer A has NO invoices (the bug condition)

    // Buyer B has invoices #1001 and #1002
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice1001Id}, ${testShopId}, ${buyerBId},
        'gid://shopify/Order/fallback-1001', '#1001', 10000, 'open', 10000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice1002Id}, ${testShopId}, ${buyerBId},
        'gid://shopify/Order/fallback-1002', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
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
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
  });

  async function seedFallbackPayments(): Promise<void> {
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'fallback-test.csv', 2, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // L14 equivalent: UPI-TEST BUYER CO-SYNT0002-#1002, ₹5,000
    const [payment1] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        '2026-10-23'::date, 5000, 'UPI', 'SYNT0002',
        'TEST BUYER CO', 'UPI-TEST BUYER CO-SYNT0002-#1002', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    paymentIds.push(payment1.id);

    // L15 equivalent: IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT, ₹2,500
    const [payment2] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        '2026-10-24'::date, 2500, 'IMPS', 'SYNT0003',
        'TEST BUYER CO', 'IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    paymentIds.push(payment2.id);
  }

  async function getMatchesForPayment(paymentId: string): Promise<Array<{
    invoiceId: string;
    invoiceName: string;
    score: number;
    amount: number;
    buyerAccountId: string;
  }>> {
    const matches = await sql<Array<{
      invoiceId: string;
      invoiceName: string;
      score: number;
      amount: string;
      buyerAccountId: string;
    }>>`
      SELECT 
        m."invoiceId" AS "invoiceId",
        i.name AS "invoiceName",
        m.score,
        m.amount,
        i."buyerAccountId" AS "buyerAccountId"
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

  /**
   * L14: UPI-TEST BUYER CO-SYNT0002-#1002, ₹5,000
   *
   * Buyer A ('Test Buyer Co') wins the name match (exact match).
   * Buyer A has no invoices, so fallback to amount window.
   * Amount window returns buyer B's invoices.
   * Scoring:
   * - invoice_ref: +30 (#1002 in narration matches invoice name)
   * - amount_exact: +20 (₹5,000 = ₹5,000)
   * - payer_name: +8 ('TEST BUYER CO' fuzzy matches 'Test Buyer Co - Net-30')
   * - Total: 58 points, MEDIUM band
   */
  it("L14: fallback finds #1002 from sibling account, score 58, medium", async () => {
    await seedFallbackPayments();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[0]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(58);
    expect(getConfidenceBand(topMatch.score)).toBe("medium");
    expect(topMatch.amount).toBe(5000);
    // Verify invoice is from buyer B (sibling account)
    expect(topMatch.buyerAccountId).toBe(buyerBId);
  });

  /**
   * L15: IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT, ₹2,500
   *
   * Same fallback path as L14.
   * Scoring:
   * - invoice_ref: +30 (#1002 in narration matches invoice name)
   * - amount_partial: +10 (₹2,500 < ₹5,000)
   * - payer_name: +8 ('TEST BUYER CO' fuzzy matches 'Test Buyer Co - Net-30')
   * - Total: 48 points, LOW band
   */
  it("L15: fallback finds #1002 from sibling account, score 48, low", async () => {
    await seedFallbackPayments();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[1]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(48);
    expect(getConfidenceBand(topMatch.score)).toBe("low");
    expect(topMatch.amount).toBe(2500);
    expect(topMatch.buyerAccountId).toBe(buyerBId);
  });

  it("both payments produce matches via fallback", async () => {
    await seedFallbackPayments();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(2);
    expect(result.matchesCreated).toBeGreaterThan(0);
  });
});

/**
 * Guard case: resolved buyer with candidates must NOT take fallback.
 *
 * When the resolved buyer DOES have candidate invoices, the matcher
 * should only suggest those, not invoices from other buyers via fallback.
 */
describeWithDb("Guard: resolved buyer with candidates skips fallback", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let buyerWithInvoicesId: string;
  let otherBuyerId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-guard-${runId}.myshopify.com`;

  const buyerWithInvoicesIdValue = `buyer-with-invoices-${runId}`;
  const otherBuyerIdValue = `buyer-other-${runId}`;
  const invoiceMatchId = `invoice-guard-match-${runId}`;
  const invoiceOtherId = `invoice-guard-other-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Buyer that will be resolved and HAS invoices
    const [buyerWithInvoices] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerWithInvoicesIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/guard-main', 'gid://shopify/CompanyLocation/guard-main',
        'Guard Test Co', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    buyerWithInvoicesId = buyerWithInvoices.id;

    // Other buyer in the shop (should NOT appear in results)
    const [otherBuyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${otherBuyerIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/guard-other', 'gid://shopify/CompanyLocation/guard-other',
        'Other Company Ltd', 100000, 'OK', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second'
      )
      RETURNING id
    `;
    otherBuyerId = otherBuyer.id;

    // Invoice for the resolved buyer
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceMatchId}, ${testShopId}, ${buyerWithInvoicesId},
        'gid://shopify/Order/guard-2001', '#2001', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    // Invoice for other buyer - same amount, inside amount window
    // Should NOT be suggested because resolved buyer has candidates
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceOtherId}, ${testShopId}, ${otherBuyerId},
        'gid://shopify/Order/guard-2002', '#2002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
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
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
  });

  async function seedGuardPayment(): Promise<void> {
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'guard-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // Payment that matches 'Guard Test Co'
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        '2026-10-23'::date, 5000, 'NEFT', 'GUARD001',
        'GUARD TEST CO', 'NEFT-GUARD001-GUARD TEST CO-#2001', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    paymentIds.push(payment.id);
  }

  it("suggests only resolved buyer's invoice, not other buyer's invoice via fallback", async () => {
    await seedGuardPayment();
    await runMatcher(sql, testShopId);

    const matches = await sql<Array<{
      invoiceId: string;
      invoiceName: string;
      buyerAccountId: string;
    }>>`
      SELECT 
        m."invoiceId" AS "invoiceId",
        i.name AS "invoiceName",
        i."buyerAccountId" AS "buyerAccountId"
      FROM "Match" m
      JOIN "Invoice" i ON i.id = m."invoiceId"
      WHERE m."paymentId" = ${paymentIds[0]}
        AND m.state = 'suggested'
    `;

    // Should have match(es) from resolved buyer only
    expect(matches.length).toBeGreaterThan(0);
    
    // All matches should be from the resolved buyer
    for (const match of matches) {
      expect(match.buyerAccountId).toBe(buyerWithInvoicesId);
    }

    // Verify other buyer's invoice is NOT suggested
    const otherBuyerMatches = matches.filter(m => m.buyerAccountId === otherBuyerId);
    expect(otherBuyerMatches.length).toBe(0);
  });
});

/**
 * Test that getBuyersWithAliases returns accounts ordered by createdAt then id.
 */
describeWithDb("getBuyersWithAliases ordering", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-order-${runId}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Create buyers with explicit createdAt to test ordering
    // Buyer C created at base time
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${'buyer-order-c-' + runId}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/order-c', 'gid://shopify/CompanyLocation/order-c',
        'Order Test C', 100000, 'OK', NOW(), NOW()
      )
    `;

    // Buyer A created 1 second later
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${'buyer-order-a-' + runId}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/order-a', 'gid://shopify/CompanyLocation/order-a',
        'Order Test A', 100000, 'OK', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second'
      )
    `;

    // Buyer B created 2 seconds later
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${'buyer-order-b-' + runId}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/order-b', 'gid://shopify/CompanyLocation/order-b',
        'Order Test B', 100000, 'OK', NOW() + INTERVAL '2 seconds', NOW() + INTERVAL '2 seconds'
      )
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      await sql.end();
    }
  });

  it("returns buyers ordered by createdAt then id", async () => {
    const { getBuyersWithAliases } = await import("../../app/lib/matching/queries.server.js");
    const buyers = await getBuyersWithAliases(sql, testShopId);

    // Should return buyers in creation order: C, A, B
    expect(buyers.length).toBe(3);
    expect(buyers[0].name).toBe("Order Test C");
    expect(buyers[1].name).toBe("Order Test A");
    expect(buyers[2].name).toBe("Order Test B");
  });
});

/**
 * #579 Fallback rejected pair filtering tests.
 *
 * When a buyer is resolved (targetBuyer) but has no non-rejected open invoices,
 * the matcher falls back to getOpenInvoicesInAmountWindow(sql, shopId, minPaise, maxPaise),
 * then filters with rejectedInvoiceIds from getRejectedPairs(sql, shopId, payment.id).
 *
 * Test 1: Rejected pair on fallback
 * Buyer A resolves and has no invoices. Sibling account B has invoice X in amount window.
 * Insert a rejected_matches row for (payment, X). Expect no suggestion for X.
 * Add a second in-window invoice Y on B, not rejected, and expect Y IS suggested.
 */
describeWithDb("#579 Fallback rejected pair filtering", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let _buyerAId: string;
  let buyerBId: string;
  let invoiceXId: string;
  let invoiceYId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-rejected-fallback-${runId}.myshopify.com`;

  const buyerAIdValue = `buyer-rejected-a-${runId}`;
  const buyerBIdValue = `buyer-rejected-b-${runId}`;
  const invoiceXIdValue = `invoice-rejected-x-${runId}`;
  const invoiceYIdValue = `invoice-rejected-y-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Buyer A: 'Test Buyer Co' - exact name match, will win buyer resolution
    // Has NO invoices - triggers fallback
    const [buyerA] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerAIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/rejected-a', 'gid://shopify/CompanyLocation/rejected-a',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    _buyerAId = buyerA.id;

    // Buyer B: sibling account with invoices
    const [buyerB] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerBIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/rejected-b', 'gid://shopify/CompanyLocation/rejected-b',
        'Test Buyer Co - Net-30', 100000, 'OK', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second'
      )
      RETURNING id
    `;
    buyerBId = buyerB.id;

    // Invoice X on buyer B: ₹5,000 - will be rejected
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceXIdValue}, ${testShopId}, ${buyerBId},
        'gid://shopify/Order/rejected-x', '#X001', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
    invoiceXId = invoiceXIdValue;

    // Invoice Y on buyer B: ₹5,500 - NOT rejected, should be suggested
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceYIdValue}, ${testShopId}, ${buyerBId},
        'gid://shopify/Order/rejected-y', '#Y001', 5500, 'open', 5500,
        NOW(), NOW() + INTERVAL '30 days', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second'
      )
    `;
    invoiceYId = invoiceYIdValue;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
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
    await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
  });

  async function seedPaymentAndRejectX(): Promise<void> {
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'rejected-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // Payment ₹5,000 - resolves to buyer A (no invoices), falls back to amount window
    // Amount window (0.5x-2x): ₹2,500 - ₹10,000 includes both X (₹5,000) and Y (₹5,500)
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        '2026-10-23'::date, 5000, 'NEFT', 'REJTEST001',
        'TEST BUYER CO', 'NEFT-REJTEST001-TEST BUYER CO', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    paymentIds.push(payment.id);

    // Insert rejected_matches row for (payment, X)
    await sql`
      INSERT INTO "rejected_matches" (
        "shopId", "paymentId", "invoiceId", "rejectedBy", "rejectedAt"
      )
      VALUES (
        ${testShopId}, ${payment.id}, ${invoiceXId}, 'test-user', NOW()
      )
    `;
  }

  it("rejected invoice X is not suggested, non-rejected Y is suggested", async () => {
    await seedPaymentAndRejectX();
    await runMatcher(sql, testShopId);

    const matches = await sql<Array<{
      invoiceId: string;
      invoiceName: string;
      state: string;
    }>>`
      SELECT 
        m."invoiceId" AS "invoiceId",
        i.name AS "invoiceName",
        m.state
      FROM "Match" m
      JOIN "Invoice" i ON i.id = m."invoiceId"
      WHERE m."paymentId" = ${paymentIds[0]}
        AND m.state = 'suggested'
    `;

    // Invoice X should NOT be suggested (it's rejected)
    const xMatches = matches.filter(m => m.invoiceId === invoiceXId);
    expect(xMatches.length).toBe(0);

    // Invoice Y SHOULD be suggested (proves fallback ran)
    const yMatches = matches.filter(m => m.invoiceId === invoiceYId);
    expect(yMatches.length).toBe(1);
    expect(yMatches[0].invoiceName).toBe("#Y001");
  });
});

/**
 * #579 Test 2: Rejected-only buyer triggers fallback
 *
 * Resolved buyer A has exactly one open invoice, rejected for this payment.
 * Sibling B has an in-window invoice.
 * Expect B's invoice suggested and A's not.
 */
describeWithDb("#579 Rejected-only buyer triggers fallback", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let buyerAId: string;
  let buyerBId: string;
  let invoiceAId: string;
  let invoiceBId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-rejected-only-${runId}.myshopify.com`;

  const buyerAIdValue = `buyer-rejonly-a-${runId}`;
  const buyerBIdValue = `buyer-rejonly-b-${runId}`;
  const invoiceAIdValue = `invoice-rejonly-a-${runId}`;
  const invoiceBIdValue = `invoice-rejonly-b-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    // Buyer A: resolves by name match, has ONE invoice that will be rejected
    const [buyerA] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerAIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/rejonly-a', 'gid://shopify/CompanyLocation/rejonly-a',
        'Rejected Only Corp', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    buyerAId = buyerA.id;

    // Buyer B: sibling with invoice in window
    const [buyerB] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerBIdValue}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/rejonly-b', 'gid://shopify/CompanyLocation/rejonly-b',
        'Rejected Only Corp - Branch', 100000, 'OK', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second'
      )
      RETURNING id
    `;
    buyerBId = buyerB.id;

    // Invoice A on buyer A: ₹5,000 - will be rejected
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceAIdValue}, ${testShopId}, ${buyerAId},
        'gid://shopify/Order/rejonly-a', '#RA001', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
    invoiceAId = invoiceAIdValue;

    // Invoice B on buyer B: ₹5,500 - in window, should be suggested
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceBIdValue}, ${testShopId}, ${buyerBId},
        'gid://shopify/Order/rejonly-b', '#RB001', 5500, 'open', 5500,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
    invoiceBId = invoiceBIdValue;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
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
    await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
  });

  async function seedPaymentAndRejectA(): Promise<void> {
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'hdfc', 'rejonly-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // Payment ₹5,000 - resolves to buyer A by name match
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testImportId},
        '2026-10-23'::date, 5000, 'NEFT', 'REJONLYTEST001',
        'REJECTED ONLY CORP', 'NEFT-REJONLYTEST001-REJECTED ONLY CORP', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    paymentIds.push(payment.id);

    // Reject buyer A's invoice
    await sql`
      INSERT INTO "rejected_matches" (
        "shopId", "paymentId", "invoiceId", "rejectedBy", "rejectedAt"
      )
      VALUES (
        ${testShopId}, ${payment.id}, ${invoiceAId}, 'test-user', NOW()
      )
    `;
  }

  it("rejected buyer A invoice not suggested, sibling B invoice IS suggested", async () => {
    await seedPaymentAndRejectA();
    await runMatcher(sql, testShopId);

    const matches = await sql<Array<{
      invoiceId: string;
      invoiceName: string;
      buyerAccountId: string;
      state: string;
    }>>`
      SELECT 
        m."invoiceId" AS "invoiceId",
        i.name AS "invoiceName",
        i."buyerAccountId" AS "buyerAccountId",
        m.state
      FROM "Match" m
      JOIN "Invoice" i ON i.id = m."invoiceId"
      WHERE m."paymentId" = ${paymentIds[0]}
        AND m.state = 'suggested'
    `;

    // Invoice A (rejected) should NOT be suggested
    const aMatches = matches.filter(m => m.invoiceId === invoiceAId);
    expect(aMatches.length).toBe(0);

    // Invoice B (sibling, not rejected) SHOULD be suggested
    const bMatches = matches.filter(m => m.invoiceId === invoiceBId);
    expect(bMatches.length).toBe(1);
    expect(bMatches[0].invoiceName).toBe("#RB001");
    expect(bMatches[0].buyerAccountId).toBe(buyerBId);
  });
});

/**
 * #579 Test 3: Cross-shop isolation
 *
 * Two shops: test-iso-a-<run>.myshopify.com and test-iso-b-<run>.myshopify.com
 * In shop A the resolved buyer has no invoices.
 * Shop B has an in-window open invoice.
 * Expect 0 suggestions in shop A and no Match row referencing shop B's invoice.
 */
describeWithDb("#579 Cross-shop isolation", () => {
  let sql: ReturnType<typeof postgres>;
  let shopAId: string;
  let shopBId: string;
  let _buyerAId: string;
  let buyerBId: string;
  let invoiceBId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const SHOP_A_DOMAIN = `test-iso-a-${runId}.myshopify.com`;
  const SHOP_B_DOMAIN = `test-iso-b-${runId}.myshopify.com`;

  const buyerAIdValue = `buyer-iso-a-${runId}`;
  const buyerBIdValue = `buyer-iso-b-${runId}`;
  const invoiceBIdValue = `invoice-iso-b-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create shop A
    const [shopA] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_A_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopAId = shopA.id;

    // Create shop B
    const [shopB] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP_B_DOMAIN}, 'INR', 'Asia/Kolkata', NOW() + INTERVAL '1 second', NOW() + INTERVAL '1 second')
      RETURNING id
    `;
    shopBId = shopB.id;

    // Buyer in shop A: 'Iso Test Corp' - will be resolved, has NO invoices
    const [buyerA] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerAIdValue}, ${shopAId}, 'COMPANY',
        'gid://shopify/Company/iso-a', 'gid://shopify/CompanyLocation/iso-a',
        'Iso Test Corp', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    _buyerAId = buyerA.id;

    // Buyer in shop B with invoice in amount window
    const [buyerB] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerBIdValue}, ${shopBId}, 'COMPANY',
        'gid://shopify/Company/iso-b', 'gid://shopify/CompanyLocation/iso-b',
        'Other Shop Buyer', 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    buyerBId = buyerB.id;

    // Invoice in shop B: ₹5,000 - in amount window for shop A's payment
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceBIdValue}, ${shopBId}, ${buyerBId},
        'gid://shopify/Order/iso-b', '#ISO-B001', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;
    invoiceBId = invoiceBIdValue;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Match" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "Payment" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${shopAId}, ${shopBId})`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${shopAId}, ${shopBId})`;
    paymentIds.length = 0;
  });

  async function seedPaymentInShopA(): Promise<void> {
    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${shopAId}, 'hdfc', 'iso-test.csv', 1, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

    // Payment ₹5,000 in shop A - resolves to buyer A (no invoices)
    // Amount window (0.5x-2x): ₹2,500 - ₹10,000
    // Shop B's invoice is in this range but should NOT be matched
    const [payment] = await sql<{ id: string }[]>`
      INSERT INTO "Payment" (
        id, "shopId", "importId", "valueDate", amount, rail, utr, "payerText", narration, status, "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${shopAId}, ${testImportId},
        '2026-10-23'::date, 5000, 'NEFT', 'ISOTEST001',
        'ISO TEST CORP', 'NEFT-ISOTEST001-ISO TEST CORP', 'unmatched', NOW(), NOW()
      )
      RETURNING id
    `;
    paymentIds.push(payment.id);
  }

  it("shop A payment gets 0 suggestions, no match references shop B invoice", async () => {
    await seedPaymentInShopA();
    await runMatcher(sql, shopAId);

    // Check matches in shop A
    const shopAMatches = await sql<Array<{
      id: string;
      invoiceId: string;
      state: string;
    }>>`
      SELECT id, "invoiceId" AS "invoiceId", state
      FROM "Match"
      WHERE "shopId" = ${shopAId}
        AND state = 'suggested'
    `;

    // Should have 0 suggestions in shop A
    expect(shopAMatches.length).toBe(0);

    // Verify no match anywhere references shop B's invoice
    const crossShopMatches = await sql<Array<{ id: string; shopId: string }>>`
      SELECT id, "shopId" AS "shopId"
      FROM "Match"
      WHERE "invoiceId" = ${invoiceBId}
    `;
    expect(crossShopMatches.length).toBe(0);
  });

  it("ensures getOpenInvoicesInAmountWindow respects shopId filter", async () => {
    const { getOpenInvoicesInAmountWindow } = await import("../../app/lib/matching/queries.server.js");
    
    // Query shop A's invoices in the amount window
    const shopAInvoices = await getOpenInvoicesInAmountWindow(
      sql,
      shopAId,
      BigInt(250000), // ₹2,500 in paise
      BigInt(1000000) // ₹10,000 in paise
    );

    // Shop A has no invoices
    expect(shopAInvoices.length).toBe(0);

    // Shop B has an invoice in this range
    const shopBInvoices = await getOpenInvoicesInAmountWindow(
      sql,
      shopBId,
      BigInt(250000),
      BigInt(1000000)
    );
    expect(shopBInvoices.length).toBe(1);
    expect(shopBInvoices[0].id).toBe(invoiceBId);
  });
});
