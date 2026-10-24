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

      expect(result.errors.length).toBe(5);
      expect(result.errors[0].row).toBe(19);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[1].row).toBe(20);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(28);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[3].row).toBe(29);
      expect(result.errors[3].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[4].row).toBe(30);
      expect(result.errors[4].code).toBe("ROW_PARSE_FAILED");
    });

    it("ICICI: reports coded errors for malformed rows, including BADDATE row", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(2);
      expect(result.errors[0].row).toBe(18);
      expect(result.errors[0].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[1].row).toBe(19);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");

      const malformedInTxns = result.transactions.find((t) =>
        t.narration.includes("impossible date")
      );
      expect(malformedInTxns).toBeUndefined();

      const badDateNoAmtInTxns = result.transactions.find((t) =>
        t.narration.includes("SYNTHETIC NO AMT ROW")
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

      expect(result.errors.length).toBe(6);
      expect(result.errors[0].row).toBe(19);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[1].row).toBe(20);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(28);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[3].row).toBe(29);
      expect(result.errors[3].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[4].row).toBe(30);
      expect(result.errors[4].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[5].row).toBe(31);
      expect(result.errors[5].code).toBe("ROW_PARSE_FAILED");
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

      expect(result.errors.length).toBe(6);
      expect(result.errors[0].row).toBe(19);
      expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[1].row).toBe(20);
      expect(result.errors[1].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[2].row).toBe(28);
      expect(result.errors[2].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[3].row).toBe(29);
      expect(result.errors[3].code).toBe("ROW_PARSE_FAILED");
      expect(result.errors[4].row).toBe(30);
      expect(result.errors[4].code).toBe("NORMALIZE_FAILED");
      expect(result.errors[5].row).toBe(31);
      expect(result.errors[5].code).toBe("ROW_PARSE_FAILED");
    });
  });

  describe("row accounting invariant", () => {
    it("HDFC: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(5);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([19, 20, 28, 30]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([29]);
    });

    it("SBI: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(6);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([19, 20, 28, 29, 31]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([30]);
    });

    it("Axis: transactions + errors + skippedRows === totalRows", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(result.totalRows);
      expect(result.transactions.length).toBe(13);
      expect(result.errors.length).toBe(6);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED").map((e) => e.row)).toEqual([19, 20, 28, 29, 31]);
      expect(result.errors.filter((e) => e.code === "NORMALIZE_FAILED").map((e) => e.row)).toEqual([30]);
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
});
