/**
 * DB integration test: Reviewer CSV v2 fixture for e2e bank import workflow.
 *
 * This test verifies the SECOND HDFC fixture (hdfc-review-synthetic-v2.csv)
 * produces the expected match scores and has different dedupe keys from v1.
 *
 * CRITICAL: V2 fixture has ZERO credits that match #1001.
 * - No credit's amount is in #1001's window (0.5x-2x of ₹10,000 = ₹5,000-₹20,000)
 * - The matcher creates NO suggestion of any band on #1001
 *
 * V2 fixture credit rows (dates: 24-26 Oct 2026):
 * - Row 1: UPI-TEST BUYER CO-SYNT0011-#1002, ₹5,000 → Medium 58
 * - Row 2: IMPS-SYNT0012-TEST BUYER CO-#1002 PARTIAL, ₹2,000 → Low 48
 * - Row 3: NEFT-SYNT0013-ACME CORP-PAYMENT, ₹3,500 → Low 10 (no invoice ref)
 * - Row 4: RTGS-SYNT0014-UNKNOWN SENDER-ADVANCE, ₹1,500 → UNMATCHED (outside all windows)
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
import { CONFIDENCE_THRESHOLD } from "../../app/lib/matching/score.js";
import { REVIEWER_DEMO_AMOUNTS, REVIEWER_DEMO_BUYER } from "../fixtures/reviewer-demo";
import { computeDateBounds, mapCreditsForImport } from "../../app/routes/app.imports";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

describeWithDb("Reviewer CSV v2: Real matcher DB path", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testBuyerId: string;
  let testImportId: string;
  const paymentIds: string[] = [];

  const runId = Date.now();
  const TEST_SHOP_DOMAIN = `test-reviewer-v2-${runId}.myshopify.com`;

  const buyerId = `buyer-reviewer-v2-${runId}`;
  const invoice1Id = `invoice-v2-1-${runId}`;
  const invoice2Id = `invoice-v2-2-${runId}`;

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
        'gid://shopify/Company/reviewer-v2', 'gid://shopify/CompanyLocation/reviewer-v2',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
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
        'gid://shopify/Order/v2-1001', '#1001', ${REVIEWER_DEMO_AMOUNTS.order1}, 'open', ${REVIEWER_DEMO_AMOUNTS.order1},
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
        'gid://shopify/Order/v2-1002', '#1002', ${REVIEWER_DEMO_AMOUNTS.order2}, 'open', ${REVIEWER_DEMO_AMOUNTS.order2},
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

  it("parses v2 fixture as HDFC with 4 credits", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    const credits = result.transactions.filter((t) => t.direction === "CR");
    expect(credits.length).toBe(4);
  });

  it("seeds 4 credit payments from v2 CSV", async () => {
    await seedPaymentsFromV2Csv();
    expect(paymentIds.length).toBe(4);
  });

  it("runs matcher and produces results", async () => {
    await seedPaymentsFromV2Csv();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(4);
  });

  /**
   * Row 1: UPI-TEST BUYER CO-SYNT0011-#1002, ₹5,000
   * - invoice_ref: +30 (#1002)
   * - amount_exact: +20
   * - payer_name: +8 (TEST BUYER CO)
   * = 58 (Medium)
   */
  it("Row 1: pins ₹5,000 payment → #1002, score 58, medium", async () => {
    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[0]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(58);
    expect(getConfidenceBand(topMatch.score)).toBe("medium");
    expect(topMatch.amount).toBe(5000);
  });

  /**
   * Row 2: IMPS-SYNT0012-TEST BUYER CO-#1002 PARTIAL, ₹2,000
   * - invoice_ref: +30 (#1002)
   * - amount_partial: +10
   * - payer_name: +8 (TEST BUYER CO)
   * = 48 (Low)
   */
  it("Row 2: pins ₹2,000 payment → #1002, score 48, low", async () => {
    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[1]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(48);
    expect(getConfidenceBand(topMatch.score)).toBe("low");
    expect(topMatch.amount).toBe(2000);
  });

  /**
   * Row 3: NEFT-SYNT0013-ACME CORP-PAYMENT, ₹3,500
   * - invoice_ref: 0 (no #number)
   * - amount_partial: +10 (₹3,500 in window for #1002 ₹5,000: [2,500-10,000])
   * - payer_name: 0 (ACME CORP doesn't match Test Buyer Co)
   * = 10 (Low)
   * NOTE: ₹3,500 is NOT in #1001's window ([5,000-20,000])
   */
  it("Row 3: pins ₹3,500 payment → #1002, score 10, low", async () => {
    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[2]);
    expect(matches.length).toBeGreaterThan(0);

    const topMatch = matches[0];
    expect(topMatch.invoiceName).toBe("#1002");
    expect(topMatch.score).toBe(10);
    expect(getConfidenceBand(topMatch.score)).toBe("low");
    expect(topMatch.amount).toBe(3500);
  });

  /**
   * Row 4: RTGS-SYNT0014-UNKNOWN SENDER-ADVANCE, ₹1,500
   * - ₹1,500 is OUTSIDE both invoice windows:
   *   - #1001 (₹10,000): window [5,000-20,000] → ₹1,500 < 5,000
   *   - #1002 (₹5,000): window [2,500-10,000] → ₹1,500 < 2,500
   * - No candidates found → UNMATCHED (zero suggestions)
   */
  it("Row 4: ₹1,500 payment is unmatched (outside all invoice windows)", async () => {
    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    const matches = await getMatchesForPayment(paymentIds[3]);
    expect(matches.length).toBe(0);
  });

  /**
   * CRITICAL: Zero matches or suggestions reference #1001.
   * All four payments either match #1002 only or are unmatched.
   */
  it("ZERO matches reference #1001 - invoice stays untouched", async () => {
    await seedPaymentsFromV2Csv();
    await runMatcher(sql, testShopId);

    let totalOrder1001Matches = 0;
    for (let i = 0; i < paymentIds.length; i++) {
      const matches = await getMatchesForPayment(paymentIds[i]);
      const order1001Matches = matches.filter((m) => m.invoiceName === "#1001");
      totalOrder1001Matches += order1001Matches.length;
    }

    expect(totalOrder1001Matches).toBe(0);
  });

  /**
   * Summary table for v2 fixture:
   * | Row | Amount  | Narration                              | Invoice | Score | Band      |
   * |-----|---------|----------------------------------------|---------|-------|-----------|
   * | 1   | ₹5,000  | UPI-TEST BUYER CO-SYNT0011-#1002       | #1002   | 58    | medium    |
   * | 2   | ₹2,000  | IMPS-SYNT0012-TEST BUYER CO-#1002 PART | #1002   | 48    | low       |
   * | 3   | ₹3,500  | NEFT-SYNT0013-ACME CORP-PAYMENT        | #1002   | 10    | low       |
   * | 4   | ₹1,500  | RTGS-SYNT0014-UNKNOWN SENDER-ADVANCE   | -       | -     | unmatched |
   *
   * #1001 has ZERO suggestions from this fixture.
   */
  it("documents pinned results table", async () => {
    await seedPaymentsFromV2Csv();
    const result = await runMatcher(sql, testShopId);
    expect(result.paymentsProcessed).toBe(4);
    expect(result.highConfidenceMatches).toBe(0);
  });
});

