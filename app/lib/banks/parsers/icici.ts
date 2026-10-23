/**
 * ICICI Bank statement parser.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * ICICI statement formats:
 * - Retail savings: S No. | Transaction Date | Cheque Number | Remarks | Withdrawal | Deposit | Balance (DD.MM.YYYY)
 * - Corporate Detailed: Tran ID | Value Date | Transaction Date | Cheque/RefNo | Withdrawal (Dr) | Deposit (Cr)
 * - Detailed: Date | Particulars | Chq. No. | Withdrawals | Deposits | Balance
 *
 * Sources:
 * - https://www.tieout.in/banks/icici/
 * - https://jemsky.com/banks/icici
 * - https://www.icici.bank.in/personal-banking/accounts/savings-account/statements
 */

import type {
  SheetData,
  RawTxnRow,
  NormalisedTxn,
  ParseError,
  ParseResult,
  DetectionResult,
} from "../types.js";
import { detectHeaderRow, detectFooterRows, isNarrationContinuation } from "../detection.js";
import { parseIndianDate, parseIndianAmount, isBlankOrZero } from "../normalisers.js";
import { parseNarration, extractUtrForDedupe } from "../narration-parser.js";
import { generateDedupeKey, dedupeTransactions } from "../dedupe.js";

/** Column mapping for ICICI format */
interface IciciColumnMap {
  snoCol?: number;
  tranIdCol?: number;
  dateCol: number;
  valueDateCol?: number;
  refCol: number;
  narrationCol: number;
  withdrawalCol: number;
  depositCol: number;
  balanceCol: number;
}

/**
 * Parse ICICI bank statement.
 */
export async function parseIciciStatement(
  sheet: SheetData,
  detection: DetectionResult,
  existingKeys?: Set<string>
): Promise<ParseResult> {
  const transactions: NormalisedTxn[] = [];
  const errors: ParseError[] = [];
  let skippedRows = 0;

  // Find header row
  const headerResult = detectHeaderRow(sheet);
  if (!headerResult) {
    return {
      detection,
      transactions: [],
      errors: [{ row: 0, message: "Could not find header row" }],
      totalRows: sheet.rows.length,
      skippedRows: sheet.rows.length,
    };
  }

  const headerRow = headerResult.row;
  const columns = mapIciciColumns(headerResult.columns);

  if (!columns) {
    return {
      detection,
      transactions: [],
      errors: [{ row: headerRow, message: "Could not map ICICI columns" }],
      totalRows: sheet.rows.length,
      skippedRows: sheet.rows.length,
    };
  }

  // Detect footer rows to skip
  const footerRows = detectFooterRows(sheet, headerRow + 1);
  skippedRows = headerRow + 1 + footerRows.size;

  // Process data rows
  let pendingNarration: string[] = [];
  let lastValidRow: RawTxnRow | null = null;

  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    if (!row) continue;

    // Skip footer rows
    if (footerRows.has(i)) {
      skippedRows++;
      continue;
    }

    // Check for B/F (brought forward) row - can be in first cell or remarks column
    const firstCell = String(row[0] ?? "").trim().toUpperCase();
    const remarksCell = String(row[columns.narrationCol] ?? "").trim().toUpperCase();
    if (
      firstCell === "B/F" ||
      firstCell.includes("BROUGHT FORWARD") ||
      remarksCell === "B/F" ||
      remarksCell.includes("BROUGHT FORWARD")
    ) {
      skippedRows++;
      continue;
    }

    // Check if this is a narration continuation row (ICICI wraps narrations too)
    if (isNarrationContinuation(row)) {
      const narrationPart = String(row[columns.narrationCol] ?? "").trim();
      if (narrationPart) {
        pendingNarration.push(narrationPart);
      }
      skippedRows++;
      continue;
    }

    // Process the previous row before handling the new one
    if (lastValidRow) {
      if (pendingNarration.length > 0) {
        lastValidRow.narration = [lastValidRow.narration, ...pendingNarration].join(" ");
      }
      const normalized = await normalizeIciciRow(lastValidRow);
      if (normalized) {
        transactions.push(normalized);
      } else {
        errors.push({
          row: lastValidRow.sourceRow,
          message: "Failed to normalize transaction",
          rawData: lastValidRow,
        });
      }
      lastValidRow = null;
      pendingNarration = [];
    }

    // Parse this row
    const rawRow = extractIciciRow(row, columns, i + 1);
    if (!rawRow) {
      skippedRows++;
      continue;
    }

    lastValidRow = rawRow;
  }

  // Don't forget the last row
  if (lastValidRow) {
    if (pendingNarration.length > 0) {
      lastValidRow.narration = [lastValidRow.narration, ...pendingNarration].join(" ");
    }
    const normalized = await normalizeIciciRow(lastValidRow);
    if (normalized) {
      transactions.push(normalized);
    } else {
      errors.push({
        row: lastValidRow.sourceRow,
        message: "Failed to normalize transaction",
        rawData: lastValidRow,
      });
    }
  }

  // Deduplicate
  const deduped = await dedupeTransactions(transactions, existingKeys);

  return {
    detection,
    transactions: deduped,
    errors,
    totalRows: sheet.rows.length,
    skippedRows,
  };
}

/**
 * Map column indices from header row.
 */
