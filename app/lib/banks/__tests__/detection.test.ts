/**
 * Tests for bank detection.
 * Using synthetic test data - not real bank data.
 */

import { describe, it, expect } from "vitest";
import { detectBank, detectHeaderRow, detectFooterRows, isNarrationContinuation, isNarrationContinuationWithDateCol } from "../detection.js";
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

    it("detects SBI from header row (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["STATE BANK OF INDIA"],
          ["Account Statement"],
          [],
          ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
          ["01/10/2026", "01/10/2026", "NEFT CR-TEST", "REF001", "", "50,000.00", "1,50,000.00"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("SBI");
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects SBI from filename (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
        ],
      };

      const result = detectBank(sheet, "SBI_Statement_Oct2026.xls");
      expect(result.bank).toBe("SBI");
    });

    it("detects SBI from preamble text (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["STATE BANK OF INDIA"],
          ["www.onlinesbi.com"],
          [],
          ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("SBI");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("detects Axis Bank from header row (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["AXIS BANK"],
          ["Statement of Account"],
          [],
          ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
          ["01-10-2026", "", "NEFT CR-TEST", "", "50,000.00", "1,50,000.00"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("AXIS");
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("detects Axis Bank from filename (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
        ],
      };

      const result = detectBank(sheet, "AXIS_Statement_2026.csv");
      expect(result.bank).toBe("AXIS");
    });

    it("detects Axis Bank from preamble text (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["AXIS BANK LIMITED"],
          ["www.axisbank.com"],
          [],
          ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("AXIS");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("does not confuse SBI with HDFC", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["STATE BANK OF INDIA"],
          ["Account Statement"],
          [],
          ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("SBI");
      expect(result.bank).not.toBe("HDFC");
    });

    it("does not confuse Axis with ICICI", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["AXIS BANK LIMITED"],
          ["Statement of Account"],
          [],
          ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("AXIS");
      expect(result.bank).not.toBe("ICICI");
    });

    it("Axis detection returns non-empty reason string", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["AXIS BANK LIMITED"],
          [],
          ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("AXIS");
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe("header detection regression tests", () => {
    it("ICICI detailed headers detect as ICICI not AXIS (regression for DR/CR matching)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["ICICI BANK"],
          [],
          ["Date", "Particulars", "Chq. No.", "Withdrawals", "Deposits", "Balance"],
          ["01.10.2026", "NEFT", "", "1000", "", "99000"],
        ],
      };

      const result = detectBank(sheet);
      expect(result.bank).toBe("ICICI");
      expect(result.bank).not.toBe("AXIS");
    });

    it("all HDFC header variants detect as HDFC via detectBank", () => {
      const hdfcVariants = [
        // HDFC_HEADERS (primary retail format)
        ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"],
        // HDFC_HEADERS_ALT (alternate spacing)
        ["Date", "Narration", "Chq./Ref. No.", "Value Dt"],
        // HDFC_ENET_HEADERS (e-net banking format)
        ["Date", "Transaction Description", "Chq/Ref. No", "Value Date", "Debit Amount", "Credit Amount", "Closing Balance"],
      ];

      for (const headers of hdfcVariants) {
        const sheet: SheetData = {
          name: "Sheet1",
          rows: [headers, ["01/10/26", "TEST", "REF001", "01/10/26", "", "1000", "1000"]],
        };
        const result = detectBank(sheet);
        expect(result.bank).toBe("HDFC");
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("all ICICI header variants detect as ICICI via detectBank", () => {
      const iciciVariants = [
        // ICICI_HEADERS (primary retail format)
        ["S No.", "Transaction Date", "Cheque Number", "Remarks", "Withdrawal", "Deposit", "Balance"],
        // ICICI_HEADERS_ALT (alternate format)
        ["S No.", "Transaction Date", "Cheque/Reference No.", "Remarks"],
        // ICICI_CORPORATE_HEADERS (corporate banking format)
        ["Tran ID", "Value Date", "Transaction Date", "Cheque/RefNo", "Withdrawal (Dr)", "Deposit (Cr)"],
        // ICICI_DETAILED_HEADERS (detailed format - regression test for DR/CR matching)
        ["Date", "Particulars", "Chq. No.", "Withdrawals", "Deposits", "Balance"],
      ];

      for (const headers of iciciVariants) {
        const sheet: SheetData = {
          name: "Sheet1",
          rows: [headers, ["1", "01.10.2026", "", "TEST", "", "1000", "1000"]],
        };
        const result = detectBank(sheet);
        expect(result.bank).toBe("ICICI");
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("SBI primary header variant detects as SBI via detectBank (UNVERIFIED)", () => {
      // SBI_HEADERS (primary format - only variant to avoid ICICI collision)
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
          ["01/10/2026", "01/10/2026", "TEST", "REF001", "", "1000", "1000"],
        ],
      };
      const result = detectBank(sheet);
      expect(result.bank).toBe("SBI");
      expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    });

    it("all Axis header variants detect as AXIS via detectBank (UNVERIFIED)", () => {
      const axisVariants = [
        // AXIS_HEADERS (primary retail format with DR/CR columns)
        ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
        // AXIS_HEADERS_ALT (alternate format with Debit/Credit)
        ["Transaction Date", "Value Date", "Particulars", "Chq./Ref.No.", "Debit", "Credit", "Balance"],
        // AXIS_HEADERS_CORPORATE (corporate format with Value Date)
        ["Tran Date", "Value Date", "Particulars", "Chq No", "Debit", "Credit", "Balance"],
      ];

      for (const headers of axisVariants) {
        const sheet: SheetData = {
          name: "Sheet1",
          rows: [headers, ["01-10-2026", "", "TEST", "100", "", "1000"]],
        };
        const result = detectBank(sheet);
        expect(result.bank).toBe("AXIS");
        expect(result.confidence).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("DR/CR only match as whole words not substrings", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Date", "Particulars", "Chq. No.", "Withdrawals", "Deposits", "Balance"],
          ["01.10.2026", "TEST", "", "1000", "", "99000"],
        ],
      };
      
      const result = detectBank(sheet);
      expect(result.bank).toBe("ICICI");
      expect(result.bank).not.toBe("AXIS");
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

    it("finds ICICI real .xls Value-Date-first header", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["ICICI BANK"],
          [],
          // Blank A, headers B-I, blank J
          ["", "S No.", "Value Date", "Transaction Date", "Cheque Number", "Transaction Remarks", "Withdrawal Amount(INR)", "Deposit Amount(INR)", "Balance(INR)", ""],
          ["", "1", "15/10/2030", "15/10/2030", "", "UPI/SYNT VENDOR/vendor@ok/Remark/SYNT BANK/600000000001/SYNT001", "0.00", "1000.00", "1000.00", ""],
        ],
      };

      const result = detectHeaderRow(sheet);
      expect(result).not.toBeNull();
      expect(result?.bank).toBe("ICICI");
      expect(result?.row).toBe(2);
    });

    it("finds SBI header row (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["STATE BANK OF INDIA"],
          [],
          ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"],
          ["01/10/2026", "01/10/2026", "TEST", "REF", "", "100.00", "100.00"],
        ],
      };

      const result = detectHeaderRow(sheet);
      expect(result).not.toBeNull();
      expect(result?.bank).toBe("SBI");
      expect(result?.row).toBe(2);
    });

    it("finds Axis Bank header row (UNVERIFIED)", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["AXIS BANK"],
          [],
          ["Tran Date", "Chq No", "Particulars", "DR", "CR", "Balance"],
          ["01-10-2026", "", "TEST", "100.00", "", "100.00"],
        ],
      };

      const result = detectHeaderRow(sheet);
      expect(result).not.toBeNull();
      expect(result?.bank).toBe("AXIS");
      expect(result?.row).toBe(2);
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

    it("detects ICICI Legends footer block", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["", "1", "15/10/2030", "15/10/2030", "", "UPI/SYNT/test@ok/SYNT BANK/600000000001/SYNT001", "0.00", "1000.00", "1000.00", ""],
          ["", "Legends - Transaction Remarks Abbreviations"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true);
    });

    it("detects HDFC asterisk separator rows", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
          ["********", "**********************************", "************", "********", "******************", "******************", "******************"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true);
    });

    it("detects HDFC end of statement marker", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
          ["---  End Of Statement ---"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true);
    });

    it("detects HDFC label-less summary values row after label row", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "Transaction", "REF", "01/10/26", "", "1000", "101000"],
          ["Opening Balance", "", "", "", "Debits", "Credits", "Closing Bal"],
          ["100000", "", "", "", "50000", "75000", "125000"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(true); // Label row
      expect(footers.has(3)).toBe(true); // Values row (all numeric, after label)
    });

    it("does not mark narration continuation as footer trigger", () => {
      const sheet: SheetData = {
        name: "Sheet1",
        rows: [
          ["Header"],
          ["01/10/26", "UPI-SYNT VENDOR-test@ok-SYNT0001", "REF", "01/10/26", "", "1000", "101000"],
          ["", "CONTINUATION TEXT HERE", "", "", "", "", ""],
          ["02/10/26", "NEFT-SYNT CORP-SALARY", "REF2", "02/10/26", "", "5000", "96000"],
        ],
      };

      const footers = detectFooterRows(sheet, 1);
      expect(footers.has(2)).toBe(false); // Continuation row should NOT be marked as footer
      expect(footers.has(3)).toBe(false); // Next transaction should NOT be marked
    });
  });

  describe("isNarrationContinuation", () => {
    it("returns true for row with only text, no date", () => {
      const row = [null, "Continuation of narration text", null, null, null, null, null];
      expect(isNarrationContinuation(row)).toBe(true);
    });

    it("returns true for row with empty first cell and narration only", () => {
      const row = ["", "SYNTHETIC CONTINUATION TEXT", null, null, null, null, null];
      expect(isNarrationContinuation(row)).toBe(true);
    });

    it("returns false for row with date", () => {
      const row = ["01/10/26", "Normal transaction", "REF", "01/10/26", "", "1000", "101000"];
      expect(isNarrationContinuation(row)).toBe(false);
    });

    it("returns false for row with non-date text in first cell", () => {
      const row = ["BADDATE", "SYNTHETIC NO AMT ROW", null, null, null, null, null];
      expect(isNarrationContinuation(row)).toBe(false);
    });

    it("returns false for row with text in first cell even with 2 cells", () => {
      const row = ["PENDING", "SYNTHETIC HELD TXN"];
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

    it("returns false for fully blank row (all empty strings)", () => {
      const row = ["", "", "", "", "", "", ""];
      expect(isNarrationContinuation(row)).toBe(false);
    });

    it("returns false for fully blank row (all nulls)", () => {
      const row = [null, null, null, null, null, null, null];
      expect(isNarrationContinuation(row)).toBe(false);
    });

    it("returns false for fully blank row (whitespace only)", () => {
      const row = ["  ", "", "   ", null, "", "", ""];
      expect(isNarrationContinuation(row)).toBe(false);
    });
  });

  describe("isNarrationContinuationWithDateCol", () => {
    it("returns true when date column is empty", () => {
      // ICICI format: S No., Transaction Date, Cheque Number, Remarks, ...
      // dateCol = 1
      const row = ["", "", "", "SYNTHETIC CONTINUATION LINE", "", "", ""];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(true);
    });

    it("returns false when date column has text (BADDATE case)", () => {
      // ICICI format: dateCol = 1
      const row = ["", "BADDATE", "", "TEXT", "", "", ""];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(false);
    });

    it("returns false when date column has valid date", () => {
      const row = ["1", "01.10.2026", "", "Normal transaction", "", "1000", ""];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(false);
    });

    it("returns true for ICICI-style continuation with empty S No. and empty date", () => {
      // Row with empty S No. (col 0) and empty date (col 1), just narration
      const row = [null, null, null, "Continuation text", null, null, null];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(true);
    });

    it("returns false for fully blank row (all empty strings)", () => {
      const row = ["", "", "", "", "", "", ""];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(false);
    });

    it("returns false for fully blank row (all nulls)", () => {
      const row = [null, null, null, null, null, null, null];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(false);
    });

    it("returns false for empty row array", () => {
      const row: (string | null)[] = [];
      expect(isNarrationContinuationWithDateCol(row, 1)).toBe(false);
    });
  });
});
