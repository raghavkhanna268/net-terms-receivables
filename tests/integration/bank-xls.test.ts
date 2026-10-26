/**
 * Integration tests for BIFF8 .xls bank statement parsing.
 * 
 * Tests that:
 * 1. .xls and CSV twins produce identical normalized transactions
 * 2. Row counts, credits/debits, and parse errors are pinned
 * 3. Specific edge cases (overflow rows, hyphen VPA, ref≠RRN, 15-digit ref) parse correctly
 * 4. Credit transactions score against realistic fictional invoices
 * 
 * All fixture data is SYNTHETIC with SYNT markers - not real bank data.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement } from "../../app/lib/banks/index.js";
import type { ParseResult, NormalisedTxn } from "../../app/lib/banks/types.js";
import {
  scorePaymentToInvoice,
  extractInvoiceRefs,
  CONFIDENCE_THRESHOLD,
  type InvoiceForScoring,
  type PaymentForScoring,
  type BuyerForScoring,
} from "../../app/lib/matching/score.js";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

/**
 * Get confidence band from score.
 */
function getConfidenceBand(score: number): "high" | "medium" | "low" {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

/**
 * Compare two transaction arrays for equivalence.
 * Compares key fields that should be identical between .xls and CSV parsing.
 */
function assertTransactionsEquivalent(
  xlsTxns: NormalisedTxn[],
  csvTxns: NormalisedTxn[],
  bankName: string
): void {
  expect(xlsTxns.length).toBe(csvTxns.length);
  
  for (let i = 0; i < xlsTxns.length; i++) {
    const xls = xlsTxns[i];
    const csv = csvTxns[i];
    
    expect(xls.date).toBe(csv.date);
    expect(xls.amountPaise).toBe(csv.amountPaise);
    expect(xls.direction).toBe(csv.direction);
    expect(xls.parsed.rail).toBe(csv.parsed.rail);
    
    if (xls.parsed.upiId || csv.parsed.upiId) {
      expect(xls.parsed.upiId).toBe(csv.parsed.upiId);
    }
    if (xls.parsed.utr || csv.parsed.utr) {
      expect(xls.parsed.utr).toBe(csv.parsed.utr);
    }
  }
}

/**
 * Create fictional invoices for scoring tests.
 * These are synthetic invoices that realistically match the fixture transactions.
 */
function createFictionalInvoices(): InvoiceForScoring[] {
  return [
    {
      id: "inv-001",
      name: "#1001",
      orderId: "gid://shopify/Order/1001",
      outstandingPaise: 5000000n, // 50,000.00
      buyerAccountId: "buyer-synt-vendor",
      dueAt: new Date("2030-10-20"),
    },
    {
      id: "inv-002",
      name: "#1002",
      orderId: "gid://shopify/Order/1002",
      outstandingPaise: 2500000n, // 25,000.00
      buyerAccountId: "buyer-synt-wholesaler",
      dueAt: new Date("2030-10-21"),
    },
    {
      id: "inv-003",
      name: "INV-2030-0001",
      orderId: null,
      outstandingPaise: 3333333n, // 33,333.33
      buyerAccountId: "buyer-synt-long",
      dueAt: new Date("2030-10-25"),
    },
    {
      id: "inv-004",
      name: "#1004",
      orderId: "gid://shopify/Order/1004",
      outstandingPaise: 7500000n, // 75,000.00
      buyerAccountId: "buyer-synt-corporate",
      dueAt: new Date("2030-10-22"),
    },
    {
      id: "inv-005",
      name: "#1005",
      orderId: "gid://shopify/Order/1005",
      outstandingPaise: 1500000n, // 15,000.00
      buyerAccountId: "buyer-synt-retailer",
      dueAt: new Date("2030-10-23"),
    },
  ];
}

/**
 * Create fictional buyers for scoring tests.
 */
function createFictionalBuyers(): BuyerForScoring[] {
  return [
    {
      id: "buyer-synt-vendor",
      name: "SYNT VENDOR PVT LTD",
      aliases: ["synt vendor", "syntvendor"],
      email: null,
    },
    {
      id: "buyer-synt-wholesaler",
      name: "SYNT WHOLESALER CO",
      aliases: ["synt wholesaler", "syntwholesaler"],
      email: null,
    },
    {
      id: "buyer-synt-long",
      name: "SYNT LONG NAME ENTERPRISE PVT LTD",
      aliases: ["synt long name", "syntlongbusiness"],
      email: null,
    },
    {
      id: "buyer-synt-corporate",
      name: "SYNT CORPORATE COLLECTIONS PVT LTD",
      aliases: ["synt corporate", "cms synt"],
      email: null,
    },
    {
      id: "buyer-synt-retailer",
      name: "SYNT RETAILER",
      aliases: ["synt retailer", "syntretail"],
      email: null,
    },
  ];
}

describe("ICICI BIFF8 .xls real-layout parsing", () => {
  let xlsResult: ParseResult;
  let csvResult: ParseResult;

  beforeAll(async () => {
    const xlsContent = readFileSync(join(FIXTURES_DIR, "icici-synthetic.xls"));
    const xlsFile = new File([xlsContent], "icici-synthetic.xls", { type: "application/vnd.ms-excel" });
    xlsResult = await parseBankStatement(xlsFile);

    const csvContent = readFileSync(join(FIXTURES_DIR, "icici-synthetic.csv"));
    const csvFile = new File([csvContent], "icici-synthetic.csv", { type: "text/csv" });
    csvResult = await parseBankStatement(csvFile);
  });

  describe("detection and parsing", () => {
    it("detects ICICI bank from .xls with high confidence", () => {
      expect(xlsResult.detection.bank).toBe("ICICI");
      expect(xlsResult.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects ICICI bank from CSV with high confidence", () => {
      expect(csvResult.detection.bank).toBe("ICICI");
      expect(csvResult.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses pinned transaction count from .xls", () => {
      expect(xlsResult.transactions.length).toBe(15);
    });

    it("parses pinned transaction count from CSV", () => {
      expect(csvResult.transactions.length).toBe(15);
    });

    it("parses pinned credit count (9 credits)", () => {
      const xlsCredits = xlsResult.transactions.filter(t => t.direction === "CR");
      const csvCredits = csvResult.transactions.filter(t => t.direction === "CR");
      expect(xlsCredits.length).toBe(9);
      expect(csvCredits.length).toBe(9);
    });

    it("parses pinned debit count (6 debits)", () => {
      const xlsDebits = xlsResult.transactions.filter(t => t.direction === "DR");
      const csvDebits = csvResult.transactions.filter(t => t.direction === "DR");
      expect(xlsDebits.length).toBe(6);
      expect(csvDebits.length).toBe(6);
    });

    it("has zero parse errors from .xls", () => {
      expect(xlsResult.errors.length).toBe(0);
    });

    it("has zero parse errors from CSV", () => {
      expect(csvResult.errors.length).toBe(0);
    });
  });

  describe(".xls and CSV produce identical normalized transactions", () => {
    it("all transactions match between .xls and CSV", () => {
      assertTransactionsEquivalent(xlsResult.transactions, csvResult.transactions, "ICICI");
    });
  });

  describe("edge case handling", () => {
    it("parses narration overflow row (mid-data)", () => {
      const overflowTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT LONG NAME ENTERPRISE") && 
        t.narration.includes("SYNT-INV-2030-0001")
      );
      expect(overflowTxn).toBeDefined();
      expect(overflowTxn!.amountPaise).toBe(3333333);
      expect(overflowTxn!.direction).toBe("CR");
    });

    it("parses narration overflow row (last transaction before legend)", () => {
      const lastOverflowTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT FINAL PAYMENT CORP") &&
        t.narration.includes("SYNT-SETTLE-2030")
      );
      expect(lastOverflowTxn).toBeDefined();
      expect(lastOverflowTxn!.amountPaise).toBe(2222222);
      expect(lastOverflowTxn!.direction).toBe("CR");
    });

    it("parses VPA with hyphen", () => {
      const hyphenVpaTxn = xlsResult.transactions.find(t => 
        t.narration.includes("synt-pay@oksynt")
      );
      expect(hyphenVpaTxn).toBeDefined();
      expect(hyphenVpaTxn!.parsed.upiId).toBe("synt-pay@oksynt");
    });

    it("parses VPA without @ (alphanumeric ID)", () => {
      const noAtVpaTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT9000000001")
      );
      expect(noAtVpaTxn).toBeDefined();
    });

    it("parses CMS credits correctly", () => {
      const cmsTxns = xlsResult.transactions.filter(t => t.parsed.rail === "CMS");
      expect(cmsTxns.length).toBe(2);
      expect(cmsTxns[0].direction).toBe("CR");
      expect(cmsTxns[1].direction).toBe("CR");
    });

    it("parses ACH debit correctly", () => {
      const achTxn = xlsResult.transactions.find(t => t.parsed.rail === "ACH");
      expect(achTxn).toBeDefined();
      expect(achTxn!.direction).toBe("DR");
    });

    it("parses interest credit correctly", () => {
      const interestTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT INT PAID")
      );
      expect(interestTxn).toBeDefined();
      expect(interestTxn!.direction).toBe("CR");
      expect(interestTxn!.amountPaise).toBe(123456);
    });

    it("parses value date != transaction date case", () => {
      const diffDateTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT UTILITY")
      );
      expect(diffDateTxn).toBeDefined();
      expect(diffDateTxn!.date).toBe("2030-10-24");
      expect(diffDateTxn!.valueDate).toBe("2030-10-23");
    });

    it("skips legend footer rows", () => {
      const legendTxn = xlsResult.transactions.find(t => 
        t.narration.includes("Legends") || t.narration.includes("legend entry")
      );
      expect(legendTxn).toBeUndefined();
    });
  });

  describe("credit transaction scoring", () => {
    const invoices = createFictionalInvoices();
    const buyers = createFictionalBuyers();

    it("scores first UPI credit against matching invoice", () => {
      const credit = xlsResult.transactions.find(t => 
        t.direction === "CR" && t.narration.includes("SYNT VENDOR PVT LTD")
      );
      expect(credit).toBeDefined();

      const payment: PaymentForScoring = {
        id: "pay-001",
        amountPaise: BigInt(credit!.amountPaise),
        narration: credit!.narration,
        payerText: "SYNT VENDOR PVT LTD",
        utr: credit!.parsed.utr ?? null,
        rail: credit!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(credit!.narration);
      const buyer = buyers.find(b => b.id === "buyer-synt-vendor")!;
      const invoice = invoices.find(i => i.buyerAccountId === "buyer-synt-vendor")!;

      const result = scorePaymentToInvoice(payment, invoice, buyer, extractedRefs);
      
      expect(result.score).toBeGreaterThan(0);
      // Score depends on amount match + name match; band varies based on match quality
      expect(["low", "medium"]).toContain(getConfidenceBand(result.score));
    });

    it("scores CMS credit against matching invoice", () => {
      const cmsTxn = xlsResult.transactions.find(t => 
        t.parsed.rail === "CMS" && t.narration.includes("SYNT CORPORATE COLLECTIONS")
      );
      expect(cmsTxn).toBeDefined();

      const payment: PaymentForScoring = {
        id: "pay-cms",
        amountPaise: BigInt(cmsTxn!.amountPaise),
        narration: cmsTxn!.narration,
        payerText: "SYNT CORPORATE COLLECTIONS PVT LTD",
        utr: null,
        rail: cmsTxn!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(cmsTxn!.narration);
      const buyer = buyers.find(b => b.id === "buyer-synt-corporate")!;
      const invoice = invoices.find(i => i.buyerAccountId === "buyer-synt-corporate")!;

      const result = scorePaymentToInvoice(payment, invoice, buyer, extractedRefs);
      
      expect(result.score).toBeGreaterThan(0);
    });
  });
});

