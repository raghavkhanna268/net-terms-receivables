/**
 * Bank-statement upload robustness tests (parser-level, no DB).
 *
 * Tests pure parsing edge cases that don't require database:
 * - Case 3: UTF-8 BOM, CRLF line endings, trailing blank lines, quoted fields with commas
 * - Case 4: Date formats, Indian amounts, Dr/Cr and signed-amount columns
 * - Case 5: Malformed row mid-file behavior (skips with error count)
 *
 * All fixtures are SYNTHETIC - no real bank data.
 */

import { describe, it, expect } from "vitest";
import { parseBankStatement } from "../index.js";
import { validateImportRequest, MAX_IMPORT_ROWS } from "~/routes/app.imports";

function makeValidNeftUtr(suffix: string): string {
  const paddedSuffix = suffix.replace(/[^0-9]/g, "").padStart(11, "0").slice(0, 11);
  return `HDFCN${paddedSuffix}`;
}

describe("Case 1: Oversized payload validation (no parser call)", () => {
  it("rejects payload with >1000 rows before parser is invoked", () => {
    const credits = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
      date: "2026-10-15",
      amountPaise: 100000,
      rail: "NEFT",
      utr: makeValidNeftUtr(String(i).padStart(11, "0")),
      payerName: `TEST-PAYER-${i}`,
      narration: `NEFT CR-TEST-PAYER-${i}-PAYMENT`,
    }));

    const payload = {
      bank: "HDFC",
      fileName: "oversized-test.csv",
      credits,
    };

    const { valid, errors } = validateImportRequest(payload);

    expect(valid).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.path === "credits" && e.message.includes("1,001"))).toBe(true);
    expect(errors.some((e) => e.message.includes("per-import limit"))).toBe(true);
  });

  it("accepts exactly 1000 rows (boundary)", () => {
    const credits = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => ({
      date: "2026-10-15",
      amountPaise: 100000,
      rail: "NEFT",
      utr: makeValidNeftUtr(`9${String(i).padStart(10, "0")}`),
      payerName: `TEST-BOUNDARY-${i}`,
      narration: `NEFT CR-TEST-BOUNDARY-${i}`,
    }));

    const payload = {
      bank: "HDFC",
      fileName: "boundary-test.csv",
      credits,
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).not.toBeNull();
    expect(errors).toHaveLength(0);
  });
});

