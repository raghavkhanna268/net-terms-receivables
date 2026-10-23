/**
 * Tests for narration parser.
 * Using synthetic test data - not real bank data.
 */

import { describe, it, expect } from "vitest";
import { parseNarration, extractUtrForDedupe } from "../narration-parser.js";

describe("narration-parser", () => {
  describe("parseNarration", () => {
    describe("UPI transactions", () => {
      it("extracts UPI with VPA and RRN - HDFC format", () => {
        const result = parseNarration(
          "UPI-SYNTHETIC VENDOR-fakevendor@synthetic-SYNT0000001-987654321098-UPI"
        );
        expect(result.rail).toBe("UPI");
        expect(result.upiId).toBe("fakevendor@synthetic");
        expect(result.utr).toBe("987654321098");
        expect(result.payerName).toBeDefined();
        expect(result.payerBank).toBe("SYNTHETIC");
      });

      it("extracts UPI - ICICI format", () => {
        const result = parseNarration("UPI/543210987654/fakeuser@synthetic/SYNTHETIC VENDOR LTD");
        expect(result.rail).toBe("UPI");
        expect(result.utr).toBe("543210987654");
        expect(result.upiId).toBe("fakeuser@synthetic");
      });

      it("extracts UPI CR format", () => {
        const result = parseNarration("UPI/CR/123456789012/sender@bank/SENDER NAME");
        expect(result.rail).toBe("UPI");
        expect(result.utr).toBe("123456789012");
        expect(result.upiId).toBe("sender@bank");
      });

      it("handles UPI with RRN and VPA", () => {
        const result = parseNarration("UPI/123456789012/user@bank/NAME");
        expect(result.rail).toBe("UPI");
        expect(result.utr).toBe("123456789012");
        expect(result.upiId).toBe("user@bank");
      });
    });

    describe("NEFT transactions", () => {
      it("extracts NEFT CR with company name - HDFC format", () => {
        const result = parseNarration("NEFT CR-SYNTHETIC CORP PVT LTD-SALARY OCT");
        expect(result.rail).toBe("NEFT");
        expect(result.payerName).toContain("SYNTHETIC");
        expect(result.payerName).toContain("SALARY");
      });

      it("extracts NEFT with UTR in IFSC-prefixed format (SYNTN26296...)", () => {
        const result = parseNarration("NEFT-SYNTN26296000001-SYNTHETIC SERVICES LTD-SYNT0000003");
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBe("SYNTN26296000001");
        expect(result.payerBank).toBe("SYNT0000003"); // IFSC takes precedence
      });

      it("extracts NEFT with real-shaped UTR (HDFCN...)", () => {
        const result = parseNarration("NEFT CR-COMPANY-HDFCN26296123456");
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBe("HDFCN26296123456");
        expect(result.payerBank).toBe("HDFC"); // From UTR prefix
      });

      it("extracts NEFT - ICICI format", () => {
        const result = parseNarration("NEFT/SYNTN26296000002/SYNTHETIC PAYROLL/SALARY OCT");
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBe("SYNTN26296000002");
      });

      it("does NOT extract invalid UTR format", () => {
        const result = parseNarration("NEFT CR-COMPANY-123456"); // Too short, no prefix
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBeUndefined();
      });
    });

    describe("RTGS transactions", () => {
      it("extracts RTGS CR with company name", () => {
        const result = parseNarration("RTGS CR-SYNTHETIC WHOLESALE LTD-INV OCT");
        expect(result.rail).toBe("RTGS");
        expect(result.payerName).toContain("SYNTHETIC");
        expect(result.payerName).toContain("WHOLESALE");
      });

      it("extracts RTGS with UTR in IFSC-prefixed format (SYNTR26296...)", () => {
        const result = parseNarration("RTGS-SYNTR26296000001-SYNTHETIC WHOLESALE-SYNT0000006");
        expect(result.rail).toBe("RTGS");
        expect(result.utr).toBe("SYNTR26296000001");
        expect(result.payerBank).toBe("SYNT0000006");
      });

      it("extracts RTGS with real-shaped UTR (HDFCR...)", () => {
        const result = parseNarration("RTGS CR-COMPANY-HDFCR26296123456");
        expect(result.rail).toBe("RTGS");
        expect(result.utr).toBe("HDFCR26296123456");
      });

      it("extracts RTGS - ICICI format", () => {
        const result = parseNarration("RTGS/SYNTR26296000002/SYNTHETIC WHOLESALE/INVOICE 12345");
        expect(result.rail).toBe("RTGS");
        expect(result.utr).toBe("SYNTR26296000002");
      });

      it("does NOT extract NEFT UTR for RTGS rail", () => {
        const result = parseNarration("RTGS CR-COMPANY-HDFCN26296123456"); // NEFT format
        expect(result.rail).toBe("RTGS");
        expect(result.utr).toBeUndefined(); // Should not match
      });
    });

    describe("IMPS transactions", () => {
      it("extracts IMPS with RRN and payer", () => {
        const result = parseNarration("IMPS-123456789012-SYNTHETIC SENDER-SYNT-Payment");
        expect(result.rail).toBe("IMPS");
        expect(result.utr).toBe("123456789012");
        expect(result.payerName).toBe("SYNTHETIC SENDER");
      });

      it("extracts IMPS - ICICI format", () => {
        const result = parseNarration("IMPS/432109876543/SYNTHETIC SENDER/Payment for services");
        expect(result.rail).toBe("IMPS");
        expect(result.utr).toBe("432109876543");
      });

      it("extracts IMPS P2A format", () => {
        const result = parseNarration("IMPS/P2A/234567890123/SENDER/REF");
        expect(result.rail).toBe("IMPS");
        expect(result.utr).toBe("234567890123");
      });
    });

    describe("ACH/NACH transactions", () => {
      it("extracts ACH debit with company - NO UTR", () => {
        const result = parseNarration("ACH D- TP ACH SYNTHETIC INSURANCE-654321");
        expect(result.rail).toBe("ACH");
        expect(result.payerName).toBe("SYNTHETIC INSURANCE");
        // ACH reference is NOT a UTR
        expect(result.utr).toBeUndefined();
      });

      it("detects NACH - NO UTR", () => {
        const result = parseNarration("NACH/ACH/SYNTHETIC LIFE INS/PREMIUM");
        expect(result.rail).toBe("ACH");
        expect(result.utr).toBeUndefined();
      });
    });

    describe("Cheque transactions", () => {
      it("does NOT extract cheque number as UTR", () => {
        const result = parseNarration("CHQ PAID-000123");
        expect(result.rail).toBe("CHEQUE");
        // Cheque number is NOT a UTR
        expect(result.utr).toBeUndefined();
      });

      it("detects CLG clearing - NO UTR", () => {
        const result = parseNarration("CLG CHQ DEP 000456");
        expect(result.rail).toBe("CHEQUE");
        expect(result.utr).toBeUndefined();
      });

      it("detects CHEQUE in text - NO UTR", () => {
        const result = parseNarration("CHEQUE DEPOSIT-SYNTHETIC COMPANY LTD");
        expect(result.rail).toBe("CHEQUE");
        expect(result.utr).toBeUndefined();
      });
    });

    describe("OTHER/unknown transactions", () => {
      it("returns OTHER for unrecognized format", () => {
        const result = parseNarration("CASH DEPOSIT AT BRANCH");
        expect(result.rail).toBe("OTHER");
      });

      it("returns OTHER for ATM withdrawal", () => {
        const result = parseNarration("ATM WDL/CASH/123456");
        expect(result.rail).toBe("OTHER");
      });
    });
  });

  describe("extractUtrForDedupe", () => {
    describe("NEFT", () => {
      it("returns refNo if it matches NEFT format", () => {
        expect(extractUtrForDedupe("some narration", "NEFT", "SYNTN26296000001")).toBe("SYNTN26296000001");
      });

      it("extracts UTR from narration if refNo is not valid", () => {
        expect(
          extractUtrForDedupe("NEFT CR-COMPANY-HDFCN26296123456", "NEFT", "REF123")
        ).toBe("HDFCN26296123456");
      });

      it("returns null for invalid NEFT UTR", () => {
        expect(extractUtrForDedupe("NEFT CR-COMPANY-123456", "NEFT", undefined)).toBeNull();
      });
    });

    describe("RTGS", () => {
      it("returns refNo if it matches RTGS format", () => {
        expect(extractUtrForDedupe("some narration", "RTGS", "SYNTR26296000001")).toBe("SYNTR26296000001");
      });

      it("extracts UTR from narration", () => {
        expect(
          extractUtrForDedupe("RTGS CR-COMPANY-HDFCR26296123456", "RTGS", undefined)
        ).toBe("HDFCR26296123456");
      });
    });

    describe("IMPS/UPI", () => {
      it("returns 12-digit RRN for IMPS", () => {
        expect(extractUtrForDedupe("IMPS/123456789012/SENDER", "IMPS", undefined)).toBe("123456789012");
      });

      it("returns 12-digit RRN for UPI", () => {
        expect(extractUtrForDedupe("UPI/987654321098/user@bank", "UPI", undefined)).toBe("987654321098");
      });

      it("returns refNo if it's 12 digits", () => {
        expect(extractUtrForDedupe("some narration", "UPI", "123456789012")).toBe("123456789012");
      });
    });

    describe("ACH/CHEQUE - no valid UTR", () => {
      it("returns null for ACH", () => {
        expect(extractUtrForDedupe("ACH D-INSURANCE-654321", "ACH", "654321")).toBeNull();
      });

      it("returns null for CHEQUE", () => {
        expect(extractUtrForDedupe("CHQ PAID-000123", "CHEQUE", "000123")).toBeNull();
      });

      it("returns null for OTHER", () => {
        expect(extractUtrForDedupe("CASH DEPOSIT", "OTHER", undefined)).toBeNull();
      });
    });
  });
});
