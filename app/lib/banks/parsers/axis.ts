/**
 * Axis Bank statement parser.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * ==================== IMPORTANT ====================
 * SYNTHETIC / UNVERIFIED LAYOUT
 * 
 * This parser's column layout is based on publicly available documentation
 * and has NOT been verified against real Axis Bank statement exports.
 * Verification pending redacted real samples from the merchant.
 *
 * Public sources used:
 * - https://www.tieout.in/banks/axis/
 * - https://www.cleanstatement.in/axis-bank-statement-to-excel
 * - https://statementconverter.io/blog/convert-axis-bank-statement-to-excel
 * ===================================================
 *
 * Axis Bank statement formats (UNVERIFIED):
 * - Retail: Tran Date | Chq No | Particulars | DR | CR | Balance
 * - Corporate: Transaction Date | Value Date | Particulars | Chq./Ref.No. | Debit | Credit | Balance
 *
 * Date formats: DD-MM-YYYY, DD/MM/YYYY, DD-MMM-YYYY
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

/** Column mapping for Axis format */
interface AxisColumnMap {
  dateCol: number;
  valueDateCol?: number;
  particularsCol: number;
  refCol: number;
  debitCol: number;
  creditCol: number;
  balanceCol: number;
}

/**
 * Parse Axis Bank statement.
 */
export async function parseAxisStatement(
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
  const columns = mapAxisColumns(headerResult.columns);

  if (!columns) {
    return {
      detection,
      transactions: [],
      errors: [{ row: headerRow, message: "Could not map Axis columns" }],
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

    // Check for Opening Balance row
    const firstCell = String(row[0] ?? "").trim().toUpperCase();
    const particularsCell = String(row[columns.particularsCol] ?? "").trim().toUpperCase();
    if (
      firstCell.includes("OPENING") ||
      particularsCell.includes("OPENING BALANCE") ||
      particularsCell === "B/F" ||
      particularsCell.includes("BROUGHT FORWARD")
    ) {
      skippedRows++;
      continue;
    }

    // Check if this is a narration continuation row
    if (isNarrationContinuation(row)) {
      const narrationPart = String(row[columns.particularsCol] ?? "").trim();
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
      const normalized = await normalizeAxisRow(lastValidRow);
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
    const rawRow = extractAxisRow(row, columns, i + 1);
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
    const normalized = await normalizeAxisRow(lastValidRow);
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
function mapAxisColumns(headers: string[]): AxisColumnMap | null {
  const lower = headers.map((h) => h.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " "));

  let dateCol = -1;
  let valueDateCol: number | undefined;
  let particularsCol = -1;
  let refCol = -1;
  let debitCol = -1;
  let creditCol = -1;
  let balanceCol = -1;

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (h === "tran date" || h === "transaction date" || h === "txn date" || h === "date") {
      dateCol = i;
    } else if (h.includes("value") && (h.includes("dt") || h.includes("date"))) {
      valueDateCol = i;
    } else if (h.includes("particulars") || h.includes("description") || h === "narration") {
      particularsCol = i;
    } else if (h.includes("chq") || h.includes("ref") || h.includes("cheque")) {
      refCol = i;
    } else if (h.includes("debit") || h.includes("withdrawal") || h === "dr") {
      debitCol = i;
    } else if (h.includes("credit") || h.includes("deposit") || h === "cr") {
      creditCol = i;
    } else if (h.includes("balance") && !h.includes("opening") && !h.includes("closing")) {
      balanceCol = i;
    }
  }

  // Require at minimum: date, particulars, and at least one amount column
  if (dateCol === -1 || particularsCol === -1 || (debitCol === -1 && creditCol === -1)) {
    return null;
  }

  return {
    dateCol,
    valueDateCol,
    particularsCol,
    refCol: refCol === -1 ? particularsCol - 1 : refCol,
    debitCol: debitCol === -1 ? creditCol - 1 : debitCol,
    creditCol: creditCol === -1 ? debitCol + 1 : creditCol,
    balanceCol: balanceCol === -1 ? Math.max(debitCol, creditCol) + 1 : balanceCol,
  };
}

/**
 * Extract raw data from a row.
 */
function extractAxisRow(
  row: (string | number | Date | boolean | null)[],
  columns: AxisColumnMap,
  sourceRow: number
): RawTxnRow | null {
  const dateRaw = row[columns.dateCol];
  const particulars = String(row[columns.particularsCol] ?? "").trim();

  // Must have date and particulars
  if (!dateRaw || !particulars) {
    return null;
  }

  // Check if date looks valid
  const dateStr = dateRaw instanceof Date ? dateRaw.toISOString() : String(dateRaw);
  if (!dateStr.match(/\d/) || dateStr.length < 6) {
    return null;
  }

  // Skip rows where particulars is just numbers (summary artifacts)
  if (particulars.match(/^[\d.,]+$/) || particulars === "NA") {
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
    narration: particulars,
    refNo: row[columns.refCol] ? String(row[columns.refCol]).trim() : undefined,
    debitRaw: row[columns.debitCol] ? String(row[columns.debitCol]) : undefined,
    creditRaw: row[columns.creditCol] ? String(row[columns.creditCol]) : undefined,
    balanceRaw: row[columns.balanceCol] ? String(row[columns.balanceCol]) : undefined,
    sourceRow,
  };
}

/**
 * Normalize a raw Axis row to standard format.
 */
async function normalizeAxisRow(raw: RawTxnRow): Promise<NormalisedTxn | null> {
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

  // Parse balance
  let balancePaise: number | undefined;
  if (raw.balanceRaw) {
    const balanceStr = raw.balanceRaw.trim();
    const cleanBalance = balanceStr.replace(/\s*(Cr|Dr)\.?\s*$/i, "").trim();
    const balanceParsed = parseIndianAmount(cleanBalance);
    balancePaise = balanceParsed?.paise;
  }

  // Parse narration
  const parsed = parseNarration(raw.narration, "AXIS");

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
