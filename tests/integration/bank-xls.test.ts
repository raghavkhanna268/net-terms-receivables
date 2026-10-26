/**
 * Integration tests for BIFF8 .xls bank statement parsing.
 * 
 * Tests that:
 * 1. .xls and CSV twins produce identical normalized transactions (all fields)
 * 2. Row counts, credits/debits, and parse errors are pinned
 * 3. Specific edge cases (overflow rows, hyphen VPA, ref≠RRN, 15-digit ref) parse correctly
 * 4. Credit transactions score against realistic fictional invoices with pinned results
 * 
 * All fixture data is SYNTHETIC with SYNT markers - not real bank data.
 * Covers issue #334 (alphabetic hyphenated VPAs).
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

type ConfidenceBand = "high" | "medium" | "low";

function getConfidenceBand(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function formatReasons(reasons: MatchReason[]): string {
  return reasons.map((r) => `${r.type}(+${r.points})`).join(", ");
}

/**
 * Compare two transaction arrays for equivalence.
 * Compares ALL normalized fields that should be identical between .xls and CSV parsing.
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
    const ctx = `${bankName} row ${i + 1}`;
    
    // Core fields
    expect(xls.date, `${ctx} date`).toBe(csv.date);
    expect(xls.valueDate, `${ctx} valueDate`).toBe(csv.valueDate);
    expect(xls.amountPaise, `${ctx} amountPaise`).toBe(csv.amountPaise);
    expect(xls.direction, `${ctx} direction`).toBe(csv.direction);
    expect(xls.refNo, `${ctx} refNo`).toBe(csv.refNo);
    expect(xls.balancePaise, `${ctx} balancePaise`).toBe(csv.balancePaise);
    expect(xls.dedupeKey, `${ctx} dedupeKey`).toBe(csv.dedupeKey);
    
    // Parsed fields
    expect(xls.parsed.rail, `${ctx} rail`).toBe(csv.parsed.rail);
    expect(xls.parsed.upiId, `${ctx} upiId`).toBe(csv.parsed.upiId);
    expect(xls.parsed.utr, `${ctx} utr`).toBe(csv.parsed.utr);
    expect(xls.parsed.payerName, `${ctx} payerName`).toBe(csv.parsed.payerName);
    expect(xls.parsed.payerBank, `${ctx} payerBank`).toBe(csv.parsed.payerBank);
  }
}

/**
 * Synthetic buyer for scoring tests.
 */
const SYNTHETIC_BUYER: BuyerForScoring = {
  id: "buyer-synt-vendor",
  name: "SYNT VENDOR PVT LTD",
  aliases: ["synt vendor", "synt vendor pvt ltd"],
  email: null,
};

/**
 * Synthetic invoices for scoring tests.
 * Amounts match fixture transactions for exact/partial match testing.
 */
