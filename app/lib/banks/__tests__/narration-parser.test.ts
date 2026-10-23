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
          "UPI-FAKE VENDOR-fakevendor@synthetic-SYNT0000001-987654321098-UPI"
        );
        expect(result.rail).toBe("UPI");
        expect(result.upiId).toBe("fakevendor@synthetic");
        expect(result.utr).toBe("987654321098");
        // Payer name extracted from first segment after UPI-
        expect(result.payerName).toBeDefined();
        expect(result.payerBank).toBe("SYNTHETIC");
      });

      it("extracts UPI - ICICI format", () => {
        const result = parseNarration("UPI/543210987654/fakeuser@synthetic/FAKE VENDOR LTD");
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
        // payerName includes multiple parts from the narration
        expect(result.payerName).toContain("SYNTHETIC");
        expect(result.payerName).toContain("SALARY");
      });

      it("extracts NEFT with UTR and IFSC", () => {
        const result = parseNarration("NEFT-HDFC2026100800001-FAKE SERVICES LTD-HDFC0001234");
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBe("HDFC2026100800001");
        // IFSC takes precedence over bank code from UTR
        expect(result.payerBank).toBe("HDFC0001234");
      });

      it("extracts NEFT - ICICI format", () => {
        const result = parseNarration("NEFT/SYNT2026100100002/SYNTHETIC PAYROLL/SALARY OCT");
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBe("SYNT2026100100002");
      });

      it("extracts UTR starting with bank code", () => {
        const result = parseNarration("NEFT CR-COMPANY-ICIC2026101500001");
        expect(result.rail).toBe("NEFT");
        expect(result.utr).toBe("ICIC2026101500001");
        // Bank code extracted from UTR prefix
        expect(result.payerBank).toBe("ICIC");
      });
    });

    describe("RTGS transactions", () => {
      it("extracts RTGS CR with company name", () => {
        const result = parseNarration("RTGS CR-SYNTHETIC WHOLESALE LTD-INV OCT");
        expect(result.rail).toBe("RTGS");
        // payerName includes parts after CR-
        expect(result.payerName).toContain("SYNTHETIC");
        expect(result.payerName).toContain("WHOLESALE");
      });

      it("extracts RTGS with UTR and IFSC", () => {
        const result = parseNarration("RTGS-SYNT2026102200001-SYNTHETIC WHOLESALE-SYNT0000006");
        expect(result.rail).toBe("RTGS");
        expect(result.utr).toBe("SYNT2026102200001");
        // IFSC detected
        expect(result.payerBank).toBe("SYNT0000006");
      });

      it("extracts RTGS - ICICI format", () => {
        const result = parseNarration("RTGS/SYNT2026100700002/SYNTHETIC WHOLESALE/INVOICE 12345");
        expect(result.rail).toBe("RTGS");
        expect(result.utr).toBe("SYNT2026100700002");
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
      it("extracts ACH debit with company", () => {
        const result = parseNarration("ACH D- TP ACH SYNTHETIC INSURANCE-654321");
        expect(result.rail).toBe("ACH");
        expect(result.payerName).toBe("SYNTHETIC INSURANCE");
        expect(result.utr).toBe("654321");
      });

      it("detects NACH", () => {
        const result = parseNarration("NACH/ACH/SYNTHETIC LIFE INS/PREMIUM");
        expect(result.rail).toBe("ACH");
      });
    });

    describe("Cheque transactions", () => {
      it("extracts cheque number", () => {
        const result = parseNarration("CHQ PAID-000123");
        expect(result.rail).toBe("CHEQUE");
        expect(result.utr).toBe("000123");
      });

      it("detects CLG clearing", () => {
        const result = parseNarration("CLG CHQ DEP 000456");
        expect(result.rail).toBe("CHEQUE");
      });

      it("detects CHEQUE in text", () => {
        const result = parseNarration("CHEQUE DEPOSIT-FAKE COMPANY LTD");
        expect(result.rail).toBe("CHEQUE");
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
    it("returns refNo if it looks like 12-digit RRN", () => {
      expect(extractUtrForDedupe("some narration", "987654321098")).toBe("987654321098");
    });

    it("returns refNo if it looks like NEFT UTR", () => {
      expect(extractUtrForDedupe("some narration", "HDFC2026100800001")).toBe("HDFC2026100800001");
    });

    it("extracts UTR from narration if refNo is not UTR", () => {
      expect(
        extractUtrForDedupe("NEFT CR-COMPANY-ICIC2026101500001", "REF123")
      ).toBe("ICIC2026101500001");
    });

    it("extracts 12-digit RRN from narration", () => {
      expect(
        extractUtrForDedupe("UPI/123456789012/user@bank/NAME", undefined)
      ).toBe("123456789012");
    });

    it("extracts N-prefix UTR from narration", () => {
      expect(
        extractUtrForDedupe("NEFT-N12345678901234567-COMPANY", undefined)
      ).toBe("N12345678901234567");
    });

    it("returns null if no UTR found", () => {
      expect(extractUtrForDedupe("CASH DEPOSIT", undefined)).toBeNull();
    });

    it("prefers bank UTR over RRN when both present", () => {
      expect(
        extractUtrForDedupe("NEFT-HDFC2026100100001-123456789012-COMPANY", undefined)
      ).toBe("HDFC2026100100001");
    });
  });
});
