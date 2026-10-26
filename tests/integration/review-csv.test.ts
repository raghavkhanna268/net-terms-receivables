/**
 * Unit-level scoring tests for App Store reviewer synthetic HDFC CSV.
 *
 * This test pins UNIT-LEVEL scoring with:
 * - Hand-set payerText (e.g., "TEST BUYER CO") instead of real parser output
 * - Pre-seeded buyer aliases for payer_alias matching
 *
 * For what the app ACTUALLY shows (real parser output, no pre-seeded aliases),
 * see tests/integration/review-csv-app-path.test.ts.
 *
 * This test documents exact scores, bands, and match candidates for the
 * synthetic reviewer file (hdfc-review-synthetic.csv).
 *
 * All data is FICTIONAL - no real bank data.
 *
 * Score breakdown components (from app/lib/matching/score.ts):
 * - invoice_ref: +30 (invoice number in narration, e.g., #1001)
 * - order_ref: +30 (order ID matches extracted ref)
 * - amount_exact: +20 (payment equals invoice outstanding)
 * - amount_partial: +10 (payment < invoice outstanding)
 * - amount_overpayment: +10 (payment > invoice outstanding)
 * - payer_alias: +10 (exact/substring match on buyer.aliases)
 * - payer_name: +8 (fuzzy match on buyer.name, floor(10 * 0.8))
 * - email_match: +6 (email prefix match, floor(10 * 0.6))
 * - multi_invoice: +5 (bonus for subset-sum match to multiple invoices)
 *
 * Maximum single-invoice score: 30 + 20 + 10 = 60
 * CONFIDENCE_THRESHOLD: 80 (requires multi-invoice or additional signals)
 *
 * NOTE: There is NO date matching in the scorer. The invoice.dueAt field is
 * only used for oldest-due-first allocation preference, not scoring.
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
  type PaymentForScoring,
  type BuyerForScoring,
  type MatchReason,
} from "../../app/lib/matching/score.js";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

/**
 * Synthetic open-invoice set for matching tests.
 *
 * This matches the shape that the real import route passes to the matcher:
 * - Buyer with id, name, aliases array, and optional email
 * - Invoices with id, name (#-prefixed), orderId (GID), outstandingPaise, buyerAccountId, dueAt
 *
 * Buyer: Test Buyer Co (test-buyer@example.com)
 * - Invoice #1001: ₹10,000.00 outstanding (matches row 1 exactly)
 * - Invoice #1002: ₹6,000.00 outstanding (for partial/name suggestion on row 2)
 *
 * Due dates are set to November 2026 to be in the same window as the statement dates.
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

/**
 * Format reasons array for test documentation.
 */
