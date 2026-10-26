/**
 * Unit test: Scorer behavior for reviewer synthetic HDFC CSV.
 *
 * This test exercises the SCORER (scoreMultiInvoiceMatch) against the reviewer
 * CSV, but with HYPOTHETICAL candidates. It does NOT exercise the full app path:
 * - It passes invoices directly to the scorer (no DB candidate selection)
 * - It does NOT apply the 0.5x-2x amount window filtering
 * - The candidate set differs from what the real matcher would produce
 *
 * For the REAL app path with proper candidate selection, see:
 * - tests/integration/review-csv-matcher-db.test.ts (DB-backed matcher test)
 *
 * Score breakdown components (from app/lib/matching/score.ts):
 * - invoice_ref: +30 (invoice number in narration, e.g., #1001)
 * - order_ref: +30 (order ID matches extracted ref)
 * - amount_exact: +20 (payment equals invoice outstanding)
 * - amount_partial: +10 (payment < invoice outstanding)
 * - amount_overpayment: +10 (payment > invoice outstanding)
 * - payer_alias: +10 (exact/substring match on buyer.aliases) - NOT in fresh store
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

describe("HDFC reviewer CSV: Scorer unit test (hypothetical candidates)", () => {
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

  describe("scorer tests with all invoices (no amount window filtering)", () => {
    /**
     * Row 1: NEFT-SYNT0001-TEST BUYER CO-#1001, ₹10,000.00
     *
     * When BOTH invoices are passed to the scorer:
     * - invoice_ref: +30 (#1001 found in narration, matches invoice.name)
     * - amount_exact: +20 (payment 10,000 = invoice outstanding 10,000)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO" in payerText to buyer.name)
     * - Total: 58 points
     *
     * NOTE: This matches the real DB path since Row 1's amount window
     * (₹5,000 - ₹20,000) includes both invoices.
     */
    it("Row 1: scorer finds #1001 with score 58", () => {
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
      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-1");

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(58);
      expect(band).toBe("medium");

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("invoice_ref");
      expect(reasonTypes).toContain("amount_exact");
      expect(reasonTypes).toContain("payer_name");
      expect(reasonTypes).not.toContain("payer_alias");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("invoice_ref(+30), amount_exact(+20), payer_name(+8)");
    });

    /**
     * Row 2: UPI-SYNT0002-TEST BUYER CO-PART PAYMENT, ₹4,000.00
     *
     * When BOTH invoices are passed to the scorer (DIFFERS FROM REAL PATH):
     * - amount_partial: +10 (payment 4,000 < invoice outstanding 10,000)
     * - Total: 10 points
     * - Allocates to #1001 (₹10,000) because it's first in due-date order
     *
     * REAL APP PATH DIFFERENCE:
     * - Amount window: ₹2,000 - ₹8,000
     * - Only #1002 (₹5,000) is in window; #1001 (₹10,000) is OUTSIDE
     * - Real path would allocate to #1002, not #1001
     */
    it("Row 2: scorer allocates to #1001 (differs from real path)", () => {
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

      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-1");
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
     * When BOTH invoices are passed (DIFFERS FROM REAL PATH):
     * - amount_partial: +10
     * - Allocates to #1001
     *
     * REAL APP PATH DIFFERENCE:
     * - Amount window: ₹1,250 - ₹5,000
     * - Only #1002 (₹5,000) is in window; #1001 (₹10,000) is OUTSIDE
     * - Real path would allocate to #1002, not #1001
     */
    it("Row 3: scorer allocates to #1001 (differs from real path)", () => {
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

      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-1");
      expect(allocation.allocatedPaise).toBe(250000n);

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("amount_partial(+10)");
    });
  });

  describe("summary: scorer test vs real DB path", () => {
    /**
     * SCORER TEST RESULTS (all invoices passed directly):
     *
     * | Row | Amount    | Top Candidate           | Score | Band   | Breakdown                                     |
     * |-----|-----------|-------------------------|-------|--------|-----------------------------------------------|
     * | 1   | ₹10,000   | invoice-reviewer-demo-1 | 58    | medium | invoice_ref(+30), amount_exact(+20), payer_name(+8) |
     * | 2   | ₹4,000    | invoice-reviewer-demo-1 | 10    | low    | amount_partial(+10)                           |
     * | 3   | ₹2,500    | invoice-reviewer-demo-1 | 10    | low    | amount_partial(+10)                           |
     *
     * REAL DB PATH RESULTS (from review-csv-matcher-db.test.ts):
     *
     * | Row | Amount    | Top Candidate | Score | Band   | Why different?                                  |
     * |-----|-----------|---------------|-------|--------|-------------------------------------------------|
     * | 1   | ₹10,000   | #RD001        | 28    | low    | No invoice_ref (CSV #1001 ≠ DB #RD001)          |
     * | 2   | ₹4,000    | #RD002        | 10    | low    | Amount window excludes ₹10,000 invoice          |
     * | 3   | ₹2,500    | #RD002        | 10    | low    | Amount window excludes ₹10,000 invoice          |
     *
     * KEY DIFFERENCE: The real DB path uses 0.5x-2x amount window filtering.
     * For rows 2 and 3, the ₹10,000 invoice is OUTSIDE the window, so only
     * the ₹5,000 invoice is considered as a candidate.
     */
    it("validates all scores match pinned expectations", () => {
      const row1 = credits.find((c) => c.refNo === "SYNT0001")!;
      const row2 = credits.find((c) => c.refNo === "SYNT0002")!;
      const row3 = credits.find((c) => c.refNo === "SYNT0003")!;

      const buildPayment = (row: NormalisedTxn) => ({
        id: `payment-${row.refNo}`,
        amountPaise: BigInt(row.amountPaise),
        narration: row.narration,
        payerText: row.parsed.payerName ?? null,
        utr: row.parsed.utr ?? null,
        rail: row.parsed.rail,
      });

      const r1 = scoreMultiInvoiceMatch(buildPayment(row1), invoices, buyer);
      const r2 = scoreMultiInvoiceMatch(buildPayment(row2), invoices, buyer);
      const r3 = scoreMultiInvoiceMatch(buildPayment(row3), invoices, buyer);

      expect(r1!.allocations[0].score).toBe(58);
      expect(r2!.allocations[0].score).toBe(10);
      expect(r3!.allocations[0].score).toBe(10);

      expect(getConfidenceBand(r1!.allocations[0].score)).toBe("medium");
      expect(getConfidenceBand(r2!.allocations[0].score)).toBe("low");
      expect(getConfidenceBand(r3!.allocations[0].score)).toBe("low");
    });
  });
});
