/**
 * Tests for date and amount normalisers.
 * Using synthetic test data - not real bank data.
 */

import { describe, it, expect } from "vitest";
import {
  parseIndianDate,
  parseIndianAmount,
  isBlankOrZero,
  formatPaiseToDisplay,
} from "../normalisers.js";

describe("normalisers", () => {
  describe("parseIndianDate", () => {
    describe("DD/MM/YY format (HDFC)", () => {
      it("parses 01/10/26 as 2026-10-01", () => {
        expect(parseIndianDate("01/10/26")).toBe("2026-10-01");
      });

      it("parses 15/03/26 as 2026-03-15", () => {
        expect(parseIndianDate("15/03/26")).toBe("2026-03-15");
      });

      it("parses single digit day/month 1/2/26 as 2026-02-01", () => {
        expect(parseIndianDate("1/2/26")).toBe("2026-02-01");
      });
    });

    describe("DD/MM/YYYY format (HDFC)", () => {
      it("parses 01/10/2026 as 2026-10-01", () => {
        expect(parseIndianDate("01/10/2026")).toBe("2026-10-01");
      });

      it("parses 31/12/2025 as 2025-12-31", () => {
        expect(parseIndianDate("31/12/2025")).toBe("2025-12-31");
      });
    });

    describe("DD.MM.YYYY format (ICICI retail)", () => {
      it("parses 01.10.2026 as 2026-10-01", () => {
        expect(parseIndianDate("01.10.2026")).toBe("2026-10-01");
      });

      it("parses 15.03.2026 as 2026-03-15", () => {
        expect(parseIndianDate("15.03.2026")).toBe("2026-03-15");
      });
    });

    describe("DD-MM-YYYY format (ICICI)", () => {
      it("parses 01-10-2026 as 2026-10-01", () => {
        expect(parseIndianDate("01-10-2026")).toBe("2026-10-01");
      });
    });

    describe("DD-MMM-YYYY format (ICICI corporate)", () => {
      it("parses 01-Oct-2026 as 2026-10-01", () => {
        expect(parseIndianDate("01-Oct-2026")).toBe("2026-10-01");
      });

      it("parses 15-Mar-2026 as 2026-03-15", () => {
        expect(parseIndianDate("15-Mar-2026")).toBe("2026-03-15");
      });

      it("handles lowercase month names", () => {
        expect(parseIndianDate("01-jan-2026")).toBe("2026-01-01");
      });

      it("handles uppercase month names", () => {
        expect(parseIndianDate("01-JAN-2026")).toBe("2026-01-01");
      });
    });

    describe("DD-MMM-YY format", () => {
      it("parses 01-Oct-26 as 2026-10-01", () => {
        expect(parseIndianDate("01-Oct-26")).toBe("2026-10-01");
      });
    });

    describe("timestamp format (HDFC)", () => {
      it("parses 13/07/2026 11:13:50", () => {
        expect(parseIndianDate("13/07/2026 11:13:50")).toBe("2026-07-13");
      });
    });

    describe("Date objects", () => {
      it("converts Date object to ISO string", () => {
        const date = new Date(2026, 9, 1); // October 1, 2026
        expect(parseIndianDate(date)).toBe("2026-10-01");
      });

      it("returns null for invalid Date", () => {
        expect(parseIndianDate(new Date("invalid"))).toBeNull();
      });
    });

    describe("invalid inputs", () => {
      it("returns null for empty string", () => {
        expect(parseIndianDate("")).toBeNull();
      });

      it("returns null for null", () => {
        expect(parseIndianDate(null)).toBeNull();
      });

      it("returns null for undefined", () => {
        expect(parseIndianDate(undefined)).toBeNull();
      });

      it("returns null for invalid date 32/13/26", () => {
        expect(parseIndianDate("32/13/26")).toBeNull();
      });

      it("returns null for text", () => {
        expect(parseIndianDate("INVALID")).toBeNull();
      });
    });
  });

  describe("parseIndianAmount", () => {
    describe("Indian digit grouping (lakhs/crores)", () => {
      it("parses 1,23,456.78 as 12345678 paise", () => {
        const result = parseIndianAmount("1,23,456.78");
        expect(result?.paise).toBe(12345678);
        expect(result?.isDebit).toBe(false);
      });

      it("parses 85,000.00 as 8500000 paise", () => {
        expect(parseIndianAmount("85,000.00")?.paise).toBe(8500000);
      });

      it("parses 1,00,000.00 as 10000000 paise", () => {
        expect(parseIndianAmount("1,00,000.00")?.paise).toBe(10000000);
      });

      it("parses 3,50,000.00 as 35000000 paise", () => {
        expect(parseIndianAmount("3,50,000.00")?.paise).toBe(35000000);
      });
    });

    describe("Western digit grouping", () => {
      it("parses 123,456.78 as 12345678 paise", () => {
        expect(parseIndianAmount("123,456.78")?.paise).toBe(12345678);
      });
    });

    describe("simple amounts", () => {
      it("parses 1234.56 as 123456 paise", () => {
        expect(parseIndianAmount("1234.56")?.paise).toBe(123456);
      });

      it("parses 1234 as 123400 paise", () => {
        expect(parseIndianAmount("1234")?.paise).toBe(123400);
      });

      it("parses .50 as 50 paise", () => {
        expect(parseIndianAmount(".50")?.paise).toBe(50);
      });
    });

    describe("Dr/Cr suffixes", () => {
      it("parses 1,234.56 Dr as debit", () => {
        const result = parseIndianAmount("1,234.56 Dr");
        expect(result?.paise).toBe(123456);
        expect(result?.isDebit).toBe(true);
      });

      it("parses 1,234.56 Cr as credit", () => {
        const result = parseIndianAmount("1,234.56 Cr");
        expect(result?.paise).toBe(123456);
        expect(result?.isDebit).toBe(false);
      });

      it("handles DR (uppercase)", () => {
        expect(parseIndianAmount("500.00 DR")?.isDebit).toBe(true);
      });

      it("handles CR (uppercase)", () => {
        expect(parseIndianAmount("500.00 CR")?.isDebit).toBe(false);
      });
    });

    describe("negative amounts", () => {
      it("parses -1,234.56 as debit", () => {
        const result = parseIndianAmount("-1,234.56");
        expect(result?.paise).toBe(123456);
        expect(result?.isDebit).toBe(true);
      });

      it("parses (1,234.56) as debit", () => {
        const result = parseIndianAmount("(1,234.56)");
        expect(result?.paise).toBe(123456);
        expect(result?.isDebit).toBe(true);
      });
    });

    describe("currency symbols", () => {
      it("strips ₹ symbol", () => {
        expect(parseIndianAmount("₹1,234.56")?.paise).toBe(123456);
      });

      it("strips Rs. prefix", () => {
        expect(parseIndianAmount("Rs. 1,234.56")?.paise).toBe(123456);
      });

      it("strips INR prefix", () => {
        expect(parseIndianAmount("INR 1,234.56")?.paise).toBe(123456);
      });
    });

    describe("blank/zero values", () => {
      it("returns 0 for empty string", () => {
        expect(parseIndianAmount("")?.paise).toBe(0);
      });

      it("returns 0 for null", () => {
        expect(parseIndianAmount(null)?.paise).toBe(0);
      });

      it("returns 0 for undefined", () => {
        expect(parseIndianAmount(undefined)?.paise).toBe(0);
      });

      it('returns 0 for "-"', () => {
        expect(parseIndianAmount("-")?.paise).toBe(0);
      });

      it('returns 0 for "NA"', () => {
        expect(parseIndianAmount("NA")?.paise).toBe(0);
      });

      it("returns 0 for 0.00", () => {
        expect(parseIndianAmount("0.00")?.paise).toBe(0);
      });
    });

    describe("number inputs", () => {
      it("handles number input", () => {
        expect(parseIndianAmount(1234.56)?.paise).toBe(123456);
      });

      it("handles negative number", () => {
        const result = parseIndianAmount(-1234.56);
        expect(result?.paise).toBe(123456);
        expect(result?.isDebit).toBe(true);
      });

      it("returns null for NaN", () => {
        expect(parseIndianAmount(NaN)).toBeNull();
      });
    });

    describe("invalid inputs", () => {
      it("returns null for non-numeric text", () => {
        expect(parseIndianAmount("INVALID")).toBeNull();
      });
    });
  });

  describe("isBlankOrZero", () => {
    it("returns true for null", () => {
      expect(isBlankOrZero(null)).toBe(true);
    });

    it("returns true for undefined", () => {
      expect(isBlankOrZero(undefined)).toBe(true);
    });

    it("returns true for empty string", () => {
      expect(isBlankOrZero("")).toBe(true);
    });

    it('returns true for "-"', () => {
      expect(isBlankOrZero("-")).toBe(true);
    });

    it('returns true for "NA"', () => {
      expect(isBlankOrZero("NA")).toBe(true);
    });

    it('returns true for "0.00"', () => {
      expect(isBlankOrZero("0.00")).toBe(true);
    });

    it("returns true for number 0", () => {
      expect(isBlankOrZero(0)).toBe(true);
    });

    it("returns false for non-zero amount", () => {
      expect(isBlankOrZero("1,234.56")).toBe(false);
    });
  });

  describe("formatPaiseToDisplay", () => {
    it("formats 12345678 paise as ₹1,23,456.78", () => {
      expect(formatPaiseToDisplay(12345678)).toBe("₹1,23,456.78");
    });

    it("formats 8500000 paise as ₹85,000.00", () => {
      expect(formatPaiseToDisplay(8500000)).toBe("₹85,000.00");
    });

    it("formats 100 paise as ₹1.00", () => {
      expect(formatPaiseToDisplay(100)).toBe("₹1.00");
    });

    it("formats 50 paise as ₹0.50", () => {
      expect(formatPaiseToDisplay(50)).toBe("₹0.50");
    });

    it("formats 10000000 paise as ₹1,00,000.00 (1 lakh)", () => {
      expect(formatPaiseToDisplay(10000000)).toBe("₹1,00,000.00");
    });

    it("formats 100000000 paise as ₹10,00,000.00 (10 lakh)", () => {
      expect(formatPaiseToDisplay(100000000)).toBe("₹10,00,000.00");
    });
  });
});