function mapIciciColumns(headers: string[]): IciciColumnMap | null {
  const lower = headers.map((h) => h.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " "));

  let snoCol: number | undefined;
  let tranIdCol: number | undefined;
  let dateCol = -1;
  let valueDateCol: number | undefined;
  let refCol = -1;
  let narrationCol = -1;
  let withdrawalCol = -1;
  let depositCol = -1;
  let balanceCol = -1;

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (h === "s no" || h === "sno" || h === "sr no") {
      snoCol = i;
    } else if (h.includes("tran id") || h === "transaction id") {
      tranIdCol = i;
    } else if (h.includes("transaction date") || h === "date" || h === "txn date") {
      dateCol = i;
    } else if (h.includes("value date") || h === "value dt") {
      valueDateCol = i;
    } else if (
      h.includes("cheque") ||
      h.includes("chq") ||
      h.includes("ref") ||
      h.includes("chequereference")
    ) {
      refCol = i;
    } else if (
      h.includes("remarks") ||
      h.includes("particulars") ||
      h.includes("description") ||
      h === "narration"
    ) {
      narrationCol = i;
    } else if (h.includes("withdrawal") || h.includes("debit") || h === "dr") {
      withdrawalCol = i;
    } else if (h.includes("deposit") || h.includes("credit") || h === "cr") {
      depositCol = i;
    } else if (h.includes("balance")) {
      // Skip autosweep/reverse sweep columns
      if (!h.includes("autosweep") && !h.includes("reverse")) {
        balanceCol = i;
      }
    }
  }

  // Require at minimum: date, narration, and at least one amount column
  if (dateCol === -1 || narrationCol === -1 || (withdrawalCol === -1 && depositCol === -1)) {
    return null;
  }

  return {
    snoCol,
    tranIdCol,
    dateCol,
    valueDateCol,
    refCol: refCol === -1 ? narrationCol - 1 : refCol,
    narrationCol,
    withdrawalCol: withdrawalCol === -1 ? depositCol - 1 : withdrawalCol,
    depositCol: depositCol === -1 ? withdrawalCol + 1 : depositCol,
    balanceCol: balanceCol === -1 ? Math.max(withdrawalCol, depositCol) + 1 : balanceCol,
  };
}

/**
 * Extract raw data from a row.
 */
function extractIciciRow(
  row: (string | number | Date | boolean | null)[],
  columns: IciciColumnMap,
  sourceRow: number
): RawTxnRow | null {
  const dateRaw = row[columns.dateCol];
  const narration = String(row[columns.narrationCol] ?? "").trim();

  // Must have date and narration
  if (!dateRaw || !narration) {
    return null;
  }

  // Check if date looks valid (contains digits)
  const dateStr = dateRaw instanceof Date ? dateRaw.toISOString() : String(dateRaw);
  if (!dateStr.match(/\d/) || dateStr.length < 6) {
    return null;
  }

  // Skip rows where narration is just "0.00" or similar (autosweep artifacts)
  if (narration.match(/^[\d.,]+$/) || narration === "NA") {
    return null;
  }

  const valueDateCell = columns.valueDateCol !== undefined ? row[columns.valueDateCol] : undefined;
  const valueDateRaw: string | Date | undefined =
    valueDateCell != null
      ? valueDateCell instanceof Date
        ? valueDateCell
        : String(valueDateCell)
      : undefined;

  return {
    dateRaw: dateRaw instanceof Date ? dateRaw : dateStr,
    valueDateRaw,
    narration,
    refNo: row[columns.refCol] ? String(row[columns.refCol]).trim() : undefined,
    debitRaw: row[columns.withdrawalCol] ? String(row[columns.withdrawalCol]) : undefined,
    creditRaw: row[columns.depositCol] ? String(row[columns.depositCol]) : undefined,
    balanceRaw: row[columns.balanceCol] ? String(row[columns.balanceCol]) : undefined,
    sourceRow,
  };
}

/**
 * Normalize a raw ICICI row to standard format.
 */
async function normalizeIciciRow(raw: RawTxnRow): Promise<NormalisedTxn | null> {
  // Parse date
  const date = parseIndianDate(raw.dateRaw as string | Date);
  if (!date) {
    return null;
  }

  const valueDate = raw.valueDateRaw
    ? parseIndianDate(raw.valueDateRaw as string | Date) ?? undefined
    : undefined;

  // Determine amount and direction
  const debitParsed = parseIndianAmount(raw.debitRaw);
  const creditParsed = parseIndianAmount(raw.creditRaw);

  let amountPaise: number;
  let direction: "CR" | "DR";

  if (creditParsed && creditParsed.paise > 0 && !isBlankOrZero(raw.creditRaw)) {
    amountPaise = creditParsed.paise;
    direction = "CR";
  } else if (debitParsed && debitParsed.paise > 0 && !isBlankOrZero(raw.debitRaw)) {
    amountPaise = debitParsed.paise;
    direction = "DR";
  } else {
    return null;
  }

  // Parse balance - ICICI often has "Cr" or "Dr" suffix
  let balancePaise: number | undefined;
  if (raw.balanceRaw) {
    const balanceStr = raw.balanceRaw.trim();
    // Remove Cr/Dr suffix for balance parsing
    const cleanBalance = balanceStr.replace(/\s*(Cr|Dr)\.?\s*$/i, "").trim();
    const balanceParsed = parseIndianAmount(cleanBalance);
    balancePaise = balanceParsed?.paise;
  }

  // Parse narration
  const parsed = parseNarration(raw.narration, "ICICI");

  // Extract UTR only for valid rails
  const utr = extractUtrForDedupe(raw.narration, parsed.rail, raw.refNo);
  if (utr) {
    parsed.utr = utr;
  }

  // Generate dedupe key with all relevant fields
  const dedupeKey = await generateDedupeKey(
    date,
    amountPaise,
    direction,
    raw.narration,
    parsed.rail,
    utr ?? undefined,
    balancePaise,
    valueDate,
    raw.refNo
  );

  return {
    date,
    valueDate,
    amountPaise,
    direction,
    narration: raw.narration,
    refNo: raw.refNo,
    balancePaise,
    parsed,
    dedupeKey,
    sourceRow: raw.sourceRow,
  };
}