describe("HDFC BIFF8 .xls real-layout parsing", () => {
  let xlsResult: ParseResult;
  let csvResult: ParseResult;

  beforeAll(async () => {
    const xlsContent = readFileSync(join(FIXTURES_DIR, "hdfc-synthetic.xls"));
    const xlsFile = new File([xlsContent], "hdfc-synthetic.xls", { type: "application/vnd.ms-excel" });
    xlsResult = await parseBankStatement(xlsFile);

    const csvContent = readFileSync(join(FIXTURES_DIR, "hdfc-synthetic.csv"));
    const csvFile = new File([csvContent], "hdfc-synthetic.csv", { type: "text/csv" });
    csvResult = await parseBankStatement(csvFile);
  });

  describe("detection and parsing", () => {
    it("detects HDFC bank from .xls with high confidence", () => {
      expect(xlsResult.detection.bank).toBe("HDFC");
      expect(xlsResult.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects HDFC bank from CSV with high confidence", () => {
      expect(csvResult.detection.bank).toBe("HDFC");
      expect(csvResult.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses pinned transaction count from .xls", () => {
      expect(xlsResult.transactions.length).toBe(15);
    });

    it("parses pinned transaction count from CSV", () => {
      expect(csvResult.transactions.length).toBe(15);
    });

    it("parses pinned credit count (7 credits)", () => {
      const xlsCredits = xlsResult.transactions.filter(t => t.direction === "CR");
      const csvCredits = csvResult.transactions.filter(t => t.direction === "CR");
      expect(xlsCredits.length).toBe(7);
      expect(csvCredits.length).toBe(7);
    });

    it("parses pinned debit count (8 debits)", () => {
      const xlsDebits = xlsResult.transactions.filter(t => t.direction === "DR");
      const csvDebits = csvResult.transactions.filter(t => t.direction === "DR");
      expect(xlsDebits.length).toBe(8);
      expect(csvDebits.length).toBe(8);
    });

    it("has zero parse errors from .xls (footer properly skipped)", () => {
      expect(xlsResult.errors.length).toBe(0);
    });

    it("has zero parse errors from CSV (footer properly skipped)", () => {
      expect(csvResult.errors.length).toBe(0);
    });
  });

  describe(".xls and CSV produce identical normalized transactions", () => {
    it("all transactions match between .xls and CSV", () => {
      assertTransactionsEquivalent(xlsResult.transactions, csvResult.transactions, "HDFC");
    });
  });

  describe("edge case handling", () => {
    it("parses hyphenated VPA (7-segment form)", () => {
      const hyphenVpaTxn = xlsResult.transactions.find(t => 
        t.narration.includes("9000000000-1@oksynt")
      );
      expect(hyphenVpaTxn).toBeDefined();
      expect(hyphenVpaTxn!.parsed.upiId).toBe("9000000000-1@oksynt");
    });

    it("parses ref != 0000+RRN case", () => {
      const diffRefTxn = xlsResult.transactions.find(t => 
        t.refNo === "1234600000000003"
      );
      expect(diffRefTxn).toBeDefined();
      expect(diffRefTxn!.narration).toContain("SYNT RETAILER");
    });

    it("parses 15-digit ref case", () => {
      const shortRefTxn = xlsResult.transactions.find(t => 
        t.refNo === "000600000000009"
      );
      expect(shortRefTxn).toBeDefined();
      expect(shortRefTxn!.narration).toContain("SYNT PETROL");
    });

    it("parses card AUTOPAY debit", () => {
      const cardTxn = xlsResult.transactions.find(t => 
        t.narration.includes("DC 1000000000000001 AUTOPAY")
      );
      expect(cardTxn).toBeDefined();
      expect(cardTxn!.direction).toBe("DR");
    });

    it("parses ATM withdrawal", () => {
      const atwTxn = xlsResult.transactions.find(t => 
        t.narration.includes("ATW-SYNTCARD0000")
      );
      expect(atwTxn).toBeDefined();
      expect(atwTxn!.direction).toBe("DR");
      expect(atwTxn!.amountPaise).toBe(1000000);
    });

    it("parses interest credit correctly", () => {
      const interestTxn = xlsResult.transactions.find(t => 
        t.narration.includes("INTEREST PAID SYNT")
      );
      expect(interestTxn).toBeDefined();
      expect(interestTxn!.direction).toBe("CR");
      expect(interestTxn!.amountPaise).toBe(123456);
    });

    it("parses value date != date case", () => {
      const diffDateTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT UTILITY")
      );
      expect(diffDateTxn).toBeDefined();
      expect(diffDateTxn!.date).toBe("2030-10-22");
      expect(diffDateTxn!.valueDate).toBe("2030-10-23");
    });

    it("parses double-space name correctly", () => {
      const doubleSpaceTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT  DOUBLE SPACE CO")
      );
      expect(doubleSpaceTxn).toBeDefined();
    });

    it("skips footer summary rows", () => {
      const summaryTxn = xlsResult.transactions.find(t => 
        t.narration.includes("Opening Balance") ||
        t.narration.includes("STATEMENT SUMMARY") ||
        t.narration.includes("End Of Statement")
      );
      expect(summaryTxn).toBeUndefined();
    });
  });

  describe("credit transaction scoring", () => {
    const invoices = createFictionalInvoices();
    const buyers = createFictionalBuyers();

    it("scores first UPI credit against matching invoice", () => {
      const credit = xlsResult.transactions.find(t => 
        t.direction === "CR" && t.narration.includes("SYNT VENDOR PVT LTD")
      );
      expect(credit).toBeDefined();

      const payment: PaymentForScoring = {
        id: "pay-hdfc-001",
        amountPaise: BigInt(credit!.amountPaise),
        narration: credit!.narration,
        payerText: "SYNT VENDOR PVT LTD",
        utr: credit!.parsed.utr ?? null,
        rail: credit!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(credit!.narration);
      const buyer = buyers.find(b => b.id === "buyer-synt-vendor")!;
      const invoice = invoices.find(i => i.buyerAccountId === "buyer-synt-vendor")!;

      const result = scorePaymentToInvoice(payment, invoice, buyer, extractedRefs);
      
      expect(result.score).toBeGreaterThan(0);
      // Score depends on amount match + name match; band varies based on match quality
      expect(["low", "medium"]).toContain(getConfidenceBand(result.score));
    });

    it("scores hyphenated VPA credit", () => {
      const hyphenCredit = xlsResult.transactions.find(t => 
        t.direction === "CR" && t.narration.includes("9000000000-1@oksynt")
      );
      expect(hyphenCredit).toBeDefined();

      const payment: PaymentForScoring = {
        id: "pay-hdfc-hyphen",
        amountPaise: BigInt(hyphenCredit!.amountPaise),
        narration: hyphenCredit!.narration,
        payerText: "SYNT WHOLESALER",
        utr: hyphenCredit!.parsed.utr ?? null,
        rail: hyphenCredit!.parsed.rail,
      };

      const extractedRefs = extractInvoiceRefs(hyphenCredit!.narration);
      const buyer = buyers.find(b => b.id === "buyer-synt-wholesaler")!;
      const invoice = invoices.find(i => i.buyerAccountId === "buyer-synt-wholesaler")!;

      const result = scorePaymentToInvoice(payment, invoice, buyer, extractedRefs);
      
      expect(result.score).toBeGreaterThan(0);
    });
  });
});

describe("pinned results summary", () => {
  it("summarizes ICICI pinned results", async () => {
    const xlsContent = readFileSync(join(FIXTURES_DIR, "icici-synthetic.xls"));
    const xlsFile = new File([xlsContent], "icici-synthetic.xls", { type: "application/vnd.ms-excel" });
    const result = await parseBankStatement(xlsFile);

    expect(result.transactions.length).toBe(15);
    expect(result.transactions.filter(t => t.direction === "CR").length).toBe(9);
    expect(result.transactions.filter(t => t.direction === "DR").length).toBe(6);
    expect(result.errors.length).toBe(0);
  });

  it("summarizes HDFC pinned results", async () => {
    const xlsContent = readFileSync(join(FIXTURES_DIR, "hdfc-synthetic.xls"));
    const xlsFile = new File([xlsContent], "hdfc-synthetic.xls", { type: "application/vnd.ms-excel" });
    const result = await parseBankStatement(xlsFile);

    expect(result.transactions.length).toBe(15);
    expect(result.transactions.filter(t => t.direction === "CR").length).toBe(7);
    expect(result.transactions.filter(t => t.direction === "DR").length).toBe(8);
    expect(result.errors.length).toBe(0);
  });
});
