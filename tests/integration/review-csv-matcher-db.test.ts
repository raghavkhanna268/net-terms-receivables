/**
 * DB integration test: Real matcher path for reviewer CSV.
 *
 * This test exercises the ACTUAL app path through matchSinglePayment:
 * 1. Buyer identification via findBestBuyerMatch
 * 2. Candidate filtering via 0.5x-2x amount window (when no buyer found)
 * 3. Scoring via scoreMultiInvoiceMatch
 *
 * Unlike the unit-level test (review-csv-app-path.test.ts), this test:
 * - Seeds real DB rows (Shop, BuyerAccount, Invoice, BankImport, Payment)
 * - Runs the actual runMatcher function
 * - Pins whatever the matcher produces (no tuning)
 *
 * The test uses the reviewer demo amounts from scripts/seed.ts:
 * - Invoice 1: ₹10,000 (exact match for CSV row 1)
 * - Invoice 2: ₹5,000 (in window for rows 2/3)
 *
 * Amount windows for candidate filtering:
 * - Row 1 (₹10,000): 0.5x=₹5,000, 2x=₹20,000 → both invoices in window
 * - Row 2 (₹4,000): 0.5x=₹2,000, 2x=₹8,000 → only ₹5,000 invoice in window
 * - Row 3 (₹2,500): 0.5x=₹1,250, 2x=₹5,000 → only ₹5,000 invoice in window (edge)
 *
 * NOTE: ₹10,000 invoice is OUTSIDE the window for rows 2 and 3!
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

describeWithDb("Reviewer CSV: Real matcher DB path", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let _invoice1Id: string;
  let _invoice2Id: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const TEST_SHOP_DOMAIN = `reviewer-matcher-${Date.now()}.myshopify.com`;

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
        ${REVIEWER_DEMO_BUYER.id}, ${testShopId}, 'COMPANY',
        'gid://shopify/Company/reviewer-demo', 'gid://shopify/CompanyLocation/reviewer-demo',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerId = buyer.id;

    // Create Invoice 1: ₹10,000
    const [inv1] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        'invoice-reviewer-1', ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/reviewer-1', '#RD001', ${REVIEWER_DEMO_AMOUNTS.order1}.00, 'open', ${REVIEWER_DEMO_AMOUNTS.order1}.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    _invoice1Id = inv1.id;

    // Create Invoice 2: ₹5,000
    const [inv2] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        'invoice-reviewer-2', ${testShopId}, ${testBuyerId},
        'gid://shopify/Order/reviewer-2', '#RD002', ${REVIEWER_DEMO_AMOUNTS.order2}.00, 'open', ${REVIEWER_DEMO_AMOUNTS.order2}.00,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
      RETURNING id
    `;
    _invoice2Id = inv2.id;
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

  it("seeds 3 credit payments from CSV", async () => {
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
   * Amount window: ₹5,000 - ₹20,000
   * Both invoices are in window: #RD001 (₹10,000), #RD002 (₹5,000)
   *
   * Expected: Buyer is identified via findBestBuyerMatch (payerText contains
   * "TEST BUYER CO" which fuzzy-matches the buyer name). Then scoring happens
   * against all buyer's invoices.
   *
   * The matcher should find both invoices and score against them. The ₹10,000
   * invoice should get a higher score due to exact amount match.
   */
  it("Row 1: pins matcher result for ₹10,000 payment", async () => {
    await seedPaymentsFromCsv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[0]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#RD001");
    expect(topMatch.score).toBe(28);
    expect(topMatch.amount).toBe(10000);
  });

  /**
   * Row 2: UPI-SYNT0002-TEST BUYER CO-PART PAYMENT, ₹4,000.00
   *
   * Amount window: ₹2,000 - ₹8,000
   * Only #RD002 (₹5,000) is in window. #RD001 (₹10,000) is OUTSIDE.
   *
   * PayerText from UPI parser: "SYNT0002" (not "TEST BUYER CO")
   * No buyer identification, so matcher uses amount window filtering.
   *
   * Expected: Only ₹5,000 invoice is a candidate. Score = amount_partial(+10).
   */
  it("Row 2: pins matcher result for ₹4,000 payment (amount window filtering)", async () => {
    await seedPaymentsFromCsv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[1]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#RD002");
    expect(topMatch.score).toBe(10);
    expect(topMatch.amount).toBe(4000);
  });

  /**
   * Row 3: IMPS-SYNT0003-UNRELATED TRADERS, ₹2,500.00
   *
   * Amount window: ₹1,250 - ₹5,000
   * Only #RD002 (₹5,000) is in window (edge case). #RD001 (₹10,000) is OUTSIDE.
   *
   * PayerText: "UNRELATED TRADERS" - no buyer match.
   *
   * Expected: Only ₹5,000 invoice is a candidate. Score = amount_partial(+10).
   */
  it("Row 3: pins matcher result for ₹2,500 payment (amount window filtering)", async () => {
    await seedPaymentsFromCsv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[2]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#RD002");
    expect(topMatch.score).toBe(10);
    expect(topMatch.amount).toBe(2500);
  });

  /**
   * Summary of pinned real matcher results:
   *
   * | Row | Amount  | PayerText             | Top Candidate | Score | Band   | Allocation |
   * |-----|---------|----------------------|---------------|-------|--------|------------|
   * | 1   | ₹10,000 | SYNT0001 TEST BUYER..| #RD001        | 28    | low    | ₹10,000    |
   * | 2   | ₹4,000  | SYNT0002             | #RD002        | 10    | low    | ₹4,000     |
   * | 3   | ₹2,500  | UNRELATED TRADERS    | #RD002        | 10    | low    | ₹2,500     |
   *
   * KEY FINDINGS:
   * - Row 1: Score is 28 (amount_exact +20, payer_name +8), NOT 58. No invoice_ref
   *   because the CSV's "#1001" doesn't match our test invoices "#RD001".
   * - Rows 2/3: The ₹10,000 invoice is OUTSIDE the amount window, so only
   *   the ₹5,000 invoice is a candidate. This is different from the unit test
   *   which passed both invoices directly to the scorer.
   * - All rows are LOW confidence (score < 50).
   */
  it("documents pinned results table", async () => {
    await seedPaymentsFromCsv();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(3);
    expect(result.highConfidenceMatches).toBe(0);
  });
});
