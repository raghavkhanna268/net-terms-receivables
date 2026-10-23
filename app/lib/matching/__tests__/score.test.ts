/**
 * Unit tests for payment matching scoring module.
 *
 * These tests use synthetic fixtures only (fake names, fake UTRs, no real data).
 * All amounts are in integer paise.
 */

import { describe, it, expect } from "vitest";
import {
  extractInvoiceRefs,
  matchInvoiceRef,
  matchOrderRef,
  scorePaymentToInvoice,
  scoreMultiInvoiceMatch,
  findSubsetSum,
  normalizePayerName,
  serializeScoreResult,
  MAX_INVOICES_FOR_SUBSET_SUM,
  MAX_SUBSET_SUM_ITERATIONS,
  type InvoiceForScoring,
  type PaymentForScoring,
  type BuyerForScoring,
} from "../score";

describe("extractInvoiceRefs", () => {
  it("extracts hash-prefixed invoice numbers", () => {
    const refs = extractInvoiceRefs("Payment for #1001 and #1002");
    expect(refs).toContain("1001");
    expect(refs).toContain("1002");
  });

  it("extracts INV- prefixed numbers", () => {
    const refs = extractInvoiceRefs("NEFT-INV-1001-PAYMENT");
    expect(refs).toContain("1001");
  });

  it("extracts D-prefixed draft order numbers", () => {
    const refs = extractInvoiceRefs("Payment for D1001");
    expect(refs).toContain("1001");
  });

  it("extracts standalone numbers (4-10 digits)", () => {
    const refs = extractInvoiceRefs("REF 12345678 PAYMENT");
    expect(refs).toContain("12345678");
  });

  it("ignores short numbers (< 4 digits)", () => {
    const refs = extractInvoiceRefs("Payment 123");
    expect(refs).not.toContain("123");
  });

  it("deduplicates extracted references", () => {
    const refs = extractInvoiceRefs("#1001 INV-1001 1001");
    expect(refs.filter((r) => r === "1001").length).toBe(1);
  });

  it("handles HDFC-style narration", () => {
    const refs = extractInvoiceRefs(
      "NEFT CR-SYNTHETIC CORP PVT LTD-INV1001/SYNTN26296000001"
    );
    expect(refs).toContain("1001");
  });

  it("handles ICICI-style narration", () => {
    const refs = extractInvoiceRefs(
      "NEFT/SYNTN26296000001/SYNTHETIC CORP/ORDER-1001"
    );
    expect(refs).toContain("1001");
  });
});

describe("matchInvoiceRef", () => {
  it("matches exact invoice number", () => {
    expect(matchInvoiceRef("#1001", ["1001", "1002"])).toBe(true);
  });

  it("matches INV- prefixed name", () => {
    expect(matchInvoiceRef("INV-1001", ["1001"])).toBe(true);
  });

  it("returns false for no match", () => {
    expect(matchInvoiceRef("#9999", ["1001", "1002"])).toBe(false);
  });

  it("handles invoice names without numbers", () => {
    expect(matchInvoiceRef("ABC", ["1001"])).toBe(false);
  });
});

describe("matchOrderRef", () => {
  it("matches order GID to extracted ref", () => {
    expect(
      matchOrderRef("gid://shopify/Order/12345", ["12345", "67890"])
    ).toBe(true);
  });

  it("returns false for null orderId", () => {
    expect(matchOrderRef(null, ["12345"])).toBe(false);
  });

  it("returns false for no match", () => {
    expect(matchOrderRef("gid://shopify/Order/99999", ["12345"])).toBe(false);
  });
});

describe("normalizePayerName", () => {
  it("removes M/S prefix", () => {
    // CORP is also a suffix that gets removed, result is lowercase
    expect(normalizePayerName("M/S SYNTHETIC CORP")).toBe("synthetic");
  });

  it("removes PVT LTD suffix", () => {
    // CORP is also removed as a suffix, result is lowercase
    expect(normalizePayerName("SYNTHETIC CORP PVT LTD")).toBe("synthetic");
  });

  it("removes PRIVATE LIMITED suffix", () => {
    expect(normalizePayerName("SYNTHETIC PRIVATE LIMITED")).toBe("synthetic");
  });

  it("normalizes whitespace", () => {
    // CORP is a suffix that gets removed, result is lowercase
    expect(normalizePayerName("SYNTHETIC   CORP")).toBe("synthetic");
  });

  it("removes punctuation", () => {
    // CORP is a suffix that gets removed, result is lowercase
    expect(normalizePayerName("SYNTHETIC, CORP.")).toBe("synthetic");
  });

  it("handles combined patterns", () => {
    // Both CORP and PVT LTD are suffixes that get removed, result is lowercase
    expect(normalizePayerName("M/S. SYNTHETIC CORP PVT. LTD.")).toBe(
      "synthetic"
    );
  });
});

