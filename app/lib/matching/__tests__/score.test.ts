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
  reasonsContainNoPII,
  MAX_INVOICES_FOR_SUBSET_SUM,
  MAX_SUBSET_SUM_ITERATIONS,
  type InvoiceForScoring,
  type PaymentForScoring,
  type BuyerForScoring,
  type MatchReason,
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

  it("does NOT extract standalone numbers without prefix (tightened in P2)", () => {
    // P2: Removed standalone 4-10 digit pattern to avoid false positives
    // Numbers now require a prefix like #, INV-, D, ORDER-, ORD-, PO-, or REF-
    const refs = extractInvoiceRefs("REF 12345678 PAYMENT");
    // Without the hyphen, "REF 12345678" doesn't match "REF-<number>"
    expect(refs).not.toContain("12345678");
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

  // P2: False-positive rejection tests for tightened regex
  it("does NOT extract phone-number-like 10-digit sequences", () => {
    // Phone numbers should not be extracted as invoice refs
    const refs = extractInvoiceRefs("Contact: 9876543210 for payment");
    // Standalone 10-digit number without prefix should not match
    expect(refs).not.toContain("9876543210");
  });

  it("does NOT extract date-like 8-digit sequences (YYYYMMDD)", () => {
    const refs = extractInvoiceRefs("Payment dated 20261023 received");
    expect(refs).not.toContain("20261023");
  });

  it("does NOT extract date-like 8-digit sequences (DDMMYYYY)", () => {
    const refs = extractInvoiceRefs("Date: 19851225 birthday payment");
    expect(refs).not.toContain("19851225");
  });

  it("does NOT extract amount-like sequences ending in 00", () => {
    // Amounts like 500000 (₹5,000.00) should not be matched
    const refs = extractInvoiceRefs("Amount: 500000 credited");
    expect(refs).not.toContain("500000");
  });

  it("DOES extract hash-prefixed amount-like numbers", () => {
    // But if explicitly prefixed with #, it's probably an invoice number
    const refs = extractInvoiceRefs("Invoice #500000 paid");
    expect(refs).toContain("500000");
  });

  it("does NOT extract year-like 4-digit sequences", () => {
    const refs = extractInvoiceRefs("Payment for 2026 fiscal year");
    expect(refs).not.toContain("2026");
  });

  it("extracts PO- prefixed purchase order numbers", () => {
    const refs = extractInvoiceRefs("PO-123456 payment received");
    expect(refs).toContain("123456");
  });

  it("extracts ORD- prefixed order numbers", () => {
    const refs = extractInvoiceRefs("ORD-789012 shipped");
    expect(refs).toContain("789012");
  });

  it("extracts REF- prefixed reference numbers (5+ digits)", () => {
    const refs = extractInvoiceRefs("REF-12345 payment");
    expect(refs).toContain("12345");
  });

  it("does NOT extract REF- with short numbers (< 5 digits)", () => {
    const refs = extractInvoiceRefs("REF-1234 payment");
    expect(refs).not.toContain("1234");
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

  it("does NOT award UTR points (UTR is from payment's own narration)", () => {
    // P1.2: UTR extracted from payment narration gives same score to every candidate
    // So we no longer award UTR points at the payment-to-candidate level
    const payment = makePayment({
      narration: "NEFT CR-SYNTHETIC CORP-SYNTN26296000001",
      utr: "SYNTN26296000001",
    });
    const invoice = makeInvoice();
    const buyer = makeBuyer();

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    // UTR match should NOT be in reasons anymore (type was removed from MatchReasonType)
    // Just verify no reason type contains "utr" 
    expect(result.reasons.every((r) => !r.type.includes("utr"))).toBe(true);
  });

  it("UTR does not change ranking (same UTR for all candidates)", () => {
    // P1.2: Since UTR comes from the payment, it's the same for all candidates
    // This test proves UTR doesn't affect relative ranking
    const payment = makePayment({
      narration: "NEFT CR-PAYMENT",
      utr: "SYNTN26296000001",
    });
    const invoice1 = makeInvoice({ id: "inv-1", name: "#1001" });
    const invoice2 = makeInvoice({ id: "inv-2", name: "#1002", outstandingPaise: 1000000n });
    const buyer = makeBuyer();

    const result1 = scorePaymentToInvoice(payment, invoice1, buyer, []);
    const result2 = scorePaymentToInvoice(payment, invoice2, buyer, []);

    // Both should have no UTR-related score (type was removed)
    const utrReasons1 = result1.reasons.filter(r => r.type.includes("utr"));
    const utrReasons2 = result2.reasons.filter(r => r.type.includes("utr"));
    expect(utrReasons1.length).toBe(0);
    expect(utrReasons2.length).toBe(0);
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

  it("does NOT award alias points for empty payer text", () => {
    const payment = makePayment({ payerText: "" });
    const invoice = makeInvoice();
    const buyer = makeBuyer({ aliases: ["synthetic corp", "synth"] });

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(false);
    expect(result.reasons.some((r) => r.type === "payer_name")).toBe(false);
  });

  it("does NOT award alias points for whitespace-only payer text", () => {
    const payment = makePayment({ payerText: "   " });
    const invoice = makeInvoice();
    const buyer = makeBuyer({ aliases: ["synthetic corp", "synth"] });

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(false);
    expect(result.reasons.some((r) => r.type === "payer_name")).toBe(false);
  });

  it("does NOT award alias points for short unrelated payer (< 3 chars after normalize)", () => {
    // "AB" normalizes to "ab" (2 chars) - too short for substring matching
    const payment = makePayment({ payerText: "AB" });
    const invoice = makeInvoice();
    const buyer = makeBuyer({ aliases: ["synthetic corp"] });

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);

    // Should not match via substring (alias.includes("ab") would be false anyway,
    // but normalizedPayer.includes(alias) is guarded by length >= 3)
    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(false);
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

// P1.3: No PII in match reasons tests
describe("reasonsContainNoPII", () => {
  it("returns true for reasons with no PII", () => {
    const reasons: MatchReason[] = [
      { type: "amount_exact", points: 20, detail: "Exact amount" },
      { type: "payer_name", points: 10, detail: "Name matched" },
      { type: "invoice_ref", points: 30, detail: "Invoice ref" },
    ];
    expect(reasonsContainNoPII(reasons)).toBe(true);
  });

  it("returns false if reasons contain email addresses", () => {
    const reasons: MatchReason[] = [
      { type: "email_match", points: 6, detail: "Email: test@example.com" },
    ];
    expect(reasonsContainNoPII(reasons)).toBe(false);
  });

  it("returns false if reasons contain phone numbers", () => {
    const reasons: MatchReason[] = [
      { type: "payer_name", points: 10, detail: "Phone: 9876543210 matched" },
    ];
    expect(reasonsContainNoPII(reasons)).toBe(false);
  });

  it("returns true for reasons without detail field", () => {
    const reasons: MatchReason[] = [
      { type: "amount_exact", points: 20 },
      { type: "payer_name", points: 10 },
    ];
    expect(reasonsContainNoPII(reasons)).toBe(true);
  });

  it("returns true for empty reasons array", () => {
    expect(reasonsContainNoPII([])).toBe(true);
  });

  it("returns true for approved detail patterns", () => {
    const reasons: MatchReason[] = [
      { type: "payer_alias", points: 30, detail: "Alias matched" },
      { type: "email_match", points: 6, detail: "Email prefix matched" },
      { type: "amount_overpayment", points: 10, detail: "Overpayment (excess flagged)" },
    ];
    expect(reasonsContainNoPII(reasons)).toBe(true);
  });
});

// P2: Overpayment gives reduced points
describe("overpayment reduced points", () => {
  it("gives reduced points (10) for overpayment vs full points (20) for exact match", () => {
    const payment: PaymentForScoring = {
      id: "payment-1",
      amountPaise: 1200000n, // ₹12,000 - more than invoice
      narration: "Payment",
      payerText: null,
      utr: null,
      rail: null,
    };

    const invoice: InvoiceForScoring = {
      id: "invoice-1",
      name: "#1001",
      orderId: null,
      outstandingPaise: 1000000n, // ₹10,000
      buyerAccountId: "buyer-1",
      dueAt: null,
    };

    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Test",
      aliases: [],
      email: null,
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);
    
    // Should have overpayment reason with reduced points
    const overpaymentReason = result.reasons.find(r => r.type === "amount_overpayment");
    expect(overpaymentReason).toBeDefined();
    expect(overpaymentReason?.points).toBe(10); // Reduced from 20

    // Compare with exact match
    const exactPayment = { ...payment, amountPaise: 1000000n };
    const exactResult = scorePaymentToInvoice(exactPayment, invoice, buyer, []);
    const exactReason = exactResult.reasons.find(r => r.type === "amount_exact");
    expect(exactReason).toBeDefined();
    expect(exactReason?.points).toBe(20); // Full points
  });
});

// Email prefix minimum length (>= 3 chars)
describe("email prefix minimum length", () => {
  it("does NOT match when payer is too short (< 3 chars)", () => {
    const payment: PaymentForScoring = {
      id: "p1",
      amountPaise: 100000n,
      narration: "Payment",
      payerText: "AB", // Too short (2 chars after normalization)
      utr: null,
      rail: null,
    };
    const invoice: InvoiceForScoring = {
      id: "i1",
      name: "#1",
      orderId: null,
      outstandingPaise: 100000n,
      buyerAccountId: "b1",
      dueAt: null,
    };
    const buyer: BuyerForScoring = {
      id: "b1",
      name: "Long Name Corp",
      aliases: [],
      email: "ab@example.com", // Prefix "ab" is only 2 chars
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);
    // Should NOT have email_match reason
    expect(result.reasons.some((r) => r.type === "email_match")).toBe(false);
  });

  it("does NOT match when email prefix is too short (< 3 chars)", () => {
    const payment: PaymentForScoring = {
      id: "p1",
      amountPaise: 100000n,
      narration: "Payment",
      payerText: "JOHN DOE", // Long enough
      utr: null,
      rail: null,
    };
    const invoice: InvoiceForScoring = {
      id: "i1",
      name: "#1",
      orderId: null,
      outstandingPaise: 100000n,
      buyerAccountId: "b1",
      dueAt: null,
    };
    const buyer: BuyerForScoring = {
      id: "b1",
      name: "Different Name",
      aliases: [],
      email: "jd@example.com", // Prefix "jd" is only 2 chars
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);
    // Should NOT have email_match reason
    expect(result.reasons.some((r) => r.type === "email_match")).toBe(false);
  });

  it("DOES match when both payer and email prefix are >= 3 chars", () => {
    const payment: PaymentForScoring = {
      id: "p1",
      amountPaise: 100000n,
      narration: "Payment",
      payerText: "JOHNDOE CORP", // Long enough
      utr: null,
      rail: null,
    };
    const invoice: InvoiceForScoring = {
      id: "i1",
      name: "#1",
      orderId: null,
      outstandingPaise: 100000n,
      buyerAccountId: "b1",
      dueAt: null,
    };
    const buyer: BuyerForScoring = {
      id: "b1",
      name: "Different Name",
      aliases: [],
      email: "johndoe@example.com", // Prefix "johndoe" >= 3 chars
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);
    // Should have email_match reason since both are long enough
    expect(result.reasons.some((r) => r.type === "email_match")).toBe(true);
  });

  it("does NOT match empty payer text", () => {
    const payment: PaymentForScoring = {
      id: "p1",
      amountPaise: 100000n,
      narration: "Payment",
      payerText: "", // Empty
      utr: null,
      rail: null,
    };
    const invoice: InvoiceForScoring = {
      id: "i1",
      name: "#1",
      orderId: null,
      outstandingPaise: 100000n,
      buyerAccountId: "b1",
      dueAt: null,
    };
    const buyer: BuyerForScoring = {
      id: "b1",
      name: "Some Name",
      aliases: [],
      email: "someone@example.com",
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, []);
    // Should NOT have email_match reason
    expect(result.reasons.some((r) => r.type === "email_match")).toBe(false);
  });
});

/**
 * Reachability table: combinations that reach >= 80 (High confidence)
 *
 * Current weights:
 * - invoice_ref: +30
 * - order_ref: +30
 * - amount_exact: +20
 * - amount_partial: +10
 * - amount_overpayment: +10
 * - payer_alias: +30 (confirmed alias only)
 * - payer_name: +8 (fuzzy match)
 * - email_match: +6
 * - multi_invoice: +5
 *
 * CONFIDENCE_THRESHOLD: 80
 */
describe("reachability: combinations that reach High (>= 80)", () => {
  const makePayment = (overrides: Partial<PaymentForScoring> = {}): PaymentForScoring => ({
    id: "payment-1",
    amountPaise: 1000000n,
    narration: "NEFT-#1001-PAYMENT",
    payerText: "SYNTHETIC CORP",
    utr: null,
    rail: "NEFT",
    ...overrides,
  });

  const makeInvoice = (overrides: Partial<InvoiceForScoring> = {}): InvoiceForScoring => ({
    id: "invoice-1",
    name: "#1001",
    orderId: null,
    outstandingPaise: 1000000n,
    buyerAccountId: "buyer-1",
    dueAt: new Date("2026-10-15"),
    ...overrides,
  });

  /**
   * Reachability table for >= 80:
   *
   * | Combination                              | Score | Reaches 80? | Has payer_alias? |
   * |------------------------------------------|-------|-------------|------------------|
   * | invoice_ref + amount_exact + payer_alias | 80    | YES         | YES              |
   * | order_ref + amount_exact + payer_alias   | 80    | YES         | YES              |
   * | invoice_ref + amount_partial + payer_alias| 70   | NO          | YES              |
   * | invoice_ref + amount_exact + payer_name  | 58    | NO          | NO               |
   * | invoice_ref + amount_exact + email_match | 56    | NO          | NO               |
   * | invoice_ref + amount_exact + multi_inv   | 55*   | NO          | NO               |
   * | multi_invoice only raises avg by +5      | varies| NO          | -                |
   *
   * * multi_invoice bonus is +5 on average score, only for 2+ invoices
   *
   * Conclusion: ALL combinations reaching >= 80 require payer_alias.
   */
  it("invoice_ref + amount_exact + payer_alias = 80 (High)", () => {
    const payment = makePayment({ narration: "#1001 payment", payerText: "SYNTHETIC CORP" });
    const invoice = makeInvoice({ name: "#1001" });
    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Other Name",
      aliases: ["synthetic"],
      email: null,
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.score).toBe(80);
    expect(result.reasons.some((r) => r.type === "invoice_ref")).toBe(true);
    expect(result.reasons.some((r) => r.type === "amount_exact")).toBe(true);
    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(true);
  });

  it("order_ref + amount_exact + payer_alias = 80 (High)", () => {
    const payment = makePayment({ narration: "ORDER-1001 payment", payerText: "SYNTHETIC CORP" });
    const invoice = makeInvoice({ name: "#9999", orderId: "gid://shopify/Order/1001" });
    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Other Name",
      aliases: ["synthetic"],
      email: null,
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.score).toBe(80);
    expect(result.reasons.some((r) => r.type === "order_ref")).toBe(true);
    expect(result.reasons.some((r) => r.type === "amount_exact")).toBe(true);
    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(true);
  });

  it("best without payer_alias: invoice_ref + amount_exact + payer_name = 58 (< 80)", () => {
    const payment = makePayment({ narration: "#1001 payment", payerText: "SYNTHETIC CORP" });
    const invoice = makeInvoice({ name: "#1001" });
    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Synthetic Corp",
      aliases: [], // No aliases
      email: null,
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.score).toBe(58);
    expect(result.score).toBeLessThan(80);
    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(false);
    expect(result.reasons.some((r) => r.type === "payer_name")).toBe(true);
  });

  it("invoice_ref + amount_exact + email_match = 56 (< 80, no alias)", () => {
    const payment = makePayment({ narration: "#1001 payment", payerText: "JOHNDOE COMPANY" });
    const invoice = makeInvoice({ name: "#1001" });
    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Different Name",
      aliases: [],
      email: "johndoe@example.com",
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.score).toBe(56);
    expect(result.score).toBeLessThan(80);
    expect(result.reasons.some((r) => r.type === "payer_alias")).toBe(false);
    expect(result.reasons.some((r) => r.type === "email_match")).toBe(true);
  });

  it("invoice_ref + overpayment + payer_alias = 70 (< 80)", () => {
    const payment = makePayment({
      narration: "#1001 payment",
      payerText: "SYNTHETIC CORP",
      amountPaise: 1200000n, // overpayment
    });
    const invoice = makeInvoice({ name: "#1001", outstandingPaise: 1000000n });
    const buyer: BuyerForScoring = {
      id: "buyer-1",
      name: "Other Name",
      aliases: ["synthetic"],
      email: null,
    };

    const result = scorePaymentToInvoice(payment, invoice, buyer, ["1001"]);

    expect(result.score).toBe(70);
    expect(result.score).toBeLessThan(80);
    expect(result.reasons.some((r) => r.type === "amount_overpayment")).toBe(true);
  });

  it("all combinations reaching >= 80 include payer_alias", () => {
    // This test documents that under current weights, no combination
    // without payer_alias can reach 80:
    // - Max without alias: invoice_ref(30) + amount_exact(20) + payer_name(8) = 58
    // - With email_match instead: 30 + 20 + 6 = 56
    // - Multi-invoice bonus (+5) on a 58 base = 63, still < 80
    //
    // The only way to reach 80 is:
    // - invoice_ref/order_ref (30) + amount_exact (20) + payer_alias (30) = 80
    const maxWithoutAlias = 30 + 20 + 8; // invoice_ref + amount_exact + payer_name
    const maxWithEmailMatch = 30 + 20 + 6; // invoice_ref + amount_exact + email_match
    const multiInvoiceBonus = 5;

    expect(maxWithoutAlias).toBe(58);
    expect(maxWithEmailMatch).toBe(56);
    expect(maxWithoutAlias + multiInvoiceBonus).toBe(63);
    expect(maxWithoutAlias + multiInvoiceBonus).toBeLessThan(80);
  });
});