const SYNTHETIC_INVOICES: InvoiceForScoring[] = [
  {
    id: "inv-001",
    name: "#1001",
    orderId: "gid://shopify/Order/1001",
    outstandingPaise: 5123456n, // Matches ICICI first UPI credit (51234.56)
    buyerAccountId: "buyer-synt-vendor",
    dueAt: new Date("2030-10-20"),
  },
  {
    id: "inv-002",
    name: "#1002", 
    orderId: "gid://shopify/Order/1002",
    outstandingPaise: 2468013n, // Matches second credit (24680.13)
    buyerAccountId: "buyer-synt-vendor",
    dueAt: new Date("2030-10-21"),
  },
  {
    id: "inv-003",
    name: "INV-2030-0001",
    orderId: null,
    outstandingPaise: 3210987n, // Matches overflow row credit (32109.87)
    buyerAccountId: "buyer-synt-vendor",
    dueAt: new Date("2030-10-25"),
  },
];

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
    it("all transactions match between .xls and CSV (all fields)", () => {
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
      expect(overflowTxn!.amountPaise).toBe(3210987); // 32109.87
      expect(overflowTxn!.direction).toBe("CR");
    });

    it("parses narration overflow row (last transaction before legend)", () => {
      const lastOverflowTxn = xlsResult.transactions.find(t => 
        t.narration.includes("SYNT FINAL PAYMENT CORP") &&
        t.narration.includes("SYNT-SETTLE-2030")
      );
      expect(lastOverflowTxn).toBeDefined();
      expect(lastOverflowTxn!.amountPaise).toBe(2109876); // 21098.76
      expect(lastOverflowTxn!.direction).toBe("CR");
    });

    it("parses VPA with hyphen (#334)", () => {
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
      expect(interestTxn!.amountPaise).toBe(123456); // 1234.56
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

  describe("credit transaction scoring (pinned)", () => {
    /**
     * First UPI credit: 51,234.56 from SYNT VENDOR PVT LTD
     * 
     * Score breakdown:
     * - amount_exact: +20 (payment matches invoice-001 exactly)
     * - payer_alias: +10 (SYNT VENDOR matches buyer alias)
     * Total: 30 points -> low band
     */
    it("pins first UPI credit score: 30 points, low band", () => {
      const credit = xlsResult.transactions.find(t => 
        t.direction === "CR" && t.narration.includes("SYNT VENDOR PVT LTD") && t.amountPaise === 5123456
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

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("inv-001");
      expect(allocation.score).toBe(30);
      expect(getConfidenceBand(allocation.score)).toBe("low");
      expect(allocation.allocatedPaise).toBe(5123456n);
      expect(formatReasons(allocation.reasons)).toBe("amount_exact(+20), payer_alias(+10)");
    });

    /**
     * CMS credit: 76,543.21 from SYNT CORPORATE COLLECTIONS
     * 
     * Score breakdown:
     * - amount_overpayment: +10 (payment exceeds invoice outstanding)
     * - payer_name: +8 (fuzzy match on buyer.name, floor(10 * 0.8))
     * Total: 18 points -> low band
     */
    it("pins CMS credit score: 18 points, low band", () => {
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

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.score).toBe(18);
      expect(getConfidenceBand(allocation.score)).toBe("low");
      expect(formatReasons(allocation.reasons)).toBe("amount_overpayment(+10), payer_name(+8)");
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
    it("all transactions match between .xls and CSV (all fields)", () => {
      assertTransactionsEquivalent(xlsResult.transactions, csvResult.transactions, "HDFC");
    });
  });

  describe("edge case handling", () => {
    it("parses hyphenated phone VPA (#334)", () => {
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
      expect(atwTxn!.amountPaise).toBe(1000000); // 10,000.00
    });

    it("parses interest credit correctly", () => {
      const interestTxn = xlsResult.transactions.find(t => 
        t.narration.includes("INTEREST PAID SYNT")
      );
      expect(interestTxn).toBeDefined();
      expect(interestTxn!.direction).toBe("CR");
      expect(interestTxn!.amountPaise).toBe(123456); // 1234.56
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

  describe("credit transaction scoring (pinned)", () => {
    /**
     * First UPI credit: 51,234.56 from SYNT VENDOR PVT LTD
     * 
     * Score breakdown:
     * - amount_exact: +20 (payment matches invoice-001 exactly)
     * - payer_alias: +10 (SYNT VENDOR matches buyer alias)
     * Total: 30 points -> low band
     */
    it("pins first UPI credit score: 30 points, low band", () => {
      const credit = xlsResult.transactions.find(t => 
        t.direction === "CR" && t.narration.includes("SYNT VENDOR PVT LTD") && t.amountPaise === 5123456
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

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("inv-001");
      expect(allocation.score).toBe(30);
      expect(getConfidenceBand(allocation.score)).toBe("low");
      expect(allocation.allocatedPaise).toBe(5123456n);
      expect(formatReasons(allocation.reasons)).toBe("amount_exact(+20), payer_alias(+10)");
    });

    /**
     * Hyphenated VPA credit: 24,680.13 from SYNT WHOLESALER
     * 
     * Score breakdown:
     * - amount_exact: +20 (payment matches invoice-002 exactly)
     * - payer_name: +8 (fuzzy match on buyer.name, floor(10 * 0.8))
     * Total: 28 points -> low band
     */
    it("pins hyphenated VPA credit score: 28 points, low band", () => {
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

      const result = scoreMultiInvoiceMatch(payment, SYNTHETIC_INVOICES, SYNTHETIC_BUYER);
      expect(result).not.toBeNull();

      const allocation = result!.allocations[0];
      expect(allocation.invoiceId).toBe("inv-002");
      expect(allocation.score).toBe(28);
      expect(getConfidenceBand(allocation.score)).toBe("low");
      expect(formatReasons(allocation.reasons)).toBe("amount_exact(+20), payer_name(+8)");
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
