#!/usr/bin/env npx tsx
/**
 * Generate synthetic BIFF8 .xls bank statement fixtures from layout specs.
 * 
 * Creates deterministic fixtures for ICICI and HDFC that match the real
 * bank export layouts, including:
 * - Exact preamble structure and merges
 * - Correct header row position and column names
 * - Proper cell types (text vs numeric)
 * - Narration overflow rows (ICICI)
 * - Footer/legend sections
 * - Date formats matching real exports
 * 
 * All data is SYNTHETIC with SYNT markers. No real bank data.
 * 
 * Run: npx tsx scripts/fixtures/make-bank-xls.ts
 */

import * as XLSX from "xlsx";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, "../../tests/fixtures/banks/synthetic");

// ============================================================================
// ICICI Synthetic Data (Real Layout Spec)
// ============================================================================

interface IciciTxn {
  sno: number;
  valueDate: string;  // DD/MM/YYYY
  txnDate: string;    // DD/MM/YYYY
  cheque: string;     // always blank
  remarks: string;
  withdrawal: string; // "0.00" or amount
  deposit: string;    // "0.00" or amount
  balance: string;
  overflowRemarks?: string; // For narration continuation
}

/** Round to 2 decimal places to avoid float noise */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function generateIciciTransactions(): IciciTxn[] {
  // Generate synthetic transactions matching the spec
  // Mix: 9 credits, 6 debits, with required edge cases
  // Amounts use odd patterns like 12345.67 to be obviously invented
  const txns: IciciTxn[] = [];
  let balance = 98765.43; // Starting balance - odd pattern
  let sno = 1;

  // UPI credit - 7 segment form
  balance = round2(balance + 51234.56);
  txns.push({
    sno: sno++,
    valueDate: "15/10/2030",
    txnDate: "15/10/2030",
    cheque: "",
    remarks: "UPI/SYNT VENDOR PVT LTD/syntvendor@oksynt/Invoice Payment/SYNT BANK/600000000001/SYNT000001",
    withdrawal: "0.00",
    deposit: "51234.56",
    balance: balance.toFixed(2),
  });

  // UPI credit - 8 segment with trailing slash
  balance = round2(balance + 24680.13);
  txns.push({
    sno: sno++,
    valueDate: "16/10/2030",
    txnDate: "16/10/2030",
    cheque: "",
    remarks: "UPI/SYNT WHOLESALER CO/syntwholesale@oksynt/Order ref 1001/SYNT CO-OP BANK/600000000002/SYNT000002/",
    withdrawal: "0.00",
    deposit: "24680.13",
    balance: balance.toFixed(2),
  });

  // UPI credit - VPA with NO @ (alphanumeric 10+ chars)
  balance = round2(balance + 13579.24);
  txns.push({
    sno: sno++,
    valueDate: "17/10/2030",
    txnDate: "17/10/2030",
    cheque: "",
    remarks: "UPI/SYNT RETAILER/SYNT9000000001/Advance payment/SYNT BANK/600000000003/SYNT000003",
    withdrawal: "0.00",
    deposit: "13579.24",
    balance: balance.toFixed(2),
  });

  // UPI credit with hyphenated VPA
  balance = round2(balance + 11235.81);
  txns.push({
    sno: sno++,
    valueDate: "18/10/2030",
    txnDate: "18/10/2030",
    cheque: "",
    remarks: "UPI/SYNT TRADERS/synt-pay@oksynt/Monthly dues/SYNT BANK/600000000004/SYNT000004",
    withdrawal: "0.00",
    deposit: "11235.81",
    balance: balance.toFixed(2),
  });

  // CMS collection credit 1
  balance = round2(balance + 76543.21);
  txns.push({
    sno: sno++,
    valueDate: "19/10/2030",
    txnDate: "19/10/2030",
    cheque: "",
    remarks: "CMS/ SYNT00123456 78/SYNT CORPORATE COLLECTIONS PVT LTD",
    withdrawal: "0.00",
    deposit: "76543.21",
    balance: balance.toFixed(2),
  });

  // CMS collection credit 2
  balance = round2(balance + 43210.98);
  txns.push({
    sno: sno++,
    valueDate: "20/10/2030",
    txnDate: "20/10/2030",
    cheque: "",
    remarks: "CMS/ SYNT00789012 34/SYNT ENTERPRISES LTD",
    withdrawal: "0.00",
    deposit: "43210.98",
    balance: balance.toFixed(2),
  });

  // UPI debit
  balance = round2(balance - 1357.91);
  txns.push({
    sno: sno++,
    valueDate: "21/10/2030",
    txnDate: "21/10/2030",
    cheque: "",
    remarks: "UPI/SYNT STORE/syntstore@oksynt/Purchase/SYNT BANK/600000000005/SYNT000005",
    withdrawal: "1357.91",
    deposit: "0.00",
    balance: balance.toFixed(2),
  });

  // ACH debit
  balance = round2(balance - 5432.10);
  txns.push({
    sno: sno++,
    valueDate: "22/10/2030",
    txnDate: "22/10/2030",
    cheque: "",
    remarks: "ACH/SYNT INSURANCE CO/SYNP0001/Premium payment 123456789 87654321",
    withdrawal: "5432.10",
    deposit: "0.00",
    balance: balance.toFixed(2),
  });

  // Value Date != Transaction Date (one day difference)
  balance = round2(balance - 2109.87);
  txns.push({
    sno: sno++,
    valueDate: "23/10/2030",
    txnDate: "24/10/2030", // Different from value date
    cheque: "",
    remarks: "UPI/SYNT UTILITY/syntutility@oksynt/Electricity bill/SYNT BANK/600000000006/SYNT000006",
    withdrawal: "2109.87",
    deposit: "0.00",
    balance: balance.toFixed(2),
  });

  // UPI debit
  balance = round2(balance - 876.54);
  txns.push({
    sno: sno++,
    valueDate: "24/10/2030",
    txnDate: "24/10/2030",
    cheque: "",
    remarks: "UPI/SYNT RESTAURANT/syntfood@oksynt/Dinner/SYNT BANK/600000000007/SYNT000007",
    withdrawal: "876.54",
    deposit: "0.00",
    balance: balance.toFixed(2),
  });

  // Interest-style single-segment credit
  balance = round2(balance + 1234.56);
  txns.push({
    sno: sno++,
    valueDate: "25/10/2030",
    txnDate: "25/10/2030",
    cheque: "",
    remarks: "600000000099 SYNT INT PAID 01-10-2030 TO 25-10-2030",
    withdrawal: "0.00",
    deposit: "1234.56",
    balance: balance.toFixed(2),
  });

  // UPI debit - short form
  balance = round2(balance - 987.65);
  txns.push({
    sno: sno++,
    valueDate: "26/10/2030",
    txnDate: "26/10/2030",
    cheque: "",
    remarks: "UPI/SYNT MALL/syntmall@oksynt/Shopping/SYNT BANK/600000000008/SYNT000008/",
    withdrawal: "987.65",
    deposit: "0.00",
    balance: balance.toFixed(2),
  });

  // MID-DATA OVERFLOW ROW: Long narration that requires overflow
  balance = round2(balance + 32109.87);
  txns.push({
    sno: sno++,
    valueDate: "27/10/2030",
    txnDate: "27/10/2030",
    cheque: "",
    remarks: "UPI/SYNT LONG NAME ENTERPRISE PVT LTD/syntlongbusiness@oksynt/Payment for invoice ",
    withdrawal: "0.00",
    deposit: "32109.87",
    balance: balance.toFixed(2),
    overflowRemarks: "SYNT-INV-2030-0001/SYNT PARTNER BANK/600000000009/SYNT000009",
  });

  // More UPI debits
  balance = round2(balance - 432.10);
  txns.push({
    sno: sno++,
    valueDate: "28/10/2030",
    txnDate: "28/10/2030",
    cheque: "",
    remarks: "UPI/SYNT PETROL/syntfuel@oksynt/Fuel/SYNT BANK/600000000010/SYNT000010",
    withdrawal: "432.10",
    deposit: "0.00",
    balance: balance.toFixed(2),
  });

  // LAST TRANSACTION WITH OVERFLOW (edge case - overflow right before legend)
  balance = round2(balance + 21098.76);
  txns.push({
    sno: sno++,
    valueDate: "29/10/2030",
    txnDate: "29/10/2030",
    cheque: "",
    remarks: "UPI/SYNT FINAL PAYMENT CORP/syntfinalpay@oksynt/Settlement of account ref ",
    withdrawal: "0.00",
    deposit: "21098.76",
    balance: balance.toFixed(2),
    overflowRemarks: "SYNT-SETTLE-2030/SYNT CLEARING BANK/600000000011/SYNT000011/",
  });

  return txns;
}

