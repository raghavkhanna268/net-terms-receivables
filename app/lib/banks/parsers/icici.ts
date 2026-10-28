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
import { detectHeaderRow, detectFooterRows, isNarrationContinuationWithDateCol } from "../detection.js";

/** Check if a row is fully blank (all cells empty or whitespace) */
function isFullyBlankRow(row: (string | number | Date | boolean | null)[]): boolean {
  for (const cell of row) {
    if (cell !== null && cell !== undefined && String(cell).trim() !== "") {
      return false;
    }
  }
  return true;
}
import { parseIndianDate, parseIndianAmount, isBlankOrZero, normalizeIciciRef, looksLikeExcelSerialString } from "../normalisers.js";
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
      errors: [{ row: 0, code: "NO_HEADER_ROW", message: "Could not find header row" }],
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
      errors: [{ row: headerRow, code: "COLUMN_MAP_FAILED", message: "Could not map ICICI columns" }],
      totalRows: sheet.rows.length,
      skippedRows: sheet.rows.length,
    };
  }

  // Detect footer rows to skip
  const footerRows = detectFooterRows(sheet, headerRow + 1);
  skippedRows = headerRow + 1;

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

    // Check for fully blank rows FIRST - skip without touching lastValidRow/pendingNarration
    if (isFullyBlankRow(row)) {
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
    // Use dateCol check since ICICI's first column is S No., not the date
    if (isNarrationContinuationWithDateCol(row, columns.dateCol)) {
      // Orphan continuation (no valid previous transaction) is an error
      if (!lastValidRow) {
        errors.push({
          row: i + 1,
          code: "ROW_PARSE_FAILED",
          message: "Failed to parse row",
        });
        continue;
      }
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
          code: "NORMALIZE_FAILED",
          message: "Failed to normalize transaction",
        });
      }
      lastValidRow = null;
      pendingNarration = [];
    }

    // Parse this row
    const rawRow = extractIciciRow(row, columns, i + 1);
    if (!rawRow) {
      const dateCell = String(row[columns.dateCol] ?? "").trim();
      const narrationContent = String(row[columns.narrationCol] ?? "").trim();
      const debitCell = String(row[columns.withdrawalCol] ?? "").trim();
      const creditCell = String(row[columns.depositCol] ?? "").trim();
      const hasAmount = (debitCell && !debitCell.match(/^[\d.,\s]*$/)) ||
                        (creditCell && !creditCell.match(/^[\d.,\s]*$/)) ||
                        (debitCell && parseFloat(debitCell.replace(/[,\s]/g, "")) > 0) ||
                        (creditCell && parseFloat(creditCell.replace(/[,\s]/g, "")) > 0);
      const hasNonNumericNarration = narrationContent && !narrationContent.match(/^[\d.,\s]*$/);
      const hasDate = dateCell.length > 0;
      if (hasAmount || hasNonNumericNarration || hasDate) {
        errors.push({
          row: i + 1,
          code: "ROW_PARSE_FAILED",
          message: "Failed to parse row",
        });
        // Clear pending narration to avoid carrying orphan text forward
        pendingNarration = [];
      } else {
        skippedRows++;
      }
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
        code: "NORMALIZE_FAILED",
        message: "Failed to normalize transaction",
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
 * Handles both standard ICICI layout and real .xls Value-Date-first layout.
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
      // If we haven't found a transaction date yet, use value date as the primary date
      if (dateCol === -1) {
        dateCol = i;
      }
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
    } else if (
      h.includes("withdrawal") ||
      h.includes("debit") ||
      h === "dr"
    ) {
      withdrawalCol = i;
    } else if (
      h.includes("deposit") ||
      h.includes("credit") ||
      h === "cr"
    ) {
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

  // Check if date looks valid:
  // - Date objects are valid
  // - Numbers are valid (Excel serial dates handled by parseIndianDate)
  // - Strings must contain digits and be at least 6 chars,
  //   OR be a 5-digit Excel serial string (e.g., "46310")
  if (dateRaw instanceof Date) {
    // Date object - OK
  } else if (typeof dateRaw === "number") {
    // Numeric Excel serial - OK, parseIndianDate will validate range
  } else {
    const dateStr = String(dateRaw).trim();
    const isValidLength = dateStr.match(/\d/) && dateStr.length >= 6;
    const isSerialString = looksLikeExcelSerialString(dateStr);
    if (!isValidLength && !isSerialString) {
      return null;
    }
  }

  // Skip rows where narration is just "0.00" or similar (autosweep artifacts)
  if (narration.match(/^[\d.,]+$/) || narration === "NA") {
    return null;
  }

  const valueDateCell = columns.valueDateCol !== undefined ? row[columns.valueDateCol] : undefined;
  const valueDateRaw: string | Date | number | undefined =
    valueDateCell != null
      ? valueDateCell instanceof Date
        ? valueDateCell
        : typeof valueDateCell === "number"
          ? valueDateCell
          : String(valueDateCell)
      : undefined;

  // Normalize ICICI ref
  const rawRef = row[columns.refCol] ? String(row[columns.refCol]).trim() : undefined;
  const normalizedRef = normalizeIciciRef(rawRef);

  return {
    dateRaw: dateRaw instanceof Date ? dateRaw : typeof dateRaw === "number" ? dateRaw : String(dateRaw),
    valueDateRaw,
    narration,
    refNo: normalizedRef,
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
  // Parse date (handles strings, Date objects, and numeric Excel serials)
  const date = parseIndianDate(raw.dateRaw);
  if (!date) {
    return null;
  }

  const valueDate = raw.valueDateRaw
    ? parseIndianDate(raw.valueDateRaw) ?? undefined
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
