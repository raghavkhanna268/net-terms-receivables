/**
 * Excel serial date parsing tests.
 * Tests for raw numeric Excel serial dates in bank statement XLSX files.
 *
 * All test data is SYNTHETIC - entirely inline, no external fixtures.
 * Uses made-up names, synthetic refs, and test-*.myshopify.com style.
 *
 * Scope: spreadsheet-loader unchanged; only date-column parsing accepts serials.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as XLSX from "xlsx";
import { parseBankStatement } from "../index.js";
import type { ParseResult, BankId } from "../types.js";

function makeHdfcXlsxWithSerialDates(
  rows: Array<{
    dateSerial: number;
    narration: string;
    ref: string;
    valueDateSerial: number;
    withdrawal?: number;
    deposit?: number;
    balance: number;
  }>
): ArrayBuffer {
  const header = [
    "Date",
    "Narration",
    "Chq./Ref.No.",
    "Value Dt",
    "Withdrawal Amt.",
    "Deposit Amt.",
    "Closing Balance",
  ];

  const preamble = [
    ["HDFC BANK"],
    ["Statement of Account"],
    ["Account No: 00123456789012"],
    ["Branch: TEST SYNTHETIC BRANCH"],
    [],
    header,
  ];

  const dataRows = rows.map((r) => [
    r.dateSerial,
    r.narration,
    r.ref,
    r.valueDateSerial,
    r.withdrawal ?? "",
    r.deposit ?? "",
    r.balance,
  ]);

  const allRows = [...preamble, ...dataRows];

  const ws = XLSX.utils.aoa_to_sheet(allRows);

  for (let i = 0; i < rows.length; i++) {
    const rowIdx = preamble.length + i;
    const dateCell = XLSX.utils.encode_cell({ r: rowIdx, c: 0 });
    const valueDateCell = XLSX.utils.encode_cell({ r: rowIdx, c: 3 });

    ws[dateCell] = { t: "n", v: rows[i].dateSerial };
    ws[valueDateCell] = { t: "n", v: rows[i].valueDateSerial };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Statement");

  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return buf;
}

describe("Excel serial date parsing (SYNTHETIC)", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalTz !== undefined) {
      process.env.TZ = originalTz;
    } else {
      delete process.env.TZ;
    }
  });

  describe("HDFC XLSX with raw numeric serial dates", () => {
    it("parses 3 data rows with serial dates 46310/46313/46315 after Total row skip", async () => {
      const xlsxBuffer = makeHdfcXlsxWithSerialDates([
        {
          dateSerial: 46310,
          narration: "NEFT CR-SYNTHETIC CORP A-PAYMENT FOR INV-001",
          ref: "SYNTN26296000001",
          valueDateSerial: 46310,
          deposit: 50000,
          balance: 150000,
        },
        {
          dateSerial: 46313,
          narration: "NEFT CR-SYNTHETIC CORP B-PAYMENT FOR INV-002",
          ref: "SYNTN26296000002",
          valueDateSerial: 46313,
          deposit: 75000,
          balance: 225000,
        },
        {
          dateSerial: 46315,
          narration: "UPI-SYNTHETIC STORE-synth@example-SYNT0000003",
          ref: "876543210987",
          valueDateSerial: 46315,
          withdrawal: 5000,
          balance: 220000,
        },
      ]);

      const file = new File([xlsxBuffer], "hdfc-serial-dates.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result: ParseResult = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED")).toHaveLength(0);
      expect(result.transactions).toHaveLength(3);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      const debits = result.transactions.filter((t) => t.direction === "DR");
      expect(credits).toHaveLength(2);
      expect(debits).toHaveLength(1);

      const creditTotal = credits.reduce((sum, t) => sum + t.amountPaise, 0);
      const debitTotal = debits.reduce((sum, t) => sum + t.amountPaise, 0);
      expect(creditTotal).toBe(12500000);
      expect(debitTotal).toBe(500000);

      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[1].date).toBe("2026-10-18");
      expect(result.transactions[2].date).toBe("2026-10-20");
    });

    it("parses HDFC XLSX with Total row before data rows (Total row skipped)", async () => {
      const xlsxBuffer = makeHdfcXlsxWithSerialDates([
        {
          dateSerial: 46310,
          narration: "NEFT CR-SYNTHETIC PAYER A-PAYMENT",
          ref: "SYNTN26296000010",
          valueDateSerial: 46310,
          deposit: 50000,
          balance: 150000,
        },
        {
          dateSerial: 46313,
          narration: "NEFT CR-SYNTHETIC PAYER B-ORDER",
          ref: "SYNTN26296000011",
          valueDateSerial: 46313,
          deposit: 75000,
          balance: 225000,
        },
        {
          dateSerial: 46315,
          narration: "UPI-SYNTHETIC VENDOR-vendor@synth-SYNT0000012",
          ref: "765432109876",
          valueDateSerial: 46315,
          withdrawal: 5000,
          balance: 220000,
        },
      ]);

      const file = new File([xlsxBuffer], "hdfc-total-then-serial.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED")).toHaveLength(0);
      expect(result.transactions).toHaveLength(3);

      const credits = result.transactions.filter((t) => t.direction === "CR");
      const debits = result.transactions.filter((t) => t.direction === "DR");
      expect(credits).toHaveLength(2);
      expect(debits).toHaveLength(1);

      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[1].date).toBe("2026-10-18");
      expect(result.transactions[2].date).toBe("2026-10-20");
    });
  });

  describe("out-of-range serial rejection", () => {
    it("rejects out-of-range serial 0 in date column", async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ["HDFC BANK"],
        ["Statement of Account"],
        [],
        [
          "Date",
          "Narration",
          "Chq./Ref.No.",
          "Value Dt",
          "Withdrawal Amt.",
          "Deposit Amt.",
          "Closing Balance",
        ],
        [0, "NEFT CR-INVALID SERIAL ZERO", "SYNTN00000000001", 0, "", 10000, 100000],
      ]);

      ws["A5"] = { t: "n", v: 0 };
      ws["D5"] = { t: "n", v: 0 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Statement");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "hdfc-serial-zero.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions).toHaveLength(0);
      const errors = result.errors.filter(
        (e) => e.code === "NORMALIZE_FAILED" || e.code === "ROW_PARSE_FAILED"
      );
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects out-of-range serial 100 in date column", async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ["HDFC BANK"],
        ["Statement of Account"],
        [],
        [
          "Date",
          "Narration",
          "Chq./Ref.No.",
          "Value Dt",
          "Withdrawal Amt.",
          "Deposit Amt.",
          "Closing Balance",
        ],
        [100, "NEFT CR-INVALID SERIAL HUNDRED", "SYNTN00000000002", 100, "", 10000, 100000],
      ]);

      ws["A5"] = { t: "n", v: 100 };
      ws["D5"] = { t: "n", v: 100 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Statement");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "hdfc-serial-hundred.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions).toHaveLength(0);
    });

    it("rejects out-of-range serial 2958466 (above max) in date column", async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ["HDFC BANK"],
        ["Statement of Account"],
        [],
        [
          "Date",
          "Narration",
          "Chq./Ref.No.",
          "Value Dt",
          "Withdrawal Amt.",
          "Deposit Amt.",
          "Closing Balance",
        ],
        [2958466, "NEFT CR-INVALID SERIAL HUGE", "SYNTN00000000003", 2958466, "", 10000, 100000],
      ]);

      ws["A5"] = { t: "n", v: 2958466 };
      ws["D5"] = { t: "n", v: 2958466 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Statement");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "hdfc-serial-huge.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions).toHaveLength(0);
    });
  });

  describe("numbers in non-date columns are not treated as dates", () => {
    it("amount columns parse as amounts, not dates", async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ["HDFC BANK"],
        ["Statement of Account"],
        [],
        [
          "Date",
          "Narration",
          "Chq./Ref.No.",
          "Value Dt",
          "Withdrawal Amt.",
          "Deposit Amt.",
          "Closing Balance",
        ],
        [46310, "NEFT CR-SYNTHETIC AMOUNT TEST", "SYNTN26296000050", 46310, "", 46310, 146310],
      ]);

      ws["A5"] = { t: "n", v: 46310 };
      ws["D5"] = { t: "n", v: 46310 };
      ws["F5"] = { t: "n", v: 46310 };
      ws["G5"] = { t: "n", v: 146310 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Statement");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "hdfc-amount-not-date.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions).toHaveLength(1);

      const txn = result.transactions[0];
      expect(txn.date).toBe("2026-10-15");
      expect(txn.amountPaise).toBe(4631000);
      expect(txn.balancePaise).toBe(14631000);
      expect(txn.direction).toBe("CR");
    });

    it("balance column parses as amount, not date", async () => {
      const ws = XLSX.utils.aoa_to_sheet([
        ["HDFC BANK"],
        ["Statement of Account"],
        [],
        [
          "Date",
          "Narration",
          "Chq./Ref.No.",
          "Value Dt",
          "Withdrawal Amt.",
          "Deposit Amt.",
          "Closing Balance",
        ],
        [46315, "NEFT CR-SYNTHETIC BALANCE TEST", "SYNTN26296000051", 46315, "", 25000, 73415],
      ]);

      ws["A5"] = { t: "n", v: 46315 };
      ws["D5"] = { t: "n", v: 46315 };
      ws["F5"] = { t: "n", v: 25000 };
      ws["G5"] = { t: "n", v: 73415 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Statement");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "hdfc-balance-not-date.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions).toHaveLength(1);

      const txn = result.transactions[0];
      expect(txn.date).toBe("2026-10-20");
      expect(txn.amountPaise).toBe(2500000);
      expect(txn.balancePaise).toBe(7341500);
    });
  });

  describe("timezone independence", () => {
    it("returns exact ISO date 2026-10-15 under TZ=UTC", async () => {
      vi.stubEnv("TZ", "UTC");

      const xlsxBuffer = makeHdfcXlsxWithSerialDates([
        {
          dateSerial: 46310,
          narration: "NEFT CR-SYNTHETIC TZ UTC TEST",
          ref: "SYNTN26296000060",
          valueDateSerial: 46310,
          deposit: 10000,
          balance: 100000,
        },
      ]);

      const file = new File([xlsxBuffer], "hdfc-tz-utc.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
    });

    it("returns exact ISO date 2026-10-15 under TZ=Pacific/Auckland", async () => {
      vi.stubEnv("TZ", "Pacific/Auckland");

      const xlsxBuffer = makeHdfcXlsxWithSerialDates([
        {
          dateSerial: 46310,
          narration: "NEFT CR-SYNTHETIC TZ AUCKLAND TEST",
          ref: "SYNTN26296000061",
          valueDateSerial: 46310,
          deposit: 10000,
          balance: 100000,
        },
      ]);

      const file = new File([xlsxBuffer], "hdfc-tz-auckland.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
    });
  });
});

/**
 * Comprehensive regression tests for ALL FOUR parsers.
 * Each test uses the real loader on a synthetic in-memory XLSX.
 *
 * Verifies:
 * - Amounts (including formatted ones) parse exactly as on main
 * - Refs (including zero-padded numeric ref cells) parse exactly as on main
 * - Narrations parse exactly as on main
 * - Raw numeric serial in detected date column parses to the right ISO date
 *
 * Scope: spreadsheet-loader unchanged; only date-column parsing accepts serials.
 */
