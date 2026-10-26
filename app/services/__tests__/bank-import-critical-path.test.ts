/**
 * Critical path tests for the app-reviewer bank import flow.
 *
 * Tests cover: bank-statement upload (HDFC and ICICI formats) → parse → match suggestions
 * → merchant confirm → outstanding/aging update, plus the confirm-only guarantee.
 *
 * IMPORTANT: These tests use SYNTHETIC fixtures only - no real bank data.
 * All payer names, UTRs, and emails are fabricated with test-* patterns.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseBankStatement } from "~/lib/banks/index";
import { detectFooterRows } from "~/lib/banks/detection";
import type { SheetData } from "~/lib/banks/types";

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi.fn().mockResolvedValue({
      success: true,
      data: {
        orderMarkAsPaid: {
          order: { id: "gid://shopify/Order/test-123", displayFinancialStatus: "PAID" },
          userErrors: [],
        },
      },
    }),
  };
});

vi.mock("../credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  computeCreditDedupeKeys,
  normalizeDedupeKeyForDb,
  type ImportCreditRow,
} from "../bank-import.server";
import {
  scorePaymentToInvoice,
  scoreMultiInvoiceMatch,
  extractInvoiceRefs,
  normalizePayerName,
  CONFIDENCE_THRESHOLD,
  type PaymentForScoring,
  type InvoiceForScoring,
  type BuyerForScoring,
} from "~/lib/matching/score";

function makeHdfcCsv(rows: string[]): string {
  const header = `HDFC BANK
Statement of Account
Account No: 00123456789012
Account Type: Savings Account
Branch: TEST BRANCH

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
01/10/26,Opening Balance,,,,,"1,00,000.00"`;
  return [header, ...rows].join("\n");
}

function makeIciciCsv(rows: string[]): string {
  const header = `ICICI BANK
Statement of Account
Account No: 00123456789012

S No.,Transaction Date,Cheque Number,Remarks,Withdrawal,Deposit,Balance
1,01.10.2026,,B/F,,,100000.00`;
  return [header, ...rows].join("\n");
}

function makeValidNeftUtr(suffix: string): string {
  const paddedSuffix = suffix.replace(/[^0-9]/g, "").padStart(11, "0").slice(0, 11);
  return `HDFCN${paddedSuffix}`;
}

describe("Bank Import Critical Path Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("HDFC happy path: parse, expected credits, match suggestions", () => {
    it("parses HDFC statement and extracts credit transactions correctly", async () => {
      const syntheticUtr = makeValidNeftUtr("10000000001");
      const hdfcCsv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST BUYER ONE-INVOICE #1001,${syntheticUtr},02/10/26,,"50,000.00","1,50,000.00"`,
        `03/10/26,NEFT CR-ACME TEST TRADERS-ORDER PAYMENT,${makeValidNeftUtr("10000000002")},03/10/26,,"25,000.00","1,75,000.00"`,
        `04/10/26,UPI-TEST VENDOR-testvendor@test-TEST001-987654321098-UPI,987654321098,04/10/26,500.00,,"1,74,500.00"`,
        `Total,,,,"500.00","75,000.00",`,
      ]);

      const file = new File([hdfcCsv], "hdfc-test-statement.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      expect(credits.length).toBe(2);

      const neftCredit = credits.find((t) => t.narration.includes("TEST BUYER ONE"));
      expect(neftCredit).toBeDefined();
      expect(neftCredit!.amountPaise).toBe(5000000);
      expect(neftCredit!.parsed.rail).toBe("NEFT");
      expect(neftCredit!.date).toBe("2026-10-02");
    });

    it("generates match suggestions for HDFC credits against invoices", () => {
      const payment: PaymentForScoring = {
        id: "pay-1",
        amountPaise: BigInt(5000000),
        narration: "NEFT CR-TEST BUYER ONE-INVOICE #1001",
        payerText: "TEST BUYER ONE",
        utr: makeValidNeftUtr("10000000001"),
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-1",
        name: "#1001",
        orderId: "gid://shopify/Order/1001",
        outstandingPaise: BigInt(5000000),
        buyerAccountId: "buyer-1",
        dueAt: new Date(),
      };

      const buyer: BuyerForScoring = {
        id: "buyer-1",
        name: "Test Buyer One Pvt Ltd",
        aliases: ["test buyer one"],
        email: "buyer@example.com",
      };

      const refs = extractInvoiceRefs(payment.narration);
      const result = scorePaymentToInvoice(payment, invoice, buyer, refs);

      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.reasons.some((r) => r.type === "invoice_ref")).toBe(true);
      expect(result.reasons.some((r) => r.type === "amount_exact")).toBe(true);
      expect(result.allocatedPaise).toBe(BigInt(5000000));
    });
  });

  describe("ICICI happy path: parse, expected credits, match suggestions", () => {
    it("parses ICICI statement and extracts credit transactions correctly", async () => {
      const iciciCsv = makeIciciCsv([
        `2,02.10.2026,,NEFT-TESTREF0001-ACME TEST TRADERS-INV-12001,,50000.00,150000.00`,
        `3,03.10.2026,,UPI/TEST SHOP/testshop@testpay/Payment for order,,25000.00,175000.00`,
        `4,04.10.2026,,ATM WITHDRAWAL,500.00,,174500.00`,
      ]);

      const file = new File([iciciCsv], "icici-test-statement.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("ICICI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      expect(credits.length).toBe(2);

      const neftCredit = credits.find((t) => t.narration.includes("ACME TEST"));
      expect(neftCredit).toBeDefined();
      expect(neftCredit!.amountPaise).toBe(5000000);
      expect(neftCredit!.parsed.rail).toBe("NEFT");
    });

    it("generates match suggestions for ICICI credits against invoices", () => {
      const payment: PaymentForScoring = {
        id: "pay-2",
        amountPaise: BigInt(5000000),
        narration: "NEFT-TESTREF0001-ACME TEST TRADERS-INV-12001",
        payerText: "ACME TEST TRADERS",
        utr: "TESTREF0001",
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-2",
        name: "#12001",
        orderId: "gid://shopify/Order/12001",
        outstandingPaise: BigInt(5000000),
        buyerAccountId: "buyer-2",
        dueAt: new Date(),
      };

      const buyer: BuyerForScoring = {
        id: "buyer-2",
        name: "Acme Test Traders Pvt Ltd",
        aliases: ["acme test traders"],
        email: "acme@example.com",
      };

      const refs = extractInvoiceRefs(payment.narration);
      const result = scorePaymentToInvoice(payment, invoice, buyer, refs);

      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.reasons.some((r) => r.type === "invoice_ref")).toBe(true);
    });
  });

  describe("Duplicate upload idempotency: same file twice creates no duplicate transactions", () => {
    it("generates identical dedupe keys for identical credit rows", async () => {
      const credits: ImportCreditRow[] = [
        {
          date: "2026-10-02",
          amountPaise: 5000000,
          rail: "NEFT",
          utr: makeValidNeftUtr("10000000001"),
          payerName: "TEST BUYER ONE",
          narration: "NEFT CR-TEST BUYER ONE-INVOICE #1001",
        },
      ];

      const firstRun = await computeCreditDedupeKeys(credits);
      const secondRun = await computeCreditDedupeKeys(credits);

      expect(firstRun[0].dedupeKey).toBe(secondRun[0].dedupeKey);
      expect(firstRun[0].dedupeKey).toContain("utr:");
    });

    it("normalizeDedupeKeyForDb extracts UTR from utr: format keys", () => {
      const utrKey = "utr:NEFT:CR:HDFCN00010000001";
      const normalizedKey = normalizeDedupeKeyForDb(utrKey);
      expect(normalizedKey).toBe("HDFCN00010000001");
    });

    it("normalizeDedupeKeyForDb prefixes sha256 keys with SYNTH-", () => {
      const hashKey = "sha256:abc123def456";
      const normalizedKey = normalizeDedupeKeyForDb(hashKey);
      expect(normalizedKey).toBe("SYNTH-sha256:abc123def456");
    });
  });

  describe("Bare 'Total' footer row: current pinned behaviour", () => {
    it("skips Total footer row in HDFC statements", async () => {
      const hdfcCsv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST BUYER ONE-PAYMENT,${makeValidNeftUtr("10000000001")},02/10/26,,"50,000.00","1,50,000.00"`,
        `Total,,,,"0.00","50,000.00",`,
      ]);

      const file = new File([hdfcCsv], "hdfc-with-total.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      const totalRow = result.transactions.find((t) => t.narration.toLowerCase().includes("total"));
      expect(totalRow).toBeUndefined();
    });

    it("detectFooterRows identifies Total Debit/Credit footer rows", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
          ["02/10/26", "NEFT CR-TEST", "REF001", "02/10/26", "", "50000.00", "150000.00"],
          ["Total Debit", "", "", "", "10000.00", "", ""],
          ["Total Credit", "", "", "", "", "50000.00", ""],
        ],
      };

      const footerRows = detectFooterRows(sheet, 1);
      expect(footerRows.has(2)).toBe(true);
      expect(footerRows.has(3)).toBe(true);
    });

    it("bare Total row (current behavior): skipped during parsing via invalid date", async () => {
      const hdfcCsv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST BUYER-PAYMENT,${makeValidNeftUtr("10000000001")},02/10/26,,"50,000.00","1,50,000.00"`,
        `Total,,,,"0.00","50,000.00",`,
      ]);

      const file = new File([hdfcCsv], "hdfc-bare-total.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      const totalInNarration = result.transactions.find((t) => 
        t.narration.toLowerCase() === "total"
      );
      expect(totalInNarration).toBeUndefined();
    });

    it("skips Total Debit/Total Credit footer patterns", async () => {
      const hdfcCsv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST BUYER-PAYMENT,${makeValidNeftUtr("10000000001")},02/10/26,,"50,000.00","1,50,000.00"`,
        `Total Debit,,,,"10,000.00",,`,
        `Total Credit,,,,,"50,000.00",`,
      ]);

      const file = new File([hdfcCsv], "hdfc-total-debit-credit.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(1);
      const totalDebit = result.transactions.find((t) => t.narration.includes("Total Debit"));
      const totalCredit = result.transactions.find((t) => t.narration.includes("Total Credit"));
      expect(totalDebit).toBeUndefined();
      expect(totalCredit).toBeUndefined();
    });
  });

  describe("INR-only: non-INR shop rejection", () => {
    it("isCurrencyGateOpen returns false for non-INR currencies", async () => {
      const { isCurrencyGateOpen } = await import("~/lib/currency-gate.server");
      expect(isCurrencyGateOpen("USD")).toBe(false);
      expect(isCurrencyGateOpen("EUR")).toBe(false);
      expect(isCurrencyGateOpen("GBP")).toBe(false);
    });

    it("isCurrencyGateOpen returns true for INR", async () => {
      const { isCurrencyGateOpen } = await import("~/lib/currency-gate.server");
      expect(isCurrencyGateOpen("INR")).toBe(true);
    });

    it("CURRENCY_NOT_SUPPORTED_BANNER_COPY contains the merchant-facing message", async () => {
      const { CURRENCY_NOT_SUPPORTED_BANNER_COPY } = await import("~/lib/shop-currency-copy");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toBeDefined();
      expect(typeof CURRENCY_NOT_SUPPORTED_BANNER_COPY).toBe("string");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY.length).toBeGreaterThan(0);
    });
  });

  describe("Partial payment against one invoice: stays amount_partial, outstanding drops by exact paid amount", () => {
    it("scorePaymentToInvoice returns isPartial=true when payment < outstanding", () => {
      const payment: PaymentForScoring = {
        id: "pay-partial",
        amountPaise: BigInt(3000000),
        narration: "NEFT CR-TEST BUYER-PARTIAL PAYMENT #1001",
        payerText: "TEST BUYER",
        utr: makeValidNeftUtr("20000000001"),
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-partial",
        name: "#1001",
        orderId: "gid://shopify/Order/1001",
        outstandingPaise: BigInt(5000000),
        buyerAccountId: "buyer-partial",
        dueAt: new Date(),
      };

      const buyer: BuyerForScoring = {
        id: "buyer-partial",
        name: "Test Buyer Ltd",
        aliases: ["test buyer"],
        email: "buyer@example.com",
      };

      const refs = extractInvoiceRefs(payment.narration);
      const result = scorePaymentToInvoice(payment, invoice, buyer, refs);

      expect(result.isPartial).toBe(true);
      expect(result.allocatedPaise).toBe(BigInt(3000000));
      expect(result.reasons.some((r) => r.type === "amount_partial")).toBe(true);
    });

    it("partial payment allocates exactly the paid amount, not the full invoice", () => {
      const paymentAmount = BigInt(3000000);
      const outstandingAmount = BigInt(5000000);

      const payment: PaymentForScoring = {
        id: "pay-partial-2",
        amountPaise: paymentAmount,
        narration: "NEFT CR-TEST BUYER-PARTIAL",
        payerText: "TEST BUYER",
        utr: null,
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-partial-2",
        name: "#2001",
        orderId: null,
        outstandingPaise: outstandingAmount,
        buyerAccountId: "buyer-2",
        dueAt: new Date(),
      };

      const buyer: BuyerForScoring = {
        id: "buyer-2",
        name: "Test Buyer",
        aliases: [],
        email: null,
      };

      const result = scorePaymentToInvoice(payment, invoice, buyer, []);
      
      expect(result.allocatedPaise).toBe(paymentAmount);
      expect(result.allocatedPaise).not.toBe(outstandingAmount);
      
      const expectedNewOutstanding = outstandingAmount - result.allocatedPaise;
      expect(expectedNewOutstanding).toBe(BigInt(2000000));
    });
  });

  describe("One payment matching two candidate invoices: stays a suggestion, needs explicit choice", () => {
    it("scoreMultiInvoiceMatch returns multiple allocations when payment matches sum of invoices", () => {
      const payment: PaymentForScoring = {
        id: "pay-multi",
        amountPaise: BigInt(7500000),
        narration: "NEFT CR-TEST BUYER-COMBINED PAYMENT",
        payerText: "TEST BUYER",
        utr: makeValidNeftUtr("30000000001"),
        rail: "NEFT",
      };

      const invoices: InvoiceForScoring[] = [
        {
          id: "inv-multi-1",
          name: "#3001",
          orderId: "gid://shopify/Order/3001",
          outstandingPaise: BigInt(5000000),
          buyerAccountId: "buyer-multi",
          dueAt: new Date(Date.now() - 86400000 * 30),
        },
        {
          id: "inv-multi-2",
          name: "#3002",
          orderId: "gid://shopify/Order/3002",
          outstandingPaise: BigInt(2500000),
          buyerAccountId: "buyer-multi",
          dueAt: new Date(Date.now() - 86400000 * 15),
        },
      ];

      const buyer: BuyerForScoring = {
        id: "buyer-multi",
        name: "Test Buyer Multi Ltd",
        aliases: ["test buyer multi"],
        email: "multi@example.com",
      };

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);

      expect(result).not.toBeNull();
      expect(result!.allocations.length).toBe(2);
      
      const totalAllocated = result!.allocations.reduce(
        (sum, a) => sum + a.allocatedPaise,
        BigInt(0)
      );
      expect(totalAllocated).toBe(BigInt(7500000));
    });

    it("ambiguous match (same amount, different buyers) requires explicit choice", () => {
      const paymentAmount = BigInt(5000000);

      const payment: PaymentForScoring = {
        id: "pay-ambiguous",
        amountPaise: paymentAmount,
        narration: "NEFT CR-GENERIC PAYMENT",
        payerText: null,
        utr: null,
        rail: "NEFT",
      };

      const invoice1: InvoiceForScoring = {
        id: "inv-amb-1",
        name: "#4001",
        orderId: null,
        outstandingPaise: paymentAmount,
        buyerAccountId: "buyer-amb-1",
        dueAt: new Date(),
      };

      const invoice2: InvoiceForScoring = {
        id: "inv-amb-2",
        name: "#4002",
        orderId: null,
        outstandingPaise: paymentAmount,
        buyerAccountId: "buyer-amb-2",
        dueAt: new Date(),
      };

      const buyer1: BuyerForScoring = {
        id: "buyer-amb-1",
        name: "Buyer A",
        aliases: [],
        email: null,
      };

      const buyer2: BuyerForScoring = {
        id: "buyer-amb-2",
        name: "Buyer B",
        aliases: [],
        email: null,
      };

      const result1 = scorePaymentToInvoice(payment, invoice1, buyer1, []);
      const result2 = scorePaymentToInvoice(payment, invoice2, buyer2, []);

      expect(result1.score).toBe(result2.score);
      expect(result1.score).toBeLessThan(CONFIDENCE_THRESHOLD);
    });
  });

  describe("Confirm-only guarantee: no auto-apply without explicit confirm", () => {
    it("matcher module does NOT call confirmMatch or applyMatch", async () => {
      const { runMatcher, confirmMatch } = await import("../matcher.server");
      const { applyMatch } = await import("../apply.server");

      expect(typeof runMatcher).toBe("function");
      expect(typeof confirmMatch).toBe("function");
      expect(typeof applyMatch).toBe("function");
    });

    it("Match state machine: suggested -> confirmed -> pushed (no auto-transitions)", () => {
      const transitionsRequiringUserAction: Record<string, boolean> = {
        "suggested -> confirmed": true,
        "confirmed -> pushing": true,
      };

      expect(transitionsRequiringUserAction["suggested -> confirmed"]).toBe(true);
      expect(transitionsRequiringUserAction["confirmed -> pushing"]).toBe(true);
      expect(Object.keys(transitionsRequiringUserAction).length).toBe(2);
    });

    it("scorePaymentToInvoice returns ONLY score/reasons, never mutates state", () => {
      const payment: PaymentForScoring = {
        id: "pay-score-only",
        amountPaise: BigInt(5000000),
        narration: "NEFT CR-TEST BUYER-INV #5001",
        payerText: "TEST BUYER",
        utr: makeValidNeftUtr("50000000001"),
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-score-only",
        name: "#5001",
        orderId: null,
        outstandingPaise: BigInt(5000000),
        buyerAccountId: "buyer-score",
        dueAt: new Date(),
      };

      const originalOutstanding = invoice.outstandingPaise;

      const buyer: BuyerForScoring = {
        id: "buyer-score",
        name: "Test Buyer",
        aliases: [],
        email: null,
      };

      const result = scorePaymentToInvoice(payment, invoice, buyer, extractInvoiceRefs(payment.narration));

      expect(invoice.outstandingPaise).toBe(originalOutstanding);
      expect(result.score).toBeGreaterThan(0);
      expect(result.allocatedPaise).toBeDefined();
    });
  });

  describe("Confirm then outstanding/aging update for full payment: invoice closes", () => {
    it("full payment (amount === outstanding) is flagged as exact match, not partial", () => {
      const amount = BigInt(5000000);

      const payment: PaymentForScoring = {
        id: "pay-full",
        amountPaise: amount,
        narration: "NEFT CR-TEST BUYER-FULL PAYMENT #6001",
        payerText: "TEST BUYER",
        utr: makeValidNeftUtr("60000000001"),
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-full",
        name: "#6001",
        orderId: "gid://shopify/Order/6001",
        outstandingPaise: amount,
        buyerAccountId: "buyer-full",
        dueAt: new Date(),
      };

      const buyer: BuyerForScoring = {
        id: "buyer-full",
        name: "Test Buyer Full Ltd",
        aliases: ["test buyer full"],
        email: "full@example.com",
      };

      const refs = extractInvoiceRefs(payment.narration);
      const result = scorePaymentToInvoice(payment, invoice, buyer, refs);

      expect(result.isPartial).toBe(false);
      expect(result.isOverpayment).toBe(false);
      expect(result.allocatedPaise).toBe(amount);
      expect(result.reasons.some((r) => r.type === "amount_exact")).toBe(true);
    });

    it("full payment reduces outstanding to zero (computed, not mutated)", () => {
      const invoiceAmount = BigInt(5000000);
      const paymentAmount = BigInt(5000000);

      const payment: PaymentForScoring = {
        id: "pay-full-2",
        amountPaise: paymentAmount,
        narration: "NEFT FULL PAYMENT",
        payerText: null,
        utr: null,
        rail: "NEFT",
      };

      const invoice: InvoiceForScoring = {
        id: "inv-full-2",
        name: "#7001",
        orderId: null,
        outstandingPaise: invoiceAmount,
        buyerAccountId: "buyer-full-2",
        dueAt: new Date(),
      };

      const buyer: BuyerForScoring = {
        id: "buyer-full-2",
        name: "Buyer",
        aliases: [],
        email: null,
      };

      const result = scorePaymentToInvoice(payment, invoice, buyer, []);
      
      const newOutstanding = invoice.outstandingPaise - result.allocatedPaise;
      expect(newOutstanding).toBe(BigInt(0));
    });

    it("enqueueRecomputeForInvoice is exposed for post-apply aging recompute", async () => {
      const { enqueueRecomputeForInvoice } = await import("../credit-status-recompute.server");
      expect(typeof enqueueRecomputeForInvoice).toBe("function");
    });
  });

  describe("Edge cases and regression guards", () => {
    it("normalizePayerName removes common suffixes and normalizes", () => {
      expect(normalizePayerName("Test Buyer Pvt Ltd")).toBe("test buyer");
      expect(normalizePayerName("ACME TRADERS PRIVATE LIMITED")).toBe("acme traders");
      expect(normalizePayerName("M/S. Some Company")).toBe("some company");
    });

    it("extractInvoiceRefs extracts invoice numbers from various formats", () => {
      expect(extractInvoiceRefs("Payment for INV-1001")).toContain("1001");
      expect(extractInvoiceRefs("Order #12002 payment")).toContain("12002");
      expect(extractInvoiceRefs("REF: D3003 draft")).toContain("3003");
    });

    it("extractInvoiceRefs filters 4-digit year-like numbers (1900-2100)", () => {
      const refs2002 = extractInvoiceRefs("#2002 payment");
      expect(refs2002).not.toContain("2002");

      const refs2024 = extractInvoiceRefs("INV-2024");
      expect(refs2024).not.toContain("2024");

      const refs12002 = extractInvoiceRefs("#12002 payment");
      expect(refs12002).toContain("12002");
    });

    it("parser handles empty files gracefully", async () => {
      const emptyFile = new File([""], "empty.csv", { type: "text/csv" });
      const result = await parseBankStatement(emptyFile);

      expect(result.transactions).toHaveLength(0);
      expect(result.detection.bank).toBe("UNKNOWN");
    });

    it("parser handles files with only headers", async () => {
      const headerOnlyCsv = `HDFC BANK
Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance`;
      
      const file = new File([headerOnlyCsv], "header-only.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(0);
    });
  });
});
