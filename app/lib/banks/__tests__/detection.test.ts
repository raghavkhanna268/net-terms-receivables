/**
 * Tests for bank detection.
 * Using synthetic test data - not real bank data.
 */

import { describe, it, expect } from "vitest";
import { detectBank, detectHeaderRow, detectFooterRows, isNarrationContinuation } from "../detection.js";
import type { SheetData } from "../types.js";

describe("detection", () => {
  describe("detectBank", () => {
    it("detects HDFC from header row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["HDFC BANK"],
          ["Statement of Account"],
          [],
          ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
          ["01/10/26", "NEFT CR-TEST", "REF001", "01/10/26", "", "50,000.00", "1,50,000.00"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("HDFC");
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects HDFC from filename", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
        ],
      };

      const result = detectBank(sheet, "HDFC_Statement_Oct2026.xls");
      expect(result.bank).toBe("HDFC");
    });

    it("detects HDFC from preamble text", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["HDFC BANK LIMITED"],
          ["www.hdfcbank.com"],
          [],
          ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("HDFC");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects ICICI from header row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["ICICI BANK"],
          ["Statement of Transactions"],
          [],
          ["S No.", "Transaction Date", "Cheque Number", "Remarks", "Withdrawal", "Deposit", "Balance"],
          ["1", "01.10.2026", "", "NEFT", "", "50,000.00", "1,50,000.00 Cr"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("ICICI");
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects ICICI from filename", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["S No.", "Transaction Date", "Cheque Number", "Remarks", "Withdrawal", "Deposit", "Balance"],
        ],
      };

      const result = detectBank(sheet, "ICICI_e-statement_2026.csv");
      expect(result.bank).toBe("ICICI");
    });

    it("detects ICICI corporate format", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["ICICI BANK LTD"],
          [],
          ["Tran ID", "Value Date", "Transaction Date", "Cheque/RefNo", "Withdrawal (Dr)", "Deposit (Cr)"],
          ["TXN001", "01-Oct-2026", "01-Oct-2026", "", "", "50,000.00"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("ICICI");
    });

    it("returns UNKNOWN for unrecognized format", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["RANDOM BANK"],
          ["Account Statement"],
          ["Transaction ID", "Date", "Description", "Amount", "Type", "Balance"],
          ["TXN001", "2026-10-01", "Opening", "0.00", "CR", "100000.00"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("UNKNOWN");
    });

    it("returns UNKNOWN for empty sheet", () => {
      const sheet: SheetData = { name: "Sheet1", rows: [] };
      const result = detectBank(sheet);
      expect(result.bank).toBe("UNKNOWN");
      expect(result.confidence).toBe(0);
    });
  });

  describe("detectHeaderRow", () => {
    it("finds HDFC header row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["HDFC BANK"],
          [],
          ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
          ["01/10/26", "TEST", "REF", "01/10/26", "", "100.00", "100.00"],
        ],
      };

      const result = detectHeaderRow(sheet);
      expect(result).not.toBeNull();
      expect(result?.bank).toBe("HDFC");
      expect(result?.row).toBe(2);
    });

    it("finds ICICI header row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["ICICI BANK"],
          [],
          ["S No.", "Transaction Date", "Cheque Number", "Remarks", "Withdrawal", "Deposit", "Balance"],
          ["1", "01.10.2026", "", "TEST", "", "100.00", "100.00 Cr"],
        ],
      };

      const result = detectHeaderRow(sheet);
      expect(result).not.toBeNull();
      expect(result?.bank).toBe("ICICI");
      expect(result?.row).toBe(2);
    });

    it("returns null if no header found", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Random data"],
          ["More random data"],
        ],
      };

      const result = detectHeaderRow(sheet);
      expect(result).toBeNull();
    });
  });

  describe("detectFooterRows", () => {
    it("detects Opening Balance row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["Opening Balance", "", "", "", "", "", "100000"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(1)).toBe(true);
    });

    it("detects Closing Balance row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
          ["Closing Balance", "", "", "", "", "", "101000"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true);
    });

    it("detects Total rows", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
          ["Total Deposits", "", "", "", "", "1000", ""],
          ["Total Withdrawals", "", "", "", "0", "", ""],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true);
      expect(footers.has(3)).toBe(true);
    });

    it("detects disclaimer rows", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
          ["*** Disclaimer: This is a computer generated statement"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true);
    });
  });

  describe("isNarrationContinuation", () => {
    it("returns true for row with only text, no date", () => {
      const row = [null, "Continuation of narration text", null, null, null, null, null];
      expect(isNarrationContinuation(row)).toBe(true);
    });

    it("returns false for row with date", () => {
      const row = ["01/10/26", "Normal transaction", "REF", "01/10/26", "", "1000", "101000"];
      expect(isNarrationContinuation(row)).toBe(false);
    });

    it("returns false for row with amounts", () => {
      const row = [null, "Text", null, null, "1000.00", null, "101000.00"];
      expect(isNarrationContinuation(row)).toBe(false);
    });

    it("returns false for empty row", () => {
      const row: (string | null)[] = [];
      expect(isNarrationContinuation(row)).toBe(false);
    });
  });
});
