/**
 * Excel serial date parsing tests.
 * Tests for raw numeric Excel serial dates in bank statement XLSX files.
 *
 * All test data is SYNTHETIC - entirely inline, no external fixtures.
 * Uses made-up names, synthetic refs, and test-*.myshopify.com style.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as XLSX from "xlsx";
import { parseBankStatement } from "../index.js";
import type { ParseResult } from "../types.js";

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