function buildIciciSheet(): XLSX.WorkSheet {
  const txns = generateIciciTransactions();
  
  // Build rows as array of arrays (all strings for ICICI)
  const rows: (string | null)[][] = [];
  
  // Row 0: blank
  rows.push(["", "", "", "", "", "", "", "", "", ""]);
  
  // Row 1: title (merged B:I)
  rows.push(["", "SYNT ACCOUNT STATEMENT", "", "", "", "", "", "", "", ""]);
  
  // Row 2: sub-title (merged B:I)
  rows.push(["", "SYNT ICICI BANK LIMITED", "", "", "", "", "", "", "", ""]);
  
  // Row 3: account line - label in B (merged B:C), value in D (merged D:I)
  rows.push(["", "Account Number", "", "000000000000 ( INR ) - SYNT TEST ACCOUNT HOLDER", "", "", "", "", "", ""]);
  
  // Row 4: date range - B (merged B:C), D, E, F (merged F:I)
  rows.push(["", "Transaction Date from", "", "01/10/2030", "to", "31/10/2030", "", "", "", ""]);
  
  // Row 5: period filter
  rows.push(["", "Transaction Period", "", "All", "", "", "", "", "", ""]);
  
  // Row 6: section heading
  rows.push(["", "Transaction Details", "", "", "", "", "", "", "", ""]);
  
  // Row 7: amount filter
  rows.push(["", "Amount from", "", "NA", "to", "NA", "", "", "", ""]);
  
  // Row 8: cheque filter
  rows.push(["", "Cheque number from", "", "NA", "to", "NA", "", "", "", ""]);
  
  // Row 9: remarks filter
  rows.push(["", "Transaction remarks", "", "All", "", "", "", "", "", ""]);
  
  // Row 10: type filter
  rows.push(["", "Transaction type", "", "All", "", "", "", "", "", ""]);
  
  // Row 11: account summary line
  rows.push(["", "SYNT SAVINGS ACCOUNT - SYNT BRANCH - 000000000000", "", "", "", "", "", "", "", ""]);
  
  // Row 12: HEADER ROW
  rows.push([
    "", // A: spacer
    "S No.",
    "Value Date",
    "Transaction Date",
    "Cheque Number",
    "Transaction Remarks",
    "Withdrawal Amount(INR)",
    "Deposit Amount(INR)",
    "Balance(INR)",
    "", // J: spacer
  ]);
  
  // Data rows starting at row 13
  for (const txn of txns) {
    rows.push([
      "", // A: spacer
      String(txn.sno),
      txn.valueDate,
      txn.txnDate,
      txn.cheque,
      txn.remarks,
      txn.withdrawal,
      txn.deposit,
      txn.balance,
      "", // J: spacer
    ]);
    
    // Add overflow row if present
    if (txn.overflowRemarks) {
      rows.push([
        "", // A: spacer
        "", // B: blank
        "", // C: blank
        "", // D: blank
        "", // E: blank
        txn.overflowRemarks, // F: overflow narration
        "", // G: blank
        "", // H: blank
        "", // I: blank
        "", // J: spacer
      ]);
    }
  }
  
  // Legend footer (no blank row between last data and legend)
  rows.push(["", "Legends : Transaction Type Codes", "", "", "", "", "", "", "", ""]);
  rows.push(["", "1. SYNT - Synthetic test legend entry", "", "", "", "", "", "", "", ""]);
  rows.push(["", "2. UPI - Unified Payments Interface", "", "", "", "", "", "", "", ""]);
  rows.push(["", "3. CMS - Cash Management Services", "", "", "", "", "", "", "", ""]);
  rows.push(["", "4. ACH - Automated Clearing House", "", "", "", "", "", "", "", ""]);
  rows.push(["", "5. INT - Interest Payment", "", "", "", "", "", "", "", ""]);
  
  // Create worksheet
  const ws = XLSX.utils.aoa_to_sheet(rows);
  
  // Set merges for preamble
  ws["!merges"] = [
    // Row 1: B:I
    { s: { r: 1, c: 1 }, e: { r: 1, c: 8 } },
    // Row 2: B:I
    { s: { r: 2, c: 1 }, e: { r: 2, c: 8 } },
    // Row 3: B:C and D:I
    { s: { r: 3, c: 1 }, e: { r: 3, c: 2 } },
    { s: { r: 3, c: 3 }, e: { r: 3, c: 8 } },
    // Row 4: B:C and F:I
    { s: { r: 4, c: 1 }, e: { r: 4, c: 2 } },
    { s: { r: 4, c: 5 }, e: { r: 4, c: 8 } },
    // Row 5: B:C and D:I
    { s: { r: 5, c: 1 }, e: { r: 5, c: 2 } },
    { s: { r: 5, c: 3 }, e: { r: 5, c: 8 } },
    // Row 6: B:I
    { s: { r: 6, c: 1 }, e: { r: 6, c: 8 } },
    // Row 7: B:C and F:I
    { s: { r: 7, c: 1 }, e: { r: 7, c: 2 } },
    { s: { r: 7, c: 5 }, e: { r: 7, c: 8 } },
    // Row 8: B:C and F:I
    { s: { r: 8, c: 1 }, e: { r: 8, c: 2 } },
    { s: { r: 8, c: 5 }, e: { r: 8, c: 8 } },
    // Row 9: B:C and D:I
    { s: { r: 9, c: 1 }, e: { r: 9, c: 2 } },
    { s: { r: 9, c: 3 }, e: { r: 9, c: 8 } },
    // Row 10: B:C and D:I
    { s: { r: 10, c: 1 }, e: { r: 10, c: 2 } },
    { s: { r: 10, c: 3 }, e: { r: 10, c: 8 } },
    // Row 11: B:I
    { s: { r: 11, c: 1 }, e: { r: 11, c: 8 } },
    // Legend rows merges (B:I)
    ...Array.from({ length: 6 }, (_, i) => ({
      s: { r: rows.length - 6 + i, c: 1 },
      e: { r: rows.length - 6 + i, c: 8 },
    })),
  ];
  
  // Set column range
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: rows.length - 1, c: 9 },
  });
  
  return ws;
}

