/**
 * DB integration test: Tied buyer name resolution in the matcher.
 *
 * Verifies that when multiple buyers tie on normalized payer name score,
 * the matcher correctly selects a buyer with open invoices rather than
 * falling back to the amount window when the oldest tied buyer has none.
 *
 * Test scenarios:
 * 1. Older duplicate buyer (same name) with no invoices
 * 2. Case/punctuation variant that ties after normalization
 * 3. Older buyer with only paid/cancelled invoices
 * 4. Newer duplicate buyer (should still work as before)
 * 5. Payer alias pointing at older empty buyer
 * 6. No tied buyer has open invoices (amount window fallback)
 *
 * All data is FICTIONAL - no real customer or bank data.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import { runMatcher } from "../../app/services/matcher.server.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

describeWithDb("Tied buyer name resolution: DB matcher path", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-tied-buyer-${runId}.example.com`;

  const olderBuyerId = `buyer-older-${runId}`;
  const newerBuyerId = `buyer-newer-${runId}`;
  const invoice1002Id = `invoice-1002-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (
        SELECT id FROM "BuyerAccount" WHERE "shopId" = ${testShopId}
      )`;
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
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (
      SELECT id FROM "BuyerAccount" WHERE "shopId" = ${testShopId}
    )`;
    await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
    paymentIds.length = 0;
  });

  async function seedPaymentsFromV2Csv(): Promise<void> {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    const [bankImport] = await sql<{ id: string }[]>`
      INSERT INTO "BankImport" (
        id, "shopId", bank, "fileName", "rowCount", "createdAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${result.detection.bank}, 'hdfc-review-synthetic-v2.csv', ${result.transactions.length}, NOW()
      )
      RETURNING id
    `;
    testImportId = bankImport.id;

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
   * Case 1: Older duplicate buyer with same name but no invoices.
   * The newer buyer has invoice #1002 with open invoices.
   * r14 (₹5,000) should match #1002 medium, r15 (₹2,000) should match #1002 low.
   */
  it("Case 1: older same-name buyer with no invoices - picks newer buyer with invoices", async () => {
    const uniqueOlderId = `${olderBuyerId}-case1`;
    const uniqueNewerId = `${newerBuyerId}-case1`;
    const uniqueInvoiceId = `${invoice1002Id}-case1`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueOlderId}, ${testShopId}, 'COMPANY',
        'company-older-case1', 'location-older-case1',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueNewerId}, ${testShopId}, 'COMPANY',
        'company-newer-case1', 'location-newer-case1',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoiceId}, ${testShopId}, ${uniqueNewerId},
        'order-1002-case1', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].score).toBe(58);
    expect(r14Matches[0].buyerAccountId).toBe(uniqueNewerId);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].score).toBe(48);
    expect(r15Matches[0].buyerAccountId).toBe(uniqueNewerId);
  });

  /**
   * Case 2: Case/punctuation variant that ties after normalization.
   * "TEST BUYER CO." vs "Test Buyer Co" normalize to the same string.
   */
  it("Case 2: case/punctuation variant ties after normalization - picks buyer with invoices", async () => {
    const uniqueOlderId = `${olderBuyerId}-case2`;
    const uniqueNewerId = `${newerBuyerId}-case2`;
    const uniqueInvoiceId = `${invoice1002Id}-case2`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueOlderId}, ${testShopId}, 'COMPANY',
        'company-older-case2', 'location-older-case2',
        'TEST BUYER CO.', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueNewerId}, ${testShopId}, 'COMPANY',
        'company-newer-case2', 'location-newer-case2',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoiceId}, ${testShopId}, ${uniqueNewerId},
        'order-1002-case2', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].score).toBe(58);
    expect(r14Matches[0].buyerAccountId).toBe(uniqueNewerId);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].score).toBe(48);
    expect(r15Matches[0].buyerAccountId).toBe(uniqueNewerId);
  });

  /**
   * Case 3: Older buyer with only paid/cancelled invoices (no open).
   * The newer buyer has the open invoice.
   */
  it("Case 3: older buyer has only paid/cancelled invoices - picks newer buyer", async () => {
    const uniqueOlderId = `${olderBuyerId}-case3`;
    const uniqueNewerId = `${newerBuyerId}-case3`;
    const uniqueInvoiceOpenId = `${invoice1002Id}-case3-open`;
    const uniqueInvoicePaidId = `${invoice1002Id}-case3-paid`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueOlderId}, ${testShopId}, 'COMPANY',
        'company-older-case3', 'location-older-case3',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoicePaidId}, ${testShopId}, ${uniqueOlderId},
        'order-1003-case3', '#1003', 8000, 'paid', 0,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueNewerId}, ${testShopId}, 'COMPANY',
        'company-newer-case3', 'location-newer-case3',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoiceOpenId}, ${testShopId}, ${uniqueNewerId},
        'order-1002-case3', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].score).toBe(58);
    expect(r14Matches[0].buyerAccountId).toBe(uniqueNewerId);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].score).toBe(48);
    expect(r15Matches[0].buyerAccountId).toBe(uniqueNewerId);
  });

  /**
   * Case 4: Newer duplicate buyer - must still work as before.
   * The older buyer has the invoice, newer has nothing.
   */
  it("Case 4: newer duplicate buyer without invoices - older buyer with invoices still matched", async () => {
    const uniqueOlderId = `${olderBuyerId}-case4`;
    const uniqueNewerId = `${newerBuyerId}-case4`;
    const uniqueInvoiceId = `${invoice1002Id}-case4`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueOlderId}, ${testShopId}, 'COMPANY',
        'company-older-case4', 'location-older-case4',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoiceId}, ${testShopId}, ${uniqueOlderId},
        'order-1002-case4', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueNewerId}, ${testShopId}, 'COMPANY',
        'company-newer-case4', 'location-newer-case4',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].score).toBe(58);
    expect(r14Matches[0].buyerAccountId).toBe(uniqueOlderId);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].score).toBe(48);
    expect(r15Matches[0].buyerAccountId).toBe(uniqueOlderId);
  });

  /**
   * Case 5: Payer alias pointing at older empty buyer.
   * The alias resolves to the older buyer which has no invoices.
   * Should try tied buyers and find the newer one with invoices.
   */
  it("Case 5: payer alias points to older buyer without invoices - picks tied buyer with invoices", async () => {
    const uniqueOlderId = `${olderBuyerId}-case5`;
    const uniqueNewerId = `${newerBuyerId}-case5`;
    const uniqueInvoiceId = `${invoice1002Id}-case5`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueOlderId}, ${testShopId}, 'COMPANY',
        'company-older-case5', 'location-older-case5',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "PayerAlias" ("buyerAccountId", "payerKey", "createdAt")
      VALUES (${uniqueOlderId}, 'test buyer co', NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueNewerId}, ${testShopId}, 'COMPANY',
        'company-newer-case5', 'location-newer-case5',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoiceId}, ${testShopId}, ${uniqueNewerId},
        'order-1002-case5', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].score).toBe(58);
    expect(r14Matches[0].buyerAccountId).toBe(uniqueNewerId);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].score).toBe(48);
    expect(r15Matches[0].buyerAccountId).toBe(uniqueNewerId);
  });

  /**
   * Case 6: No tied buyer has open invoices - amount window fallback.
   * Both buyers have the same name but neither has open invoices.
   * Create a third buyer (different name) with an invoice in the amount window.
   * 
   * Note: Amount window is 0.5x to 2x of the PAYMENT amount:
   * - r14 (₹5,000) window: ₹2,500 - ₹10,000
   * - r15 (₹2,000) window: ₹1,000 - ₹4,000
   * Invoice at ₹3,000 falls in both windows.
   */
  it("Case 6: no tied buyer has open invoices - falls back to amount window", async () => {
    const uniqueOlderId = `${olderBuyerId}-case6`;
    const uniqueNewerId = `${newerBuyerId}-case6`;
    const otherBuyerId = `buyer-other-case6-${runId}`;
    const uniqueInvoiceId = `${invoice1002Id}-case6`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueOlderId}, ${testShopId}, 'COMPANY',
        'company-older-case6', 'location-older-case6',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueNewerId}, ${testShopId}, 'COMPANY',
        'company-newer-case6', 'location-newer-case6',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${otherBuyerId}, ${testShopId}, 'COMPANY',
        'company-other-case6', 'location-other-case6',
        'Different Company Name', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${uniqueInvoiceId}, ${testShopId}, ${otherBuyerId},
        'order-1002-case6', '#1002', 3000, 'open', 3000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].buyerAccountId).toBe(otherBuyerId);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].buyerAccountId).toBe(otherBuyerId);
  });

  /**
   * Case 7: Three or more tied buyers - oldest has no invoices, two later ones do.
   * Assert that the FIRST later buyer in createdAt order wins (not any arbitrary one).
   * This tests proper iteration order in the tied buyer fallback.
   */
  it("Case 7: 3+ tied buyers - first later buyer with invoices wins", async () => {
    const buyer1Id = `${olderBuyerId}-case7-oldest`;
    const buyer2Id = `${newerBuyerId}-case7-middle`;
    const buyer3Id = `${newerBuyerId}-case7-newest`;
    const invoice2Id = `${invoice1002Id}-case7-mid`;
    const invoice3Id = `${invoice1002Id}-case7-new`;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyer1Id}, ${testShopId}, 'COMPANY',
        'company-case7-oldest', 'location-case7-oldest',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '60 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyer2Id}, ${testShopId}, 'COMPANY',
        'company-case7-middle', 'location-case7-middle',
        'Test Buyer Co', 100000, 'OK', NOW() - INTERVAL '30 days', NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice2Id}, ${testShopId}, ${buyer2Id},
        'order-1002-case7-mid', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyer3Id}, ${testShopId}, 'COMPANY',
        'company-case7-newest', 'location-case7-newest',
        'Test Buyer Co', 100000, 'OK', NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice3Id}, ${testShopId}, ${buyer3Id},
        'order-1002-case7-new', '#1002', 5000, 'open', 5000,
        NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
      )
    `;

    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const r14Matches = await getMatchesForPayment(paymentIds[0]);
    expect(r14Matches.length).toBe(1);
    expect(r14Matches[0].invoiceName).toBe("#1002");
    expect(r14Matches[0].score).toBe(58);
    expect(r14Matches[0].buyerAccountId).toBe(buyer2Id);

    const r15Matches = await getMatchesForPayment(paymentIds[1]);
    expect(r15Matches.length).toBe(1);
    expect(r15Matches[0].invoiceName).toBe("#1002");
    expect(r15Matches[0].score).toBe(48);
    expect(r15Matches[0].buyerAccountId).toBe(buyer2Id);
  });
});
