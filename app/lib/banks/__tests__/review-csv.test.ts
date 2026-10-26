/**
 * Integration tests for App Store reviewer synthetic HDFC CSV.
 *
 * This test pins the current parser and matcher behavior against the synthetic
 * reviewer file (hdfc-review-synthetic.csv). It documents exact scores, bands,
 * and match candidates without modifying any app code.
 *
 * All data is FICTIONAL - no real bank data.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement } from "../index.js";
import type { ParseResult, NormalisedTxn } from "../types.js";
import {
  scoreMultiInvoiceMatch,
  extractInvoiceRefs,
  CONFIDENCE_THRESHOLD,
  type InvoiceForScoring,
  type PaymentForScoring,
  type BuyerForScoring,
} from "~/lib/matching/score";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

/**
 * Synthetic open-invoice set for matching tests.
 *
 * Buyer: Test Buyer Co (test-buyer@example.com)
 * - Invoice #1001: ₹10,000.00 outstanding (matches row 1 exactly)
 * - Invoice #1002: ₹6,000.00 outstanding (for partial/name suggestion on row 2)
 */
const SYNTHETIC_BUYER: BuyerForScoring = {
  id: "buyer-synthetic-review",
  name: "Test Buyer Co",
  aliases: ["test buyer co", "test buyer"],
  email: "test-buyer@example.com",
};

const SYNTHETIC_INVOICES: InvoiceForScoring[] = [
  {
    id: "invoice-1001",
    name: "#1001",
    orderId: "gid://shopify/Order/1001",
    outstandingPaise: 1000000n, // ₹10,000.00
    buyerAccountId: SYNTHETIC_BUYER.id,
    dueAt: new Date("2026-11-30"),
  },
  {
    id: "invoice-1002",
    name: "#1002",
    orderId: "gid://shopify/Order/1002",
    outstandingPaise: 600000n, // ₹6,000.00
    buyerAccountId: SYNTHETIC_BUYER.id,
    dueAt: new Date("2026-12-15"),
  },
];

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

