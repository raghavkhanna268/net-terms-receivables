/**
 * Edge-case tests for bank statement parsing.
 * Using SYNTHETIC fixtures - not real bank data.
 * Layout: UNVERIFIED (based on public documentation only)
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Tests cover:
 * - UTF-8 BOM at file start (SBI fixture)
 * - CRLF line endings (Axis fixture)
 * - Trailing blank rows
 * - Debit-only rows
 * - Dr suffix in amounts (HDFC debit-only fixture)
 * - Cr suffix in balance columns (ICICI fixtures)
 * - Missing/blank UTR/reference
 * - Date format variations (DD/MM/YYYY, DD-MMM-YYYY, 2-digit year)
 * - Malformed rows handling with coded errors (code + row index only)
 * - Opening/closing balance row skipping
 * - Console output safety (no narration/remitter leakage)
 */

import { describe, it, expect, beforeAll, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement } from "../index.js";
import type { ParseResult } from "../types.js";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

describe("edge-case handling (SYNTHETIC, UNVERIFIED LAYOUT)", () => {
  describe("HDFC edge cases", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects HDFC bank", () => {
      expect(result.detection.bank).toBe("HDFC");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses valid transactions despite malformed row", () => {
      expect(result.transactions.length).toBeGreaterThan(0);
    });

    it("handles trailing blank rows without crashing", () => {
      expect(result.transactions.length).toBe(13);
    });

    it("parses DD/MM/YY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SALARY"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-01");
    });

    it("parses DD-MMM-YY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SERVICES"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-05");
    });

    it("parses DD/MM/YYYY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("WHOLESALE LTD-INV"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-07");
    });

    it("handles missing UTR/reference with exact values", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("IMPS-123456789012-SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
      expect(txnMissingRef!.refNo).toBeFalsy();
      expect(txnMissingRef!.parsed.utr).toBe("123456789012");
      expect(txnMissingRef!.direction).toBe("CR");
      expect(txnMissingRef!.amountPaise).toBe(2500000); // 25,000.00
      expect(txnMissingRef!.balancePaise).toBe(20955000); // 2,09,550.00
    });

    it("handles amounts with Indian thousands grouping", () => {
      const txnLarge = result.transactions.find(
        (t) => t.narration.includes("SYNTR26296000002-SYNTHETIC WHOLESALE")
      );
      expect(txnLarge).toBeDefined();
      expect(txnLarge?.direction).toBe("DR");
      expect(txnLarge?.amountPaise).toBe(10000000); // 1,00,000.00
    });

    it("parses RTGS amounts correctly", () => {
      const rtgsTxn = result.transactions.find((t) => t.narration.includes("WHOLESALE LTD-INV"));
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn?.amountPaise).toBe(35000000); // 3,50,000.00
    });

    it("skips malformed row without crashing", () => {
      const malformed = result.transactions.find((t) => t.narration.includes("Malformed row"));
      expect(malformed).toBeUndefined();
    });

    it("parses debit transactions correctly", () => {
      const debits = result.transactions.filter((t) => t.direction === "DR");
      expect(debits.length).toBeGreaterThan(0);
      for (const d of debits) {
        expect(d.amountPaise).toBeGreaterThan(0);
      }
    });

    it("parses credit transactions correctly", () => {
      const credits = result.transactions.filter((t) => t.direction === "CR");
      expect(credits.length).toBeGreaterThan(0);
      for (const c of credits) {
        expect(c.amountPaise).toBeGreaterThan(0);
      }
    });
  });

  describe("ICICI edge cases", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects ICICI bank", () => {
      expect(result.detection.bank).toBe("ICICI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses valid transactions despite malformed row", () => {
      expect(result.transactions.length).toBeGreaterThan(0);
    });

    it("handles trailing blank rows", () => {
      expect(result.transactions.length).toBe(13);
    });

    it("parses DD.MM.YYYY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SALARY"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-01");
    });

    it("handles balance with Cr suffix and exact value", () => {
      const txn = result.transactions[0];
      expect(txn?.balancePaise).toBeDefined();
      expect(txn?.balancePaise).toBe(18500000); // 1,85,000.00 Cr
    });

    it("handles missing reference with exact values", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("IMPS-123456789012-SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
      expect(txnMissingRef!.refNo).toBeFalsy();
      expect(txnMissingRef!.parsed.utr).toBe("123456789012");
      expect(txnMissingRef!.direction).toBe("CR");
      expect(txnMissingRef!.balancePaise).toBe(20955000); // 2,09,550.00
    });

    it("handles large amounts with Indian thousands grouping", () => {
      const txnLarge = result.transactions.find(
        (t) => t.narration.includes("SYNTR26296000002-SYNTHETIC WHOLESALE")
      );
      expect(txnLarge).toBeDefined();
      expect(txnLarge?.direction).toBe("DR");
      expect(txnLarge?.amountPaise).toBe(10000000); // 1,00,000.00
    });

    it("skips impossible date row (45/13/2026)", () => {
      const malformed = result.transactions.find((t) => t.narration.includes("impossible date"));
      expect(malformed).toBeUndefined();
    });

    it("skips B/F row", () => {
      const bf = result.transactions.find((t) => t.narration === "B/F");
      expect(bf).toBeUndefined();
    });
  });

  describe("SBI edge cases with UTF-8 BOM", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects SBI bank despite UTF-8 BOM", () => {
      expect(result.detection.bank).toBe("SBI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses transactions with UTF-8 BOM at file start", () => {
      expect(result.transactions.length).toBeGreaterThan(0);
    });

    it("handles trailing blank rows", () => {
      expect(result.transactions.length).toBe(13);
    });

    it("parses DD/MM/YYYY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SALARY"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-01");
    });

    it("parses DD-MMM-YYYY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SERVICES"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-05");
    });

    it("handles missing reference with exact values", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("IMPS-123456789012-SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
      expect(txnMissingRef!.refNo).toBeFalsy();
      expect(txnMissingRef!.parsed.utr).toBe("123456789012");
      expect(txnMissingRef!.direction).toBe("CR");
    });

    it("handles large amounts with Indian thousands grouping", () => {
      const txnLarge = result.transactions.find(
        (t) => t.narration.includes("SYNTR26296000002-SYNTHETIC WHOLESALE")
      );
      expect(txnLarge).toBeDefined();
      expect(txnLarge?.direction).toBe("DR");
      expect(txnLarge?.amountPaise).toBe(10000000); // 1,00,000.00
    });

    it("skips malformed date row", () => {
      const malformed = result.transactions.find((t) => t.narration.includes("invalid date"));
      expect(malformed).toBeUndefined();
    });

    it("skips Opening Balance row", () => {
      const opening = result.transactions.find((t) => t.narration.includes("Opening Balance"));
      expect(opening).toBeUndefined();
    });
  });

  describe("Axis edge cases with CRLF line endings", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects Axis bank despite CRLF line endings", () => {
      expect(result.detection.bank).toBe("AXIS");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses transactions with CRLF line endings", () => {
      expect(result.transactions.length).toBeGreaterThan(0);
    });

    it("handles trailing blank rows", () => {
      expect(result.transactions.length).toBe(13);
    });

    it("parses DD-MM-YYYY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SALARY"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-01");
    });

    it("parses DD-MMM-YY date format", () => {
      const txn = result.transactions.find((t) => t.narration.includes("SERVICES"));
      expect(txn).toBeDefined();
      expect(txn?.date).toBe("2026-10-05");
    });

    it("handles missing reference with exact values", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("IMPS-123456789012-SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
      expect(txnMissingRef!.refNo).toBeFalsy();
      expect(txnMissingRef!.parsed.utr).toBe("123456789012");
      expect(txnMissingRef!.direction).toBe("CR");
    });

    it("handles large amounts with Indian thousands grouping", () => {
      const txnLarge = result.transactions.find(
        (t) => t.narration.includes("SYNTR26296000002-SYNTHETIC WHOLESALE")
      );
      expect(txnLarge).toBeDefined();
      expect(txnLarge?.direction).toBe("DR");
      expect(txnLarge?.amountPaise).toBe(10000000); // 1,00,000.00
    });

    it("skips malformed date row", () => {
      const malformed = result.transactions.find((t) => t.narration.includes("bad date format"));
      expect(malformed).toBeUndefined();
    });

    it("skips Opening Balance row", () => {
      const opening = result.transactions.find((t) => t.narration.includes("Opening Balance"));
      expect(opening).toBeUndefined();
    });
  });

  describe("debit-only transactions", () => {
    describe("HDFC debit-only", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "hdfc-debitonly-synthetic.csv"));
        const file = new File([content], "hdfc-debitonly-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("detects HDFC bank", () => {
        expect(result.detection.bank).toBe("HDFC");
      });

      it("parses debit-only transactions", () => {
        expect(result.transactions.length).toBe(6);
      });

      it("all transactions are debits", () => {
        for (const txn of result.transactions) {
          expect(txn.direction).toBe("DR");
          expect(txn.amountPaise).toBeGreaterThan(0);
        }
      });

      it("parses Dr suffix amount correctly", () => {
        const rtgsTxn = result.transactions.find((t) => t.narration.includes("RTGS-SYNTR"));
        expect(rtgsTxn).toBeDefined();
        expect(rtgsTxn?.amountPaise).toBe(5000000); // 50,000.00 Dr
        expect(rtgsTxn?.direction).toBe("DR");
      });

      it("parses exact amounts in paise", () => {
        const expectedAmounts = [
          { narration: "NEFT-SYNTN26296000001", paise: 1500000 }, // 15,000.00
          { narration: "UPI-SYNTHETIC VENDOR", paise: 125000 }, // 1,250.00
          { narration: "IMPS-123456789012", paise: 500000 }, // 5,000.00
          { narration: "CHQ PAID", paise: 2500000 }, // 25,000.00
          { narration: "ACH D-TP ACH", paise: 250000 }, // 2,500.00
        ];

        for (const expected of expectedAmounts) {
          const txn = result.transactions.find((t) => t.narration.includes(expected.narration));
          expect(txn).toBeDefined();
          expect(txn?.amountPaise).toBe(expected.paise);
        }
      });
    });

    describe("ICICI debit-only", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "icici-debitonly-synthetic.csv"));
        const file = new File([content], "icici-debitonly-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("detects ICICI bank", () => {
        expect(result.detection.bank).toBe("ICICI");
      });

      it("parses debit-only transactions", () => {
        expect(result.transactions.length).toBe(6);
      });

      it("all transactions are debits", () => {
        for (const txn of result.transactions) {
          expect(txn.direction).toBe("DR");
        }
      });

      it("handles balance with Cr suffix", () => {
        for (const txn of result.transactions) {
          expect(txn.balancePaise).toBeDefined();
          expect(txn.balancePaise).toBeGreaterThan(0);
        }
      });
    });

    describe("SBI debit-only", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "sbi-debitonly-synthetic.csv"));
        const file = new File([content], "sbi-debitonly-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("detects SBI bank", () => {
        expect(result.detection.bank).toBe("SBI");
      });

      it("parses debit-only transactions", () => {
        expect(result.transactions.length).toBe(6);
      });

      it("all transactions are debits", () => {
        for (const txn of result.transactions) {
          expect(txn.direction).toBe("DR");
        }
      });
    });

    describe("Axis debit-only", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "axis-debitonly-synthetic.csv"));
        const file = new File([content], "axis-debitonly-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("detects Axis bank", () => {
        expect(result.detection.bank).toBe("AXIS");
      });

      it("parses debit-only transactions", () => {
        expect(result.transactions.length).toBe(6);
      });

      it("all transactions are debits", () => {
        for (const txn of result.transactions) {
          expect(txn.direction).toBe("DR");
        }
      });
    });
  });

  describe("console output safety", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>[];
    let logOutput: string[];

    beforeEach(() => {
      logOutput = [];
      consoleSpy = [
        vi.spyOn(console, "log").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "warn").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "error").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "info").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "debug").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
      ];
    });

    afterEach(() => {
      consoleSpy.forEach((spy) => spy.mockRestore());
    });

    it("does not log narration text from HDFC fixture", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      await parseBankStatement(file);

      const allLogs = logOutput.join("\n");
      expect(allLogs).not.toContain("SYNTHETIC CORP PVT LTD");
      expect(allLogs).not.toContain("SYNTHETIC VENDOR");
      expect(allLogs).not.toContain("SYNTHETIC SENDER");
      expect(allLogs).not.toContain("SYNTHETIC STORE");
      expect(allLogs).not.toContain("vendor@synt");
      expect(allLogs).not.toContain("store@synt");
    });

    it("does not log narration text from ICICI fixture", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      await parseBankStatement(file);

      const allLogs = logOutput.join("\n");
      expect(allLogs).not.toContain("SYNTHETIC CORP");
      expect(allLogs).not.toContain("SYNTHETIC VENDOR");
      expect(allLogs).not.toContain("SYNTHETIC SENDER");
      expect(allLogs).not.toContain("vendor@synt");
    });

    it("does not log narration text from SBI fixture", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      await parseBankStatement(file);

      const allLogs = logOutput.join("\n");
      expect(allLogs).not.toContain("SYNTHETIC CORP");
      expect(allLogs).not.toContain("SYNTHETIC VENDOR");
      expect(allLogs).not.toContain("SYNTHETIC SENDER");
    });

    it("does not log narration text from Axis fixture", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      await parseBankStatement(file);

      const allLogs = logOutput.join("\n");
      expect(allLogs).not.toContain("SYNTHETIC CORP");
      expect(allLogs).not.toContain("SYNTHETIC VENDOR");
      expect(allLogs).not.toContain("SYNTHETIC SENDER");
    });

    it("only logs counts/ids/codes, never raw fixture data", async () => {
      const fixtures = [
        "hdfc-edgecases-synthetic.csv",
        "icici-edgecases-synthetic.csv",
        "sbi-edgecases-synthetic.csv",
        "axis-edgecases-synthetic.csv",
      ];

      for (const fixture of fixtures) {
        logOutput = [];
        const content = readFileSync(join(FIXTURES_DIR, fixture));
        const file = new File([content], fixture, { type: "text/csv" });
        await parseBankStatement(file);

        const allLogs = logOutput.join("\n");
        expect(allLogs).not.toContain("SALARY");
        expect(allLogs).not.toContain("PAYMENT");
        expect(allLogs).not.toContain("LANDLORD");
        expect(allLogs).not.toContain("RESTAURANT");
        expect(allLogs).not.toContain("INSURANCE");
      }
    });
  });

  describe("malformed row handling", () => {
    it("HDFC: reports coded errors for malformed rows, skips Opening/Closing Balance without error", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(13);
      expect(result.skippedRows).toBeGreaterThan(0);

      const malformedInTxns = result.transactions.find((t) =>
        t.narration.includes("Malformed row")
      );
      expect(malformedInTxns).toBeUndefined();

      const openingBalanceInTxns = result.transactions.find((t) =>
        t.narration.includes("Opening Balance")
      );
      expect(openingBalanceInTxns).toBeUndefined();

      const closingBalanceInTxns = result.transactions.find((t) =>
        t.narration.includes("Closing Balance")
      );
      expect(closingBalanceInTxns).toBeUndefined();

      const badDateNoAmtInTxns = result.transactions.find((t) =>
        t.narration.includes("SYNTHETIC NO AMT ROW")
      );
      expect(badDateNoAmtInTxns).toBeUndefined();

      expect(result.errors.length).toBe(6);
      expect(result.errors[0].row).toBe(20);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[1].row).toBe(21);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(22);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[3].row).toBe(30);
      expect(result.errors[3].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[4].row).toBe(31);
      expect(result.errors[4].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[5].row).toBe(32);
      expect(result.errors[5].code).toBe("ROW_PARSE_FAILED");
    });

    it("ICICI: reports coded errors for malformed rows, including BADDATE in date column", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(3);
      expect(result.errors[0].row).toBe(19);
      expect(result.errors[0].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[1].row).toBe(20);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(21);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");

      const malformedInTxns = result.transactions.find((t) =>
        t.narration.includes("impossible date")
      );
      expect(malformedInTxns).toBeUndefined();

      const badDateNoAmtInTxns = result.transactions.find((t) =>
        t.narration.includes("SYNTHETIC NO AMT TEXT")
      );
      expect(badDateNoAmtInTxns).toBeUndefined();
    });

    it("SBI: reports coded errors for malformed rows, skips Closing Balance/B-F without error", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(13);
      expect(result.skippedRows).toBeGreaterThan(0);

      const malformedInTxns = result.transactions.find((t) =>
        t.narration.includes("invalid date")
      );
      expect(malformedInTxns).toBeUndefined();

      const closingBalanceInTxns = result.transactions.find((t) =>
        t.narration.includes("Closing Balance")
      );
      expect(closingBalanceInTxns).toBeUndefined();

      const bfInTxns = result.transactions.find((t) => t.narration === "B/F");
      expect(bfInTxns).toBeUndefined();

      const broughtForwardInTxns = result.transactions.find((t) =>
        t.narration.includes("Brought Forward")
      );
      expect(broughtForwardInTxns).toBeUndefined();

      const badDateNoAmtInTxns = result.transactions.find((t) =>
        t.narration.includes("SYNTHETIC NO AMT ROW")
      );
      expect(badDateNoAmtInTxns).toBeUndefined();

      expect(result.errors.length).toBe(7);
      expect(result.errors[0].row).toBe(20);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[1].row).toBe(21);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(22);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[3].row).toBe(30);
      expect(result.errors[3].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[4].row).toBe(31);
      expect(result.errors[4].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[5].row).toBe(32);
      expect(result.errors[5].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[6].row).toBe(33);
      expect(result.errors[6].code).toBe("ROW_PARSE_FAILED");
    });

    it("Axis: reports coded errors for malformed rows, skips Closing Balance/B-F without error", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(13);
      expect(result.skippedRows).toBeGreaterThan(0);

      const malformedInTxns = result.transactions.find((t) =>
        t.narration.includes("bad date format")
      );
      expect(malformedInTxns).toBeUndefined();

      const closingBalanceInTxns = result.transactions.find((t) =>
        t.narration.includes("Closing Balance")
      );
      expect(closingBalanceInTxns).toBeUndefined();

      const bfInTxns = result.transactions.find((t) => t.narration === "B/F");
      expect(bfInTxns).toBeUndefined();

      const broughtForwardInTxns = result.transactions.find((t) =>
        t.narration.includes("Brought Forward")
      );
      expect(broughtForwardInTxns).toBeUndefined();

      const badDateNoAmtInTxns = result.transactions.find((t) =>
        t.narration.includes("SYNTHETIC NO AMT ROW")
      );
      expect(badDateNoAmtInTxns).toBeUndefined();

      expect(result.errors.length).toBe(7);
      expect(result.errors[0].row).toBe(20);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[1].row).toBe(21);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(22);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[3].row).toBe(30);
      expect(result.errors[3].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[4].row).toBe(31);
      expect(result.errors[4].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[5].row).toBe(32);
      expect(result.errors[5].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[6].row).toBe(33);
      expect(result.errors[6].code).toBe("ROW_PARSE_FAILED");
    });
  });

  describe("row accounting invariant", () => {
    it("HDFC: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(6);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([20, 21, 22, 30, 32]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([31]);
    });

    it("SBI: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(7);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([20, 21, 22, 30, 31, 33]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([32]);
    });

    it("Axis: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(7);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([20, 21, 22, 30, 31, 33]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([32]);
    });

    it("ICICI: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(3);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([20, 21]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([19]);
    });

    it("HDFC retail: matches main error list, no spurious error at row 27 or 28", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(14);
      expect(result.errors.length).toBe(0);
      const hasRow27Error = result.errors.some((e) => e.row === 27);
      expect(hasRow27Error).toBe(false);
      const hasRow28Error = result.errors.some((e) => e.row === 28);
      expect(hasRow28Error).toBe(false);
    });
  });

  describe("narration continuation handling", () => {
    it("HDFC: genuine continuation row merges into previous transaction", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE LTD-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE LTD-INV SYNTHETIC CONTINUATION LINE");
    });

    it("HDFC: BADDATE row does not merge into previous transaction", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const anyTxnWithBadDate = result.transactions.find((t) =>
        t.narration.includes("SYNTHETIC NO AMT ROW") || t.narration.includes("BADDATE")
      );
      expect(anyTxnWithBadDate).toBeUndefined();
    });

    it("HDFC: orphan continuation after error gives ROW_PARSE_FAILED and does not merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const orphanError = result.errors.find((e) => e.row === 22);
      expect(orphanError).toBeDefined();
      expect(orphanError!.code).toBe("ROW_PARSE_FAILED");

      const nextTxn = result.transactions.find((t) =>
        t.narration.includes("NEFT CR-SYNTHETIC ENTERPRISE")
      );
      expect(nextTxn).toBeDefined();
      expect(nextTxn!.narration).toBe("NEFT CR-SYNTHETIC ENTERPRISE-PAYMENT");
    });

    it("HDFC: blank row between transaction and continuation does not break merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE LTD-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE LTD-INV SYNTHETIC CONTINUATION LINE");

      const blankRowErrors = result.errors.filter((e) => e.row === 18);
      expect(blankRowErrors.length).toBe(0);
    });

    it("SBI: genuine continuation row merges into previous transaction", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE-INV SYNTHETIC CONTINUATION LINE");
    });

    it("SBI: orphan continuation after error gives ROW_PARSE_FAILED and does not merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const orphanError = result.errors.find((e) => e.row === 22);
      expect(orphanError).toBeDefined();
      expect(orphanError!.code).toBe("ROW_PARSE_FAILED");

      const nextTxn = result.transactions.find((t) =>
        t.narration.includes("NEFT CR-SYNTHETIC ENTERPRISE")
      );
      expect(nextTxn).toBeDefined();
      expect(nextTxn!.narration).toBe("NEFT CR-SYNTHETIC ENTERPRISE-PAYMENT");
    });

    it("SBI: blank row between transaction and continuation does not break merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE-INV SYNTHETIC CONTINUATION LINE");

      const blankRowErrors = result.errors.filter((e) => e.row === 18);
      expect(blankRowErrors.length).toBe(0);
    });

    it("Axis: genuine continuation row merges into previous transaction", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE-INV SYNTHETIC CONTINUATION LINE");
    });

    it("Axis: orphan continuation after error gives ROW_PARSE_FAILED and does not merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const orphanError = result.errors.find((e) => e.row === 22);
      expect(orphanError).toBeDefined();
      expect(orphanError!.code).toBe("ROW_PARSE_FAILED");

      const nextTxn = result.transactions.find((t) =>
        t.narration.includes("NEFT CR-SYNTHETIC ENTERPRISE")
      );
      expect(nextTxn).toBeDefined();
      expect(nextTxn!.narration).toBe("NEFT CR-SYNTHETIC ENTERPRISE-PAYMENT");
    });

    it("Axis: blank row between transaction and continuation does not break merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE-INV SYNTHETIC CONTINUATION LINE");

      const blankRowErrors = result.errors.filter((e) => e.row === 18);
      expect(blankRowErrors.length).toBe(0);
    });

    it("ICICI: genuine continuation row merges into previous transaction", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE-INV SYNTHETIC CONTINUATION LINE");
    });

    it("ICICI: BADDATE in date column gives ROW_PARSE_FAILED and does not merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const badDateError = result.errors.find((e) => e.row === 20);
      expect(badDateError).toBeDefined();
      expect(badDateError!.code).toBe("ROW_PARSE_FAILED");

      const storeTxn = result.transactions.find((t) =>
        t.narration.includes("UPI-SYNTHETIC STORE")
      );
      expect(storeTxn).toBeDefined();
      expect(storeTxn!.narration).toBe("UPI-SYNTHETIC STORE-store@synt-SYNT0000002");
    });

    it("ICICI: orphan continuation after error gives ROW_PARSE_FAILED and does not merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const orphanError = result.errors.find((e) => e.row === 21);
      expect(orphanError).toBeDefined();
      expect(orphanError!.code).toBe("ROW_PARSE_FAILED");

      const nextTxn = result.transactions.find((t) =>
        t.narration.includes("NEFT CR-SYNTHETIC ENTERPRISE")
      );
      expect(nextTxn).toBeDefined();
      expect(nextTxn!.narration).toBe("NEFT CR-SYNTHETIC ENTERPRISE-PAYMENT");
    });

    it("ICICI: blank row between transaction and continuation does not break merge", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxn = result.transactions.find((t) =>
        t.narration.includes("RTGS CR-SYNTHETIC WHOLESALE-INV")
      );
      expect(rtgsTxn).toBeDefined();
      expect(rtgsTxn!.narration).toBe("RTGS CR-SYNTHETIC WHOLESALE-INV SYNTHETIC CONTINUATION LINE");

      const blankRowErrors = result.errors.filter((e) => e.row === 17);
      expect(blankRowErrors.length).toBe(0);
    });
  });

  describe("blank row handling", () => {
    it("HDFC: fully blank rows are skipped, not errors", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      const blankRowErrors = result.errors.filter(
        (e) => e.code === "ROW_PARSE_FAILED" && ![20, 21, 22, 30, 32].includes(e.row)
      );
      expect(blankRowErrors.length).toBe(0);
    });

    it("SBI: fully blank rows are skipped, not errors", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      const blankRowErrors = result.errors.filter(
        (e) => e.code === "ROW_PARSE_FAILED" && ![20, 21, 22, 30, 31, 33].includes(e.row)
      );
      expect(blankRowErrors.length).toBe(0);
    });

    it("Axis: fully blank rows are skipped, not errors", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      const blankRowErrors = result.errors.filter(
        (e) => e.code === "ROW_PARSE_FAILED" && ![20, 21, 22, 30, 31, 33].includes(e.row)
      );
      expect(blankRowErrors.length).toBe(0);
    });

    it("ICICI: fully blank rows are skipped, not errors", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      const blankRowErrors = result.errors.filter(
        (e) => e.code === "ROW_PARSE_FAILED" && ![20, 21].includes(e.row)
      );
      expect(blankRowErrors.length).toBe(0);
    });
  });

  describe("UTR extraction", () => {
    it("HDFC: extracts UTR for NEFT transactions", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      expect(neftTxns.length).toBeGreaterThan(0);
      const salaryTxn = neftTxns.find((t) => t.narration.includes("SALARY"));
      expect(salaryTxn?.parsed.utr).toBe("SYNTN26296000001");
    });

    it("HDFC: extracts UTR from narration for missing refNo", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const upiMissingRef = result.transactions.find(
        (t) => t.narration.includes("UPI-SYNTHETIC STORE") && !t.refNo
      );
      expect(upiMissingRef).toBeDefined();
      expect(upiMissingRef!.refNo).toBeFalsy();
      expect(upiMissingRef!.parsed.utr).toBe("876543210987");
    });

    it("ICICI: extracts UTR for RTGS transactions", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      expect(rtgsTxns.length).toBeGreaterThan(0);
      const incomingRtgs = rtgsTxns.find((t) => t.direction === "CR");
      expect(incomingRtgs?.parsed.utr).toBeDefined();
    });

    it("SBI: extracts UTR for IMPS transactions with exact value", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      expect(impsTxns.length).toBeGreaterThan(0);

      const impsTxn = impsTxns.find((t) => t.narration.includes("IMPS-123456789012"));
      expect(impsTxn).toBeDefined();
      expect(impsTxn!.parsed.utr).toBe("123456789012");
    });
  });

  describe("bare Total footer row handling", () => {
    it("HDFC v2 fixture: bare 'Total' row is recognized as footer, produces 0 parse errors", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
      const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.errors.length).toBe(0);
    });

    it("HDFC v2 fixture: parses exactly 4 credits", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
      const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      expect(credits.length).toBe(4);
    });

    it("HDFC v2 fixture: bare Total row does not produce ROW_PARSE_FAILED", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-review-synthetic-v2.csv"));
      const file = new File([content], "hdfc-review-synthetic-v2.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const rowParseFailedErrors = result.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      expect(rowParseFailedErrors.length).toBe(0);
    });

    it("HDFC: transaction with narration starting 'TOTAL ...' is parsed as transaction, not footer", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBe(13);
    });

    it("HDFC XLSX: bare Total row followed by numeric serial dates parses correctly", async () => {
      const XLSX = await import("xlsx");

      const rows = [
        ["HDFC BANK"],
        ["Statement of Account"],
        ["Account No: SYNT00111222333"],
        [],
        ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
        ["Opening Balance", "", "", "", "", "", 50000],
        ["Total", "", "", "", 1500, 25000, ""],
        [new Date(Date.UTC(2026, 9, 15)), "NEFT-SYNTN001-SYNTHETIC CORP-PAYMENT", "SYNTN001", new Date(Date.UTC(2026, 9, 15)), "", 10000, 60000],
        [new Date(Date.UTC(2026, 9, 18)), "UPI-SYNTHETIC VENDOR-vendor@synt-SYNT0002", "SYNT0002", new Date(Date.UTC(2026, 9, 18)), 1500, "", 58500],
        [new Date(Date.UTC(2026, 9, 20)), "IMPS-SYNTN002-SYNTHETIC SENDER-ADVANCE", "SYNTN002", new Date(Date.UTC(2026, 9, 20)), "", 15000, 73500],
      ];

      const worksheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });

      const dateFormat = "DD/MM/YY";
      for (let r = 7; r <= 9; r++) {
        const cellA = XLSX.utils.encode_cell({ r, c: 0 });
        const cellD = XLSX.utils.encode_cell({ r, c: 3 });
        if (worksheet[cellA]) worksheet[cellA].z = dateFormat;
        if (worksheet[cellD]) worksheet[cellD].z = dateFormat;
      }

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Statement");

      const xlsxBuffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
      const file = new File([xlsxBuffer], "hdfc-total-serial-dates.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");

      const rowParseFailedErrors = result.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      expect(rowParseFailedErrors.length).toBe(0);

      expect(result.transactions.length).toBe(3);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      const debits = result.transactions.filter((t) => t.direction === "DR");

      expect(credits.length).toBe(2);
      expect(debits.length).toBe(1);

      const creditTotal = credits.reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(2500000);

      const debitTotal = debits.reduce((sum, t) => sum + t.amountPaise, 0);
      expect(debitTotal).toBe(150000);

      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[1].date).toBe("2026-10-18");
      expect(result.transactions[2].date).toBe("2026-10-20");
    });

    // TODO: parseIndianDate does not handle raw Excel serial numbers; needs app code change
    it.skip("HDFC XLSX: bare Total row followed by unformatted numeric serials parses correctly", async () => {
      const XLSX = await import("xlsx");

      // Excel serial = days since 1899-12-30 + 1 (for 1900 leap year bug)
      // Formula: Math.floor((Date.UTC(y,m-1,d) - Date.UTC(1899,11,30)) / 86400000) + 1
      const SERIAL_2026_10_15 = 46311;
      const SERIAL_2026_10_18 = 46314;
      const SERIAL_2026_10_20 = 46316;

      const rows: (string | number | null)[][] = [
        ["HDFC BANK"],
        ["Statement of Account"],
        ["Account No: SYNT00111222333"],
        [],
        ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
        ["Opening Balance", "", "", "", "", "", 50000],
        ["Total", "", "", "", 1500, 25000, ""],
        [null, "NEFT-SYNTN001-SYNTHETIC CORP-PAYMENT", "SYNTN001", null, "", 10000, 60000],
        [null, "UPI-SYNTHETIC VENDOR-vendor@synt-SYNT0002", "SYNT0002", null, 1500, "", 58500],
        [null, "IMPS-SYNTN002-SYNTHETIC SENDER-ADVANCE", "SYNTN002", null, "", 15000, 73500],
      ];

      const worksheet = XLSX.utils.aoa_to_sheet(rows);

      const serials = [SERIAL_2026_10_15, SERIAL_2026_10_18, SERIAL_2026_10_20];
      for (let i = 0; i < 3; i++) {
        const r = 7 + i;
        const cellA = XLSX.utils.encode_cell({ r, c: 0 });
        const cellD = XLSX.utils.encode_cell({ r, c: 3 });
        worksheet[cellA] = { t: "n", v: serials[i] };
        worksheet[cellD] = { t: "n", v: serials[i] };
      }

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Statement");

      const xlsxBuffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
      const file = new File([xlsxBuffer], "hdfc-total-raw-serials.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });

      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");

      const rowParseFailedErrors = result.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
      expect(rowParseFailedErrors.length).toBe(0);

      expect(result.transactions.length).toBe(3);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      const debits = result.transactions.filter((t) => t.direction === "DR");

      expect(credits.length).toBe(2);
      expect(debits.length).toBe(1);

      const creditTotal = credits.reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(2500000);

      const debitTotal = debits.reduce((sum, t) => sum + t.amountPaise, 0);
      expect(debitTotal).toBe(150000);

      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[1].date).toBe("2026-10-18");
      expect(result.transactions[2].date).toBe("2026-10-20");
    });
  });
});
