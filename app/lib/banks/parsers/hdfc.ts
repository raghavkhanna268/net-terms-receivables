/**
 * HDFC Bank statement parser.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * HDFC statement formats:
 * - Retail: Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
 * - ENet (corporate): Date | Transaction Description | Chq/Ref. No | Value Date | Debit Amount | Credit Amount | Closing Balance
 *
 * Date formats: dd/mm/yy, dd/mm/yyyy, dd-MMM-yyyy (corporate)
 *
 * Sources:
 * - https://www.tieout.in/banks/hdfc/
 * - https://www.cleanstatement.in/hdfc-bank-statement-to-excel
 * - https://statementconverter.io/blog/convert-hdfc-bank-statement-to-excel
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

/** Column mapping for HDFC retail format */
interface HdfcColumnMap {
  dateCol: number;
  narrationCol: number;
  refCol: number;
  valueDateCol: number;
  withdrawalCol: number;
  depositCol: number;
  balanceCol: number;
}

/**
 * Parse HDFC bank statement.
 */
export async function parseHdfcStatement(
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
  const columns = mapHdfcColumns(headerResult.columns);

  if (!columns) {
    return {
      detection,
      transactions: [],
      errors: [{ row: headerRow, message: "Could not map HDFC columns" }],
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

    // Check if this is a narration continuation row
    if (isNarrationContinuation(row)) {
      // Append narration to pending
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
      const normalized = await normalizeHdfcRow(lastValidRow);
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
    const rawRow = extractHdfcRow(row, columns, i + 1);
    if (!rawRow) {
      // Empty or invalid row
      skippedRows++;
      continue;
    }

    // Store for potential continuation
    lastValidRow = rawRow;
  }

  // Don't forget the last row
  if (lastValidRow) {
    if (pendingNarration.length > 0) {
      lastValidRow.narration = [lastValidRow.narration, ...pendingNarration].join(" ");
    }
    const normalized = await normalizeHdfcRow(lastValidRow);
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
function mapHdfcColumns(headers: string[]): HdfcColumnMap | null {
  const lower = headers.map((h) => h.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " "));

  let dateCol = -1;
  let narrationCol = -1;
  let refCol = -1;
  let valueDateCol = -1;
  let withdrawalCol = -1;
  let depositCol = -1;
  let balanceCol = -1;

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (h === "date" || h === "txn date" || h === "transaction date") {
      dateCol = i;
    } else if (h.includes("narration") || h === "transaction description" || h === "description") {
      narrationCol = i;
    } else if (h.includes("chq") || h.includes("ref") || h.includes("cheque")) {
      // Could be ref or something else, check for value date
      if (h.includes("value")) {
        valueDateCol = i;
      } else {
        refCol = i;
      }
    } else if (h.includes("value") && (h.includes("dt") || h.includes("date"))) {
      valueDateCol = i;
    } else if (
      h.includes("withdrawal") ||
      h.includes("debit") ||
      h === "dr" ||
      h.includes("withdrawal amt")
    ) {
      withdrawalCol = i;
    } else if (
      h.includes("deposit") ||
      h.includes("credit") ||
      h === "cr" ||
      h.includes("deposit amt")
    ) {
      depositCol = i;
    } else if (h.includes("balance") || h.includes("closing")) {
      balanceCol = i;
    }
  }

  // Require at minimum: date, narration, and at least one amount column
  if (dateCol === -1 || narrationCol === -1 || (withdrawalCol === -1 && depositCol === -1)) {
    return null;
  }

  return {
    dateCol,
    narrationCol,
    refCol: refCol === -1 ? narrationCol + 1 : refCol,
    valueDateCol: valueDateCol === -1 ? dateCol : valueDateCol,
    withdrawalCol: withdrawalCol === -1 ? depositCol - 1 : withdrawalCol,
    depositCol: depositCol === -1 ? withdrawalCol + 1 : depositCol,
    balanceCol: balanceCol === -1 ? Math.max(withdrawalCol, depositCol) + 1 : balanceCol,
  };
}

/**
 * Extract raw data from a row.
 */
function extractHdfcRow(
  row: (string | number | Date | boolean | null)[],
  columns: HdfcColumnMap,
  sourceRow: number
): RawTxnRow | null {
  const dateRaw = row[columns.dateCol];
  const narration = String(row[columns.narrationCol] ?? "").trim();

  // Must have date and narration
  if (!dateRaw || !narration) {
    return null;
  }

  // Check if date looks valid
  const dateStr = dateRaw instanceof Date ? dateRaw.toISOString() : String(dateRaw);
  if (!dateStr.match(/\d/) || dateStr.length < 6) {
    return null;
  }

  const valueDateCell = row[columns.valueDateCol];
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
 * Normalize a raw HDFC row to standard format.
 */
async function normalizeHdfcRow(raw: RawTxnRow): Promise<NormalisedTxn | null> {
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
    // No valid amount - might be a summary row
    return null;
  }

  // Parse balance
  const balanceParsed = parseIndianAmount(raw.balanceRaw);
  const balancePaise = balanceParsed?.paise;

  // Parse narration
  const parsed = parseNarration(raw.narration, "HDFC");

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