describe("HDFC reviewer synthetic CSV parse and match", () => {
  let parseResult: ParseResult;
  let credits: NormalisedTxn[];
  let debits: NormalisedTxn[];

  beforeAll(async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic.csv"));
    const file = new File([content], "hdfc-review-synthetic.csv", { type: "text/csv" });
    parseResult = await parseBankStatement(file);

    credits = parseResult.transactions.filter((t) => t.direction === "CR");
    debits = parseResult.transactions.filter((t) => t.direction === "DR");
  });

  describe("detection and parsing", () => {
    it("detects HDFC bank", () => {
      expect(parseResult.detection.bank).toBe("HDFC");
      expect(parseResult.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("pins exact row counts", () => {
      // Total rows in file (including header, preamble, footer)
      expect(parseResult.totalRows).toBe(26);

      // Parsed transactions (both credits and debits)
      expect(parseResult.transactions.length).toBe(4);

      // Credits imported (deposits)
      expect(credits.length).toBe(3);

      // Non-credits skipped (debits/withdrawals) - these are parsed but filtered by direction
      expect(debits.length).toBe(1);

      // Parse errors: The "Total" summary row has amounts but no date, triggering a parse error
      expect(parseResult.errors.length).toBe(1);

      // Skipped rows (preamble, header, opening balance, footer, summary)
      expect(parseResult.skippedRows).toBeGreaterThan(0);
    });

    it("parses all credits with SYNT marker in narration", () => {
      for (const credit of credits) {
        expect(credit.narration).toContain("SYNT");
      }
    });

    it("parses all transactions with SYNT marker in refNo", () => {
      for (const txn of parseResult.transactions) {
        expect(txn.refNo).toMatch(/^SYNT\d{4}$/);
      }
    });

    it("parses dates as November 2026", () => {
      for (const txn of parseResult.transactions) {
        expect(txn.date).toMatch(/^2026-11-\d{2}$/);
      }
    });

    it("pins credit amounts in paise", () => {
      const amounts = credits.map((c) => c.amountPaise);
      expect(amounts).toEqual([
        1000000, // Row 1: ₹10,000.00
        400000, // Row 2: ₹4,000.00
        250000, // Row 3: ₹2,500.00
      ]);
    });

    it("pins debit amount in paise", () => {
      expect(debits.length).toBe(1);
      expect(debits[0].amountPaise).toBe(120000); // Row 4: ₹1,200.00
    });

    it("extracts payment rails correctly", () => {
      const rails = parseResult.transactions.map((t) => t.parsed.rail);
      expect(rails).toEqual(["NEFT", "UPI", "IMPS", "OTHER"]);
    });
  });

  describe("matcher scoring against synthetic invoices", () => {
    /**
     * Row 1: NEFT-SYNT0001-TEST BUYER CO-#1001, ₹10,000.00
     * Expected: High confidence match to #1001 (order ref + exact amount + payer name)
     */
    it("Row 1: pins high confidence match to #1001", () => {
      const row1 = credits.find((c) => c.refNo === "SYNT0001");
      expect(row1).toBeDefined();

      const payment: PaymentForScoring = {
        id: "payment-row1",
        amountPaise: BigInt(row1!.amountPaise),
        narration: row1!.narration,
        payerText: "TEST BUYER CO",
        utr: row1!.parsed.utr ?? null,
        rail: row1!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row1!.narration);
      expect(extractedRefs).toContain("1001");

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      // Pin exact score, band, and candidate
      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("invoice-1001");

      // Score breakdown:
      // - Invoice ref (#1001 in narration): +30
      // - Exact amount (₹10,000): +20
      // - Payer name match: +10 (alias) or +8 (fuzzy name)
      // Total expected: 60 (with name match) or 58 (fuzzy)
      const score = allocation.score;
      const band = getConfidenceBand(score);

      // Pin the actual score and band from current implementation
      expect(score).toBe(60);
      expect(band).toBe("medium");
      expect(allocation.allocatedPaise).toBe(1000000n);

      // Pin reasons
      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("invoice_ref");
      expect(reasonTypes).toContain("amount_exact");
      expect(reasonTypes).toContain("payer_alias");
    });

    /**
     * Row 2: UPI-SYNT0002-TEST BUYER CO-PART PAYMENT, ₹4,000.00
     * Expected: Partial/name-only suggestion (no invoice ref, partial amount, payer name)
     *
     * DEVIATION FROM INTENT: This row was intended as a "partial or name-only suggestion"
     * for invoice #1002 (₹6,000). However, the current matcher implementation:
     * - Does NOT have an invoice reference in the narration
     * - Amount ₹4,000 is partial against both invoices
     * - Only scores on amount_partial + payer_alias
     *
     * The actual behavior is pinned below without asserting "correct" intent.
     */
    it("Row 2: pins partial/name suggestion behavior", () => {
      const row2 = credits.find((c) => c.refNo === "SYNT0002");
      expect(row2).toBeDefined();

      const payment: PaymentForScoring = {
        id: "payment-row2",
        amountPaise: BigInt(row2!.amountPaise),
        narration: row2!.narration,
        payerText: "TEST BUYER CO",
        utr: row2!.parsed.utr ?? null,
        rail: row2!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row2!.narration);
      // No invoice ref in "PART PAYMENT" narration
      expect(extractedRefs.length).toBe(0);

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];

      // Pin actual behavior: matches oldest-due invoice first (#1001)
      // Score: amount_partial (10) + payer_alias (10) = 20
      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(20);
      expect(band).toBe("low");

      // Allocation goes to oldest-due invoice (#1001), not #1002
      // This deviates from the stated intent of "partial for #1002"
      expect(allocation.invoiceId).toBe("invoice-1001");
      expect(allocation.allocatedPaise).toBe(400000n);

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).toContain("payer_alias");
      expect(reasonTypes).not.toContain("invoice_ref");
    });

    /**
     * Row 3: IMPS-SYNT0003-UNRELATED TRADERS, ₹2,500.00
     * Expected: Should stay unmatched (different payer, no invoice ref)
     *
     * DEVIATION FROM INTENT: The current matcher still produces a low-confidence
     * suggestion because the amount partially matches and there's no explicit
     * payer-mismatch penalty. The test pins the actual behavior.
     */
    it("Row 3: pins unmatched/low-confidence behavior", () => {
      const row3 = credits.find((c) => c.refNo === "SYNT0003");
      expect(row3).toBeDefined();

      const payment: PaymentForScoring = {
        id: "payment-row3",
        amountPaise: BigInt(row3!.amountPaise),
        narration: row3!.narration,
        payerText: "UNRELATED TRADERS", // Different payer
        utr: row3!.parsed.utr ?? null,
        rail: row3!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row3!.narration);
      expect(extractedRefs.length).toBe(0);

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);

      // Current implementation still returns a result (no explicit payer mismatch filter)
      // In production, this would be a low-confidence suggestion requiring manual review
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      const score = allocation.score;
      const band = getConfidenceBand(score);

      // Score: amount_partial only (10), no payer match
      expect(score).toBe(10);
      expect(band).toBe("low");

      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).not.toContain("payer_alias");
      expect(reasonTypes).not.toContain("payer_name");
    });

    /**
     * Row 4: SYNT0004-BANK CHARGES, ₹1,200.00 (WITHDRAWAL)
     * Expected: Skipped as non-credit
     */
    it("Row 4: is a debit and should not be matched", () => {
      const row4 = debits.find((d) => d.refNo === "SYNT0004");
      expect(row4).toBeDefined();
      expect(row4!.direction).toBe("DR");

      // Debits are not matched against open invoices (they're withdrawals, not payments)
      // This test documents that the row is correctly identified as a debit
      expect(row4!.amountPaise).toBe(120000);
      expect(row4!.narration).toContain("BANK CHARGES");
    });
  });

  describe("summary of pinned match results", () => {
    it("documents all rows with their pinned scores and candidates", () => {
      /**
       * Summary table of pinned match results:
       *
       * | Row | Ref      | Amount    | Direction | Score | Band   | Candidate   | Notes                           |
       * |-----|----------|-----------|-----------|-------|--------|-------------|---------------------------------|
       * | 1   | SYNT0001 | 10,000.00 | CR        | 60    | medium | invoice-1001| Order ref + exact amt + alias   |
       * | 2   | SYNT0002 | 4,000.00  | CR        | 20    | low    | invoice-1001| Partial + alias (oldest-due)    |
       * | 3   | SYNT0003 | 2,500.00  | CR        | 10    | low    | invoice-1001| Partial only (payer mismatch)   |
       * | 4   | SYNT0004 | 1,200.00  | DR        | N/A   | N/A    | N/A         | Debit - not matched             |
       *
       * DEVIATIONS FROM STATED INTENT:
       * - Row 1: Intent was "high confidence" but score is 60 (medium band). This is because
       *   CONFIDENCE_THRESHOLD is 80, requiring invoice ref + amount + name + more.
       * - Row 2: Intent was "partial for #1002" but matches #1001 (oldest-due preference).
       * - Row 3: Intent was "stay unmatched" but scorer returns low-confidence suggestion.
       */

      // This test exists purely for documentation
      expect(parseResult.transactions.length).toBe(4);
      expect(credits.length).toBe(3);
      expect(debits.length).toBe(1);
    });
  });
});