/**
 * Date bounds validation: v2 fixture rows must be inside the app's date bounds.
 */
describe("V2 fixture date bounds", () => {
  it("all v2 rows are inside date bounds for now = 2026-10-28", async () => {
    const now = new Date("2026-10-28T12:00:00Z");
    const { minDateIso, maxDateIso } = computeDateBounds(now);

    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const parsed = await parseBankStatement(file);

    const creditTxns = parsed.transactions.filter((t) => t.direction === "CR");
    const credits = mapCreditsForImport(
      creditTxns.map((t) => ({
        date: t.date,
        amountPaise: t.amountPaise,
        direction: t.direction,
        narration: t.narration,
        refNo: t.refNo,
        balancePaise: t.balancePaise,
        rail: t.parsed.rail,
        utr: t.parsed.utr,
        payerName: t.parsed.payerName,
        dedupeKey: t.dedupeKey,
        sourceRow: t.sourceRow,
      }))
    );

    const outside = credits.filter(
      (c) =>
        (c.date as string) < minDateIso ||
        (c.date as string) > maxDateIso ||
        (c.valueDate !== undefined &&
          ((c.valueDate as string) < minDateIso || (c.valueDate as string) > maxDateIso))
    );

    expect(outside.length).toBe(0);
  });

  it("v2 fixture dates (24-26 Oct 2026) are valid for runs through 2028", async () => {
    const testDates = [
      new Date("2026-10-28T00:00:00Z"),
      new Date("2026-11-15T00:00:00Z"),
      new Date("2027-06-01T00:00:00Z"),
      new Date("2028-10-20T00:00:00Z"),
    ];

    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const parsed = await parseBankStatement(file);

    const creditDates = parsed.transactions
      .filter((t) => t.direction === "CR")
      .map((t) => t.date);

    for (const now of testDates) {
      const { minDateIso, maxDateIso } = computeDateBounds(now);
      for (const date of creditDates) {
        expect(date >= minDateIso).toBe(true);
        expect(date <= maxDateIso).toBe(true);
      }
    }
  });
});

