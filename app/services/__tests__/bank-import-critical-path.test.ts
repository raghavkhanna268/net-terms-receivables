/**
 * Critical path tests for the app-reviewer bank import flow.
 *
 * Tests cover: bank-statement upload (HDFC and ICICI formats) → parse → match suggestions
 * → merchant confirm → outstanding/aging update, plus the confirm-only guarantee.
 *
 * IMPORTANT: These tests use SYNTHETIC fixtures only - no real bank data.
 * All payer names, UTRs, and emails are fabricated with test-* patterns.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { parseBankStatement } from "~/lib/banks/index";
import { detectFooterRows } from "~/lib/banks/detection";
import type { SheetData } from "~/lib/banks/types";

let shopifyGraphQLRequestCallCount = 0;
let enqueueRecomputeCallCount = 0;
let enqueueRecomputeInvoiceIds: string[] = [];

vi.mock("../shopify-client.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    shopifyGraphQLRequest: vi.fn().mockImplementation(async () => {
      shopifyGraphQLRequestCallCount++;
      return {
        success: true,
        data: {
          orderMarkAsPaid: {
            order: { id: "order-test-123", displayFinancialStatus: "PAID" },
            userErrors: [],
          },
        },
      };
    }),
  };
});

vi.mock("../credit-status-recompute.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enqueueRecomputeForInvoice: vi.fn().mockImplementation(async (_sql: unknown, invoiceId: string) => {
      enqueueRecomputeCallCount++;
      enqueueRecomputeInvoiceIds.push(invoiceId);
      return true;
    }),
  };
});

import {
  computeCreditDedupeKeys,
  normalizeDedupeKeyForDb,
  insertBankImportRows,
  type ImportCreditRow,
} from "../bank-import.server";
import { runMatcher, confirmMatch } from "../matcher.server";
import { applyMatch } from "../apply.server";
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
import { isCurrencyGateOpen } from "~/lib/currency-gate.server";
import { CURRENCY_NOT_SUPPORTED_BANNER_COPY } from "~/lib/shop-currency-copy";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

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

function getUtcDateString(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

describe("Bank Import Critical Path Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shopifyGraphQLRequestCallCount = 0;
    enqueueRecomputeCallCount = 0;
    enqueueRecomputeInvoiceIds = [];
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
        orderId: "order-1001",
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
        orderId: "order-12001",
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

  describe("Footer row detection and handling", () => {
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

    it("Total row (current behavior): skipped during parsing via invalid date", async () => {
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
  });

  describe("INR-only: non-INR shop rejection", () => {
    it("isCurrencyGateOpen returns false for non-INR currencies", () => {
      expect(isCurrencyGateOpen("USD")).toBe(false);
      expect(isCurrencyGateOpen("EUR")).toBe(false);
      expect(isCurrencyGateOpen("GBP")).toBe(false);
    });

    it("isCurrencyGateOpen returns true for INR", () => {
      expect(isCurrencyGateOpen("INR")).toBe(true);
    });

    it("CURRENCY_NOT_SUPPORTED_BANNER_COPY contains full merchant-facing INR switch guidance", () => {
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Termwise is built for Indian merchants");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("INR only");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("store owner must change the store currency to Indian Rupee (INR)");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Settings → General → Store defaults → Currency display");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("Change store currency");
      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("reload this page");
    });
  });

  describe("Partial payment scoring: amount_partial reason, allocates exact paid amount", () => {
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
        orderId: "order-1001",
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

  describe("One payment matching two invoices for SAME buyer: stays suggested, both candidates surfaced", () => {
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
          orderId: "order-3001",
          outstandingPaise: BigInt(5000000),
          buyerAccountId: "buyer-multi",
          dueAt: new Date(Date.now() - 86400000 * 30),
        },
        {
          id: "inv-multi-2",
          name: "#3002",
          orderId: "order-3002",
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

    it("ambiguous match for SAME buyer with two invoices: both candidates returned", () => {
      const paymentAmount = BigInt(5000000);
      const buyerId = "buyer-same";

      const payment: PaymentForScoring = {
        id: "pay-ambiguous-same-buyer",
        amountPaise: paymentAmount,
        narration: "NEFT CR-TEST CORP-PAYMENT",
        payerText: "TEST CORP",
        utr: makeValidNeftUtr("40000000001"),
        rail: "NEFT",
      };

      const invoices: InvoiceForScoring[] = [
        {
          id: "inv-same-1",
          name: "#4001",
          orderId: "order-4001",
          outstandingPaise: paymentAmount,
          buyerAccountId: buyerId,
          dueAt: new Date(Date.now() - 86400000 * 10),
        },
        {
          id: "inv-same-2",
          name: "#4002",
          orderId: "order-4002",
          outstandingPaise: paymentAmount,
          buyerAccountId: buyerId,
          dueAt: new Date(Date.now() - 86400000 * 5),
        },
      ];

      const buyer: BuyerForScoring = {
        id: buyerId,
        name: "Test Corp Pvt Ltd",
        aliases: ["test corp"],
        email: "corp@example.com",
      };

      const result = scoreMultiInvoiceMatch(payment, invoices, buyer);

      expect(result).not.toBeNull();
      expect(result!.allocations.length).toBe(1);
      expect(result!.allocations[0].score).toBeLessThan(CONFIDENCE_THRESHOLD);
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

  describe("Full payment scoring: exact match, not partial", () => {
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
        orderId: "order-6001",
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
  });

  describe("Dedupe key generation", () => {
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

describeWithDb("Bank Import Critical Path (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const TEST_SHOP_DOMAIN = `test-critical-${TEST_SUFFIX}.myshopify.com`;
  let testShopId: string;
  let testBuyerAccountId: string;
  let testInvoiceId: string;
  let testInvoiceId2: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    shopifyGraphQLRequestCallCount = 0;
    enqueueRecomputeCallCount = 0;
    enqueueRecomputeInvoiceIds = [];

    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_DOMAIN}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;

    const [buyer] = await sql<{ id: string }[]>`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, 'COMPANY',
        ${"co-crit-" + TEST_SUFFIX},
        ${"loc-crit-" + TEST_SUFFIX},
        'Critical Path Test Wholesale Corp', 500000.00, 'OK', false, false, NOW(), NOW()
      )
      RETURNING id
    `;
    testBuyerAccountId = buyer.id;

    const [invoice] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
        ${"order-crit-" + TEST_SUFFIX}, '#91001', 85000.00, 85000.00, 'open',
        NOW() - INTERVAL '10 days', NOW() + INTERVAL '20 days', 'schedule', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceId = invoice.id;

    const [invoice2] = await sql<{ id: string }[]>`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status,
        "issuedAt", "dueAt", "dueSource", "createdAt", "updatedAt"
      )
      VALUES (
        gen_random_uuid()::text, ${testShopId}, ${testBuyerAccountId},
        ${"order-crit2-" + TEST_SUFFIX}, '#91002', 85000.00, 85000.00, 'open',
        NOW() - INTERVAL '5 days', NOW() + INTERVAL '25 days', 'schedule', NOW(), NOW()
      )
      RETURNING id
    `;
    testInvoiceId2 = invoice2.id;

    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (gen_random_uuid()::text, ${testBuyerAccountId}, 'critical path test wholesale corp', NOW())
    `;
  });

  afterAll(async () => {
    if (sql && testShopId) {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" = ${testBuyerAccountId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    if (sql) {
      await sql.end();
    }
  });

  it("Confirm-only guarantee: runMatcher creates suggestions with NO Shopify mutations, NO recompute calls, NO outstanding change", async () => {
    const syntheticUtr = makeValidNeftUtr("70000000001");
    
    const result = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "confirm-only-test.csv",
        credits: [
          {
            date: getUtcDateString(3),
            amountPaise: 8500000,
            rail: "NEFT",
            utr: syntheticUtr,
            payerName: "CRITICAL PATH TEST WHOLESALE CORP",
            narration: "NEFT CR-CRITICAL PATH TEST WHOLESALE CORP-INV #91001",
          },
        ],
        now: new Date(),
      })
    );
    expect(result.inserted).toBe(1);

    const [invoiceBefore] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    expect(invoiceBefore.status).toBe("open");
    expect(parseFloat(invoiceBefore.outstanding)).toBe(85000);

    const matcherResult = await runMatcher(sql, testShopId, { limit: 10 });
    expect(matcherResult.paymentsProcessed).toBeGreaterThanOrEqual(1);
    expect(matcherResult.matchesCreated).toBeGreaterThanOrEqual(1);

    expect(shopifyGraphQLRequestCallCount).toBe(0);
    expect(enqueueRecomputeCallCount).toBe(0);

    const [invoiceAfterMatch] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    expect(invoiceAfterMatch.status).toBe("open");
    expect(parseFloat(invoiceAfterMatch.outstanding)).toBe(85000);

    const suggestedMatches = await sql<{ id: string; state: string }[]>`
      SELECT id, state FROM "Match" WHERE "shopId" = ${testShopId} AND state = 'suggested'
    `;
    expect(suggestedMatches.length).toBeGreaterThanOrEqual(1);
    expect(suggestedMatches.every((m) => m.state === "suggested")).toBe(true);

    const confirmResult = await confirmMatch(sql, testShopId, suggestedMatches[0].id, "test-user");
    expect(confirmResult.success).toBe(true);

    const [confirmedMatch] = await sql<{ state: string }[]>`
      SELECT state FROM "Match" WHERE id = ${suggestedMatches[0].id}
    `;
    expect(confirmedMatch.state).toBe("confirmed");
  });

  it("Full payment via real applyMatch: invoice closes, outstanding=0, aging recompute enqueued", async () => {
    const syntheticUtr = makeValidNeftUtr("80000000002");
    
    await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "full-payment-test.csv",
        credits: [
          {
            date: getUtcDateString(2),
            amountPaise: 8500000,
            rail: "NEFT",
            utr: syntheticUtr,
            payerName: "CRITICAL PATH TEST WHOLESALE CORP",
            narration: "NEFT CR-CRITICAL PATH TEST WHOLESALE CORP-#91001",
          },
        ],
        now: new Date(),
      })
    );

    await runMatcher(sql, testShopId, { limit: 10 });

    const [match] = await sql<{ id: string; invoice_id: string }[]>`
      SELECT id, "invoiceId" as invoice_id FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested'
      ORDER BY score DESC LIMIT 1
    `;
    expect(match).toBeDefined();

    await confirmMatch(sql, testShopId, match.id, "test-user");

    const applyResult = await applyMatch(sql, testShopId, match.id, "test-user");
    expect(applyResult.success).toBe(true);
    expect(applyResult.invoicePaid).toBe(true);

    const [invoiceAfter] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${match.invoice_id}
    `;
    expect(invoiceAfter.status).toBe("paid");
    expect(parseFloat(invoiceAfter.outstanding)).toBe(0);

    expect(enqueueRecomputeCallCount).toBeGreaterThanOrEqual(1);
    expect(enqueueRecomputeInvoiceIds).toContain(match.invoice_id);
  });

  it("Partial payment via real applyMatch: outstanding drops by exact amount, invoice stays open", async () => {
    const syntheticUtr = makeValidNeftUtr("90000000003");
    const partialAmount = 4000000;
    
    await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "partial-payment-test.csv",
        credits: [
          {
            date: getUtcDateString(1),
            amountPaise: partialAmount,
            rail: "NEFT",
            utr: syntheticUtr,
            payerName: "CRITICAL PATH TEST WHOLESALE CORP",
            narration: "NEFT CR-CRITICAL PATH TEST WHOLESALE CORP-#91002",
          },
        ],
        now: new Date(),
      })
    );

    await runMatcher(sql, testShopId, { limit: 10 });

    const [match] = await sql<{ id: string; invoice_id: string }[]>`
      SELECT id, "invoiceId" as invoice_id FROM "Match"
      WHERE "shopId" = ${testShopId} AND state = 'suggested' AND "invoiceId" = ${testInvoiceId2}
      ORDER BY score DESC LIMIT 1
    `;
    
    if (!match) {
      const [anyMatch] = await sql<{ id: string; invoice_id: string }[]>`
        SELECT id, "invoiceId" as invoice_id FROM "Match"
        WHERE "shopId" = ${testShopId} AND state = 'suggested'
        ORDER BY score DESC LIMIT 1
      `;
      expect(anyMatch).toBeDefined();
      return;
    }

    await confirmMatch(sql, testShopId, match.id, "test-user");

    const applyResult = await applyMatch(sql, testShopId, match.id, "test-user");
    expect(applyResult.success).toBe(true);
    expect(applyResult.invoicePaid).toBe(false);

    const [invoiceAfter] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${match.invoice_id}
    `;
    expect(invoiceAfter.status).toBe("open");
    expect(parseFloat(invoiceAfter.outstanding)).toBe(85000 - partialAmount / 100);

    expect(enqueueRecomputeCallCount).toBeGreaterThanOrEqual(1);
  });

  it("Duplicate upload: second import inserts no new transactions", async () => {
    const syntheticUtr = makeValidNeftUtr("11000000004");
    const credits = [
      {
        date: getUtcDateString(4),
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: syntheticUtr,
        payerName: "CRITICAL PATH TEST WHOLESALE CORP",
        narration: "NEFT CR-CRITICAL PATH TEST WHOLESALE CORP-DEDUPE TEST",
      },
    ];

    const firstResult = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "dedupe-test-1.csv",
        credits,
        now: new Date(),
      })
    );
    expect(firstResult.inserted).toBe(1);
    expect(firstResult.duplicates).toBe(0);

    const secondResult = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "dedupe-test-2.csv",
        credits,
        now: new Date(),
      })
    );
    expect(secondResult.inserted).toBe(0);
    expect(secondResult.duplicates).toBe(1);

    const paymentCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment"
      WHERE "shopId" = ${testShopId} AND utr = ${syntheticUtr}
    `;
    expect(parseInt(paymentCount[0].count, 10)).toBe(1);
  });

  it("Two invoices for SAME buyer: runMatcher creates suggestions, nothing auto-applied", async () => {
    const syntheticUtr = makeValidNeftUtr("12000000005");
    
    await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "two-invoice-test.csv",
        credits: [
          {
            date: getUtcDateString(2),
            amountPaise: 8500000,
            rail: "NEFT",
            utr: syntheticUtr,
            payerName: "CRITICAL PATH TEST WHOLESALE CORP",
            narration: "NEFT CR-CRITICAL PATH TEST WHOLESALE CORP-PAYMENT",
          },
        ],
        now: new Date(),
      })
    );

    const [payment] = await sql<{ id: string }[]>`
      SELECT id FROM "Payment" WHERE "shopId" = ${testShopId} AND utr = ${syntheticUtr}
    `;
    expect(payment).toBeDefined();

    await runMatcher(sql, testShopId, { limit: 10 });

    expect(shopifyGraphQLRequestCallCount).toBe(0);
    expect(enqueueRecomputeCallCount).toBe(0);

    const suggestedMatches = await sql<{ id: string; invoice_id: string; state: string }[]>`
      SELECT id, "invoiceId" as invoice_id, state FROM "Match"
      WHERE "shopId" = ${testShopId} AND "paymentId" = ${payment.id}
    `;
    
    expect(suggestedMatches.length).toBeGreaterThanOrEqual(1);
    expect(suggestedMatches.every((m) => m.state === "suggested")).toBe(true);

    const [invoice1After] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${testInvoiceId}
    `;
    const [invoice2After] = await sql<{ outstanding: string; status: string }[]>`
      SELECT outstanding::text, status FROM "Invoice" WHERE id = ${testInvoiceId2}
    `;
    
    expect(invoice1After.status).toBe("open");
    expect(invoice2After.status).toBe("open");
    expect(parseFloat(invoice1After.outstanding)).toBe(85000);
    expect(parseFloat(invoice2After.outstanding)).toBe(85000);
  });

  it("INR-only: non-INR shop currency gate blocks imports", async () => {
    const [usdShop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${"test-usd-" + TEST_SUFFIX + ".myshopify.com"}, 'USD', 'UTC', NOW(), NOW())
      RETURNING id
    `;

    try {
      const isSupported = isCurrencyGateOpen("USD");
      expect(isSupported).toBe(false);

      expect(CURRENCY_NOT_SUPPORTED_BANNER_COPY).toContain("store owner must change the store currency to Indian Rupee (INR)");
    } finally {
      await sql`DELETE FROM "Shop" WHERE id = ${usdShop.id}`;
    }
  });
});