describe("Case 2: Invalid inputs validation", () => {
  it("empty credits array gives clear validation error", () => {
    const payload = {
      bank: "HDFC",
      fileName: "empty.csv",
      credits: [],
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).toBeNull();
    expect(errors.some((e) => e.message.includes("At least one credit row"))).toBe(true);
  });

  it("invalid bank type gives clear validation error", () => {
    const payload = {
      bank: "KOTAK",
      fileName: "kotak.csv",
      credits: [
        {
          date: "2026-10-15",
          amountPaise: 100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).toBeNull();
    expect(errors.some((e) => e.path === "bank")).toBe(true);
  });

  it("invalid rail type gives clear validation error", () => {
    const payload = {
      bank: "HDFC",
      fileName: "badrail.csv",
      credits: [
        {
          date: "2026-10-15",
          amountPaise: 100000,
          rail: "SWIFT",
          narration: "SWIFT CR-TEST",
        },
      ],
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).toBeNull();
    expect(errors.some((e) => e.message.includes("Rail must be one of"))).toBe(true);
  });

  it("invalid date format (DD-MM-YYYY instead of YYYY-MM-DD) gives clear validation error", () => {
    const payload = {
      bank: "HDFC",
      fileName: "baddate.csv",
      credits: [
        {
          date: "31-12-2026",
          amountPaise: 100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).toBeNull();
    expect(errors.some((e) => e.message.includes("YYYY-MM-DD"))).toBe(true);
  });

  it("negative amountPaise gives clear validation error", () => {
    const payload = {
      bank: "HDFC",
      fileName: "negative.csv",
      credits: [
        {
          date: "2026-10-15",
          amountPaise: -100000,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).toBeNull();
    expect(errors.some((e) => e.message.includes("positive integer"))).toBe(true);
  });

  it("zero amountPaise gives clear validation error", () => {
    const payload = {
      bank: "HDFC",
      fileName: "zero.csv",
      credits: [
        {
          date: "2026-10-15",
          amountPaise: 0,
          rail: "NEFT",
          narration: "NEFT CR-TEST",
        },
      ],
    };

    const { valid, errors } = validateImportRequest(payload);
    expect(valid).toBeNull();
    expect(errors.some((e) => e.message.includes("positive integer"))).toBe(true);
  });
});

describe("Case 3: UTF-8 BOM, CRLF line endings, trailing blank lines, quoted fields", () => {
  it("UTF-8 BOM at file start parses correctly", async () => {
    const bomContent =
      "\ufeffHDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT CR-TEST-BOM-CORP-INV001,${makeValidNeftUtr("11111111111")},02/10/26,,"50,000.00","1,50,000.00"`;

    const file = new File([bomContent], "bom-test.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].amountPaise).toBe(5000000);
  });

  it("CRLF line endings parse correctly", async () => {
    const crlfContent =
      "HDFC BANK\r\nStatement\r\n\r\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\r\n" +
      `02/10/26,NEFT CR-TEST-CRLF-CORP,${makeValidNeftUtr("22222222222")},02/10/26,,"25,000.00","1,25,000.00"\r\n`;

    const file = new File([crlfContent], "crlf-test.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].amountPaise).toBe(2500000);
  });

  it("trailing blank lines parse correctly", async () => {
    const trailingContent =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT CR-TEST-TRAILING-CORP,${makeValidNeftUtr("33333333333")},02/10/26,,"10,000.00","1,10,000.00"\n\n\n\n`;

    const file = new File([trailingContent], "trailing-test.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions.length).toBe(1);
  });

  it("quoted fields containing commas parse correctly", async () => {
    const quotedContent =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,"NEFT CR-TEST, COMMA CORP-INV001",${makeValidNeftUtr("44444444444")},02/10/26,,"15,000.00","1,15,000.00"`;

    const file = new File([quotedContent], "quoted-test.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].narration).toContain("TEST, COMMA CORP");
  });
});

describe("Case 4: Date formats and Indian amount grouping", () => {
  it("parses dd/mm/yyyy date format", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `15/10/2026,NEFT CR-TEST-DDMMYYYY,${makeValidNeftUtr("55555555555")},15/10/2026,,"20,000.00","1,20,000.00"`;

    const file = new File([content], "ddmmyyyy.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].date).toBe("2026-10-15");
  });

  it("parses dd-MMM-yy date format", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `15-Oct-26,NEFT CR-TEST-DDMMMYY,${makeValidNeftUtr("66666666666")},15-Oct-26,,"30,000.00","1,30,000.00"`;

    const file = new File([content], "ddmmmyy.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].date).toBe("2026-10-15");
  });

  it("parses dd/mm/yy date format", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `15/10/26,NEFT CR-TEST-DDMMYY,${makeValidNeftUtr("77777777777")},15/10/26,,"40,000.00","1,40,000.00"`;

    const file = new File([content], "ddmmyy.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].date).toBe("2026-10-15");
  });

  it("parses Indian digit grouping (1,23,456.78)", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT CR-TEST-INDIAN-AMT,${makeValidNeftUtr("88888888888")},02/10/26,,"1,23,456.78","2,23,456.78"`;

    const file = new File([content], "indian-amt.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(1);
    expect(result.transactions[0].amountPaise).toBe(12345678);
  });

  it("parses separate Dr/Cr columns correctly", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT DR-TEST-DEBIT,${makeValidNeftUtr("99999999991")},02/10/26,"5,000.00",,"1,00,000.00"\n` +
      `03/10/26,NEFT CR-TEST-CREDIT,${makeValidNeftUtr("99999999992")},03/10/26,,"10,000.00","1,10,000.00"`;

    const file = new File([content], "dr-cr.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(2);

    const debit = result.transactions.find((t) => t.direction === "DR");
    const credit = result.transactions.find((t) => t.direction === "CR");

    expect(debit).toBeDefined();
    expect(debit!.amountPaise).toBe(500000);

    expect(credit).toBeDefined();
    expect(credit!.amountPaise).toBe(1000000);
  });

  it("parses single signed-amount column (ICICI format) correctly", async () => {
    const content = `ICICI BANK
Statement of Account
Account No: 00123456789012

S No.,Transaction Date,Cheque Number,Remarks,Withdrawal,Deposit,Balance
1,01.10.2026,,B/F,,,100000.00
2,02.10.2026,,NEFT-TEST-SIGNED-DEBIT,-5000.00,,95000.00
3,03.10.2026,,NEFT-TEST-SIGNED-CREDIT,,10000.00,105000.00`;

    const file = new File([content], "signed-amt.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("ICICI");

    const debit = result.transactions.find((t) => t.direction === "DR");
    const credit = result.transactions.find((t) => t.direction === "CR");

    expect(debit).toBeDefined();
    expect(debit!.amountPaise).toBe(500000);

    expect(credit).toBeDefined();
    expect(credit!.amountPaise).toBe(1000000);
  });
});

describe("Case 5: Malformed row mid-file (current behavior: skips with error count)", () => {
  it("skips malformed row and continues parsing valid rows", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT CR-TEST-BEFORE-MALFORMED,${makeValidNeftUtr("10101010101")},02/10/26,,"10,000.00","1,10,000.00"\n` +
      `MALFORMED ROW WITH INVALID DATA,,,,,\n` +
      `03/10/26,NEFT CR-TEST-AFTER-MALFORMED,${makeValidNeftUtr("10101010102")},03/10/26,,"20,000.00","1,30,000.00"`;

    const file = new File([content], "malformed-mid.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(2);
    expect(result.skippedRows).toBeGreaterThan(0);

    expect(result.transactions[0].narration).toContain("BEFORE-MALFORMED");
    expect(result.transactions[1].narration).toContain("AFTER-MALFORMED");
  });

  it("reports coded error ROW_PARSE_FAILED for unparseable row", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT CR-TEST-VALID,${makeValidNeftUtr("20202020201")},02/10/26,,"10,000.00","1,10,000.00"\n` +
      `BADDATE,Some narration with data but bad date,REF123,BADDATE,,"5,000.00","1,15,000.00"\n` +
      `03/10/26,NEFT CR-TEST-VALID2,${makeValidNeftUtr("20202020202")},03/10/26,,"15,000.00","1,30,000.00"`;

    const file = new File([content], "coded-error.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length).toBe(2);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].code).toBe("ROW_PARSE_FAILED");
  });

  it("row accounting: transactions + errors + skippedRows === totalRows", async () => {
    const content =
      "HDFC BANK\nStatement\n\nDate,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance\n" +
      `02/10/26,NEFT CR-TEST-ROW1,${makeValidNeftUtr("30303030301")},02/10/26,,"10,000.00","1,10,000.00"\n` +
      `MALFORMED,,,,,\n` +
      `03/10/26,NEFT CR-TEST-ROW2,${makeValidNeftUtr("30303030302")},03/10/26,,"20,000.00","1,30,000.00"\n` +
      `\n\n`;

    const file = new File([content], "row-accounting.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.transactions.length + result.errors.length + result.skippedRows).toBe(
      result.totalRows
    );
  });
});

describe("File type detection", () => {
  it("detects CSV from extension", async () => {
    const content = "HDFC BANK\nDate,Narration\n2026-10-01,Test";
    const file = new File([content], "test.csv", { type: "text/csv" });

    const result = await parseBankStatement(file);
    expect(result.detection.bank).toBeDefined();
  });

  it("rejects invalid XLS magic bytes with error", async () => {
    const xlsMagic = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const file = new File([xlsMagic], "test.xls", { type: "application/vnd.ms-excel" });

    await expect(parseBankStatement(file)).rejects.toThrow();
  });
});