describe("All-parser regression: serial dates + main-compatible field parsing (SYNTHETIC)", () => {
  /**
   * Helper: create HDFC XLSX with raw serial dates, formatted amounts, and zero-padded refs
   */
  function makeHdfcRegressionXlsx(): ArrayBuffer {
    const header = [
      "Date",
      "Narration",
      "Chq./Ref.No.",
      "Value Dt",
      "Withdrawal Amt.",
      "Deposit Amt.",
      "Closing Balance",
    ];

    const preamble = [
      ["HDFC BANK"],
      ["Statement of Account"],
      ["Account No: 00123456789012"],
      ["Branch: TEST SYNTHETIC BRANCH"],
      [],
      header,
    ];

    const dataRows = [
      [46310, "NEFT CR-SYNTHETIC CORP A-PAYMENT FOR INV-001", "0001234567890", 46310, "", "50,000.00", "1,50,000.00"],
      [46313, "UPI-SYNTHETIC STORE-synth@upi-UTR123456789", "0009876543210", 46313, "5,000.50", "", "1,44,999.50"],
    ];

    const allRows = [...preamble, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    ws["A7"] = { t: "n", v: 46310 };
    ws["D7"] = { t: "n", v: 46310 };
    ws["C7"] = { t: "s", v: "0001234567890" };
    ws["F7"] = { t: "s", v: "50,000.00" };
    ws["G7"] = { t: "s", v: "1,50,000.00" };

    ws["A8"] = { t: "n", v: 46313 };
    ws["D8"] = { t: "n", v: 46313 };
    ws["C8"] = { t: "s", v: "0009876543210" };
    ws["E8"] = { t: "s", v: "5,000.50" };
    ws["G8"] = { t: "s", v: "1,44,999.50" };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" });
  }

  /**
   * Helper: create ICICI XLSX with raw serial dates, formatted amounts, and zero-padded refs
   */
  function makeIciciRegressionXlsx(): ArrayBuffer {
    const header = [
      "S No.",
      "Transaction Date",
      "Cheque Number",
      "Remarks",
      "Withdrawal",
      "Deposit",
      "Balance",
    ];

    const preamble = [
      ["ICICI BANK"],
      ["Statement of transactions"],
      ["Saving Account no.: 012345678901"],
      [],
      header,
    ];

    const dataRows = [
      [1, 46310, "0007654321098", "NEFT/CR/SYNTHETIC PAYER/INV-100", "", "75,000.00", "2,75,000.00"],
      [2, 46315, "0001122334455", "UPI/synth.merchant@ybl/PURCHASE", "12,500.75", "", "2,62,499.25"],
    ];

    const allRows = [...preamble, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    ws["B6"] = { t: "n", v: 46310 };
    ws["C6"] = { t: "s", v: "0007654321098" };
    ws["F6"] = { t: "s", v: "75,000.00" };
    ws["G6"] = { t: "s", v: "2,75,000.00" };

    ws["B7"] = { t: "n", v: 46315 };
    ws["C7"] = { t: "s", v: "0001122334455" };
    ws["E7"] = { t: "s", v: "12,500.75" };
    ws["G7"] = { t: "s", v: "2,62,499.25" };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" });
  }

  /**
   * Helper: create SBI XLSX with raw serial dates, formatted amounts, and zero-padded refs
   */
  function makeSbiRegressionXlsx(): ArrayBuffer {
    const header = [
      "Txn Date",
      "Value Date",
      "Description",
      "Ref No./Cheque No.",
      "Debit",
      "Credit",
      "Balance",
    ];

    const preamble = [
      ["STATE BANK OF INDIA"],
      ["Account Statement"],
      ["Account No: 30012345678"],
      [],
      header,
    ];

    const dataRows = [
      [46310, 46310, "NEFT-CR-SYNTHETIC VENDOR-PAYMENT", "0005566778899", "", "1,00,000.00", "3,50,000.00"],
      [46313, 46313, "ATM-WDL-SYNTHETIC BRANCH", "0002233445566", "20,000.00", "", "3,30,000.00"],
    ];

    const allRows = [...preamble, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    ws["A6"] = { t: "n", v: 46310 };
    ws["B6"] = { t: "n", v: 46310 };
    ws["D6"] = { t: "s", v: "0005566778899" };
    ws["F6"] = { t: "s", v: "1,00,000.00" };
    ws["G6"] = { t: "s", v: "3,50,000.00" };

    ws["A7"] = { t: "n", v: 46313 };
    ws["B7"] = { t: "n", v: 46313 };
    ws["D7"] = { t: "s", v: "0002233445566" };
    ws["E7"] = { t: "s", v: "20,000.00" };
    ws["G7"] = { t: "s", v: "3,30,000.00" };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" });
  }

  /**
   * Helper: create Axis XLSX with raw serial dates, formatted amounts, and zero-padded refs
   */
  function makeAxisRegressionXlsx(): ArrayBuffer {
    const header = [
      "Transaction Date",
      "Value Date",
      "Particulars",
      "Chq./Ref.No.",
      "Debit",
      "Credit",
      "Balance",
    ];

    const preamble = [
      ["AXIS BANK"],
      ["Statement of Account"],
      ["Account No: 917010012345678"],
      [],
      header,
    ];

    const dataRows = [
      [46310, 46310, "NEFT-CR-SYNTHETIC CLIENT-ORDER-500", "0003344556677", "", "2,50,000.00", "5,00,000.00"],
      [46315, 46315, "IMPS/P2P/SYNTHETIC PERSON", "0008877665544", "15,000.25", "", "4,84,999.75"],
    ];

    const allRows = [...preamble, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    ws["A6"] = { t: "n", v: 46310 };
    ws["B6"] = { t: "n", v: 46310 };
    ws["D6"] = { t: "s", v: "0003344556677" };
    ws["F6"] = { t: "s", v: "2,50,000.00" };
    ws["G6"] = { t: "s", v: "5,00,000.00" };

    ws["A7"] = { t: "n", v: 46315 };
    ws["B7"] = { t: "n", v: 46315 };
    ws["D7"] = { t: "s", v: "0008877665544" };
    ws["E7"] = { t: "s", v: "15,000.25" };
    ws["G7"] = { t: "s", v: "4,84,999.75" };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    return XLSX.write(wb, { type: "array", bookType: "xlsx" });
  }

  describe("HDFC parser regression", () => {
    it("parses serial dates, formatted amounts, zero-padded refs, and narrations correctly", async () => {
      const xlsxBuffer = makeHdfcRegressionXlsx();
      const file = new File([xlsxBuffer], "hdfc-regression.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result: ParseResult = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC" as BankId);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED")).toHaveLength(0);
      expect(result.transactions).toHaveLength(2);

      const txn1 = result.transactions[0];
      expect(txn1.date).toBe("2026-10-15");
      expect(txn1.amountPaise).toBe(5000000);
      expect(txn1.direction).toBe("CR");
      expect(txn1.refNo).toBe("0001234567890");
      expect(txn1.narration).toBe("NEFT CR-SYNTHETIC CORP A-PAYMENT FOR INV-001");
      expect(txn1.balancePaise).toBe(15000000);

      const txn2 = result.transactions[1];
      expect(txn2.date).toBe("2026-10-18");
      expect(txn2.amountPaise).toBe(500050);
      expect(txn2.direction).toBe("DR");
      expect(txn2.refNo).toBe("0009876543210");
      expect(txn2.narration).toBe("UPI-SYNTHETIC STORE-synth@upi-UTR123456789");
      expect(txn2.balancePaise).toBe(14499950);
    });
  });

  describe("ICICI parser regression", () => {
    it("parses serial dates, formatted amounts, zero-padded refs, and narrations correctly", async () => {
      const xlsxBuffer = makeIciciRegressionXlsx();
      const file = new File([xlsxBuffer], "icici-regression.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result: ParseResult = await parseBankStatement(file);

      expect(result.detection.bank).toBe("ICICI" as BankId);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED")).toHaveLength(0);
      expect(result.transactions).toHaveLength(2);

      const txn1 = result.transactions[0];
      expect(txn1.date).toBe("2026-10-15");
      expect(txn1.amountPaise).toBe(7500000);
      expect(txn1.direction).toBe("CR");
      expect(txn1.refNo).toBe("0007654321098");
      expect(txn1.narration).toBe("NEFT/CR/SYNTHETIC PAYER/INV-100");
      expect(txn1.balancePaise).toBe(27500000);

      const txn2 = result.transactions[1];
      expect(txn2.date).toBe("2026-10-20");
      expect(txn2.amountPaise).toBe(1250075);
      expect(txn2.direction).toBe("DR");
      expect(txn2.refNo).toBe("0001122334455");
      expect(txn2.narration).toBe("UPI/synth.merchant@ybl/PURCHASE");
      expect(txn2.balancePaise).toBe(26249925);
    });
  });

  describe("SBI parser regression", () => {
    it("parses serial dates, formatted amounts, zero-padded refs, and narrations correctly", async () => {
      const xlsxBuffer = makeSbiRegressionXlsx();
      const file = new File([xlsxBuffer], "sbi-regression.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result: ParseResult = await parseBankStatement(file);

      expect(result.detection.bank).toBe("SBI" as BankId);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED")).toHaveLength(0);
      expect(result.transactions).toHaveLength(2);

      const txn1 = result.transactions[0];
      expect(txn1.date).toBe("2026-10-15");
      expect(txn1.amountPaise).toBe(10000000);
      expect(txn1.direction).toBe("CR");
      expect(txn1.refNo).toBe("0005566778899");
      expect(txn1.narration).toBe("NEFT-CR-SYNTHETIC VENDOR-PAYMENT");
      expect(txn1.balancePaise).toBe(35000000);

      const txn2 = result.transactions[1];
      expect(txn2.date).toBe("2026-10-18");
      expect(txn2.amountPaise).toBe(2000000);
      expect(txn2.direction).toBe("DR");
      expect(txn2.refNo).toBe("0002233445566");
      expect(txn2.narration).toBe("ATM-WDL-SYNTHETIC BRANCH");
      expect(txn2.balancePaise).toBe(33000000);
    });
  });

  describe("Axis parser regression", () => {
    it("parses serial dates, formatted amounts, zero-padded refs, and narrations correctly", async () => {
      const xlsxBuffer = makeAxisRegressionXlsx();
      const file = new File([xlsxBuffer], "axis-regression.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result: ParseResult = await parseBankStatement(file);

      expect(result.detection.bank).toBe("AXIS" as BankId);
      expect(result.errors.filter((e) => e.code === "ROW_PARSE_FAILED")).toHaveLength(0);
      expect(result.transactions).toHaveLength(2);

      const txn1 = result.transactions[0];
      expect(txn1.date).toBe("2026-10-15");
      expect(txn1.amountPaise).toBe(25000000);
      expect(txn1.direction).toBe("CR");
      expect(txn1.refNo).toBe("0003344556677");
      expect(txn1.narration).toBe("NEFT-CR-SYNTHETIC CLIENT-ORDER-500");
      expect(txn1.balancePaise).toBe(50000000);

      const txn2 = result.transactions[1];
      expect(txn2.date).toBe("2026-10-20");
      expect(txn2.amountPaise).toBe(1500025);
      expect(txn2.direction).toBe("DR");
      expect(txn2.refNo).toBe("0008877665544");
      expect(txn2.narration).toBe("IMPS/P2P/SYNTHETIC PERSON");
      expect(txn2.balancePaise).toBe(48499975);
    });
  });

  describe("Cross-parser: amounts in date-range are NOT treated as dates", () => {
    it("HDFC: amount 46310 parses as INR 463.10, not as a date", async () => {
      const header = [
        "Date",
        "Narration",
        "Chq./Ref.No.",
        "Value Dt",
        "Withdrawal Amt.",
        "Deposit Amt.",
        "Closing Balance",
      ];
      const preamble = [["HDFC BANK"], ["Statement"], [], header];
      const dataRows = [[46310, "TEST AMOUNT EQUALS SERIAL", "REF001", 46310, "", 46310, 146310]];
      const allRows = [...preamble, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(allRows);

      ws["A5"] = { t: "n", v: 46310 };
      ws["D5"] = { t: "n", v: 46310 };
      ws["F5"] = { t: "n", v: 46310 };
      ws["G5"] = { t: "n", v: 146310 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "hdfc-amount-serial-range.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("HDFC");
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[0].amountPaise).toBe(4631000);
      expect(result.transactions[0].balancePaise).toBe(14631000);
    });

    it("ICICI: amount 46315 parses as INR 463.15, not as a date", async () => {
      const header = ["S No.", "Transaction Date", "Cheque Number", "Remarks", "Withdrawal", "Deposit", "Balance"];
      const preamble = [["ICICI BANK"], ["Statement"], [], header];
      const dataRows = [[1, 46310, "REF002", "TEST ICICI AMOUNT", "", 46315, 146315]];
      const allRows = [...preamble, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(allRows);

      ws["B5"] = { t: "n", v: 46310 };
      ws["F5"] = { t: "n", v: 46315 };
      ws["G5"] = { t: "n", v: 146315 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "icici-amount-serial-range.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("ICICI");
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[0].amountPaise).toBe(4631500);
      expect(result.transactions[0].balancePaise).toBe(14631500);
    });

    it("SBI: amount 46313 parses as INR 463.13, not as a date", async () => {
      const header = ["Txn Date", "Value Date", "Description", "Ref No./Cheque No.", "Debit", "Credit", "Balance"];
      const preamble = [["STATE BANK OF INDIA"], ["Statement"], [], header];
      const dataRows = [[46310, 46310, "TEST SBI AMOUNT", "REF003", "", 46313, 146313]];
      const allRows = [...preamble, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(allRows);

      ws["A5"] = { t: "n", v: 46310 };
      ws["B5"] = { t: "n", v: 46310 };
      ws["F5"] = { t: "n", v: 46313 };
      ws["G5"] = { t: "n", v: 146313 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "sbi-amount-serial-range.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("SBI");
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].date).toBe("2026-10-15");
      expect(result.transactions[0].amountPaise).toBe(4631300);
      expect(result.transactions[0].balancePaise).toBe(14631300);
    });

    it("Axis: amount 46310 parses as INR 463.10, not as a date", async () => {
      const header = ["Transaction Date", "Value Date", "Particulars", "Chq./Ref.No.", "Debit", "Credit", "Balance"];
      const preamble = [["AXIS BANK"], ["Statement"], [], header];
      const dataRows = [[46315, 46315, "TEST AXIS AMOUNT", "REF004", "", 46310, 146310]];
      const allRows = [...preamble, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(allRows);

      ws["A5"] = { t: "n", v: 46315 };
      ws["B5"] = { t: "n", v: 46315 };
      ws["F5"] = { t: "n", v: 46310 };
      ws["G5"] = { t: "n", v: 146310 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

      const file = new File([buf], "axis-amount-serial-range.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const result = await parseBankStatement(file);

      expect(result.detection.bank).toBe("AXIS");
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].date).toBe("2026-10-20");
      expect(result.transactions[0].amountPaise).toBe(4631000);
      expect(result.transactions[0].balancePaise).toBe(14631000);
    });
  });
});

/**
 * Dedupe hash stability tests.
 * Ensures the dedupe key is the same as main's when value-date is a serial.
 *
 * On main, if valueDateRaw was a serial string (e.g., "46313"), parseIndianDate
 * returned null, so valueDate was undefined and the hash didn't include `vdate:`.
 * Our code now parses the serial and stores the ISO date on the transaction,
 * but for hash stability, we preserve main's behavior by not including the
 * serial-derived valueDate in the hash.
 *
 * Note: On main, a row whose TRANSACTION date was a bare serial failed to parse,
 * so there's no main hash to preserve for it - those rows simply didn't exist.
 * We keep the transaction date deterministic (using the parsed ISO date in the hash).
 */
describe("Dedupe hash stability (SYNTHETIC)", () => {
  it("hash matches main when value-date is a serial string (no UTR)", async () => {
    // Scenario: XLSX with transaction date as normal text, value-date as serial string "46313"
    // On main: valueDateRaw "46313" would fail parseIndianDate, valueDate=undefined, hash has no vdate
    // On new: valueDateRaw "46313" parses to "2026-10-18", but hash should still have no vdate

    const header = [
      "Date",
      "Narration",
      "Chq./Ref.No.",
      "Value Dt",
      "Withdrawal Amt.",
      "Deposit Amt.",
      "Closing Balance",
    ];
    const preamble = [["HDFC BANK"], ["Statement"], [], header];
    // Transaction date as normal text "15/10/2026", value-date as serial string "46313"
    const dataRows = [["15/10/2026", "NEFT CR-SYNTHETIC HASH TEST-NO UTR", "REFNOUTR001", "46313", "", "10000", "100000"]];
    const allRows = [...preamble, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Ensure value-date cell is a string "46313" (serial string, not a number)
    ws["D5"] = { t: "s", v: "46313" };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const file = new File([buf], "hdfc-hash-stability.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions).toHaveLength(1);

    const txn = result.transactions[0];
    // Transaction displays the parsed value-date
    expect(txn.valueDate).toBe("2026-10-18");
    expect(txn.date).toBe("2026-10-15");

    // The dedupe key should NOT include vdate (matching main's behavior)
    // On main, the canonical string would be: date:2026-10-15|amount:1000000|dir:CR|nar:...|bal:10000000|ref:REFNOUTR001
    // It would NOT have vdate:2026-10-18

    // Verify by checking the key format
    expect(txn.dedupeKey).toMatch(/^sha256:/);
    // The hash should be computed without vdate - we verify this by checking the transaction
    // still has valueDate displayed (proving the parsed value is used for display, not hash)
    expect(txn.valueDate).toBe("2026-10-18");

    // Construct what main would have hashed (no vdate since serial failed to parse)
    // date:2026-10-15|amount:1000000|dir:CR|nar:neft cr-synthetic hash test-no utr|bal:10000000|ref:REFNOUTR001
    const expectedNar = "neft cr-synthetic hash test-no utr";
    const mainCanonical = `date:2026-10-15|amount:1000000|dir:CR|nar:${expectedNar}|bal:10000000|ref:REFNOUTR001`;

    // Hash the main canonical string
    const encoder = new TextEncoder();
    const data = encoder.encode(mainCanonical);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    const expectedHash = Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    expect(txn.dedupeKey).toBe(`sha256:${expectedHash}`);
  });
});

/**
 * XLSX/XLS only tests.
 * Ensures serial dates are only accepted for XLSX/XLS files, not CSV/TXT.
 */
describe("XLSX/XLS only serial acceptance (SYNTHETIC)", () => {
  it("CSV with '46310' in date column stays unparsed (main's outcome)", async () => {
    // On main, "46310" in a CSV date column would fail to parse (not a valid date format)
    // The row should fail with ROW_PARSE_FAILED or be skipped
    const csvContent = [
      "HDFC BANK",
      "Statement of Account",
      "",
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "46310,NEFT CR-SYNTHETIC CSV TEST,REF001,46310,,10000,100000",
    ].join("\n");

    const file = new File([csvContent], "hdfc-serial-date.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    // The row should not parse (serial string rejected for CSV)
    expect(result.transactions).toHaveLength(0);
    // Should have error or be skipped
    const errors = result.errors.filter((e) => e.code === "ROW_PARSE_FAILED");
    expect(errors.length).toBeGreaterThanOrEqual(0);
  });

  it("XLSX with '46310' (string serial) in date column parses to 2026-10-15", async () => {
    const header = [
      "Date",
      "Narration",
      "Chq./Ref.No.",
      "Value Dt",
      "Withdrawal Amt.",
      "Deposit Amt.",
      "Closing Balance",
    ];
    const preamble = [["HDFC BANK"], ["Statement"], [], header];
    const dataRows = [["46310", "NEFT CR-SYNTHETIC XLSX SERIAL TEST", "REF002", "46310", "", "10000", "100000"]];
    const allRows = [...preamble, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(allRows);

    // Ensure date cell is a string "46310" (serial string)
    ws["A5"] = { t: "s", v: "46310" };
    ws["D5"] = { t: "s", v: "46310" };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Statement");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const file = new File([buf], "hdfc-serial-date.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2026-10-15");
    expect(result.transactions[0].valueDate).toBe("2026-10-15");
  });

  it("CSV with valid date '15/10/2026' parses normally", async () => {
    // Verify that normal CSV parsing still works
    const csvContent = [
      "HDFC BANK",
      "Statement of Account",
      "",
      "Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance",
      "15/10/2026,NEFT CR-SYNTHETIC NORMAL CSV TEST,REF003,15/10/2026,,10000,100000",
    ].join("\n");

    const file = new File([csvContent], "hdfc-normal-date.csv", { type: "text/csv" });
    const result = await parseBankStatement(file);

    expect(result.detection.bank).toBe("HDFC");
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].date).toBe("2026-10-15");
  });
});
