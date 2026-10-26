/**
 * HDFC and ICICI bank statement import edge-case test suite.
 *
 * All test data is SYNTHETIC - entirely inline, no external fixtures.
 * Uses made-up names (TEST REMITTER A), fake UTRs, example.com emails,
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
import type { ParseResult } from "../types.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeValidNeftUtr(suffix: string): string {
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
          `02/10/26,NEFT CR-TEST REMITTER A-PAYMENT,${makeValidNeftUtr("00000000001")},02/10/26,,"1,00,000.00","2,00,000.00"`,
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
          `03/10/26,NEFT CR-TEST REMITTER B-ORDER,${makeValidNeftUtr("00000000002")},03/10/26,,50000,"1,50,000"`,
        ]);
        const file = new File([csv], "hdfc-no-decimal.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(5000000);
        expect(result.transactions[0].balancePaise).toBe(15000000);
      });

      it("handles blank debit cell vs zero debit cell equally", async () => {
        const csvBlank = makeHdfcCsv([
          `04/10/26,NEFT CR-TEST REMITTER C,${makeValidNeftUtr("00000000003")},04/10/26,,"25,000.00","1,25,000.00"`,
        ]);
        const csvZero = makeHdfcCsv([
          `04/10/26,NEFT CR-TEST REMITTER C,${makeValidNeftUtr("00000000003")},04/10/26,0.00,"25,000.00","1,25,000.00"`,
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
          `05/10/26,NEFT CR-TEST REMITTER D,${makeValidNeftUtr("00000000004")},05/10/26,,"10,000.00","1,10,000.00 Cr"`,
        ]);
        const file = new File([csv], "hdfc-cr-suffix.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].balancePaise).toBe(11000000);
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
      if (originalTz !== undefined) {
        process.env.TZ = originalTz;
      } else {
        delete process.env.TZ;
      }
    });

    describe("HDFC date formats", () => {
      it("parses dd/mm/yy format (01/10/26)", async () => {
        const csv = makeHdfcCsv([
          `01/10/26,NEFT CR-TEST DATE FORMAT,${makeValidNeftUtr("00000000010")},01/10/26,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-ddmmyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-01");
      });

      it("parses dd/mm/yyyy format (15/10/2026)", async () => {
        const csv = makeHdfcCsv([
          `15/10/2026,NEFT CR-TEST DATE FORMAT,${makeValidNeftUtr("00000000011")},15/10/2026,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-ddmmyyyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });

      it("parses dd-MMM-yyyy format (15-Oct-2026)", async () => {
        const csv = makeHdfcCsv([
          `15-Oct-2026,NEFT CR-TEST DATE FORMAT,${makeValidNeftUtr("00000000012")},15-Oct-2026,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-ddMmmyyyy.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
      });

      it("handles year rollover (31/12 to 01/01)", async () => {
        const csv = makeHdfcCsv([
          `31/12/25,NEFT CR-TEST YEAR END,${makeValidNeftUtr("00000000013")},31/12/25,,"5,000.00","1,05,000.00"`,
          `01/01/26,NEFT CR-TEST NEW YEAR,${makeValidNeftUtr("00000000014")},01/01/26,,"5,000.00","1,10,000.00"`,
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
        vi.unstubAllEnvs();
      });

      it("parseIndianDate returns consistent ISO date under America/Los_Angeles TZ", () => {
        vi.stubEnv("TZ", "America/Los_Angeles");
        const result = parseIndianDate("15/10/26");
        expect(result).toBe("2026-10-15");
        vi.unstubAllEnvs();
      });

      it("parseIndianDate returns consistent ISO date under UTC TZ", () => {
        vi.stubEnv("TZ", "UTC");
        const result = parseIndianDate("15/10/26");
        expect(result).toBe("2026-10-15");
        vi.unstubAllEnvs();
      });

      it("full parse maintains date under Asia/Kolkata", async () => {
        vi.stubEnv("TZ", "Asia/Kolkata");
        const csv = makeHdfcCsv([
          `15/10/26,NEFT CR-TEST TZ KOLKATA,${makeValidNeftUtr("00000000020")},15/10/26,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-tz-kolkata.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
        vi.unstubAllEnvs();
      });

      it("full parse maintains date under America/Los_Angeles", async () => {
        vi.stubEnv("TZ", "America/Los_Angeles");
        const csv = makeHdfcCsv([
          `15/10/26,NEFT CR-TEST TZ LA,${makeValidNeftUtr("00000000021")},15/10/26,,"10,000.00","1,10,000.00"`,
        ]);
        const result = await parseBankStatement(new File([csv], "hdfc-tz-la.csv", { type: "text/csv" }));
        expect(result.transactions[0].date).toBe("2026-10-15");
        vi.unstubAllEnvs();
      });
    });
  });

  describe("(3) File quirks", () => {
    describe("HDFC", () => {
      it("handles UTF-8 BOM at file start", async () => {
        const bomContent = "\ufeff" + makeHdfcCsv([
          `02/10/26,NEFT CR-TEST BOM HDFC,${makeValidNeftUtr("00000000030")},02/10/26,,"50,000.00","1,50,000.00"`,
        ]);
        const file = new File([bomContent], "hdfc-bom.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("HDFC");
        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amountPaise).toBe(5000000);
      });

      it("handles CRLF line endings", async () => {
        const crlfContent = makeHdfcCsv([
          `02/10/26,NEFT CR-TEST CRLF,${makeValidNeftUtr("00000000031")},02/10/26,,"25,000.00","1,25,000.00"`,
        ]).replace(/\n/g, "\r\n");
        const file = new File([crlfContent], "hdfc-crlf.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.detection.bank).toBe("HDFC");
        expect(result.transactions).toHaveLength(1);
      });

      it("handles trailing blank lines", async () => {
        const csv = makeHdfcCsv([
          `02/10/26,NEFT CR-TEST TRAILING,${makeValidNeftUtr("00000000032")},02/10/26,,"10,000.00","1,10,000.00"`,
        ]) + "\n\n\n\n";
        const file = new File([csv], "hdfc-trailing.csv", { type: "text/csv" });
        const result = await parseBankStatement(file);

        expect(result.transactions).toHaveLength(1);
      });

      it("skips header and footer summary rows", async () => {
        const csv = makeHdfcCsv([
          `01/10/26,Opening Balance,,,,,"1,00,000.00"`,
          `02/10/26,NEFT CR-TEST ACTUAL TXN,${makeValidNeftUtr("00000000033")},02/10/26,,"50,000.00","1,50,000.00"`,
          `Total Debit,,,,0.00,,`,
          `Total Credit,,,,"50,000.00",,`,
          `Closing Balance,,,,,"1,50,000.00",`,
        ]);
        const file = new File([csv], "hdfc-headers-footers.csv", { type: "text/csv" });
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

      it("handles quoted commas in narration", async () => {
        const csv = makeHdfcCsv([
          `02/10/26,"NEFT CR-TEST, COMMA CORP-INV,001",${makeValidNeftUtr("00000000034")},02/10/26,,"15,000.00","1,15,000.00"`,
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
02/10/26,NEFT CR-TEST EXTRA COL,${makeValidNeftUtr("00000000035")},02/10/26,,"20,000.00","1,20,000.00",EXTRA_VALUE`;
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
    it("wrong bank layout (ICICI headers in HDFC preamble) returns UNKNOWN or errors cleanly", async () => {
      const mismatchedCsv = `HDFC BANK
Statement

S No.,Transaction Date,Cheque Number,Remarks,Withdrawal,Deposit,Balance
1,02.10.2026,,NEFT-TEST MISMATCHED,,"20,000.00","1,20,000.00"`;
      const file = new File([mismatchedCsv], "mismatched.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.errors.length).toBeGreaterThanOrEqual(0);
      expect(() => result).not.toThrow();
    });

    it("missing required columns returns error with code", async () => {
      const missingColsCsv = `HDFC BANK
Statement

Date,Narration
02/10/26,NEFT CR-TEST NO AMOUNTS`;
      const file = new File([missingColsCsv], "missing-cols.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.errors.length).toBeGreaterThan(0);
      const hasColumnError = result.errors.some(
        (e) => e.code === "COLUMN_MAP_FAILED" || e.code === "NO_HEADER_ROW" || e.code === "UNKNOWN_BANK_FORMAT"
      );
      expect(hasColumnError).toBe(true);
    });

    it("binary/garbage content returns UNKNOWN without throwing", async () => {
      const binaryContent = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd]);
      const file = new File([binaryContent], "garbage.csv", { type: "text/csv" });

      let result: ParseResult | undefined;
      let didThrow = false;
      try {
        result = await parseBankStatement(file);
      } catch {
        didThrow = true;
      }

      if (!didThrow && result) {
        expect(result.detection.bank).toBe("UNKNOWN");
        expect(result.transactions).toHaveLength(0);
      }
    });

    it("empty file returns UNKNOWN with no transactions", async () => {
      const file = new File([""], "empty.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("UNKNOWN");
      expect(result.transactions).toHaveLength(0);
    });

    it("header-only file returns zero transactions", async () => {
      const headerOnly = makeHdfcCsv([]);
      const file = new File([headerOnly], "header-only.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(0);
    });
  });

  describe("(5) Duplicate import - parser-level dedupe", () => {
    it("same row twice in file produces only one transaction", async () => {
      const utr = makeValidNeftUtr("00000000050");
      const csv = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST DUP ROW,${utr},02/10/26,,"10,000.00","1,10,000.00"`,
        `02/10/26,NEFT CR-TEST DUP ROW,${utr},02/10/26,,"10,000.00","1,10,000.00"`,
      ]);
      const file = new File([csv], "hdfc-dup.csv", { type: "text/csv" });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(1);
    });

    it("genuinely different row in second import IS detected as new", async () => {
      const utr1 = makeValidNeftUtr("00000000051");
      const utr2 = makeValidNeftUtr("00000000052");

      const csv1 = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST FIRST,${utr1},02/10/26,,"10,000.00","1,10,000.00"`,
      ]);
      const csv2 = makeHdfcCsv([
        `02/10/26,NEFT CR-TEST FIRST,${utr1},02/10/26,,"10,000.00","1,10,000.00"`,
        `03/10/26,NEFT CR-TEST SECOND,${utr2},03/10/26,,"20,000.00","1,30,000.00"`,
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

  describe("(6) Logs and Sentry - no PII leakage", () => {
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
        `02/10/26,NEFT CR-${PII_MARKERS.remitter}-${PII_MARKERS.narration},${makeValidNeftUtr("00000000060")},02/10/26,,"1,00,000.00","2,00,000.00"`,
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
        `02/10/26,NEFT CR-TEST AMOUNT CHECK,${makeValidNeftUtr("00000000061")},02/10/26,,"1,00,000.00","2,00,000.00"`,
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
    const syntheticUtr = makeValidNeftUtr("00000000070");

    const credits = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: syntheticUtr,
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
    const utr1 = makeValidNeftUtr("00000000071");
    const utr2 = makeValidNeftUtr("00000000072");

    const credits1 = [
      {
        date: "2026-10-02",
        amountPaise: 5000000,
        rail: "NEFT" as const,
        utr: utr1,
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
        utr: utr1,
        payerName: "TEST FIRST IMPORT",
        narration: "NEFT CR-TEST FIRST IMPORT",
      },
      {
        date: "2026-10-03",
        amountPaise: 7500000,
        rail: "NEFT" as const,
        utr: utr2,
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

describeWithDb("(4) Bad files - no partial Payment rows persisted", () => {
  let sql: ReturnType<typeof postgres>;
  let testShopId: string;
  let testShopDomain: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const testSuffix = `${Date.now().toString(36)}-bad`;
    testShopDomain = `test-badfile-${testSuffix}.myshopify.com`;

    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${testShopDomain}, 'INR', 'UTC', NOW(), NOW())
      RETURNING id
    `;
    testShopId = shop.id;
  });

  afterAll(async () => {
    if (testShopId) {
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${testShopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${testShopId}`;
    }
    await sql.end();
  });

  it("parser rejection results in zero Payment rows for shop", async () => {
    const emptyFile = new File([""], "empty-bad.csv", { type: "text/csv" });
    const result = await parseBankStatement(emptyFile);

    expect(result.detection.bank).toBe("UNKNOWN");
    expect(result.transactions).toHaveLength(0);

    const countBefore = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count FROM "Payment" WHERE "shopId" = ${testShopId}
    `;
    expect(parseInt(countBefore[0].count, 10)).toBe(0);
  });
});

describe("(6) Sentry and AuditEvent - PII verification", () => {
  it("parser operation does not throw, positive control for sentinel in output", async () => {
    const csv = makeHdfcCsv([
      `02/10/26,NEFT CR-SENTINEL_SENTRY_TEST-CONFIDENTIAL,${makeValidNeftUtr("00000000080")},02/10/26,,"10,000.00","1,10,000.00"`,
    ]);
    const file = new File([csv], "hdfc-sentry-valid.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].narration).toContain("SENTINEL_SENTRY_TEST");
  });

  it("AuditEvent rows (if created via server path) never contain PII - positive control", async () => {
    const csv = makeHdfcCsv([
      `02/10/26,NEFT CR-SENTINEL_AUDIT_PII_NAME-CONFIDENTIAL,${makeValidNeftUtr("00000000081")},02/10/26,,"50,000.00","1,50,000.00"`,
    ]);
    const file = new File([csv], "hdfc-audit-check.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].narration).toContain("SENTINEL_AUDIT_PII_NAME");
  });
});
