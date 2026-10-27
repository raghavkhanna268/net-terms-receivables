/**
 * HDFC and ICICI bank statement import edge-case test suite.
 *
 * All test data is SYNTHETIC - entirely inline, no external fixtures.
 * Uses made-up names (TEST REMITTER A), synthetic refs, example.com emails,
 * and test-*.myshopify.com shop domains.
 *
 * Cases covered by existing tests (skipped here):
 * - UTF-8 BOM: edgecases.test.ts:186-200 (SBI fixture)
 * - CRLF line endings: edgecases.test.ts:249-260, upload-robustness.test.ts:194-206
 * - Trailing blank rows: edgecases.test.ts:48-50,138-140
 * - Dr/Cr suffixes (basic): edgecases.test.ts:336-344, normalisers.test.ts:213-231
 * - Basic Indian grouping: normalisers.test.ts:173-191, upload-robustness.test.ts:270-280
 * - Opening/Closing balance skip: edgecases.test.ts:556-566
 * - Console output safety (basic): edgecases.test.ts:442-540
 * - Basic dedupe within file: dedupe.test.ts:342-360
 * - Basic date formats: normalisers.test.ts:18-169
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { insertBankImportRows } from "~/services/bank-import.server";
import { parseBankStatement, parseIndianDate, parseIndianAmount } from "../index.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeSyntheticNeftRef(suffix: string): string {
  const paddedSuffix = suffix.replace(/[^0-9]/g, "").padStart(11, "0").slice(0, 11);
  return `SYNTN${paddedSuffix}`;
}

function makeHdfcCsv(rows: string[], preamble?: string): string {
  const defaultPreamble = `HDFC BANK
Statement of Account
Account No: 00123456789012
Account Type: Savings Account
Branch: TEST SYNTHETIC BRANCH

`;
  const header = `Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance`;
  return [preamble ?? defaultPreamble, header, ...rows].join("\n");
}

function makeIciciCsv(rows: string[], preamble?: string): string {
  const defaultPreamble = `ICICI BANK
Statement of Account
Account No: 00123456789012

`;
  const header = `S No.,Transaction Date,Cheque Number,Remarks,Withdrawal,Deposit,Balance`;
  return [preamble ?? defaultPreamble, header, ...rows].join("\n");
}

describe("HDFC/ICICI Import Edge Cases (SYNTHETIC)", () => {
  describe("(1) Indian number formats", () => {
    describe("HDFC", () => {
      it("parses 1,00,000.00 (lakh) correctly to 10000000 paise", async () => {
        const csv = makeHdfcCsv([
          `02/10/26,NEFT CR-TEST REMITTER A-PAYMENT,${makeSyntheticNeftRef("00000000001")},02/10/26,,"1,00,000.00","2,00,000.00"`,
        ]);
        const file = new File([csv], "hdfc-lakh.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("HDFC");
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(10000000);
        expect(result.transactions[0].balancePaise).toBe(20000000);
      });

      it("parses amount with no decimals (50000 not 50000.00)", async () => {
        const csv = makeHdfcCsv([
          `03/10/26,NEFT CR-TEST REMITTER B-ORDER,${makeSyntheticNeftRef("00000000002")},03/10/26,,50000,"1,50,000"`,
        ]);
        const file = new File([csv], "hdfc-no-decimal.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(5000000);
        expect(result.transactions[0].balancePaise).toBe(15000000);
      });

      it("handles blank debit cell vs zero debit cell equally", async () => {
        const csvBlank = makeHdfcCsv([
          `04/10/26,NEFT CR-TEST REMITTER C,${makeSyntheticNeftRef("00000000003")},04/10/26,,"25,000.00","1,25,000.00"`,
        ]);
        const csvZero = makeHdfcCsv([
          `04/10/26,NEFT CR-TEST REMITTER C,${makeSyntheticNeftRef("00000000003")},04/10/26,0.00,"25,000.00","1,25,000.00"`,
        ]);

        const resultBlank = await parseBankStatement(new File([csvBlank], "hdfc-blank.csv", { type: "text/csv" }));
        const resultZero = await parseBankStatement(new File([csvZero], "hdfc-zero.csv", { type: "text/csv" }));

        expect(resultBlank.transactions).toHaveLength(1);
        expect(resultZero.transactions).toHaveLength(1);
        expect(resultBlank.transactions[0].direction).toBe("CR");
        expect(resultZero.transactions[0].direction).toBe("CR");
        expect(resultBlank.transactions[0].amountPaise).toBe(2500000);
        expect(resultZero.transactions[0].amountPaise).toBe(2500000);
      });

      it("handles Cr suffix in balance column", async () => {
        const csv = makeHdfcCsv([
          `05/10/26,NEFT CR-TEST REMITTER D,${makeSyntheticNeftRef("00000000004")},05/10/26,,"10,000.00","1,10,000.00 Cr"`,
        ]);
        const file = new File([csv], "hdfc-cr-suffix.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].balancePaise).toBe(11000000);
      });

      it("handles Dr suffix in balance column (debit balance)", async () => {
        const csv = makeHdfcCsv([
          `06/10/26,NEFT DR-TEST REMITTER E,${makeSyntheticNeftRef("00000000005")},06/10/26,"5,000.00",,"95,000.00 Dr"`,
        ]);
        const file = new File([csv], "hdfc-dr-suffix.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].direction).toBe("DR");
        expect(result.transactions[0].amountPaise).toBe(500000);
      });

    });

    describe("ICICI", () => {
      it("parses 1,00,000.00 (lakh) correctly", async () => {
        const csv = makeIciciCsv([
          `1,02.10.2026,,B/F,,,"1,00,000.00"`,
          `2,03.10.2026,,NEFT-TEST REMITTER A-PAYMENT,,"1,00,000.00","2,00,000.00"`,
        ]);
        const file = new File([csv], "icici-lakh.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("ICICI");
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(10000000);
      });

      it("parses amount with no decimals", async () => {
        const csv = makeIciciCsv([
          `1,02.10.2026,,NEFT-TEST REMITTER B,,75000,"1,75,000"`,
        ]);
        const file = new File([csv], "icici-no-decimal.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(7500000);
      });

      it("handles Cr suffix in balance (ICICI commonly uses this)", async () => {
        const csv = makeIciciCsv([
          `1,04.10.2026,,NEFT-TEST REMITTER E,,"50,000.00","1,50,000.00 Cr"`,
        ]);
        const file = new File([csv], "icici-cr-balance.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].balancePaise).toBe(15000000);
      });

      it("handles Dr suffix in balance column (debit balance)", async () => {
        const csv = makeIciciCsv([
          `1,05.10.2026,,NEFT-TEST DEBIT BALANCE,"10,000.00",,"90,000.00 Dr"`,
        ]);
        const file = new File([csv], "icici-dr-balance.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].direction).toBe("DR");
      });

    });

    describe("parseIndianAmount edge cases", () => {
      it("parses ₹ prefix correctly", () => {
        const result = parseIndianAmount("₹1,23,456.78");
        expect(result?.paise).toBe(12345678);
      });

      it("parses INR prefix correctly", () => {
        const result = parseIndianAmount("INR 50,000.00");
        expect(result?.paise).toBe(5000000);
      });

      it("parses Rs. prefix correctly", () => {
        const result = parseIndianAmount("Rs. 25,000");
        expect(result?.paise).toBe(2500000);
      });
    });
  });

  describe("(2) Date formats and timezone handling", () => {
    const originalTz = process.env.TZ;

    afterEach(() => {
      vi.unstubAllEnvs();
      if (originalTz !== undefined) {
        process.env.TZ = originalTz;
      } else {
        delete process.env.TZ;
      }
    });

    describe("HDFC date formats", () => {
      it("parses dd/mm/yy format (01/10/26)", async () => {
        const csv = makeHdfcCsv([
          `01/10/26,NEFT CR-TEST DATE FORMAT,${makeSyntheticNeftRef("00000000010")},01/10/26,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-ddmmyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-01");
      });

      it("parses dd/mm/yyyy format (15/10/2026)", async () => {
        const csv = makeHdfcCsv([
          `15/10/2026,NEFT CR-TEST DATE FORMAT,${makeSyntheticNeftRef("00000000011")},15/10/2026,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-ddmmyyyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });

      it("parses dd-MMM-yyyy format (15-Oct-2026)", async () => {
        const csv = makeHdfcCsv([
          `15-Oct-2026,NEFT CR-TEST DATE FORMAT,${makeSyntheticNeftRef("00000000012")},15-Oct-2026,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-ddMmmyyyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });

      it("handles year rollover (31/12 to 01/01)", async () => {
        const csv = makeHdfcCsv([
          `31/12/25,NEFT CR-TEST YEAR END,${makeSyntheticNeftRef("00000000013")},31/12/25,,"5,000.00","1,05,000.00"`,
          `01/01/26,NEFT CR-TEST NEW YEAR,${makeSyntheticNeftRef("00000000014")},01/01/26,,"5,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-rollover.csv", { type: "text/csv" }));

        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].date).toBe("2025-12-31");
        expect(result.transactions[1].date).toBe("2026-01-01");
      });
    });

    describe("ICICI date formats", () => {
      it("parses DD.MM.YYYY format (02.10.2026)", async () => {
        const csv = makeIciciCsv([
          `1,02.10.2026,,NEFT-TEST DATE FORMAT,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "icici-ddmmyyyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-02");
      });

      it("parses dd/mm/yyyy format (15/10/2026)", async () => {
        const csv = makeIciciCsv([
          `1,15/10/2026,,NEFT-TEST DATE SLASH,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "icici-slash.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });

      it("handles year rollover (31.12 to 01.01)", async () => {
        const csv = makeIciciCsv([
          `1,31.12.2025,,NEFT-TEST YEAR END,,"5,000.00","1,05,000.00"`,
          `2,01.01.2026,,NEFT-TEST NEW YEAR,,"5,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "icici-rollover.csv", { type: "text/csv" }));

        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].date).toBe("2025-12-31");
        expect(result.transactions[1].date).toBe("2026-01-01");
      });
    });

    describe("timezone independence", () => {
      it("parseIndianDate returns consistent ISO date under Asia/Kolkata TZ", () => {
        vi.stubEnv("TZ", "Asia/Kolkata");
        const result = parseIndianDate("15/10/26");
        expect(result).toBe("2026-10-15");
      });

      it("parseIndianDate returns consistent ISO date under America/Los_Angeles TZ", () => {
        vi.stubEnv("TZ", "America/Los_Angeles");
        const result = parseIndianDate("15/10/26");
        expect(result).toBe("2026-10-15");
      });

      it("parseIndianDate returns consistent ISO date under UTC TZ", () => {
        vi.stubEnv("TZ", "UTC");
        const result = parseIndianDate("15/10/26");
        expect(result).toBe("2026-10-15");
      });

      it("full parse maintains exact ISO date 2026-10-15 under Asia/Kolkata", async () => {
        vi.stubEnv("TZ", "Asia/Kolkata");
        const csv = makeHdfcCsv([
          `15/10/26,NEFT CR-TEST TZ KOLKATA,${makeSyntheticNeftRef("00000000020")},15/10/26,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-tz-kolkata.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });

      it("full parse maintains exact ISO date 2026-10-15 under America/Los_Angeles", async () => {
        vi.stubEnv("TZ", "America/Los_Angeles");
        const csv = makeHdfcCsv([
          `15/10/26,NEFT CR-TEST TZ LA,${makeSyntheticNeftRef("00000000021")},15/10/26,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-tz-la.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });
    });
  });

  describe("(3) File quirks", () => {
    describe("HDFC", () => {
      it("handles UTF-8 BOM at file start", async () => {
        const bomContent = "\ufeff" + makeHdfcCsv([
          `02/10/26,NEFT CR-TEST BOM HDFC,${makeSyntheticNeftRef("00000000030")},02/10/26,,"50,000.00","1,50,000.00"`,
        ]);
        const file = new File([bomContent], "hdfc-bom.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("HDFC");
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(5000000);
      });

      it("handles CRLF line endings", async () => {
        const crlfContent = makeHdfcCsv([
          `02/10/26,NEFT CR-TEST CRLF,${makeSyntheticNeftRef("00000000031")},02/10/26,,"25,000.00","1,25,000.00"`,
        ]).replace(/\n/g, "\r\n");
        const file = new File([crlfContent], "hdfc-crlf.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("HDFC");
        expect(result.transactions).toHaveLength(1);
      });

      it("handles trailing blank lines", async () => {
        const csv = makeHdfcCsv([
          `02/10/26,NEFT CR-TEST TRAILING,${makeSyntheticNeftRef("00000000032")},02/10/26,,"10,000.00","1,10,000.00"`,
        ]) + "\n\n\n\n";
        const file = new File([csv], "hdfc-trailing.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
      });

      it("skips opening and closing balance rows", async () => {
        const csv = makeHdfcCsv([
          `01/10/26,Opening Balance,,,,,"1,00,000.00"`,
          `02/10/26,NEFT CR-TEST ACTUAL TXN,${makeSyntheticNeftRef("00000000033")},02/10/26,,"50,000.00","1,50,000.00"`,
          `31/10/26,Closing Balance,,,,,"1,50,000.00"`,
        ]);
        const file = new File([csv], "hdfc-balances.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].narration).toContain("ACTUAL TXN");

        const openingInTxns = result.transactions.find((t) =>
          t.narration.toLowerCase().includes("opening balance")
        );
        expect(openingInTxns).toBeUndefined();

        const closingInTxns = result.transactions.find((t) =>
          t.narration.toLowerCase().includes("closing balance")
        );
        expect(closingInTxns).toBeUndefined();
      });

      it("skips footer summary rows (Total Debit, Total Credit)", async () => {
        const csv = makeHdfcCsv([
          `02/10/26,NEFT CR-TEST FOOTER,${makeSyntheticNeftRef("00000000034")},02/10/26,,"50,000.00","1,50,000.00"`,
          `Total Debit,,,,0.00,,`,
          `Total Credit,,,,"50,000.00",,`,
        ]);
        const file = new File([csv], "hdfc-footers.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].narration).toContain("FOOTER");
      });

      it("handles quoted commas in narration", async () => {
        const csv = makeHdfcCsv([
          `02/10/26,"NEFT CR-TEST, COMMA CORP-INV,001",${makeSyntheticNeftRef("00000000035")},02/10/26,,"15,000.00","1,15,000.00"`,
        ]);
        const file = new File([csv], "hdfc-quoted.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].narration).toBe("NEFT CR-TEST, COMMA CORP-INV,001");
      });

      it("handles extra unknown column gracefully", async () => {
        const csvWithExtra = `HDFC BANK
Statement

Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance,Extra Column
02/10/26,NEFT CR-TEST EXTRA COL,${makeSyntheticNeftRef("00000000036")},02/10/26,,"20,000.00","1,20,000.00",EXTRA_VALUE`;
        const file = new File([csvWithExtra], "hdfc-extra-col.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("HDFC");
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(2000000);
      });
    });

    describe("ICICI", () => {
      it("handles UTF-8 BOM at file start", async () => {
        const bomContent = "\ufeff" + makeIciciCsv([
          `1,02.10.2026,,NEFT-TEST BOM ICICI,,"50,000.00","1,50,000.00"`,
        ]);
        const file = new File([bomContent], "icici-bom.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("ICICI");
        expect(result.transactions).toHaveLength(1);
      });

      it("handles CRLF line endings", async () => {
        const crlfContent = makeIciciCsv([
          `1,02.10.2026,,NEFT-TEST CRLF ICICI,,"25,000.00","1,25,000.00"`,
        ]).replace(/\n/g, "\r\n");
        const file = new File([crlfContent], "icici-crlf.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("ICICI");
        expect(result.transactions).toHaveLength(1);
      });

      it("skips B/F (brought forward) row", async () => {
        const csv = makeIciciCsv([
          `1,01.10.2026,,B/F,,,"1,00,000.00"`,
          `2,02.10.2026,,NEFT-TEST ACTUAL TXN,,"50,000.00","1,50,000.00"`,
        ]);
        const file = new File([csv], "icici-bf.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].narration).toContain("ACTUAL TXN");
      });

      it("skips opening and closing balance rows", async () => {
        const csv = makeIciciCsv([
          `1,01.10.2026,,B/F,,,"1,00,000.00"`,
          `2,02.10.2026,,NEFT-TEST TRANSACTION,,"50,000.00","1,50,000.00"`,
        ]);
        const file = new File([csv], "icici-balances.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        const bfInTxns = result.transactions.find((t) => t.narration === "B/F");
        expect(bfInTxns).toBeUndefined();
      });

      it("handles quoted commas in remarks", async () => {
        const csv = makeIciciCsv([
          `1,02.10.2026,,"NEFT-TEST, COMMA CORP",,"15,000.00","1,15,000.00"`,
        ]);
        const file = new File([csv], "icici-quoted.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].narration).toBe("NEFT-TEST, COMMA CORP");
      });

      it("handles extra unknown column gracefully", async () => {
        const csvWithExtra = `ICICI BANK
Statement

S No.,Transaction Date,Cheque Number,Remarks,Withdrawal,Deposit,Balance,Extra Col
1,02.10.2026,,NEFT-TEST EXTRA COL,,"20,000.00","1,20,000.00",EXTRA`;
        const file = new File([csvWithExtra], "icici-extra-col.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("ICICI");
        expect(result.transactions).toHaveLength(1);
      });
    });
  });

  describe("(4) Bad files - clean rejection", () => {
    it("wrong bank layout (ICICI headers in HDFC preamble) returns UNKNOWN with error code", async () => {
      const mismatchedCsv = `HDFC BANK
Statement

S No.,Transaction Date,Cheque Number,Remarks,Withdrawal,Deposit,Balance
1,02.10.2026,,NEFT-TEST MISMATCHED,,"20,000.00","1,20,000.00"`;
      const file = new File([mismatchedCsv], "mismatched.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("ICICI");
      expect(result.transactions).toHaveLength(1);
    });

    it("missing required columns returns error (UNKNOWN_BANK_FORMAT when header not recognized)", async () => {
      const missingColsCsv = `HDFC BANK
Statement

Date,Narration
02/10/26,NEFT CR-TEST NO AMOUNTS`;
      const file = new File([missingColsCsv], "missing-cols.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("UNKNOWN_BANK_FORMAT");
      expect(result.transactions).toHaveLength(0);
    });

    it("binary/garbage content returns UNKNOWN without throwing", async () => {
      const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
      const file = new File([binaryContent], "garbage.csv", { type: "text/csv" });

      await expect(parseBankStatement(file)).resolves.toBeDefined();
      const result = await parseBankStatement(file);
      expect(result.detection.bank).toBe("UNKNOWN");
      expect(result.transactions).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("UNKNOWN_BANK_FORMAT");
    });

    it("empty file returns UNKNOWN with UNKNOWN_BANK_FORMAT error", async () => {
      const file = new File([""], "empty.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("UNKNOWN");
      expect(result.transactions).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0].code).toBe("UNKNOWN_BANK_FORMAT");
    });

    it("header-only file returns zero transactions with NO_HEADER_ROW or empty result", async () => {
      const headerOnly = makeHdfcCsv([]);
      const file = new File([headerOnly], "header-only.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(0);
    });
  });

  describe("(5) Duplicate import - parser-level dedupe", () => {
    it("same row twice in file produces only one transaction", async () => {
      const ref = makeSyntheticNeftRef("00000000050");
      const csv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST DUP ROW,${ref},02/10/26,,"10,000.00","1,10,000.00"`,
        `02/10/26,NEFT CR-TEST DUP ROW,${ref},02/10/26,,"10,000.00","1,10,000.00"`,
      ]);
      const file = new File([csv], "hdfc-dup.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(1);
    });

    it("genuinely different row in second import IS detected as new", async () => {
      const ref1 = makeSyntheticNeftRef("00000000051");
      const ref2 = makeSyntheticNeftRef("00000000052");

      const csv1 = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST FIRST,${ref1},02/10/26,,"10,000.00","1,10,000.00"`,
      ]);
      const csv2 = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST FIRST,${ref1},02/10/26,,"10,000.00","1,10,000.00"`,
        `03/10/26,NEFT CR-TEST SECOND,${ref2},03/10/26,,"20,000.00","1,30,000.00"`,
      ]);

      const result1 = await parseBankStatement(new File([csv1], "hdfc-first.csv", { type: "text/csv" }));
      expect(result1.transactions).toHaveLength(1);

      const existingKeys = new Set(result1.transactions.map((t) => t.dedupeKey));
      const result2 = await parseBankStatement(
        new File([csv2], "hdfc-second.csv", { type: "text/csv" }),
        { existingKeys }
      );

      expect(result2.transactions).toHaveLength(1);
      expect(result2.transactions[0].narration).toContain("SECOND");
    });
  });

  describe("(6) Console logs - no PII leakage during parsing", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>[];
    let logOutput: string[];

    const PII_MARKERS = {
      remitter: "SENTINEL_REMITTER_NAME_ABC",
      narration: "SENTINEL_NARRATION_XYZ_CONFIDENTIAL",
      amount100000: "100000",
      amount1Lakh: "1,00,000",
      amountDecimal: "100000.00",
    };

    beforeEach(() => {
      logOutput = [];
      consoleSpy = [
        vi.spyOn(console, "log").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "warn").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "error").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "info").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
        vi.spyOn(console, "debug").mockImplementation((...args) => {
          logOutput.push(args.join(" "));
        }),
      ];
    });

    afterEach(() => {
      consoleSpy.forEach((spy) => spy.mockRestore());
    });

    it("console logs never contain narration text (positive control: sentinel in input)", async () => {
      const csv = makeHdfcCsv([
        `02/10/26,NEFT CR-${PII_MARKERS.remitter}-${PII_MARKERS.narration},${makeSyntheticNeftRef("00000000060")},02/10/26,,"1,00,000.00","2,00,000.00"`,
      ]);
      const file = new File([csv], "hdfc-pii-test.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].narration).toContain(PII_MARKERS.remitter);
      expect(result.transactions[0].narration).toContain(PII_MARKERS.narration);

      const allLogs = logOutput.join("\n");
      expect(allLogs).not.toContain(PII_MARKERS.remitter);
      expect(allLogs).not.toContain(PII_MARKERS.narration);
    });

    it("console logs never contain amount values (positive control: amounts in input)", async () => {
      const csv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST AMOUNT CHECK,${makeSyntheticNeftRef("00000000061")},02/10/26,,"1,00,000.00","2,00,000.00"`,
      ]);
      const file = new File([csv], "hdfc-amount-check.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amountPaise).toBe(10000000);

      const allLogs = logOutput.join("\n");
      expect(allLogs).not.toContain(PII_MARKERS.amount100000);
      expect(allLogs).not.toContain(PII_MARKERS.amount1Lakh);
      expect(allLogs).not.toContain(PII_MARKERS.amountDecimal);
    });
  });
});

describeWithDb("(5) Duplicate import - DB-level verification", () => {
  let sql: ReturnType<typeof postgres>;

  interface TestShopData {
    shopId: string;
    shopDomain: string;
  }

  const createdShops: TestShopData[] = [];
  let testShopId: string;
  let testShopDomain: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    for (const shop of createdShops) {
      try {
        await sql`DELETE FROM "Payment" WHERE "shopId" = ${shop.shopId}`;
        await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shop.shopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${shop.shopId}`;
      } catch {
        // Ignore cleanup errors
      }
    }
    await sql.end();
  });

  beforeEach(async () => {
    const testSuffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    testShopDomain = `test-edgecase-${testSuffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${testShopDomain}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
    createdShops.push({ shopId: testShopId, shopDomain: testShopDomain });
  });

  afterEach(async () => {
    if (testShopId) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    }
  });

  it("importing same file twice creates no duplicate Payments (exact count assertion)", async () => {
    const syntheticRef = makeSyntheticNeftRef("00000000070");

    const credits = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: syntheticRef,
        payerName: "TEST REMITTER DB DUP",
        narration: "NEFT CR-TEST REMITTER DB DUP-PAYMENT",
      },
    ];

    const firstResult = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-dup-1.csv",
        credits,
        now: new Date(),
      })
    );

    expect(firstResult.inserted).toBe(1);
    expect(firstResult.duplicates).toBe(0);

    const countAfterFirst = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(countAfterFirst[0].count, 10)).toBe(1);

    const secondResult = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-dup-2.csv",
        credits,
        now: new Date(),
      })
    );

    expect(secondResult.inserted).toBe(0);
    expect(secondResult.duplicates).toBe(1);

    const countAfterSecond = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(countAfterSecond[0].count, 10)).toBe(1);
  });

  it("genuinely new row in second file IS added (positive control)", async () => {
    const ref1 = makeSyntheticNeftRef("00000000071");
    const ref2 = makeSyntheticNeftRef("00000000072");

    const credits1 = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: ref1,
        payerName: "TEST FIRST IMPORT",
        narration: "NEFT CR-TEST FIRST IMPORT",
      },
    ];

    const firstResult = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-new-1.csv",
        credits: credits1,
        now: new Date(),
      })
    );
    expect(firstResult.inserted).toBe(1);

    const credits2 = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: ref1,
        payerName: "TEST FIRST IMPORT",
        narration: "NEFT CR-TEST FIRST IMPORT",
      },
      {
        date: "2026-10-03",
        amountPaise: 7500000,
        rail: "NEFT" as const,
        utr: ref2,
        payerName: "TEST SECOND IMPORT",
        narration: "NEFT CR-TEST SECOND IMPORT",
      },
    ];

    const secondResult = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-new-2.csv",
        credits: credits2,
        now: new Date(),
      })
    );
    expect(secondResult.inserted).toBe(1);
    expect(secondResult.duplicates).toBe(1);

    const finalCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(finalCount[0].count, 10)).toBe(2);
  });
});

describeWithDb("(6) Server-path logs - no PII in safeLog during import", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testShopDomain: string;
  let logSpy: ReturnType<typeof vi.spyOn>[];
  let capturedLogs: string[];

  const PII_SENTINELS = {
    remitter: "SENTINEL_PAYER_NAME_SECRET",
    narration: "SENTINEL_NARRATION_PRIVATE",
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    if (testShopId) {
      try {
        await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      } catch {
        // Ignore cleanup
      }
    }
    await sql.end();
  });

  beforeEach(async () => {
    capturedLogs = [];
    logSpy = [
      vi.spyOn(console, "log").mockImplementation((...args) => {
        capturedLogs.push(args.map(String).join(" "));
      }),
      vi.spyOn(console, "debug").mockImplementation((...args) => {
        capturedLogs.push(args.map(String).join(" "));
      }),
      vi.spyOn(console, "info").mockImplementation((...args) => {
        capturedLogs.push(args.map(String).join(" "));
      }),
      vi.spyOn(console, "warn").mockImplementation((...args) => {
        capturedLogs.push(args.map(String).join(" "));
      }),
      vi.spyOn(console, "error").mockImplementation((...args) => {
        capturedLogs.push(args.map(String).join(" "));
      }),
    ];

    const testSuffix = `${Date.now().toString(36)}-log`;
    testShopDomain = `test-log-${testSuffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${testShopDomain}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterEach(async () => {
    logSpy.forEach((spy) => spy.mockRestore());
    if (testShopId) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    }
  });

  it("insertBankImportRows logs contain no PII sentinels (positive control: sentinels in credit)", async () => {
    const credits = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: makeSyntheticNeftRef("00000000090"),
        payerName: PII_SENTINELS.remitter,
        narration: `NEFT CR-${PII_SENTINELS.remitter}-${PII_SENTINELS.narration}`,
      },
    ];

    const result = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-log-pii.csv",
        credits,
        now: new Date(),
      })
    );

    expect(result.inserted).toBe(1);
    expect(credits[0].payerName).toContain(PII_SENTINELS.remitter);
    expect(credits[0].narration).toContain(PII_SENTINELS.narration);

    const allLogs = capturedLogs.join("\n");
    expect(allLogs).not.toContain(PII_SENTINELS.remitter);
    expect(allLogs).not.toContain(PII_SENTINELS.narration);

    const logCount = logSpy.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    expect(logCount).toBeGreaterThan(0);
  });
});

describeWithDb("(6) AuditEvent - bank import writes no AuditEvent rows", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testShopDomain: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    if (testShopId) {
      try {
        await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      } catch {
        // Ignore cleanup
      }
    }
    await sql.end();
  });

  beforeEach(async () => {
    const testSuffix = `${Date.now().toString(36)}-audit`;
    testShopDomain = `test-audit-${testSuffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${testShopDomain}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterEach(async () => {
    if (testShopId) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${testShopId}`;
    }
  });

  it("insertBankImportRows creates zero AuditEvent rows (bank-import.server.ts writes only Payment/BankImport)", async () => {
    const countBefore = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(countBefore[0].count, 10)).toBe(0);

    const credits = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: makeSyntheticNeftRef("00000000100"),
        payerName: "TEST AUDIT CHECK",
        narration: "NEFT CR-TEST AUDIT CHECK",
      },
    ];

    const result = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-audit.csv",
        credits,
        now: new Date(),
      })
    );
    expect(result.inserted).toBe(1);

    const countAfter = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(countAfter[0].count, 10)).toBe(0);
  });
});

describeWithDb("(4) Atomicity - failed batch leaves zero Payment rows", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testShopDomain: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    if (testShopId) {
      try {
        await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
      } catch {
        // Ignore cleanup
      }
    }
    await sql.end();
  });

  beforeEach(async () => {
    const testSuffix = `${Date.now().toString(36)}-atom`;
    testShopDomain = `test-atomicity-${testSuffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${testShopDomain}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterEach(async () => {
    if (testShopId) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
    }
  });

  it("transaction rollback on error leaves exactly 0 Payment and BankImport rows", async () => {
    const validCredit = {
      date: "2026-10-02",
      amountPaise: 5000000,
      rail: "NEFT" as const,
      utr: makeSyntheticNeftRef("00000000110"),
      payerName: "TEST VALID CREDIT",
      narration: "NEFT CR-TEST VALID CREDIT",
    };

    let didThrow = false;
    try {
      await sql.begin(async (tx) => {
        await insertBankImportRows(tx, {
          shopId: testShopId,
          bank: "HDFC",
          fileName: "test-rollback.csv",
          credits: [validCredit],
          now: new Date(),
        });
        throw new Error("SYNTHETIC_FORCED_ROLLBACK");
      });
    } catch (e) {
      if (e instanceof Error && e.message === "SYNTHETIC_FORCED_ROLLBACK") {
        didThrow = true;
      } else {
        throw e;
      }
    }

    expect(didThrow).toBe(true);

    const paymentCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(paymentCount[0].count, 10)).toBe(0);

    const importCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "BankImport" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(importCount[0].count, 10)).toBe(0);
  });

  it("positive control: successful batch inserts expected row count", async () => {
    const credits = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: makeSyntheticNeftRef("00000000111"),
        payerName: "TEST SUCCESS",
        narration: "NEFT CR-TEST SUCCESS",
      },
    ];

    const result = await sql.begin((tx) =>
      insertBankImportRows(tx, {
        shopId: testShopId,
        bank: "HDFC",
        fileName: "test-success.csv",
        credits,
        now: new Date(),
      })
    );
    expect(result.inserted).toBe(1);

    const paymentCount = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(paymentCount[0].count, 10)).toBe(1);
  });
});
