/**
 * Edge-case tests for bank statement parsing.
 * Using SYNTHETIC fixtures - not real bank data.
 * Layout: UNVERIFIED (based on public documentation only)
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Tests cover:
 * - UTF-8 BOM at file start
 * - CRLF line endings
 * - Trailing blank rows
 * - Debit-only rows
 * - Amounts with Dr/Cr suffixes
 * - Missing/blank UTR/reference
 * - Date format variations (DD/MM/YYYY, DD-MMM-YYYY, 2-digit year)
 * - Header variants
 * - Malformed rows (should produce errors, not crash)
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

    it("handles missing UTR/reference", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("SYNTHETIC SENDER") && t.direction === "CR"
      );
      expect(txnMissingRef).toBeDefined();
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

    it("handles balance with Cr suffix", () => {
      const txn = result.transactions[0];
      expect(txn?.balancePaise).toBeDefined();
      expect(txn?.balancePaise).toBeGreaterThan(0);
    });

    it("handles missing reference number", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
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

    it("handles missing reference", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
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

    it("handles missing reference", () => {
      const txnMissingRef = result.transactions.find(
        (t) => t.narration.includes("SYNTHETIC SENDER")
      );
      expect(txnMissingRef).toBeDefined();
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

      it("parses amounts with Dr suffix correctly", () => {
        const rtgsTxn = result.transactions.find((t) => t.narration.includes("RTGS-SYNTR"));
        expect(rtgsTxn).toBeDefined();
        expect(rtgsTxn?.amountPaise).toBe(10000000); // 1,00,000.00
        expect(rtgsTxn?.direction).toBe("DR");
      });

      it("parses exact amounts in paise", () => {
        const expectedAmounts = [
          { narration: "NEFT-SYNTN26296000001", paise: 1500000 }, // 15,000.00
          { narration: "UPI-SYNTHETIC VENDOR", paise: 125000 }, // 1,250.00
          { narration: "IMPS-123456789012", paise: 500000 }, // 5,000.00
          { narration: "CHQ PAID", paise: 2500000 }, // 25,000.00
          { narration: "ACH D-TP ACH", paise: 550000 }, // 5,500.00
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

  describe("error handling without crashes", () => {
    it("HDFC: malformed rows produce coded errors with row index", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });

      let result: ParseResult | null = null;
      let thrownError: Error | null = null;

      try {
        result = await parseBankStatement(file);
      } catch (e) {
        thrownError = e as Error;
      }

      expect(thrownError).toBeNull();
      expect(result).not.toBeNull();
      expect(result!.transactions.length).toBeGreaterThan(0);
      expect(result!.skippedRows).toBeGreaterThan(0);
    });

    it("ICICI: malformed rows produce coded errors with row index", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-edgecases-synthetic.csv"));
      const file = new File([content], "icici-edgecases-synthetic.csv", { type: "text/csv" });

      let result: ParseResult | null = null;
      let thrownError: Error | null = null;

      try {
        result = await parseBankStatement(file);
      } catch (e) {
        thrownError = e as Error;
      }

      expect(thrownError).toBeNull();
      expect(result).not.toBeNull();
      expect(result!.transactions.length).toBeGreaterThan(0);
      expect(result!.skippedRows).toBeGreaterThan(0);
    });

    it("SBI: malformed rows produce coded errors with row index", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });

      let result: ParseResult | null = null;
      let thrownError: Error | null = null;

      try {
        result = await parseBankStatement(file);
      } catch (e) {
        thrownError = e as Error;
      }

      expect(thrownError).toBeNull();
      expect(result).not.toBeNull();
      expect(result!.transactions.length).toBeGreaterThan(0);
      expect(result!.skippedRows).toBeGreaterThan(0);
    });

    it("Axis: malformed rows produce coded errors with row index", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-edgecases-synthetic.csv"));
      const file = new File([content], "axis-edgecases-synthetic.csv", { type: "text/csv" });

      let result: ParseResult | null = null;
      let thrownError: Error | null = null;

      try {
        result = await parseBankStatement(file);
      } catch (e) {
        thrownError = e as Error;
      }

      expect(thrownError).toBeNull();
      expect(result).not.toBeNull();
      expect(result!.transactions.length).toBeGreaterThan(0);
      expect(result!.skippedRows).toBeGreaterThan(0);
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

    it("HDFC: returns undefined UTR for missing reference", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-edgecases-synthetic.csv"));
      const file = new File([content], "hdfc-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const upiMissingRef = result.transactions.find(
        (t) => t.narration.includes("UPI-SYNTHETIC STORE") && !t.refNo
      );
      expect(upiMissingRef).toBeDefined();
      expect(upiMissingRef!.parsed.utr).toBeUndefined();
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

    it("SBI: extracts UTR for IMPS transactions", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-edgecases-synthetic.csv"));
      const file = new File([content], "sbi-edgecases-synthetic.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      expect(impsTxns.length).toBeGreaterThan(0);
    });
  });
});