describe("scorePaymentToInvoice", () => {
  const makePayment = (overrides: Partial<PaymentForScoring> = {}): PaymentForScoring => ({
    id: "payment-1",
    amountPaise: 1000000n, // ₹10,000
    narration: "NEFT CR-SYNTHETIC CORP-PAYMENT",
    payerText: "SYNTHETIC CORP PVT LTD",
    utr: "SYNTN26296000001",
    rail: "NEFT",
    ...overrides,
  });

  const makeInvoice = (overrides: Partial<InvoiceForScoring> = {}): InvoiceForScoring => ({
    id: "invoice-1",
    name: "#1001",
    orderId: "gid://shopify/Order/1001",
    outstandingPaise: 1000000n, // ₹10,000
    buyerAccountId: "buyer-1",
    dueAt: new Date("2026-10-15"),
    ...overrides,
  });

  const makeBuyer = (overrides: Partial<BuyerForScoring> = {}): BuyerForScoring => ({
    id: "buyer-1",
    name: "Synthetic Corp",
    aliases: ["synthetic corp", "synthetic"],
    email: null,
    ...overrides,
  });

  it("scores exact amount match", () => {
    const payment = makePayment();
    const invoice = makeInvoice();
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.allocatedPaise).toBe(1000000n);
    expect(result.isPartial).toBe(false);
    expect(result.isOverpayment).toBe(false);
    expect(result.excessPaise).toBeNull();
    expect(result.reasons.some((r) => r.type === "amount_exact")).toBe(true);
  });

  it("scores partial payment", () => {
    const payment = makePayment({ amountPaise: 800000n }); // ₹8,000
    const invoice = makeInvoice({ outstandingPaise: 1000000n }); // ₹10,000
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.allocatedPaise).toBe(800000n);
    expect(result.isPartial).toBe(true);
    expect(result.isOverpayment).toBe(false);
    expect(result.reasons.some((r) => r.type === "amount_partial")).toBe(true);
  });

  it("scores overpayment", () => {
    const payment = makePayment({ amountPaise: 1200000n }); // ₹12,000
    const invoice = makeInvoice({ outstandingPaise: 1000000n }); // ₹10,000
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.allocatedPaise).toBe(1000000n);
    expect(result.excessPaise).toBe(200000n);
    expect(result.isOverpayment).toBe(true);
    expect(result.reasons.some((r) => r.type === "amount_overpayment")).toBe(true);
  });

  it("scores UTR match in narration", () => {
    const payment = makePayment({
      narration: "NEFT CR-SYNTHETIC CORP-SYNTN26296000001",
    });
    const invoice = makeInvoice();
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.reasons.some((r) => r.type === "utr_match")).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(40);
  });

  it("scores invoice reference in narration", () => {
    const payment = makePayment({ narration: "Payment for #1001" });
    const invoice = makeInvoice({ name: "#1001" });
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.reasons.some((r) => r.type === "invoice_ref")).toBe(true);
  });

  it("scores order reference in narration", () => {
    const payment = makePayment({ narration: "ORDER-1001 payment" });
    // Use a different invoice name so we don't match invoice_ref
    const invoice = makeInvoice({ name: "#2002", orderId: "gid://shopify/Order/1001" });
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.reasons.some((r) => r.type === "order_ref")).toBe(true);
  });

  it("scores payer alias match", () => {
    // SYNTHETIC CORP normalizes to "SYNTHETIC" (CORP is removed as suffix)
    // So the alias should be "synthetic" to match
    const payment = makePayment({ payerText: "SYNTHETIC CORP" });
    const invoice = makeInvoice();
    const buyer = makeBuyer({ aliases: ["synthetic"] });

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(true);
  });

  it("scores payer name match (fuzzy)", () => {
    const payment = makePayment({ payerText: "SYNTHETIC CORPORATION" });
    const invoice = makeInvoice();
    const buyer = makeBuyer({ name: "Synthetic Corp", aliases: [] });

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.reasons.some((r) => r.type === "payer_name")).toBe(true);
  });

  it("caps score at 100", () => {
    const payment = makePayment({
      narration: "NEFT-SYNTN26296000001-#1001-SYNTHETIC CORP",
    });
    const invoice = makeInvoice({ name: "#1001" });
    const buyer = makeBuyer({ aliases: ["synthetic corp"] });

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.score).toBeLessThanOrEqual(100);
  });
});