function formatReasons(reasons: MatchReason[]): string {
  return reasons.map((r) => `${r.type}(+${r.points})`).join(", ");
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

    /**
     * Row count explanation (26 total rows):
     * - Line 1: Comment "# SYNTHETIC REVIEWER..."
     * - Line 2: Comment "# Purpose:..."
     * - Line 3: Comment "# All names..."
     * - Line 4: Empty line
     * - Line 5: "HDFC BANK"
     * - Line 6: "Statement of Account"
     * - Line 7: "Account No: 00999888777666"
     * - Line 8: "Account Type: Savings Account"
     * - Line 9: "Branch: SYNTHETIC REVIEW BRANCH"
     * - Line 10: Empty line
     * - Line 11: Header row "Date,Narration,..."
     * - Line 12: "Opening Balance" row
     * - Lines 13-16: 4 transaction rows (3 credits + 1 debit)
     * - Line 17: Empty line
     * - Line 18: "Total" summary row (this causes parse error - has amounts but no date)
     * - Line 19: Empty line
     * - Line 20: "Statement Summary"
     * - Line 21: "Opening Balance: 50,000.00"
     * - Line 22: "Total Deposits: 16,500.00"
     * - Line 23: "Total Withdrawals: 1,200.00"
     * - Line 24: "Closing Balance: 65,300.00"
     * - Line 25: Empty line
     * - Line 26: "This is a computer generated..."
     *
     * Parse error: The "Total" row (line 18) has amounts in the withdrawal/deposit
     * columns but no date, triggering ROW_PARSE_FAILED. This is consistent with
     * hdfc-retail-synthetic.csv which has the same Total row format.
     */
    it("pins exact row counts", () => {
      // Total rows in file (all lines including comments, preamble, footer)
      expect(parseResult.totalRows).toBe(26);

      // Parsed transactions (both credits and debits)
      expect(parseResult.transactions.length).toBe(4);

      // Credits imported (deposits)
      expect(credits.length).toBe(3);

      // Non-credits (debits/withdrawals) - parsed but filtered by direction
      expect(debits.length).toBe(1);

      // Parse errors: "Total" summary row has amounts but no date
      // This matches hdfc-retail-synthetic.csv behavior
      expect(parseResult.errors.length).toBe(1);
      expect(parseResult.errors[0].code).toBe("ROW_PARSE_FAILED");

      // Skipped rows (preamble, header, opening balance, footer, summary)
      expect(parseResult.skippedRows).toBeGreaterThan(0);
    });

    /**
     * UI display notes (app/routes/app.imports.tsx):
     *
     * Lines 940-947: Total Rows display
     *   "Total Rows: 26 (skipped: N)"
     *
     * Lines 943-947: Credits Found display
     *   "Credits Found: 3 (debits: 1, not imported)"
     *
     * Lines 951-992: Parse errors banner
     *   "1 row(s) could not be parsed"
     *   "Row 18: ROW_PARSE_FAILED - Could not parse this row"
     */
    it("documents UI display values", () => {
      // What the UI would show for "Credits Found"
      expect(credits.length).toBe(3);

      // What the UI would show for "debits: X, not imported"
      expect(debits.length).toBe(1);

      // What the UI would show for "N row(s) could not be parsed"
      expect(parseResult.errors.length).toBe(1);
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
     *
     * Score breakdown:
     * - invoice_ref: +30 (#1001 found in narration, matches invoice.name)
     * - amount_exact: +20 (payment 10,000 = invoice outstanding 10,000)
     * - payer_alias: +10 (payerText "TEST BUYER CO" matches alias "test buyer co")
     * - Total: 60 points
     *
     * This is the MAXIMUM possible score for a single-invoice match.
     * CONFIDENCE_THRESHOLD is 80, which requires either:
     * - Multi-invoice match (adds +5 bonus) plus perfect single-invoice scores, OR
     * - Additional scoring factors not present in the current scorer
     *
     * There is NO date matching - invoice.dueAt is only for allocation ordering.
     */
    it("Row 1: pins medium-band match (score 60 < 80 threshold) with breakdown", () => {
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

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("invoice-1001");

      // Pin exact score (60 is maximum single-invoice score)
      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(60);
      expect(band).toBe("medium"); // 60 < CONFIDENCE_THRESHOLD (80)
      expect(allocation.allocatedPaise).toBe(1000000n);

      // Pin exact reason breakdown
      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("invoice_ref");
      expect(reasonTypes).toContain("amount_exact");
      expect(reasonTypes).toContain("payer_alias");

      // Verify points per reason
      const invoiceRefReason = allocation.reasons.find((r) => r.type === "invoice_ref");
      const amountExactReason = allocation.reasons.find((r) => r.type === "amount_exact");
      const payerAliasReason = allocation.reasons.find((r) => r.type === "payer_alias");

      expect(invoiceRefReason?.points).toBe(30);
      expect(amountExactReason?.points).toBe(20);
      expect(payerAliasReason?.points).toBe(10);

      // Document the breakdown
      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("invoice_ref(+30), amount_exact(+20), payer_alias(+10)");
    });

    /**
     * Row 2: UPI-SYNT0002-TEST BUYER CO-PART PAYMENT, ₹4,000.00
     *
     * Score breakdown:
     * - amount_partial: +10 (payment 4,000 < invoice outstanding)
     * - payer_alias: +10 (payerText "TEST BUYER CO" matches alias)
     * - Total: 20 points
     *
     * No invoice_ref because "PART PAYMENT" narration has no #1001 or #1002.
     * Allocation goes to invoice-1001 (oldest-due-first preference).
     *
     * DEVIATION FROM STATED INTENT: The intent was "partial for #1002" but the
     * matcher allocates to #1001 because both invoices are partial matches and
     * #1001 has an earlier dueAt.
     */
    it("Row 2: pins partial/name suggestion behavior with breakdown", () => {
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
      expect(extractedRefs.length).toBe(0); // No invoice ref in "PART PAYMENT"

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];

      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(20);
      expect(band).toBe("low");

      // Allocation goes to oldest-due invoice (#1001), not #1002
      expect(allocation.invoiceId).toBe("invoice-1001");
      expect(allocation.allocatedPaise).toBe(400000n);

      // Pin reason breakdown
      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).toContain("payer_alias");
      expect(reasonTypes).not.toContain("invoice_ref");

      // Verify points
      const amountPartialReason = allocation.reasons.find((r) => r.type === "amount_partial");
      const payerAliasReason = allocation.reasons.find((r) => r.type === "payer_alias");

      expect(amountPartialReason?.points).toBe(10);
      expect(payerAliasReason?.points).toBe(10);

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("amount_partial(+10), payer_alias(+10)");
    });

    /**
     * Row 3: IMPS-SYNT0003-UNRELATED TRADERS, ₹2,500.00
     *
     * Score breakdown:
     * - amount_partial: +10 (payment 2,500 < invoice outstanding)
     * - Total: 10 points
     *
     * No invoice_ref (no #-prefixed number in narration).
     * No payer match ("UNRELATED TRADERS" doesn't match "Test Buyer Co" or aliases).
     *
     * DEVIATION FROM STATED INTENT: The intent was "stay unmatched" but the
     * scorer still returns a low-confidence suggestion. In production, this
     * would be shown as a low-confidence match requiring manual review.
     * The scorer has no explicit payer-mismatch filter - it just doesn't add points.
     */
    it("Row 3: pins unmatched/low-confidence behavior with breakdown", () => {
      const row3 = credits.find((c) => c.refNo === "SYNT0003");
      expect(row3).toBeDefined();

      const payment: PaymentForScoring = {
        id: "payment-row3",
        amountPaise: BigInt(row3!.amountPaise),
        narration: row3!.narration,
        payerText: "UNRELATED TRADERS",
        utr: row3!.parsed.utr ?? null,
        rail: row3!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(row3!.narration);
      expect(extractedRefs.length).toBe(0);

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      const score = allocation.score;
      const band = getConfidenceBand(score);

      expect(score).toBe(10);
      expect(band).toBe("low");

      // Pin reason breakdown - only amount_partial, no payer match
      const reasonTypes = allocation.reasons.map((r) => r.type);
      expect(reasonTypes).toContain("amount_partial");
      expect(reasonTypes).not.toContain("payer_alias");
      expect(reasonTypes).not.toContain("payer_name");
      expect(reasonTypes).not.toContain("invoice_ref");

      const breakdown = formatReasons(allocation.reasons);
      expect(breakdown).toBe("amount_partial(+10)");
    });

    /**
     * Row 4: SYNT0004-BANK CHARGES, ₹1,200.00 (WITHDRAWAL)
     *
     * This is a debit (withdrawal), not a credit. Debits are parsed but not
     * matched against open invoices - they're bank charges, not incoming payments.
     */
    it("Row 4: is a debit and should not be matched", () => {
      const row4 = debits.find((d) => d.refNo === "SYNT0004");
      expect(row4).toBeDefined();
      expect(row4!.direction).toBe("DR");
      expect(row4!.amountPaise).toBe(120000);
      expect(row4!.narration).toContain("BANK CHARGES");
    });
  });

  describe("comparison with hdfc-retail-synthetic.csv", () => {
    /**
     * The existing hdfc-retail-synthetic.csv has the same "Total" row format
     * that causes a ROW_PARSE_FAILED error. This is expected HDFC behavior.
     */
    it("hdfc-retail-synthetic.csv also has Total row parse error", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
      const retailResult = await parseBankStatement(file);

      // Should also have a parse error for Total row
      const totalRowError = retailResult.errors.find(
        (e) => e.code === "ROW_PARSE_FAILED"
      );
      expect(totalRowError).toBeDefined();
    });
  });

  describe("summary of pinned match results", () => {
    /**
     * Summary table of pinned match results (unit-level with aliases):
     *
     * | Row | Ref      | Amount    | Dir | Score | Band   | Candidate    | Breakdown                                  |
     * |-----|----------|-----------|-----|-------|--------|--------------|-------------------------------------------|
     * | 1   | SYNT0001 | 10,000.00 | CR  | 60    | medium | invoice-1001 | invoice_ref(+30), amount_exact(+20), payer_alias(+10) |
     * | 2   | SYNT0002 | 4,000.00  | CR  | 20    | low    | invoice-1001 | amount_partial(+10), payer_alias(+10)     |
     * | 3   | SYNT0003 | 2,500.00  | CR  | 10    | low    | invoice-1001 | amount_partial(+10)                       |
     * | 4   | SYNT0004 | 1,200.00  | DR  | N/A   | N/A    | N/A          | Debit - not matched                       |
     *
     * SCORE BREAKDOWN NOTES:
     * - Maximum single-invoice score is 60 (30 ref + 20 amount + 10 name)
     * - CONFIDENCE_THRESHOLD is 80, requiring multi-invoice bonus or more signals
     * - There is NO date matching - dueAt is only for allocation ordering
     *
     * DEVIATIONS FROM STATED INTENT:
     * - Row 1: Intent was "high confidence" but 60 < 80 threshold → medium band
     * - Row 2: Intent was "partial for #1002" but oldest-due preference → #1001
     * - Row 3: Intent was "stay unmatched" but scorer returns low-confidence → still suggests
     *
     * NOTE: This is UNIT-LEVEL scoring with pre-seeded aliases. For real app
     * behavior (no aliases, amount window filtering), see:
     * - tests/integration/review-csv-matcher-db.test.ts
     */
    it("validates pinned scores from individual tests", () => {
      const row1 = credits.find((c) => c.refNo === "SYNT0001")!;
      const row2 = credits.find((c) => c.refNo === "SYNT0002")!;
      const row3 = credits.find((c) => c.refNo === "SYNT0003")!;

      const buyer: BuyerForScoring = {
        id: "buyer-1",
        name: "Test Buyer Co",
        aliases: ["test buyer co"],
        email: "test@test-buyer.example",
      };

      const invoices: InvoiceForScoring[] = [
        {
          id: "invoice-1001",
          name: "#1001",
          orderId: "gid://shopify/Order/1001",
          outstandingPaise: 1000000n,
          buyerAccountId: buyer.id,
          dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        {
          id: "invoice-1002",
          name: "#1002",
          orderId: "gid://shopify/Order/1002",
          outstandingPaise: 500000n,
          buyerAccountId: buyer.id,
          dueAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000),
        },
      ];

      const makePayment = (row: NormalisedTxn) => ({
        id: `payment-${row.refNo}`,
        amountPaise: BigInt(row.amountPaise),
        narration: row.narration,
        payerText: "TEST BUYER CO",
        utr: row.parsed.utr ?? null,
        rail: row.parsed.rail,
      });

      const r1 = scoreMultiInvoiceMatch(makePayment(row1), invoices, buyer);
      const r2 = scoreMultiInvoiceMatch(makePayment(row2), invoices, buyer);
      const r3 = scoreMultiInvoiceMatch(
        { ...makePayment(row3), payerText: "UNRELATED TRADERS" },
        invoices,
        buyer
      );

      expect(r1!.allocations[0].score).toBe(60);
      expect(r2!.allocations[0].score).toBe(20);
      expect(r3!.allocations[0].score).toBe(10);

      expect(getConfidenceBand(r1!.allocations[0].score)).toBe("medium");
      expect(getConfidenceBand(r2!.allocations[0].score)).toBe("low");
      expect(getConfidenceBand(r3!.allocations[0].score)).toBe("low");
    });
  });
});