/**
 * Dedupe key comparison: v1 vs v2 fixtures must have different dedupe keys.
 */
describe("Fixture v1 vs v2: dedupe keys differ", () => {
  it("v2 fixture has different dedupe keys than v1", async () => {
    const v1Content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
    const v1File = new File([v1Content], "hdfc-review-synthetic.csv", { type: "text/csv" });
    const v1Result = await parseBankStatement(v1File);

    const v2Content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const v2File = new File([v2Content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const v2Result = await parseBankStatement(v2File);

    const v1Keys = new Set(v1Result.transactions.map((t) => t.dedupeKey));
    const v2Keys = new Set(v2Result.transactions.map((t) => t.dedupeKey));

    const overlap = [...v1Keys].filter((k) => v2Keys.has(k));
    expect(overlap).toEqual([]);
    expect(v1Keys.size).toBeGreaterThan(0);
    expect(v2Keys.size).toBeGreaterThan(0);
  });

  it("both fixtures parse as HDFC", async () => {
    const v1Content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
    const v1File = new File([v1Content], "hdfc-review-synthetic.csv", { type: "text/csv" });
    const v1Result = await parseBankStatement(v1File);

    const v2Content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const v2File = new File([v2Content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const v2Result = await parseBankStatement(v2File);

    expect(v1Result.detection.bank).toBe("HDFC");
    expect(v2Result.detection.bank).toBe("HDFC");
  });

  it("v2 has same CSV shape as v1 (columns, header rows, encoding)", async () => {
    const v1Lines = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"), "utf8").split("\n");
    const v2Lines = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"), "utf8").split("\n");

    const v1HeaderLine = v1Lines.find((l) => l.startsWith("Date,Narration,"));
    const v2HeaderLine = v2Lines.find((l) => l.startsWith("Date,Narration,"));
    expect(v1HeaderLine).toBe(v2HeaderLine);

    expect(v1Lines[0]).toMatch(/^# SYNTHETIC/);
    expect(v2Lines[0]).toMatch(/^# SYNTHETIC/);
  });

  it("v2 fixture has 4 credits and no #1001 in narrations", async () => {
    const v2Content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
    const v2File = new File([v2Content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
    const v2Result = await parseBankStatement(v2File);

    const credits = v2Result.transactions.filter((t) => t.direction === "CR");
    expect(credits.length).toBe(4);

    const narrations = credits.map((c) => c.narration);
    const has1001 = narrations.some((n) => n.includes("#1001"));
    expect(has1001).toBe(false);
  });
});
