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

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import { runMatcher } from "../../app/services/matcher.server.js";
import { REVIEWER_DEMO_AMOUNTS, REVIEWER_DEMO_BUYER } from "../fixtures/reviewer-demo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

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
      amount: number;
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
    return matches;
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
   * - High (80) requires a confirmed payer alias; without one the best is Medium (58)
   */
  it("documents pinned results table", async () => {
    await seedPaymentsFromCsv();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(3);
    expect(result.highConfidenceMatches).toBe(0);
  });
});