// ============================================================================
// HDFC Synthetic Data (Real Layout Spec)
// ============================================================================

interface HdfcTxn {
  date: string;       // DD/MM/YY
  narration: string;
  ref: string;        // 16 digits usually
  valueDate: string;  // DD/MM/YY
  withdrawal: number | null;  // numeric or null
  deposit: number | null;     // numeric or null
  balance: number;    // numeric
}

function generateHdfcTransactions(): { txns: HdfcTxn[]; openingBalance: number } {
  const txns: HdfcTxn[] = [];
  const openingBalance = 98765.43; // Odd pattern starting balance
  let balance = openingBalance;

  // UPI credit - 6 segment form
  balance = round2(balance + 51234.56);
  txns.push({
    date: "15/10/30",
    narration: "UPI-SYNT VENDOR PVT LTD-syntvendor@oksynt-SYNT0000001-600000000001-Invoice Payment",
    ref: "0000600000000001",
    valueDate: "15/10/30",
    withdrawal: null,
    deposit: 51234.56,
    balance,
  });

  // UPI credit - 7 segment with hyphenated VPA
  balance = round2(balance + 24680.13);
  txns.push({
    date: "16/10/30",
    narration: "UPI-SYNT WHOLESALER-9000000000-1@oksynt-SYNT0000002-600000000002-Order payment",
    ref: "0000600000000002",
    valueDate: "16/10/30",
    withdrawal: null,
    deposit: 24680.13,
    balance,
  });

  // UPI credit with ref ≠ 0000+RRN
  balance = round2(balance + 13579.24);
  txns.push({
    date: "17/10/30",
    narration: "UPI-SYNT RETAILER-syntretail@oksynt-SYNT0000003-600000000003-Advance",
    ref: "1234600000000003", // Different from 0000+RRN
    valueDate: "17/10/30",
    withdrawal: null,
    deposit: 13579.24,
    balance,
  });

  // UPI credit with 15-digit ref
  balance = round2(balance + 11235.81);
  txns.push({
    date: "18/10/30",
    narration: "UPI-SYNT TRADERS-synttraders@oksynt-SYNT0000004-600000000004-Monthly dues",
    ref: "ABC6000000000004", // 3 letters + 13 digits = 16 chars but pattern variant
    valueDate: "18/10/30",
    withdrawal: null,
    deposit: 11235.81,
    balance,
  });

  // UPI debit
  balance = round2(balance - 1357.91);
  txns.push({
    date: "19/10/30",
    narration: "UPI-SYNT STORE-syntstore@oksynt-SYNT0000005-600000000005-Purchase",
    ref: "0000600000000005",
    valueDate: "19/10/30",
    withdrawal: 1357.91,
    deposit: null,
    balance,
  });

  // Card AUTOPAY debit
  balance = round2(balance - 5432.10);
  txns.push({
    date: "20/10/30",
    narration: "DC 1000000000000001 AUTOPAY SI-SYNTMERCHANT",
    ref: "0000000000123456",
    valueDate: "20/10/30",
    withdrawal: 5432.10,
    deposit: null,
    balance,
  });

  // ATM withdrawal
  balance = round2(balance - 10000);
  txns.push({
    date: "21/10/30",
    narration: "ATW-SYNTCARD0000-SYNTATM00-SYNTCITY",
    ref: "0000000000234567",
    valueDate: "21/10/30",
    withdrawal: 10000,
    deposit: null,
    balance,
  });

  // Value Date != Date
  balance = round2(balance - 2109.87);
  txns.push({
    date: "22/10/30",
    narration: "UPI-SYNT UTILITY-syntutility@oksynt-SYNT0000006-600000000006-Electricity",
    ref: "0000600000000006",
    valueDate: "23/10/30", // Different
    withdrawal: 2109.87,
    deposit: null,
    balance,
  });

  // UPI debit with double space in name (spec mentions this)
  balance = round2(balance - 876.54);
  txns.push({
    date: "23/10/30",
    narration: "UPI-SYNT  DOUBLE SPACE CO-syntdouble@oksynt-SYNT0000007-600000000007-Test",
    ref: "0000600000000007",
    valueDate: "23/10/30",
    withdrawal: 876.54,
    deposit: null,
    balance,
  });

  // Interest credit
  balance = round2(balance + 1234.56);
  txns.push({
    date: "24/10/30",
    narration: "INTEREST PAID SYNT 01-OCT-2030",
    ref: "0000000000345678",
    valueDate: "24/10/30",
    withdrawal: null,
    deposit: 1234.56,
    balance,
  });

  // ME DC SI debit (mandate)
  balance = round2(balance - 987.65);
  txns.push({
    date: "25/10/30",
    narration: "ME DC SI SYNT0001 SYNT SUBSCRIPTION SERVICES",
    ref: "0000000000456789",
    valueDate: "25/10/30",
    withdrawal: 987.65,
    deposit: null,
    balance,
  });

  // UPI credit
  balance = round2(balance + 32109.87);
  txns.push({
    date: "26/10/30",
    narration: "UPI-SYNT LONG ENTERPRISE-syntlong@oksynt-SYNT0000008-600000000008-Payment",
    ref: "0000600000000008",
    valueDate: "26/10/30",
    withdrawal: null,
    deposit: 32109.87,
    balance,
  });

  // 15-digit ref row (as mentioned in spec)
  balance = round2(balance - 432.10);
  txns.push({
    date: "27/10/30",
    narration: "UPI-SYNT PETROL-syntfuel@oksynt-SYNT0000009-600000000009-Fuel",
    ref: "000600000000009", // 15 digits
    valueDate: "27/10/30",
    withdrawal: 432.10,
    deposit: null,
    balance,
  });

  // DC POS debit
  balance = round2(balance - 765.43);
  txns.push({
    date: "28/10/30",
    narration: "DC SYNT POS SYNTPOS 123456-SYNT0000000001",
    ref: "0000000000567890",
    valueDate: "28/10/30",
    withdrawal: 765.43,
    deposit: null,
    balance,
  });

  // Final UPI credit
  balance = round2(balance + 21098.76);
  txns.push({
    date: "29/10/30",
    narration: "UPI-SYNT FINAL CORP-syntfinal@oksynt-SYNT0000010-600000000010-Settlement",
    ref: "0000600000000010",
    valueDate: "29/10/30",
    withdrawal: null,
    deposit: 21098.76,
    balance,
  });

  return { txns, openingBalance };
}