describe("findSubsetSum", () => {
  it("finds single invoice exact match", () => {
    const invoices = [
      { outstandingPaise: 1000000n, index: 0 },
      { outstandingPaise: 500000n, index: 1 },
    ];

    const result = findSubsetSum(1000000n, invoices);

    expect(result).toEqual([0]);
  });

  it("finds two invoices summing to payment", () => {
    const invoices = [
      { outstandingPaise: 600000n, index: 0 },
      { outstandingPaise: 400000n, index: 1 },
      { outstandingPaise: 300000n, index: 2 },
    ];

    const result = findSubsetSum(1000000n, invoices);

    expect(result).toContain(0);
    expect(result).toContain(1);
    expect(result?.length).toBe(2);
  });

  it("finds three invoices summing to payment", () => {
    const invoices = [
      { outstandingPaise: 500000n, index: 0 },
      { outstandingPaise: 300000n, index: 1 },
      { outstandingPaise: 200000n, index: 2 },
    ];

    const result = findSubsetSum(1000000n, invoices);

    expect(result?.length).toBe(3);
  });

  it("returns closest match when no exact match exists", () => {
    // When no exact match exists, findSubsetSum returns the closest combination
    // that doesn't exceed the payment amount (for partial payment handling)
    const invoices = [
      { outstandingPaise: 1000000n, index: 0 },
      { outstandingPaise: 2000000n, index: 1 },
    ];

    // 1500000 can't be matched exactly, but 1000000 (index 0) is a valid partial
    const result = findSubsetSum(1500000n, invoices);

    // Returns the best partial match
    expect(result).toEqual([0]);
  });

  it("respects MAX_INVOICES_FOR_SUBSET_SUM limit", () => {
    const invoices = Array.from({ length: 20 }, (_, i) => ({
      outstandingPaise: BigInt(100000 * (i + 1)),
      index: i,
    }));

    // Should not hang or throw
    const result = findSubsetSum(999999999n, invoices);
    expect(result === null || Array.isArray(result)).toBe(true);
  });

  it("handles empty invoice list", () => {
    const result = findSubsetSum(1000000n, []);
    expect(result).toBeNull();
  });
});

describe("scoreMultiInvoiceMatch", () => {
  const makePayment = (amountPaise: bigint): PaymentForScoring => ({
    id: "payment-1",
    amountPaise,
    narration: "Payment",
    payerText: "SYNTHETIC CORP",
    utr: null,
    rail: "NEFT",
  });

  const makeBuyer = (): BuyerForScoring => ({
    id: "buyer-1",
    name: "Synthetic Corp",
    aliases: ["synthetic corp"],
    email: null,
  });

  it("matches single invoice when exact", () => {
    const payment = makePayment(1000000n);
    const invoices: InvoiceForScoring[] = [
      {
        id: "inv-1",
        name: "#1001",
        orderId: null,
        outstandingPaise: 1000000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-15"),
      },
    ];

    const result = scoreMultiInvoiceMatch(payment, invoices, makeBuyer());

    expect(result?.allocations.length).toBe(1);
    expect(result?.allocations[0].invoiceId).toBe("inv-1");
  });

  it("matches multiple invoices summing to payment", () => {
    const payment = makePayment(1500000n);
    const invoices: InvoiceForScoring[] = [
      {
        id: "inv-1",
        name: "#1001",
        orderId: null,
        outstandingPaise: 1000000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-15"),
      },
      {
        id: "inv-2",
        name: "#1002",
        orderId: null,
        outstandingPaise: 500000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-20"),
      },
    ];

    const result = scoreMultiInvoiceMatch(payment, invoices, makeBuyer());

    expect(result?.allocations.length).toBe(2);
    expect(result?.reasons.some((r) => r.type === "multi_invoice")).toBe(true);
  });

  it("detects overpayment with excess", () => {
    const payment = makePayment(1200000n);
    const invoices: InvoiceForScoring[] = [
      {
        id: "inv-1",
        name: "#1001",
        orderId: null,
        outstandingPaise: 1000000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-15"),
      },
    ];

    const result = scoreMultiInvoiceMatch(payment, invoices, makeBuyer());

    expect(result?.excessPaise).toBe(200000n);
  });

  it("returns null for empty invoice list", () => {
    const payment = makePayment(1000000n);
    const result = scoreMultiInvoiceMatch(payment, [], makeBuyer());
    expect(result).toBeNull();
  });

  it("allocates oldest-due invoices first", () => {
    const payment = makePayment(600000n);
    const invoices: InvoiceForScoring[] = [
      {
        id: "inv-newer",
        name: "#1002",
        orderId: null,
        outstandingPaise: 600000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-20"),
      },
      {
        id: "inv-older",
        name: "#1001",
        orderId: null,
        outstandingPaise: 600000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-10"),
      },
    ];

    const result = scoreMultiInvoiceMatch(payment, invoices, makeBuyer());

    // Should prefer the older invoice
    expect(result?.allocations[0].invoiceId).toBe("inv-older");
  });
});

