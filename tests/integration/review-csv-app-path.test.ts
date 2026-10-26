/**
 * Integration test: App-level scoring for reviewer synthetic HDFC CSV.
 *
 * This test pins what the app ACTUALLY shows when processing the reviewer
 * CSV file (hdfc-review-synthetic.csv). Unlike review-csv.test.ts which uses
 * hand-set payerText and pre-seeded aliases, this test:
 *
 * 1. Uses the REAL parser output (parsed.payerName becomes payerText)
 * 2. Uses NO pre-seeded aliases (fresh store has empty aliases)
 * 3. Builds candidates from the same order/company data the seed creates
 *
 * The scoring here matches what a merchant would see in the app's import
 * review UI when processing this file against a freshly seeded demo store.
 *
 * Score breakdown components (from app/lib/matching/score.ts):
 * - invoice_ref: +30 (invoice number in narration, e.g., #1001)
 * - order_ref: +30 (order ID matches extracted ref)
 * - amount_exact: +20 (payment equals invoice outstanding)
 * - amount_partial: +10 (payment < invoice outstanding)
 * - amount_overpayment: +10 (payment > invoice outstanding)
 * - payer_alias: +10 (exact/substring match on buyer.aliases) - NOT AVAILABLE in fresh store
 * - payer_name: +8 (fuzzy match on buyer.name, floor(10 * 0.8))
 * - email_match: +6 (email prefix match, floor(10 * 0.6))
 * - multi_invoice: +5 (bonus for subset-sum match to multiple invoices)
 *
 * CONFIDENCE_THRESHOLD: 80 (requires multi-invoice or additional signals)
 *
 * All data is FICTIONAL - no real bank data.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import type { ParseResult, NormalisedTxn } from "../../app/lib/banks/types.js";
import {
  scoreMultiInvoiceMatch,
  extractInvoiceRefs,
  CONFIDENCE_THRESHOLD,
  type InvoiceForScoring,
  type BuyerForScoring,
  type MatchReason,
} from "../../app/lib/matching/score.js";
import {
  buildReviewerDemoBuyer,
  buildReviewerDemoInvoices,
} from "../fixtures/reviewer-demo.js";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function formatReasons(reasons: MatchReason[]): string {
  return reasons.map((r) => `${r.type}(+${r.points})`).join(", ");
}

describe("HDFC reviewer CSV: App-level scoring (real parser, no aliases)", () => {
  let parseResult: ParseResult;
  let credits: NormalisedTxn[];

  const buyer: BuyerForScoring = buildReviewerDemoBuyer(false);
  const invoices: InvoiceForScoring[] = buildReviewerDemoInvoices(buyer.id);

  beforeAll(async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
    const file = new File([content], "hdfc-review-synthetic.csv", { type: "text/csv" });
    parseResult = await parseBankStatement(file);
    credits = parseResult.transactions.filter((t) => t.direction === "CR");
  });

  describe("parser output for scoring", () => {
    it("extracts 3 credit rows", () => {
      expect(credits.length).toBe(3);
    });

    it("Row 1: payerName includes company name and invoice ref", () => {
      const row1 = credits.find((c) => c.refNo === "SYNT0001");
      expect(row1).toBeDefined();
      expect(row1!.parsed.payerName).toBe("SYNT0001 TEST BUYER CO #1001");
    });

    it("Row 2: payerName is ref only (UPI parser behavior)", () => {
      const row2 = credits.find((c) => c.refNo === "SYNT0002");
      expect(row2).toBeDefined();
      expect(row2!.parsed.payerName).toBe("SYNT0002");
    });

    it("Row 3: payerName is unrelated trader name", () => {
      const row3 = credits.find((c) => c.refNo === "SYNT0003");
      expect(row3).toBeDefined();
      expect(row3!.parsed.payerName).toBe("UNRELATED TRADERS");
    });
  });

  describe("app-level scoring against seeded orders", () => {
    /**
     * Row 1: NEFT-SYNT0001-TEST BUYER CO-#1001, ₹10,000.00
     *
     * Score breakdown (APP PATH - no pre-seeded alias):
     * - invoice_ref: +30 (#1001 found in narration, matches invoice.name)
     * - amount_exact: +20 (payment 10,000 = invoice outstanding 10,000)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO" in payerText to buyer.name)
     * - Total: 58 points
     *
     * DIFFERENCE FROM UNIT TEST (review-csv.test.ts):
     * - Unit test hand-sets payerText="TEST BUYER CO" and pre-seeds alias
     * - Unit test gets payer_alias(+10) → score 60
     * - App path gets payer_name(+8) → score 58
     *
     * The payerText here is "SYNT0001 TEST BUYER CO #1001" from the real parser.
     * The scorer extracts "TEST BUYER CO" via fuzzy matching (not alias lookup).
     */
    it("Row 1: pins medium-band match (score 58, no alias)", () => {
      const row1 = credits.find((c) => c.refNo === "SYNT0001")!;

      const payment = {
        id: "payment-row1",
        amountPaise: BigInt(row1.amountPaise),
        narration: row1.narration,
        payerText: row1.parsed.payerName ?? null,
        utr: row1.parsed.utr ?? null,
        rail: row1.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row1.narration);
      expect(extractedRefs).toContain("1001");

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-1001");

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(58);
      expect(band).toBe("medium");

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("invoice_ref");
      expect(reasonTypes).toContain("amount_exact");
      expect(reasonTypes).toContain("payer_name");
      expect(reasonTypes).not.toContain("payer_alias");

      const invoiceRefReason = allocation.reasons.find((r) => r.type === "invoice_ref");
      const amountExactReason = allocation.reasons.find((r) => r.type === "amount_exact");
      const payerNameReason = allocation.reasons.find((r) => r.type === "payer_name");

      expect(invoiceRefReason?.points).toBe(30);
      expect(amountExactReason?.points).toBe(20);
      expect(payerNameReason?.points).toBe(8);

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("invoice_ref(+30), amount_exact(+20), payer_name(+8)");
    });

    /**
     * Row 2: UPI-SYNT0002-TEST BUYER CO-PART PAYMENT, ₹4,000.00
     *
     * Score breakdown (APP PATH):
     * - amount_partial: +10 (payment 4,000 < invoice outstanding 10,000)
     * - Total: 10 points
     *
     * DIFFERENCE FROM UNIT TEST (review-csv.test.ts):
     * - Unit test hand-sets payerText="TEST BUYER CO" and gets payer_alias(+10)
     * - Unit test score: 20 (partial + alias)
     * - App path payerText="SYNT0002" (UPI parser extracts only the ref)
     * - App path score: 10 (partial only)
     *
     * The UPI parser extracts payerName as "SYNT0002" because the format
     * "UPI-REF-NAME-DETAIL" extracts the first non-UPI segment as the name.
     * "TEST BUYER CO" is in the narration but not in the extracted payerName.
     *
     * No invoice_ref because "PART PAYMENT" narration has no #-prefixed number.
     * Allocation goes to invoice #1001 (₹10,000) because when scores are equal,
     * the scorer picks the first invoice in due-date order (oldest first).
     */
    it("Row 2: pins low-band match (score 10, no name match)", () => {
      const row2 = credits.find((c) => c.refNo === "SYNT0002")!;

      const payment = {
        id: "payment-row2",
        amountPaise: BigInt(row2.amountPaise),
        narration: row2.narration,
        payerText: row2.parsed.payerName ?? null,
        utr: row2.parsed.utr ?? null,
        rail: row2.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row2.narration);
      expect(extractedRefs.length).toBe(0);

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(10);
      expect(band).toBe("low");

      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-1001");
      expect(allocation.allocatedPaise).toBe(400000n);

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).not.toContain("payer_alias");
      expect(reasonTypes).not.toContain("payer_name");
      expect(reasonTypes).not.toContain("invoice_ref");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("amount_partial(+10)");
    });

    /**
     * Row 3: IMPS-SYNT0003-UNRELATED TRADERS, ₹2,500.00
     *
     * Score breakdown (APP PATH):
     * - amount_partial: +10 (payment 2,500 < invoice outstanding 10,000)
     * - Total: 10 points
     *
     * SAME AS UNIT TEST because:
     * - payerText="UNRELATED TRADERS" doesn't match "Test Buyer Co"
     * - No alias match, no name match
     * - Only amount_partial applies
     *
     * Allocation goes to invoice #1001 (₹10,000) because when scores are equal,
     * the scorer picks the first invoice in due-date order (oldest first).
     */
    it("Row 3: pins low-band match (score 10, unrelated payer)", () => {
      const row3 = credits.find((c) => c.refNo === "SYNT0003")!;

      const payment = {
        id: "payment-row3",
        amountPaise: BigInt(row3.amountPaise),
        narration: row3.narration,
        payerText: row3.parsed.payerName ?? null,
        utr: row3.parsed.utr ?? null,
        rail: row3.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row3.narration);
      expect(extractedRefs.length).toBe(0);

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(10);
      expect(band).toBe("low");

      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-1001");
      expect(allocation.allocatedPaise).toBe(250000n);

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).not.toContain("payer_alias");
      expect(reasonTypes).not.toContain("payer_name");
      expect(reasonTypes).not.toContain("invoice_ref");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("amount_partial(+10)");
    });
  });

  describe("summary: app-level vs unit-level comparison", () => {
    /**
     * Pinned app-level results table:
     *
     * | Row | Ref      | Amount    | Dir | Top Candidate              | Score | Band   | Breakdown                                     |
     * |-----|----------|-----------|-----|----------------------------|-------|--------|-----------------------------------------------|
     * | 1   | SYNT0001 | 10,000.00 | CR  | invoice-reviewer-demo-1001 | 58    | medium | invoice_ref(+30), amount_exact(+20), payer_name(+8) |
     * | 2   | SYNT0002 | 4,000.00  | CR  | invoice-reviewer-demo-1001 | 10    | low    | amount_partial(+10)                           |
     * | 3   | SYNT0003 | 2,500.00  | CR  | invoice-reviewer-demo-1001 | 10    | low    | amount_partial(+10)                           |
     * | 4   | SYNT0004 | 1,200.00  | DR  | N/A                        | N/A   | N/A    | Debit - not matched                           |
     *
     * Comparison with unit-level test (review-csv.test.ts):
     *
     * | Row | Unit Score | App Score | Difference | Reason                                          |
     * |-----|------------|-----------|------------|------------------------------------------------|
     * | 1   | 60         | 58        | -2         | payer_alias(+10) → payer_name(+8)              |
     * | 2   | 20         | 10        | -10        | UPI parser payerName="SYNT0002", no name match |
     * | 3   | 10         | 10        | 0          | Same - unrelated payer, partial only           |
     *
     * KEY INSIGHT: Row 2 drops from 20 to 10 because the UPI parser extracts
     * payerName="SYNT0002" instead of "TEST BUYER CO". The company name is in
     * the narration but not in the structured payerText the scorer receives.
     *
     * FLAG: Rows 2 and 3 are LOW confidence. A reviewer would need to manually
     * verify these matches since they only have amount_partial as a signal.
     */
    it("documents all rows with pinned app-level scores", () => {
      expect(credits.length).toBe(3);
    });
  });
});
