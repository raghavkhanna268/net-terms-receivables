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
        // IFSC takes precedence over VPA handle for payer bank
        expect(result.payerBank).toBe("SYNT0000001");
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

      it("extracts payer name from cheque narration", () => {
        const result = parseNarration("CHQ DEP-SYNTHETIC VENDOR LTD-000123");
        expect(result.rail).toBe("CHEQUE");
        expect(result.payerName).toBe("SYNTHETIC VENDOR");
      });

      it("extracts payer name - CLG format", () => {
        const result = parseNarration("CLG-000456-SYNTHETIC PAYEE CORP");
        expect(result.rail).toBe("CHEQUE");
        // "CORP" is cleaned by cleanPayerName (common suffix removal)
        expect(result.payerName).toBe("SYNTHETIC PAYEE");
      });

      it("does NOT capture junk as payer name - pure numbers", () => {
        const result = parseNarration("CHQ PAID-000123-456789");
        expect(result.rail).toBe("CHEQUE");
        expect(result.payerName).toBeUndefined();
      });

      it("does NOT capture keywords as payer name", () => {
        const result = parseNarration("CHQ DEP PAID");
        expect(result.rail).toBe("CHEQUE");
        expect(result.payerName).toBeUndefined();
      });

      it("does NOT capture short tokens as payer name", () => {
        const result = parseNarration("CHQ-AB-CD-123456");
        expect(result.rail).toBe("CHEQUE");
        expect(result.payerName).toBeUndefined();
      });

      it("handles HDFC cheque format from synthetic fixture", () => {
        const result = parseNarration("CHQ DEP-SYNTHETIC RETAILER-000654");
        expect(result.rail).toBe("CHEQUE");
        expect(result.payerName).toBe("SYNTHETIC RETAILER");
      });

      it("handles ICICI cheque format from synthetic fixture", () => {
        const result = parseNarration("CLG/CHQ/SYNTHETIC VENDOR PVT LTD/CHEQUE DEPOSIT");
        expect(result.rail).toBe("CHEQUE");
        expect(result.payerName).toBe("SYNTHETIC VENDOR");
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

    describe("CMS (Cash Management Service) transactions", () => {
      it("detects CMS rail from narration starting with CMS/", () => {
        const result = parseNarration("CMS/ SYNT123 45/SYNT TEST TRADERS");
        expect(result.rail).toBe("CMS");
      });

      it("detects CMS rail from narration starting with CMS space", () => {
        const result = parseNarration("CMS REF00001/SYNT DEMO CORP");
        expect(result.rail).toBe("CMS");
      });

      it("does NOT extract ref as UTR from CMS narration (CMS refs are not UTRs)", () => {
        const result = parseNarration("CMS/ SYNT123 45/SYNT TEST TRADERS");
        expect(result.rail).toBe("CMS");
        // CMS refs are internal refs, NOT UTRs - utr should be undefined
        expect(result.utr).toBeUndefined();
      });

      it("extracts payer name from CMS narration", () => {
        const result = parseNarration("CMS/ SYNT123 45/SYNT TEST TRADERS");
        expect(result.rail).toBe("CMS");
        expect(result.payerName).toBe("SYNT TEST TRADERS");
      });

      it("handles CMS with only ref segment (no UTR, but may extract name)", () => {
        const result = parseNarration("CMS/ REF00001");
        expect(result.rail).toBe("CMS");
        // CMS refs are NOT UTRs
        expect(result.utr).toBeUndefined();
      });

      it("handles CMS corporate collection format", () => {
        const result = parseNarration("CMS/ SYNTCORP 99/SYNT WHOLESALE PVT LTD");
        expect(result.rail).toBe("CMS");
        // CMS refs are NOT UTRs
        expect(result.utr).toBeUndefined();
        expect(result.payerName).toBe("SYNT WHOLESALE");
      });
    });

    describe("UPI with special VPA formats", () => {
      it("extracts UPI ID without @ symbol (ICICI format)", () => {
        const result = parseNarration(
          "UPI/600000000001/synttest.1234/SYNT VENDOR/SYNT BANK/600000000002/SYNT000001",
          "ICICI"
        );
        expect(result.rail).toBe("UPI");
        expect(result.upiId).toBe("synttest.1234");
      });

      it("does NOT extract code-shaped ref as UPI ID (ICICI format)", () => {
        // Index 2 has "SYNT0000001234" which looks like a code (3-6 letters + digits)
        const result = parseNarration(
          "UPI/600000000001/SYNT0000001234/SYNT VENDOR/SYNT BANK",
          "ICICI"
        );
        expect(result.rail).toBe("UPI");
        // Should NOT be extracted as UPI ID since it matches ^[A-Z]{3,6}\d+$
        expect(result.upiId).toBeUndefined();
      });

      it("extracts standard VPA in HDFC format", () => {
        const result = parseNarration(
          "UPI-SYNT VENDOR-vendor9000@oksynt-SYNT0000001-600000000003-UPI"
        );
        expect(result.rail).toBe("UPI");
        expect(result.upiId).toBe("vendor9000@oksynt");
      });

      it("extracts payer bank from IFSC segment (HDFC UPI)", () => {
        const result = parseNarration(
          "UPI-SYNT VENDOR-vendor@oksynt-SYNT0000001-600000000004-UPI"
        );
        expect(result.rail).toBe("UPI");
        expect(result.payerBank).toBe("SYNT0000001");
      });

      it("extracts payer bank from bank name segment for ICICI UPI", () => {
        const result = parseNarration(
          "UPI/SYNT VENDOR/vendor@oksynt/Test Remark/SYNT BANK/600000000005/SYNT000002",
          "ICICI"
        );
        expect(result.rail).toBe("UPI");
        // VPA handle is extracted when no IFSC found
        expect(result.payerBank).toBe("OKSYNT");
      });

      it("extracts payer bank from bank name when present (ICICI)", () => {
        // ICICI format where the bank name is explicitly mentioned
        const result = parseNarration(
          "UPI/SYNT VENDOR/syntvendor/Test Remark/SYNT BANK/600000000005/SYNT000002",
          "ICICI"
        );
        expect(result.rail).toBe("UPI");
        // When VPA has no @ and bank name segment contains "BANK", use it
        expect(result.payerBank).toBe("SYNT BANK");
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

      it("returns null for non-12-digit ref and falls back to narration", () => {
        // 16-digit ref doesn't match 12-digit pattern, so falls back to narration extraction
        expect(extractUtrForDedupe("UPI/600000000001/vendor@synth", "UPI", "0000600000000001")).toBe("600000000001");
      });

      it("returns null when ref is all zeros and narration has no RRN", () => {
        expect(extractUtrForDedupe("some narration without RRN", "UPI", "0000000000000000")).toBeNull();
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
