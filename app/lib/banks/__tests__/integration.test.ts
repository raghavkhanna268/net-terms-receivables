/**
 * Integration tests for bank statement parsing.
 * Using SYNTHETIC fixtures - not real bank data.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseBankStatement, parseAndFilterStatement } from "../index.js";
import type { ParseResult } from "../types.js";

const FIXTURES_DIR = join(process.cwd(), "tests/fixtures/banks/synthetic");

describe("bank statement parsing integration", () => {
  describe("HDFC retail format (synthetic)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects HDFC bank", () => {
      expect(result.detection.bank).toBe("HDFC");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses multiple transactions", () => {
      expect(result.transactions.length).toBeGreaterThan(5);
    });

    it("skips preamble and footer rows", () => {
      expect(result.skippedRows).toBeGreaterThan(0);
    });

    it("extracts NEFT transactions correctly", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      expect(neftTxns.length).toBeGreaterThan(0);

      const salary = neftTxns.find((t) => t.narration.includes("SALARY"));
      expect(salary).toBeDefined();
      expect(salary?.direction).toBe("CR");
      expect(salary?.amountPaise).toBe(8500000); // 85,000.00
    });

    it("extracts UPI transactions correctly", () => {
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");
      expect(upiTxns.length).toBeGreaterThan(0);

      const upi = upiTxns[0];
      expect(upi.parsed.upiId).toBeDefined();
      expect(upi.direction).toBe("DR"); // purchases are debits
    });

    it("extracts IMPS transactions correctly", () => {
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      expect(impsTxns.length).toBeGreaterThan(0);
    });

    it("extracts RTGS transactions correctly", () => {
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      expect(rtgsTxns.length).toBeGreaterThan(0);
    });

    it("extracts ACH transactions correctly", () => {
      const achTxns = result.transactions.filter((t) => t.parsed.rail === "ACH");
      expect(achTxns.length).toBeGreaterThan(0);
    });

    it("extracts cheque transactions correctly", () => {
      const chqTxns = result.transactions.filter((t) => t.parsed.rail === "CHEQUE");
      expect(chqTxns.length).toBeGreaterThan(0);
    });

    it("parses dates correctly", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(txn.date.startsWith("2026")).toBe(true);
      }
    });

    it("generates dedupe keys", () => {
      for (const txn of result.transactions) {
        expect(txn.dedupeKey).toBeDefined();
        expect(txn.dedupeKey.length).toBeGreaterThan(5);
      }
    });

    it("has unique dedupe keys", () => {
      const keys = result.transactions.map((t) => t.dedupeKey);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });
  });

  describe("ICICI retail format (synthetic)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-retail-synthetic.csv"));
      const file = new File([content], "icici-retail-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects ICICI bank", () => {
      expect(result.detection.bank).toBe("ICICI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses multiple transactions", () => {
      expect(result.transactions.length).toBeGreaterThan(5);
    });

    it("skips B/F (brought forward) row", () => {
      const bf = result.transactions.find((t) => t.narration.includes("B/F"));
      expect(bf).toBeUndefined();
    });

    it("extracts NEFT transactions correctly", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      expect(neftTxns.length).toBeGreaterThan(0);
    });

    it("extracts UPI transactions correctly", () => {
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("parses ICICI date format (DD.MM.YYYY)", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it("handles balance with Cr suffix", () => {
      const withBalance = result.transactions.filter((t) => t.balancePaise !== undefined);
      expect(withBalance.length).toBeGreaterThan(0);
    });
  });

  describe("HDFC XLSX format (synthetic)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.xlsx"));
      const file = new File([content], "hdfc-retail-synthetic.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      result = await parseBankStatement(file);
    });

    it("detects HDFC bank from XLSX", () => {
      expect(result.detection.bank).toBe("HDFC");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses multiple transactions from XLSX", () => {
      expect(result.transactions.length).toBeGreaterThan(5);
    });

    it("extracts all four rails from XLSX", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");

      expect(neftTxns.length).toBeGreaterThan(0);
      expect(rtgsTxns.length).toBeGreaterThan(0);
      expect(impsTxns.length).toBeGreaterThan(0);
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("parses dates correctly from XLSX", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(txn.date.startsWith("2026")).toBe(true);
      }
    });

    it("generates unique dedupe keys from XLSX", () => {
      const keys = result.transactions.map((t) => t.dedupeKey);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });
  });

  describe("ICICI XLSX format (synthetic)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "icici-retail-synthetic.xlsx"));
      const file = new File([content], "icici-retail-synthetic.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      result = await parseBankStatement(file);
    });

    it("detects ICICI bank from XLSX", () => {
      expect(result.detection.bank).toBe("ICICI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses multiple transactions from XLSX", () => {
      expect(result.transactions.length).toBeGreaterThan(5);
    });

    it("extracts all four rails from XLSX", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");

      expect(neftTxns.length).toBeGreaterThan(0);
      expect(rtgsTxns.length).toBeGreaterThan(0);
      expect(impsTxns.length).toBeGreaterThan(0);
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("parses dates correctly from XLSX", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it("skips B/F row from XLSX", () => {
      const bf = result.transactions.find((t) => t.narration.includes("B/F"));
      expect(bf).toBeUndefined();
    });
  });

  describe("SBI retail format (synthetic, UNVERIFIED LAYOUT)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-retail-synthetic.csv"));
      const file = new File([content], "sbi-retail-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects SBI bank", () => {
      expect(result.detection.bank).toBe("SBI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses exactly 14 transactions (matching fixture)", () => {
      expect(result.transactions.length).toBe(14);
    });

    it("credit total matches fixture footer (7,93,500.00 = 79350000 paise)", () => {
      const creditTotal = result.transactions
        .filter((t) => t.direction === "CR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(79350000);
    });

    it("debit total matches fixture footer (2,46,850.00 = 24685000 paise)", () => {
      const debitTotal = result.transactions
        .filter((t) => t.direction === "DR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(debitTotal).toBe(24685000);
    });

    it("skips preamble and footer rows", () => {
      expect(result.skippedRows).toBeGreaterThan(0);
    });

    it("extracts NEFT transactions correctly", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      expect(neftTxns.length).toBeGreaterThan(0);

      const salary = neftTxns.find((t) => t.narration.includes("SALARY"));
      expect(salary).toBeDefined();
      expect(salary?.direction).toBe("CR");
      expect(salary?.amountPaise).toBe(9000000); // 90,000.00
    });

    it("extracts UPI transactions correctly", () => {
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("extracts IMPS transactions correctly", () => {
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      expect(impsTxns.length).toBeGreaterThan(0);
    });

    it("extracts RTGS transactions correctly", () => {
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      expect(rtgsTxns.length).toBeGreaterThan(0);
    });

    it("extracts ACH D as debit (not credit)", () => {
      const achTxns = result.transactions.filter((t) => t.parsed.rail === "ACH");
      const achDebit = achTxns.find((t) => t.narration.includes("ACH D"));
      expect(achDebit).toBeDefined();
      expect(achDebit?.direction).toBe("DR");
      expect(achDebit?.amountPaise).toBe(1000000); // 10,000.00
    });

    it("parses dates correctly (DD/MM/YYYY format)", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(txn.date.startsWith("2026")).toBe(true);
      }
    });

    it("generates dedupe keys", () => {
      for (const txn of result.transactions) {
        expect(txn.dedupeKey).toBeDefined();
        expect(txn.dedupeKey.length).toBeGreaterThan(5);
      }
    });

    it("has unique dedupe keys", () => {
      const keys = result.transactions.map((t) => t.dedupeKey);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });
  });

  describe("SBI XLSX format (synthetic, UNVERIFIED LAYOUT)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "sbi-retail-synthetic.xlsx"));
      const file = new File([content], "sbi-retail-synthetic.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      result = await parseBankStatement(file);
    });

    it("detects SBI bank from XLSX", () => {
      expect(result.detection.bank).toBe("SBI");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses exactly 14 transactions from XLSX (matching fixture)", () => {
      expect(result.transactions.length).toBe(14);
    });

    it("XLSX credit total matches fixture footer (7,93,500.00 = 79350000 paise)", () => {
      const creditTotal = result.transactions
        .filter((t) => t.direction === "CR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(79350000);
    });

    it("XLSX debit total matches fixture footer (2,46,850.00 = 24685000 paise)", () => {
      const debitTotal = result.transactions
        .filter((t) => t.direction === "DR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(debitTotal).toBe(24685000);
    });

    it("extracts all four rails from XLSX", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");

      expect(neftTxns.length).toBeGreaterThan(0);
      expect(rtgsTxns.length).toBeGreaterThan(0);
      expect(impsTxns.length).toBeGreaterThan(0);
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("parses dates correctly from XLSX", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(txn.date.startsWith("2026")).toBe(true);
      }
    });
  });

  describe("Axis Bank retail format (synthetic, UNVERIFIED LAYOUT)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-retail-synthetic.csv"));
      const file = new File([content], "axis-retail-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects Axis bank", () => {
      expect(result.detection.bank).toBe("AXIS");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses exactly 14 transactions (matching fixture)", () => {
      expect(result.transactions.length).toBe(14);
    });

    it("credit total matches fixture footer (8,74,000.00 = 87400000 paise)", () => {
      const creditTotal = result.transactions
        .filter((t) => t.direction === "CR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(87400000);
    });

    it("debit total matches fixture footer (2,97,350.00 = 29735000 paise)", () => {
      const debitTotal = result.transactions
        .filter((t) => t.direction === "DR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(debitTotal).toBe(29735000);
    });

    it("skips preamble and footer rows", () => {
      expect(result.skippedRows).toBeGreaterThan(0);
    });

    it("extracts NEFT transactions correctly", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      expect(neftTxns.length).toBeGreaterThan(0);

      const salary = neftTxns.find((t) => t.narration.includes("SALARY"));
      expect(salary).toBeDefined();
      expect(salary?.direction).toBe("CR");
      expect(salary?.amountPaise).toBe(9500000); // 95,000.00
    });

    it("extracts UPI transactions correctly", () => {
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("extracts IMPS transactions correctly", () => {
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      expect(impsTxns.length).toBeGreaterThan(0);
    });

    it("extracts RTGS transactions correctly", () => {
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      expect(rtgsTxns.length).toBeGreaterThan(0);
    });

    it("parses dates correctly (DD-MM-YYYY format)", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(txn.date.startsWith("2026")).toBe(true);
      }
    });

    it("generates dedupe keys", () => {
      for (const txn of result.transactions) {
        expect(txn.dedupeKey).toBeDefined();
        expect(txn.dedupeKey.length).toBeGreaterThan(5);
      }
    });

    it("has unique dedupe keys", () => {
      const keys = result.transactions.map((t) => t.dedupeKey);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it("skips Opening Balance row", () => {
      const opening = result.transactions.find((t) => t.narration.includes("Opening Balance"));
      expect(opening).toBeUndefined();
    });
  });

  describe("Axis Bank XLSX format (synthetic, UNVERIFIED LAYOUT)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "axis-retail-synthetic.xlsx"));
      const file = new File([content], "axis-retail-synthetic.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      result = await parseBankStatement(file);
    });

    it("detects Axis bank from XLSX", () => {
      expect(result.detection.bank).toBe("AXIS");
      expect(result.detection.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("parses exactly 14 transactions from XLSX (matching fixture)", () => {
      expect(result.transactions.length).toBe(14);
    });

    it("XLSX credit total matches fixture footer (8,74,000.00 = 87400000 paise)", () => {
      const creditTotal = result.transactions
        .filter((t) => t.direction === "CR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(87400000);
    });

    it("XLSX debit total matches fixture footer (2,97,350.00 = 29735000 paise)", () => {
      const debitTotal = result.transactions
        .filter((t) => t.direction === "DR")
        .reduce((sum, t) => sum + t.amountPaise, 0);
      expect(debitTotal).toBe(29735000);
    });

    it("extracts all four rails from XLSX", () => {
      const neftTxns = result.transactions.filter((t) => t.parsed.rail === "NEFT");
      const rtgsTxns = result.transactions.filter((t) => t.parsed.rail === "RTGS");
      const impsTxns = result.transactions.filter((t) => t.parsed.rail === "IMPS");
      const upiTxns = result.transactions.filter((t) => t.parsed.rail === "UPI");

      expect(neftTxns.length).toBeGreaterThan(0);
      expect(rtgsTxns.length).toBeGreaterThan(0);
      expect(impsTxns.length).toBeGreaterThan(0);
      expect(upiTxns.length).toBeGreaterThan(0);
    });

    it("parses dates correctly from XLSX", () => {
      for (const txn of result.transactions) {
        expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(txn.date.startsWith("2026")).toBe(true);
      }
    });

    it("skips Opening Balance row from XLSX", () => {
      const opening = result.transactions.find((t) => t.narration.includes("Opening Balance"));
      expect(opening).toBeUndefined();
    });
  });

  describe("malformed data handling (synthetic)", () => {
    describe("HDFC malformed CSV", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "hdfc-malformed-synthetic.csv"));
        const file = new File([content], "hdfc-malformed-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("still detects as HDFC", () => {
        expect(result.detection.bank).toBe("HDFC");
      });

      it("parses valid rows", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips rows with invalid dates", () => {
        const invalidDate = result.transactions.find((t) => t.date === "INVALID");
        expect(invalidDate).toBeUndefined();
      });

      it("skips rows with missing required fields", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });

    describe("HDFC malformed XLSX", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "hdfc-malformed-synthetic.xlsx"));
        const file = new File([content], "hdfc-malformed-synthetic.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        result = await parseBankStatement(file);
      });

      it("still detects as HDFC from XLSX", () => {
        expect(result.detection.bank).toBe("HDFC");
      });

      it("parses valid rows from XLSX", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips malformed rows from XLSX", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });

    describe("ICICI malformed CSV", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "icici-malformed-synthetic.csv"));
        const file = new File([content], "icici-malformed-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("still detects as ICICI", () => {
        expect(result.detection.bank).toBe("ICICI");
      });

      it("parses valid rows", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("handles impossible dates gracefully", () => {
        const impossibleDate = result.transactions.find((t) => t.date.includes("45"));
        expect(impossibleDate).toBeUndefined();
      });
    });

    describe("ICICI malformed XLSX", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "icici-malformed-synthetic.xlsx"));
        const file = new File([content], "icici-malformed-synthetic.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        result = await parseBankStatement(file);
      });

      it("still detects as ICICI from XLSX", () => {
        expect(result.detection.bank).toBe("ICICI");
      });

      it("parses valid rows from XLSX", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips malformed rows from XLSX", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });

    describe("SBI malformed CSV (UNVERIFIED LAYOUT)", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "sbi-malformed-synthetic.csv"));
        const file = new File([content], "sbi-malformed-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("still detects as SBI", () => {
        expect(result.detection.bank).toBe("SBI");
      });

      it("parses valid rows", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips rows with invalid dates", () => {
        const invalidDate = result.transactions.find((t) => t.date === "INVALID");
        expect(invalidDate).toBeUndefined();
      });

      it("handles impossible dates gracefully", () => {
        const impossibleDate = result.transactions.find((t) => t.date.includes("45"));
        expect(impossibleDate).toBeUndefined();
      });

      it("skips rows with missing required fields", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });

    describe("SBI malformed XLSX (UNVERIFIED LAYOUT)", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "sbi-malformed-synthetic.xlsx"));
        const file = new File([content], "sbi-malformed-synthetic.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        result = await parseBankStatement(file);
      });

      it("still detects as SBI from XLSX", () => {
        expect(result.detection.bank).toBe("SBI");
      });

      it("parses valid rows from XLSX", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips malformed rows from XLSX", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });

    describe("Axis Bank malformed CSV (UNVERIFIED LAYOUT)", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "axis-malformed-synthetic.csv"));
        const file = new File([content], "axis-malformed-synthetic.csv", { type: "text/csv" });
        result = await parseBankStatement(file);
      });

      it("still detects as Axis", () => {
        expect(result.detection.bank).toBe("AXIS");
      });

      it("parses valid rows", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips rows with invalid dates", () => {
        const invalidDate = result.transactions.find((t) => t.date === "BAD-DATE");
        expect(invalidDate).toBeUndefined();
      });

      it("handles impossible dates gracefully", () => {
        const impossibleDate = result.transactions.find((t) => t.date.includes("40"));
        expect(impossibleDate).toBeUndefined();
      });

      it("skips rows with missing required fields", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });

    describe("Axis Bank malformed XLSX (UNVERIFIED LAYOUT)", () => {
      let result: ParseResult;

      beforeAll(async () => {
        const content = readFileSync(join(FIXTURES_DIR, "axis-malformed-synthetic.xlsx"));
        const file = new File([content], "axis-malformed-synthetic.xlsx", {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
        result = await parseBankStatement(file);
      });

      it("still detects as Axis from XLSX", () => {
        expect(result.detection.bank).toBe("AXIS");
      });

      it("parses valid rows from XLSX", () => {
        expect(result.transactions.length).toBeGreaterThan(0);
      });

      it("skips malformed rows from XLSX", () => {
        expect(result.transactions.length).toBeLessThan(result.totalRows);
      });
    });
  });

  describe("unknown bank format (synthetic)", () => {
    let result: ParseResult;

    beforeAll(async () => {
      const content = readFileSync(join(FIXTURES_DIR, "unknown-bank-synthetic.csv"));
      const file = new File([content], "unknown-bank-synthetic.csv", { type: "text/csv" });
      result = await parseBankStatement(file);
    });

    it("detects as UNKNOWN", () => {
      expect(result.detection.bank).toBe("UNKNOWN");
    });

    it("returns no transactions", () => {
      expect(result.transactions).toHaveLength(0);
    });

    it("returns an error", () => {
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].message).toContain("Unknown bank format");
    });
  });

  describe("deduplication", () => {
    it("filters against existing keys", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });

      // First parse to get keys
      const firstResult = await parseBankStatement(file);
      expect(firstResult.transactions.length).toBeGreaterThan(0);

      // Create a set with some existing keys
      const existingKeys = new Set(firstResult.transactions.slice(0, 3).map((t) => t.dedupeKey));

      // Parse again with existing keys
      const content2 = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const file2 = new File([content2], "hdfc-retail-synthetic.csv", { type: "text/csv" });
      const filteredResult = await parseAndFilterStatement(file2, existingKeys);

      // Should have fewer transactions
      expect(filteredResult.transactions.length).toBe(
        firstResult.transactions.length - existingKeys.size
      );
    });
  });

  describe("ArrayBuffer input", () => {
    it("parses from ArrayBuffer directly", async () => {
      const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
      const buffer = content.buffer.slice(
        content.byteOffset,
        content.byteOffset + content.byteLength
      );

      const result = await parseBankStatement(buffer, { fileName: "hdfc-retail-synthetic.csv" });

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions.length).toBeGreaterThan(0);
    });
  });
});

describe("transaction validation", () => {
  it("all transactions have required fields", async () => {
    const content = readFileSync(join(FIXTURES_DIR, "hdfc-retail-synthetic.csv"));
    const file = new File([content], "hdfc-retail-synthetic.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    for (const txn of result.transactions) {
      // Required fields
      expect(txn.date).toBeDefined();
      expect(txn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(txn.amountPaise).toBeGreaterThan(0);
      expect(["CR", "DR"]).toContain(txn.direction);
      expect(txn.narration).toBeDefined();
      expect(txn.narration.length).toBeGreaterThan(0);
      expect(txn.parsed).toBeDefined();
      expect(txn.parsed.rail).toBeDefined();
      expect(txn.dedupeKey).toBeDefined();
      expect(txn.sourceRow).toBeGreaterThan(0);
    }
  });
});

describe("HDFC parser dedupe-key stability", () => {
  it("preserves raw refNo with leading zeros and produces stable dedupe keys", async () => {
    // Synthetic HDFC CSV with zero-padded UPI ref and cheque ref
    const csv = `HDFC BANK
Account No: XXXXXX1234
Statement Period: 01/02/2020 to 29/02/2020

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
03/02/20,UPI-SYNTHETIC VENDOR-vendor@synth-SYNT0001234-600000000001-UPI,0000600000000001,03/02/20,,50000.00,150000.00
04/02/20,CHQ DEP-SYNTHETIC RETAILER-000654,000654,04/02/20,,75000.00,225000.00
`;
    const file = new File([csv], "hdfc-stability-test.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions.length).toBe(2);

    // UPI transaction with zero-padded ref
    const upiTxn = result.transactions.find((t) => t.parsed.rail === "UPI");
    expect(upiTxn).toBeDefined();
    expect(upiTxn!.refNo).toBe("0000600000000001");
    expect(upiTxn!.parsed.utr).toBe("600000000001");
    expect(upiTxn!.dedupeKey).toBe("utr:UPI:CR:600000000001");

    // Cheque transaction with leading-zero ref
    const chqTxn = result.transactions.find((t) => t.parsed.rail === "CHEQUE");
    expect(chqTxn).toBeDefined();
    expect(chqTxn!.refNo).toBe("000654");
    expect(chqTxn!.dedupeKey.startsWith("sha256:")).toBe(true);
    // Hardcoded hash computed from main's code
    expect(chqTxn!.dedupeKey).toBe(
      "sha256:33dd758200fdf7d8a542ac6d7fe7ec85b11156a485457b0b214be5bedc541fd6"
    );
  });
});

describe("ICICI parser real-layout handling", () => {
  it("parses Value-Date-first header, wrapped narration, Legends footer, and CMS credit", async () => {
    // Synthetic ICICI CSV matching real .xls layout:
    // - Blank col A (spacer)
    // - Value Date column (not Transaction Date)
    // - Wrapped narration continuation row
    // - Legends footer block (regression test for footer detection)
    // - CMS credit with stable dedupe key
    const csv = `,S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount(INR),Deposit Amount(INR),Balance(INR),
,1,03/02/2020,03/02/2020,,UPI/SYNT VENDOR/syntvendor@oksynt/Payment for invoice,0.00,50000.00,150000.00,
,2,04/02/2020,04/02/2020,,UPI/SYNT WHOLESALER/syntwholesaler/Order payment/SYNT BANK/600000000002/SYNT000001 with additional,0.00,25000.00,175000.00,
,,,,,remarks text that wraps to next row,,,,
,3,05/02/2020,05/02/2020,,CMS/ SYNT00123456/SYNT CORPORATE COLLECTIONS PVT LTD,0.00,100000.00,275000.00,
,4,06/02/2020,06/02/2020,,UPI/SYNT STORE/syntstore.payments@oksynt/Purchase/SYNT CO-OP BANK/600000000003/SYNT000002,10000.00,0.00,265000.00,
,Legends,,,,,,,
,1. SYNT - Synthetic test legend entry,,,,,,,
,2. TEST - Another synthetic legend,,,,,,,
`;
    const file = new File([csv], "icici-real-layout-test.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("ICICI");
    // Should have 4 transactions (Legends rows should be detected as footer)
    expect(result.transactions.length).toBe(4);

    // First UPI credit
    const upiTxn1 = result.transactions.find((t) => t.narration.includes("SYNT VENDOR"));
    expect(upiTxn1).toBeDefined();
    expect(upiTxn1!.parsed.rail).toBe("UPI");
    expect(upiTxn1!.parsed.upiId).toBe("syntvendor@oksynt");

    // Wrapped narration should be joined
    const wrappedTxn = result.transactions.find((t) => t.narration.includes("SYNT WHOLESALER"));
    expect(wrappedTxn).toBeDefined();
    expect(wrappedTxn!.narration).toContain("remarks text that wraps to next row");
    expect(wrappedTxn!.parsed.utr).toBe("600000000002");

    // CMS credit
    const cmsTxn = result.transactions.find((t) => t.parsed.rail === "CMS");
    expect(cmsTxn).toBeDefined();
    expect(cmsTxn!.narration).toContain("SYNT CORPORATE COLLECTIONS");
    // CMS has no UTR, uses sha256 dedupe key
    expect(cmsTxn!.dedupeKey.startsWith("sha256:")).toBe(true);
    // Pinned sha256 key for CMS transaction
    expect(cmsTxn!.dedupeKey).toBe(
      "sha256:63e01aad390bd12b03727274f7865584f4d303888b0fadd3382ca883f81a549b"
    );

    // Legends footer should NOT appear in any transaction's narration
    for (const txn of result.transactions) {
      expect(txn.narration).not.toContain("Legends");
      expect(txn.narration).not.toContain("Synthetic test legend");
    }

    // Debit transaction
    const debitTxn = result.transactions.find((t) => t.direction === "DR");
    expect(debitTxn).toBeDefined();
    expect(debitTxn!.parsed.rail).toBe("UPI");
    expect(debitTxn!.amountPaise).toBe(1000000); // 10000.00 INR
  });
});