describe("serializeScoreResult", () => {
  it("converts bigints to strings", () => {
    const result = {
      score: 80,
      reasons: [{ type: "amount_exact" as const, points: 20 }],
      allocatedPaise: 1000000n,
      excessPaise: 200000n,
      isPartial: false,
      isOverpayment: true,
    };

    const serialized = serializeScoreResult(result);

    expect(serialized.allocatedPaise).toBe("1000000");
    expect(serialized.excessPaise).toBe("200000");
  });

  it("handles null excessPaise", () => {
    const result = {
      score: 80,
      reasons: [],
      allocatedPaise: 1000000n,
      excessPaise: null,
      isPartial: false,
      isOverpayment: false,
    };

    const serialized = serializeScoreResult(result);

    expect(serialized.excessPaise).toBeNull();
  });
});

describe("scoring constants", () => {
  it("has reasonable limits for bounded combinatorics", () => {
    expect(MAX_INVOICES_FOR_SUBSET_SUM).toBeGreaterThanOrEqual(10);
    expect(MAX_INVOICES_FOR_SUBSET_SUM).toBeLessThanOrEqual(20);
    expect(MAX_SUBSET_SUM_ITERATIONS).toBeGreaterThanOrEqual(1000);
    expect(MAX_SUBSET_SUM_ITERATIONS).toBeLessThanOrEqual(100000);
  });
});

describe("currency mismatch handling", () => {
  it("does not crash with mismatched currencies (currency field not in score)", () => {
    // Score module works with paise amounts only - currency check is at a higher level
    // This test documents that the scorer is currency-agnostic
    const payment: PaymentForScoring = {
      id: "payment-1",
      amountPaise: 1000000n, // Could be INR paise or USD cents
      narration: "Payment",
      payerText: null,
      utr: null,
      rail: null,
    };

    const invoice: InvoiceForScoring = {
      id: "invoice-1",
      name: "#1001",
      orderId: null,
      outstandingPaise: 1000000n, // Could be different currency
      buyerAccountId: "buyer-1",
      dueAt: null,
    };

    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Test",
      aliases: [],
      email: null,
    };

    // Should not throw
    const result = scorePaymentToInvoice(payment, invoice, buyer, []);
    expect(result.score).toBeGreaterThan(0);
  });
});

describe("ambiguous match ties", () => {
  it("handles two invoices with identical amounts from same buyer", () => {
    const payment: PaymentForScoring = {
      id: "payment-1",
      amountPaise: 1000000n,
      narration: "Payment",
      payerText: "SYNTHETIC CORP",
      utr: null,
      rail: null,
    };

    const invoices: InvoiceForScoring[] = [
      {
        id: "inv-1",
        name: "#1001",
        orderId: null,
        outstandingPaise: 1000000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-15"),
      },
      {
        id: "inv-2",
        name: "#1002",
        orderId: null,
        outstandingPaise: 1000000n,
        buyerAccountId: "buyer-1",
        dueAt: new Date("2026-10-20"),
      },
    ];

    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Synthetic Corp",
      aliases: ["synthetic corp"],
      email: null,
    };

    // Should return a valid result (preferring the older invoice)
    const result = scoreMultiInvoiceMatch(payment, invoices, buyer);
    expect(result).not.toBeNull();
    expect(result?.allocations.length).toBeGreaterThanOrEqual(1);
  });
});
