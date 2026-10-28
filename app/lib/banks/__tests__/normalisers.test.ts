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
  normalizeIciciRef,
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
        // Use Date.UTC to create a UTC midnight date (matches Excel parsing behavior)
        const date = new Date(Date.UTC(2026, 9, 1)); // October 1, 2026 UTC
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

    describe("date validation (month lengths and leap years)", () => {
      it("rejects 31/02/26 (February has no 31st)", () => {
        expect(parseIndianDate("31/02/26")).toBeNull();
      });

      it("rejects 30/02/26 (February has no 30th)", () => {
        expect(parseIndianDate("30/02/26")).toBeNull();
      });

      it("rejects 29/02/26 (2026 is not a leap year)", () => {
        expect(parseIndianDate("29/02/26")).toBeNull();
      });

      it("accepts 29/02/24 (2024 is a leap year)", () => {
        expect(parseIndianDate("29/02/24")).toBe("2024-02-29");
      });

      it("rejects 31/04/26 (April has 30 days)", () => {
        expect(parseIndianDate("31/04/26")).toBeNull();
      });

      it("accepts 30/04/26 (April has 30 days)", () => {
        expect(parseIndianDate("30/04/26")).toBe("2026-04-30");
      });

      it("rejects 31/06/26 (June has 30 days)", () => {
        expect(parseIndianDate("31/06/26")).toBeNull();
      });

      it("accepts 31/01/26 (January has 31 days)", () => {
        expect(parseIndianDate("31/01/26")).toBe("2026-01-31");
      });

      it("accepts 31/03/26 (March has 31 days)", () => {
        expect(parseIndianDate("31/03/26")).toBe("2026-03-31");
      });

      it("rejects 31/09/26 (September has 30 days)", () => {
        expect(parseIndianDate("31/09/26")).toBeNull();
      });

      it("rejects 31/11/26 (November has 30 days)", () => {
        expect(parseIndianDate("31/11/26")).toBeNull();
      });

      it("accepts 29/02/2000 (2000 is a leap year - divisible by 400)", () => {
        expect(parseIndianDate("29/02/00")).toBe("2000-02-29");
      });
    });

    describe("numeric Excel serial dates", () => {
      it("converts serial 46310 to 2026-10-15", () => {
        expect(parseIndianDate(46310)).toBe("2026-10-15");
      });

      it("converts serial 46313 to 2026-10-18", () => {
        expect(parseIndianDate(46313)).toBe("2026-10-18");
      });

      it("converts serial 46315 to 2026-10-20", () => {
        expect(parseIndianDate(46315)).toBe("2026-10-20");
      });

      it("converts boundary serial 32874 to 1990-01-01", () => {
        expect(parseIndianDate(32874)).toBe("1990-01-01");
      });

      it("converts boundary serial 73415 to 2100-12-31", () => {
        expect(parseIndianDate(73415)).toBe("2100-12-31");
      });

      it("rejects serial below range (32873)", () => {
        expect(parseIndianDate(32873)).toBeNull();
      });

      it("rejects serial above range (73416)", () => {
        expect(parseIndianDate(73416)).toBeNull();
      });

      it("rejects out-of-range serial 0", () => {
        expect(parseIndianDate(0)).toBeNull();
      });

      it("rejects out-of-range serial 100", () => {
        expect(parseIndianDate(100)).toBeNull();
      });

      it("rejects out-of-range serial 2958466 (way above range)", () => {
        expect(parseIndianDate(2958466)).toBeNull();
      });

      it("rejects negative serial", () => {
        expect(parseIndianDate(-1)).toBeNull();
      });

      it("rejects NaN", () => {
        expect(parseIndianDate(NaN)).toBeNull();
      });

      it("drops fractional time part (46310.75 = 2026-10-15)", () => {
        expect(parseIndianDate(46310.75)).toBe("2026-10-15");
      });

      it("handles fractional serial at boundary (32874.5 = 1990-01-01)", () => {
        expect(parseIndianDate(32874.5)).toBe("1990-01-01");
      });
    });

    describe("numeric Excel serial timezone independence", () => {
      it("returns same date under TZ=UTC", () => {
        const result = parseIndianDate(46310);
        expect(result).toBe("2026-10-15");
      });

      it("returns same date regardless of local timezone (no shift)", () => {
        expect(parseIndianDate(46310)).toBe("2026-10-15");
        expect(parseIndianDate(46313)).toBe("2026-10-18");
        expect(parseIndianDate(46315)).toBe("2026-10-20");
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

  describe("normalizeIciciRef", () => {
    it("trims and preserves case (no uppercasing for hash stability)", () => {
      expect(normalizeIciciRef("synt000001")).toBe("synt000001");
      expect(normalizeIciciRef("SYNT000001")).toBe("SYNT000001");
    });

    it("preserves pure numeric cheque numbers", () => {
      expect(normalizeIciciRef("000456")).toBe("000456");
    });

    it("returns undefined for undefined input", () => {
      expect(normalizeIciciRef(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(normalizeIciciRef("")).toBeUndefined();
    });

    it("trims whitespace", () => {
      expect(normalizeIciciRef("  SYNT000001  ")).toBe("SYNT000001");
    });
  });
});
