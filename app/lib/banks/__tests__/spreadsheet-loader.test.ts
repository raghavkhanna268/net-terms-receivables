/**
 * Tests for spreadsheet-loader.
 * Verifies that CSV/TXT values are preserved verbatim without type coercion.
 */

import { describe, it, expect } from "vitest";
import { loadSpreadsheet, detectFileType } from "../spreadsheet-loader.js";

describe("spreadsheet-loader", () => {
  describe("detectFileType", () => {
    it("detects xlsx by extension", () => {
      expect(detectFileType("statement.xlsx")).toBe("xlsx");
      expect(detectFileType("statement.XLSX")).toBe("xlsx");
    });

    it("detects xls by extension", () => {
      expect(detectFileType("statement.xls")).toBe("xls");
    });

    it("detects csv by extension", () => {
      expect(detectFileType("statement.csv")).toBe("csv");
    });

    it("detects txt by extension", () => {
      expect(detectFileType("statement.txt")).toBe("txt");
    });

    it("defaults to csv for unknown extension", () => {
      expect(detectFileType("statement.dat")).toBe("csv");
      expect(detectFileType("statement")).toBe("csv");
    });
  });

  describe("loadSpreadsheet CSV preservation", () => {
    it("preserves leading-zero cheque number (000123)", async () => {
      const csv = "Date,Ref,Narration,Amount\n05/03/2026,000123,CHQ PAID,1000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][1]).toBe("000123");
    });

    it("preserves 12-digit RRN without scientific notation", async () => {
      const csv = "Date,Ref,Narration,Amount\n05/03/2026,123456789012,UPI PAYMENT,500.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][1]).toBe("123456789012");
    });

    it("preserves 18+ digit numeric ref without scientific notation", async () => {
      const csv = "Date,Ref,Narration,Amount\n05/03/2026,123456789012345678,NEFT PAYMENT,5000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][1]).toBe("123456789012345678");
    });

    it("preserves DD/MM/YYYY date format verbatim", async () => {
      const csv = "Date,Ref,Narration,Amount\n05/03/2026,REF001,PAYMENT,1000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][0]).toBe("05/03/2026");
    });

    it("preserves DD.MM.YYYY date format verbatim", async () => {
      const csv = "Date,Ref,Narration,Amount\n05.03.2026,REF001,PAYMENT,1000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][0]).toBe("05.03.2026");
    });

    it("preserves DD-MMM-YYYY date format verbatim", async () => {
      const csv = "Date,Ref,Narration,Amount\n05-Mar-2026,REF001,PAYMENT,1000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][0]).toBe("05-Mar-2026");
    });

    it("preserves NEFT UTR with bank code", async () => {
      const csv = "Date,Ref,Narration,Amount\n05/03/2026,HDFCN26296123456,NEFT CR,50000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][1]).toBe("HDFCN26296123456");
    });

    it("handles quoted fields with commas", async () => {
      const csv = 'Date,Ref,Narration,Amount\n05/03/2026,REF001,"ACME CORP, INC",1000.00';
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      expect(result.rows[1][2]).toBe("ACME CORP, INC");
    });

    it("handles empty cells as null", async () => {
      const csv = "Date,Ref,Narration,Amount\n05/03/2026,,PAYMENT,1000.00";
      const content = new TextEncoder().encode(csv).buffer;

      const result = await loadSpreadsheet(content, "csv");
      // Empty cells are returned as null (defval: null)
      expect(result.rows[1][1]).toBeNull();
    });
  });

  describe("loadSpreadsheet TXT preservation", () => {
    it("preserves leading zeros in TXT files", async () => {
      const txt = "Date\tRef\tNarration\tAmount\n05/03/2026\t000123\tCHQ PAID\t1000.00";
      const content = new TextEncoder().encode(txt).buffer;

      const result = await loadSpreadsheet(content, "txt");
      expect(result.rows[1][1]).toBe("000123");
    });

    it("preserves 12-digit RRN in TXT files", async () => {
      const txt = "Date\tRef\tNarration\tAmount\n05/03/2026\t123456789012\tUPI\t500.00";
      const content = new TextEncoder().encode(txt).buffer;

      const result = await loadSpreadsheet(content, "txt");
      expect(result.rows[1][1]).toBe("123456789012");
    });
  });
});
