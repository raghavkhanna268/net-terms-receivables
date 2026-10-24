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
