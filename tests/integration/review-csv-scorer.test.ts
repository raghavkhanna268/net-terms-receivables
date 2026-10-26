/**
 * Unit test: Scorer behavior for reviewer synthetic HDFC CSV (v3).
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
 * CSV v3 changes:
 * - Row 2: UPI-TEST BUYER CO-SYNT0002-#1002, ₹5,000.00 (was ₹4,000)
 * - Row 3: IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT, ₹2,500.00
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

describe("HDFC reviewer CSV v3: Scorer unit test (hypothetical candidates)", () => {
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

  describe("parser output for scoring (CSV v3)", () => {
    it("extracts 3 credit rows", () => {
      expect(credits.length).toBe(3);
    });

    it("Row 1: payerName includes company name and invoice ref", () => {
      const row1 = credits.find((c) => c.refNo === "SYNT0001");
      expect(row1).toBeDefined();
      expect(row1!.parsed.payerName).toBe("SYNT0001 TEST BUYER CO #1001");
      expect(row1!.amountPaise).toBe(1000000); // ₹10,000
    });

    it("Row 2: payerName is company name from UPI parser (v3)", () => {
      const row2 = credits.find((c) => c.refNo === "SYNT0002");
      expect(row2).toBeDefined();
      // UPI parser extracts "TEST BUYER CO" from "UPI-TEST BUYER CO-SYNT0002-#1002"
      expect(row2!.parsed.payerName).toBe("TEST BUYER CO");
      expect(row2!.amountPaise).toBe(500000); // ₹5,000
    });

    it("Row 3: payerName is company name from IMPS parser (v3)", () => {
      const row3 = credits.find((c) => c.refNo === "SYNT0003");
      expect(row3).toBeDefined();
      // IMPS parser extracts "TEST BUYER CO" from "IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT"
      expect(row3!.parsed.payerName).toBe("TEST BUYER CO");
      expect(row3!.amountPaise).toBe(250000); // ₹2,500
    });
  });

  describe("scorer tests with all invoices (no amount window filtering)", () => {
    /**
     * Row 1: NEFT-SYNT0001-TEST BUYER CO-#1001, ₹10,000.00
     *
     * Score breakdown:
     * - invoice_ref: +30 (#1001 found in narration, matches invoice.name)
     * - amount_exact: +20 (payment 10,000 = invoice outstanding 10,000)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO" in payerText to buyer.name)
     * - Total: 58 points, MEDIUM band
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
     * Row 2: UPI-TEST BUYER CO-SYNT0002-#1002, ₹5,000.00 (CSV v3)
     *
     * Score breakdown:
     * - invoice_ref: +30 (#1002 in narration matches invoice name)
     * - amount_exact: +20 (payment ₹5,000 = invoice ₹5,000)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO" to buyer.name)
     * - Total: 58 points, MEDIUM band
     */
    it("Row 2: scorer finds #1002 with score 58 (v3)", () => {
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
      expect(extractedRefs).toContain("1002");

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-2");

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(58);
      expect(band).toBe("medium");

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("invoice_ref");
      expect(reasonTypes).toContain("amount_exact");
      expect(reasonTypes).toContain("payer_name");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("invoice_ref(+30), amount_exact(+20), payer_name(+8)");
    });

    /**
     * Row 3: IMPS-SYNT0003-TEST BUYER CO-#1002 PART PAYMENT, ₹2,500.00 (CSV v3)
     *
     * Score breakdown:
     * - invoice_ref: +30 (#1002 in narration matches invoice name)
     * - amount_partial: +10 (payment ₹2,500 < invoice ₹5,000)
     * - payer_name: +8 (fuzzy match "TEST BUYER CO" to buyer.name)
     * - Total: 48 points, LOW band
     */
    it("Row 3: scorer finds #1002 with score 48 (v3)", () => {
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
      expect(extractedRefs).toContain("1002");

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("invoice-reviewer-demo-2");

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(48);
      expect(band).toBe("low");

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("invoice_ref");
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).toContain("payer_name");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("invoice_ref(+30), amount_partial(+10), payer_name(+8)");
    });
  });

  describe("summary: scorer test vs real DB path (CSV v3)", () => {
    /**
     * SCORER TEST RESULTS (all invoices passed directly):
     *
     * | Row | Amount   | PayerText (parsed)           | Top Candidate           | Score | Band   | Breakdown                                     |
     * |-----|----------|------------------------------|-------------------------|-------|--------|-----------------------------------------------|
     * | 1   | ₹10,000  | SYNT0001 TEST BUYER CO #1001 | invoice-reviewer-demo-1 | 58    | medium | invoice_ref(+30), amount_exact(+20), payer_name(+8) |
     * | 2   | ₹5,000   | TEST BUYER CO                | invoice-reviewer-demo-2 | 58    | medium | invoice_ref(+30), amount_exact(+20), payer_name(+8) |
     * | 3   | ₹2,500   | TEST BUYER CO                | invoice-reviewer-demo-2 | 48    | low    | invoice_ref(+30), amount_partial(+10), payer_name(+8) |
     *
     * High (80) requires a confirmed payer alias; without one the best is Medium (58).
     */
    it("validates all scores match pinned expectations (v3)", () => {
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
      expect(r2!.allocations[0].score).toBe(58);
      expect(r3!.allocations[0].score).toBe(48);

      expect(getConfidenceBand(r1!.allocations[0].score)).toBe("medium");
      expect(getConfidenceBand(r2!.allocations[0].score)).toBe("medium");
      expect(getConfidenceBand(r3!.allocations[0].score)).toBe("low");
    });
  });
});