function buildHdfcSheet(): XLSX.WorkSheet {
  const { txns, openingBalance } = generateHdfcTransactions();
  
  // Calculate totals
  let totalDebits = 0;
  let totalCredits = 0;
  let drCount = 0;
  let crCount = 0;
  
  for (const txn of txns) {
    if (txn.withdrawal !== null) {
      totalDebits += txn.withdrawal;
      drCount++;
    }
    if (txn.deposit !== null) {
      totalCredits += txn.deposit;
      crCount++;
    }
  }
  
  const closingBalance = txns[txns.length - 1].balance;
  
  // Build rows - mixed types (strings and numbers)
  const rows: (string | number | null)[][] = [];
  
  // Row 0: Bank banner with padding
  const padding = " ".repeat(150);
  rows.push([`HDFC BANK Ltd.${padding}Page No . : 1`, null, null, null, null, null, null]);
  
  // Rows 1-3: blank
  rows.push([null, null, null, null, null, null, null]);
  rows.push([null, null, null, null, null, null, null]);
  rows.push([null, null, null, null, null, null, null]);
  
  // Rows 4-17: Two-column preamble (A and E)
  // Row 4
  rows.push([null, null, null, null, "Account Branch : SYNT BRANCH", null, null]);
  // Row 5
  rows.push(["SYNT TEST ACCOUNT HOLDER", null, null, null, "Address : SYNT ADDRESS LINE 1", null, null]);
  // Row 6
  rows.push(["SYNT ADDRESS LINE 1", null, null, null, "SYNT ADDRESS LINE 2", null, null]);
  // Row 7
  rows.push(["SYNT ADDRESS LINE 2", null, null, null, "SYNT CITY", null, null]);
  // Row 8
  rows.push(["SYNT CITY 000000", null, null, null, "City : SYNT CITY", null, null]);
  // Row 9
  rows.push(["SYNT STATE", null, null, null, "State : SYNT STATE", null, null]);
  // Row 10
  rows.push([null, null, null, null, "SYNT CONTACT INFO", null, null]);
  // Row 11
  rows.push([null, null, null, null, "Email : synt.test@oksynt.example", null, null]);
  // Row 12
  rows.push(["JOINT HOLDERS :", null, null, null, "OD Limit : 0.00", null, null]);
  // Row 13
  rows.push([null, null, null, null, "Cust ID : 000000000", null, null]);
  // Row 14
  rows.push(["Nomination : Not Registered", null, null, null, "Account No : 00000000000000", null, null]);
  // Row 15
  rows.push(["Statement From : 01/10/2030 To : 31/10/2030", null, null, null, "A/C Open Date : 01/01/2020", null, null]);
  // Row 16
  rows.push([null, null, null, null, "Account Status : Regular", null, null]);
  // Row 17
  rows.push([null, null, null, null, "RTGS/NEFT IFSC : SYNT0000001 MICR : SYNT00000", null, null]);
  
  // Row 18: blank
  rows.push([null, null, null, null, null, null, null]);
  
  // Row 19: asterisk rule (A only)
  rows.push(["*".repeat(190), null, null, null, null, null, null]);
  
  // Row 20: HEADER ROW
  rows.push(["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]);
  
  // Row 21: asterisk row (all columns)
  rows.push(["*".repeat(8), "*".repeat(34), "*".repeat(12), "*".repeat(8), "*".repeat(18), "*".repeat(18), "*".repeat(18)]);
  
  // Data rows (22 onwards)
  for (const txn of txns) {
    rows.push([
      txn.date,
      txn.narration,
      txn.ref,
      txn.valueDate,
      txn.withdrawal,
      txn.deposit,
      txn.balance,
    ]);
  }
  
  // Footer
  const dataEndRow = rows.length;
  
  // +0: blank
  rows.push([null, null, null, null, null, null, null]);
  
  // +1: asterisk row (all columns)
  rows.push(["*".repeat(8), "*".repeat(34), "*".repeat(12), "*".repeat(8), "*".repeat(18), "*".repeat(18), "*".repeat(18)]);
  
  // +2: asterisk rule (A only)
  rows.push(["*".repeat(130), null, null, null, null, null, null]);
  
  // +3: blank
  rows.push([null, null, null, null, null, null, null]);
  
  // +4: summary title
  rows.push(["STATEMENT SUMMARY  :-", null, null, null, null, null, null]);
  
  // +5: summary labels
  rows.push(["Opening Balance", null, null, null, "Debits", "Credits", "Closing Bal"]);
  
  // +6: summary values (NUMERIC, no text labels - this is the ROW_PARSE_FAILED case)
  rows.push([openingBalance, null, null, null, totalDebits, totalCredits, closingBalance]);
  
  // +7: blank
  rows.push([null, null, null, null, null, null, null]);
  
  // +8: count labels
  rows.push([null, null, null, null, "Dr Count", "Cr Count", null]);
  
  // +9: count values
  rows.push([null, null, null, null, drCount, crCount, null]);
  
  // +10-11: blank
  rows.push([null, null, null, null, null, null, null]);
  rows.push([null, null, null, null, null, null, null]);
  
  // +12: generation line
  rows.push(["Generated On :", "29/10/2030 14:30:00", "Generated By :", "SYNT USER", "Requesting Branch Code :", "SYNT001", null]);
  
  // +13: blank
  rows.push([null, null, null, null, null, null, null]);
  
  // +14: branch contact line
  rows.push(["SYNT Branch Contact", "000-0000-0000", null, null, null, null, null]);
  
  // +15-16: bank contact
  rows.push(["SYNT Contact: For any issues, contact SYNT customer care at 1800-XXX-XXXX", null, null, null, null, null, null]);
  rows.push(["Registered Office: SYNT HDFC Bank Ltd., SYNT Tower, SYNT City - 000000", null, null, null, null, null, null]);
  
  // +17: end marker
  rows.push(["---  End Of Statement ---", null, null, null, null, null, null]);
  
  // Create worksheet
  const ws = XLSX.utils.aoa_to_sheet(rows);
  
  // No merges for HDFC per spec
  
  return ws;
}

// ============================================================================
// CSV Generation (twins with identical transactions)
// ============================================================================

function generateIciciCsv(txns: IciciTxn[]): string {
  const lines: string[] = [];
  
  // Preamble (simplified for CSV - just comments indicating structure)
  lines.push("# SYNTHETIC TEST DATA - ICICI Real Layout");
  lines.push("# Generated by scripts/fixtures/make-bank-xls.ts");
  lines.push("# All data is fictional with SYNT markers");
  lines.push("");
  lines.push("SYNT ACCOUNT STATEMENT");
  lines.push("SYNT ICICI BANK LIMITED");
  lines.push("Account Number,000000000000 ( INR ) - SYNT TEST ACCOUNT HOLDER");
  lines.push("Transaction Date from,01/10/2030,to,31/10/2030");
  lines.push("Transaction Period,All");
  lines.push("Transaction Details");
  lines.push("Amount from,NA,to,NA");
  lines.push("Cheque number from,NA,to,NA");
  lines.push("Transaction remarks,All");
  lines.push("Transaction type,All");
  lines.push("SYNT SAVINGS ACCOUNT - SYNT BRANCH - 000000000000");
  lines.push("");
  
  // Header
  lines.push(",S No.,Value Date,Transaction Date,Cheque Number,Transaction Remarks,Withdrawal Amount(INR),Deposit Amount(INR),Balance(INR),");
  
  // Data rows
  for (const txn of txns) {
    const remarksEscaped = txn.remarks.includes(",") ? `"${txn.remarks}"` : txn.remarks;
    lines.push(`,${txn.sno},${txn.valueDate},${txn.txnDate},${txn.cheque},${remarksEscaped},${txn.withdrawal},${txn.deposit},${txn.balance},`);
    
    if (txn.overflowRemarks) {
      const overflowEscaped = txn.overflowRemarks.includes(",") ? `"${txn.overflowRemarks}"` : txn.overflowRemarks;
      // Overflow goes in column 5 (Transaction Remarks) - 5 leading commas for columns 0-4
      lines.push(`,,,,,${overflowEscaped},,,,`);
    }
  }
  
  // Legend footer
  lines.push(",Legends : Transaction Type Codes,,,,,,,,");
  lines.push(",1. SYNT - Synthetic test legend entry,,,,,,,,");
  lines.push(",2. UPI - Unified Payments Interface,,,,,,,,");
  lines.push(",3. CMS - Cash Management Services,,,,,,,,");
  lines.push(",4. ACH - Automated Clearing House,,,,,,,,");
  lines.push(",5. INT - Interest Payment,,,,,,,,");
  
  return lines.join("\n");
}

function generateHdfcCsv(txns: HdfcTxn[], openingBalance: number): string {
  const lines: string[] = [];
  
  // Calculate totals
  let totalDebits = 0;
  let totalCredits = 0;
  let drCount = 0;
  let crCount = 0;
  
  for (const txn of txns) {
    if (txn.withdrawal !== null) {
      totalDebits += txn.withdrawal;
      drCount++;
    }
    if (txn.deposit !== null) {
      totalCredits += txn.deposit;
      crCount++;
    }
  }
  
  const closingBalance = txns[txns.length - 1].balance;
  
  // Preamble
  lines.push("# SYNTHETIC TEST DATA - HDFC Real Layout");
  lines.push("# Generated by scripts/fixtures/make-bank-xls.ts");
  lines.push("# All data is fictional with SYNT markers");
  lines.push("");
  lines.push("HDFC BANK Ltd.                                                                                                                                          Page No . : 1");
  lines.push("");
  lines.push("");
  lines.push("");
  lines.push(",,,,Account Branch : SYNT BRANCH");
  lines.push("SYNT TEST ACCOUNT HOLDER,,,,Address : SYNT ADDRESS LINE 1");
  lines.push("SYNT ADDRESS LINE 1,,,,SYNT ADDRESS LINE 2");
  lines.push("SYNT ADDRESS LINE 2,,,,SYNT CITY");
  lines.push("SYNT CITY 000000,,,,City : SYNT CITY");
  lines.push("SYNT STATE,,,,State : SYNT STATE");
  lines.push(",,,,SYNT CONTACT INFO");
  lines.push(",,,,Email : synt.test@oksynt.example");
  lines.push("JOINT HOLDERS :,,,,OD Limit : 0.00");
  lines.push(",,,,Cust ID : 000000000");
  lines.push("Nomination : Not Registered,,,,Account No : 00000000000000");
  lines.push("Statement From : 01/10/2030 To : 31/10/2030,,,,A/C Open Date : 01/01/2020");
  lines.push(",,,,Account Status : Regular");
  lines.push(",,,,RTGS/NEFT IFSC : SYNT0000001 MICR : SYNT00000");
  lines.push("");
  lines.push("**************************************************************************************************************************************************");
  
  // Header
  lines.push("Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance");
  
  // Asterisk row under header
  lines.push("********,**********************************,************,********,******************,******************,******************");
  
  // Data rows
  for (const txn of txns) {
    const narrationEscaped = txn.narration.includes(",") ? `"${txn.narration}"` : txn.narration;
    const withdrawal = txn.withdrawal !== null ? txn.withdrawal : "";
    const deposit = txn.deposit !== null ? txn.deposit : "";
    lines.push(`${txn.date},${narrationEscaped},${txn.ref},${txn.valueDate},${withdrawal},${deposit},${txn.balance}`);
  }
  
  // Footer
  lines.push("");
  lines.push("********,**********************************,************,********,******************,******************,******************");
  lines.push("**************************************************************************************************************************");
  lines.push("");
  lines.push("STATEMENT SUMMARY  :-");
  lines.push("Opening Balance,,,,Debits,Credits,Closing Bal");
  lines.push(`${openingBalance},,,,${totalDebits},${totalCredits},${closingBalance}`);
  lines.push("");
  lines.push(",,,,Dr Count,Cr Count");
  lines.push(`,,,,${drCount},${crCount}`);
  lines.push("");
  lines.push("");
  lines.push("Generated On :,29/10/2030 14:30:00,Generated By :,SYNT USER,Requesting Branch Code :,SYNT001");
  lines.push("");
  lines.push("SYNT Branch Contact,000-0000-0000");
  lines.push("SYNT Contact: For any issues contact SYNT customer care at 1800-XXX-XXXX");
  lines.push("Registered Office: SYNT HDFC Bank Ltd. SYNT Tower SYNT City - 000000");
  lines.push("---  End Of Statement ---");
  
  return lines.join("\n");
}

// ============================================================================
// Main
// ============================================================================

function main() {
  // Ensure output directory exists
  mkdirSync(FIXTURES_DIR, { recursive: true });
  
  // Generate ICICI
  console.log("Generating ICICI synthetic fixtures...");
  const iciciWs = buildIciciSheet();
  const iciciWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(iciciWb, iciciWs, "Statement");
  
  const iciciXlsPath = join(FIXTURES_DIR, "icici-synthetic.xls");
  const iciciXlsBuffer = XLSX.write(iciciWb, { type: "buffer", bookType: "biff8" });
  writeFileSync(iciciXlsPath, iciciXlsBuffer);
  console.log(`  Created: ${iciciXlsPath}`);
  
  // Generate ICICI CSV twin
  const iciciTxns = generateIciciTransactions();
  const iciciCsvPath = join(FIXTURES_DIR, "icici-synthetic.csv");
  writeFileSync(iciciCsvPath, generateIciciCsv(iciciTxns));
  console.log(`  Created: ${iciciCsvPath}`);
  
  // Generate HDFC
  console.log("Generating HDFC synthetic fixtures...");
  const hdfcWs = buildHdfcSheet();
  const hdfcWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(hdfcWb, hdfcWs, "Statement");
  
  const hdfcXlsPath = join(FIXTURES_DIR, "hdfc-synthetic.xls");
  const hdfcXlsBuffer = XLSX.write(hdfcWb, { type: "buffer", bookType: "biff8" });
  writeFileSync(hdfcXlsPath, hdfcXlsBuffer);
  console.log(`  Created: ${hdfcXlsPath}`);
  
  // Generate HDFC CSV twin
  const { txns: hdfcTxns, openingBalance } = generateHdfcTransactions();
  const hdfcCsvPath = join(FIXTURES_DIR, "hdfc-synthetic.csv");
  writeFileSync(hdfcCsvPath, generateHdfcCsv(hdfcTxns, openingBalance));
  console.log(`  Created: ${hdfcCsvPath}`);
  
  console.log("\nAll synthetic fixtures generated successfully.");
  console.log("\nTransaction summary:");
  console.log(`  ICICI: ${iciciTxns.length} transactions (${iciciTxns.filter(t => t.deposit !== "0.00").length} credits, ${iciciTxns.filter(t => t.withdrawal !== "0.00").length} debits)`);
  console.log(`    - 2 overflow rows (mid-data + last transaction)`);
  console.log(`    - 1 VPA without @`);
  console.log(`    - 1 hyphenated VPA`);
  console.log(`    - 2 CMS credits`);
  console.log(`    - 1 ACH debit`);
  console.log(`    - 1 interest credit`);
  console.log(`    - 1 value date != txn date`);
  console.log(`  HDFC: ${hdfcTxns.length} transactions (${hdfcTxns.filter(t => t.deposit !== null).length} credits, ${hdfcTxns.filter(t => t.withdrawal !== null).length} debits)`);
  console.log(`    - 1 hyphenated VPA (7-segment)`);
  console.log(`    - 1 ref != 0000+RRN`);
  console.log(`    - 1 15-digit ref`);
  console.log(`    - Card/ATW debits`);
  console.log(`    - 1 interest credit`);
  console.log(`    - 1 value date != date`);
}

main();
