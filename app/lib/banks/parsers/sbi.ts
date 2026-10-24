/**
 * SBI (State Bank of India) statement parser.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * ==================== IMPORTANT ====================
 * SYNTHETIC / UNVERIFIED LAYOUT
 * 
 * This parser's column layout is based on publicly available documentation
 * and has NOT been verified against real SBI statement exports.
 * Verification pending redacted real samples from the merchant.
 *
 * Public sources used:
 * - https://www.tieout.in/banks/sbi/
 * - https://www.cleanstatement.in/sbi-bank-statement-to-excel
 * - https://statementconverter.io/blog/convert-sbi-bank-statement-to-excel
 * ===================================================
 *
 * SBI statement formats (UNVERIFIED):
 * - Retail: Txn Date | Value Date | Description | Ref No./Cheque No. | Debit | Credit | Balance
 * - Corporate: Transaction Date | Value Date | Transaction Remarks | Cheque/Ref No | Withdrawal | Deposit | Balance
 *
 * Date formats: DD/MM/YYYY, DD MMM YYYY, DD-MMM-YYYY
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

/** Column mapping for SBI format */
interface SbiColumnMap {
  dateCol: number;
  valueDateCol: number;
  descriptionCol: number;
  refCol: number;
  debitCol: number;
  creditCol: number;
  balanceCol: number;
}

/**
 * Parse SBI bank statement.
 */
export async function parseSbiStatement(
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
  const columns = mapSbiColumns(headerResult.columns);

  if (!columns) {
    return {
      detection,
      transactions: [],
      errors: [{ row: headerRow, code: "COLUMN_MAP_FAILED", message: "Could not map SBI columns" }],
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

    // Check for Opening Balance / Closing Balance / B/F rows
    const firstCell = String(row[0] ?? "").trim().toUpperCase();
    const descCell = String(row[columns.descriptionCol] ?? "").trim().toUpperCase();
    if (
      firstCell.includes("OPENING") ||
      firstCell.includes("CLOSING") ||
      descCell.includes("OPENING BALANCE") ||
      descCell.includes("CLOSING BALANCE") ||
      descCell === "O/B" ||
      descCell === "B/F" ||
      descCell.includes("BROUGHT FORWARD")
    ) {
      skippedRows++;
      continue;
    }

    // Check if this is a narration continuation row
    if (isNarrationContinuation(row)) {
      const narrationPart = String(row[columns.descriptionCol] ?? "").trim();
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
      const normalized = await normalizeSbiRow(lastValidRow);
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
    const rawRow = extractSbiRow(row, columns, i + 1);
    if (!rawRow) {
      const dateCell = String(row[columns.dateCol] ?? "").trim();
      const descContent = String(row[columns.descriptionCol] ?? "").trim();
      const debitCell = String(row[columns.debitCol] ?? "").trim();
      const creditCell = String(row[columns.creditCol] ?? "").trim();
      const hasAmount = (debitCell && !debitCell.match(/^[\d.,\s]*$/)) ||
                        (creditCell && !creditCell.match(/^[\d.,\s]*$/)) ||
                        (debitCell && parseFloat(debitCell.replace(/[,\s]/g, "")) > 0) ||
                        (creditCell && parseFloat(creditCell.replace(/[,\s]/g, "")) > 0);
      const hasNonNumericDesc = descContent && !descContent.match(/^[\d.,\s]*$/);
      const hasDate = dateCell.length > 0;
      if (hasAmount || hasNonNumericDesc || hasDate) {
        errors.push({
          row: i + 1,
          code: "ROW_PARSE_FAILED",
          message: "Failed to parse row",
        });
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
    const normalized = await normalizeSbiRow(lastValidRow);
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
 */
function mapSbiColumns(headers: string[]): SbiColumnMap | null {
  const lower = headers.map((h) => h.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " "));

  let dateCol = -1;
  let valueDateCol = -1;
  let descriptionCol = -1;
  let refCol = -1;
  let debitCol = -1;
  let creditCol = -1;
  let balanceCol = -1;

  for (let i = 0; i < lower.length; i++) {
    const h = lower[i];
    if (h === "txn date" || h === "transaction date" || h === "date") {
      dateCol = i;
    } else if (h.includes("value") && (h.includes("dt") || h.includes("date"))) {
      valueDateCol = i;
    } else if (
      h.includes("description") ||
      h.includes("remarks") ||
      h.includes("particulars") ||
      h === "narration"
    ) {
      descriptionCol = i;
    } else if (h.includes("ref") || h.includes("chq") || h.includes("cheque")) {
      refCol = i;
    } else if (h.includes("debit") || h.includes("withdrawal") || h === "dr") {
      debitCol = i;
    } else if (h.includes("credit") || h.includes("deposit") || h === "cr") {
      creditCol = i;
    } else if (h.includes("balance") && !h.includes("opening") && !h.includes("closing")) {
      balanceCol = i;
    }
  }

  // If no value date column found, use date column
  if (valueDateCol === -1) {
    valueDateCol = dateCol;
  }

  // Require at minimum: date, description, and at least one amount column
  if (dateCol === -1 || descriptionCol === -1 || (debitCol === -1 && creditCol === -1)) {
    return null;
  }

  return {
    dateCol,
    valueDateCol,
    descriptionCol,
    refCol: refCol === -1 ? descriptionCol + 1 : refCol,
    debitCol: debitCol === -1 ? creditCol - 1 : debitCol,
    creditCol: creditCol === -1 ? debitCol + 1 : creditCol,
    balanceCol: balanceCol === -1 ? Math.max(debitCol, creditCol) + 1 : balanceCol,
  };
}

/**
 * Extract raw data from a row.
 */
function extractSbiRow(
  row: (string | number | Date | boolean | null)[],
  columns: SbiColumnMap,
  sourceRow: number
): RawTxnRow | null {
  const dateRaw = row[columns.dateCol];
  const description = String(row[columns.descriptionCol] ?? "").trim();

  // Must have date and description
  if (!dateRaw || !description) {
    return null;
  }

  // Check if date looks valid
  const dateStr = dateRaw instanceof Date ? dateRaw.toISOString() : String(dateRaw);
  if (!dateStr.match(/\d/) || dateStr.length < 6) {
    return null;
  }

  // Skip rows where description is just numbers (summary artifacts)
  if (description.match(/^[\d.,]+$/) || description === "NA") {
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
    narration: description,
    refNo: row[columns.refCol] ? String(row[columns.refCol]).trim() : undefined,
    debitRaw: row[columns.debitCol] ? String(row[columns.debitCol]) : undefined,
    creditRaw: row[columns.creditCol] ? String(row[columns.creditCol]) : undefined,
    balanceRaw: row[columns.balanceCol] ? String(row[columns.balanceCol]) : undefined,
    sourceRow,
  };
}

/**
 * Normalize a raw SBI row to standard format.
 */
async function normalizeSbiRow(raw: RawTxnRow): Promise<NormalisedTxn | null> {
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

  // Parse balance - SBI may have "Cr" or "Dr" suffix
  let balancePaise: number | undefined;
  if (raw.balanceRaw) {
    const balanceStr = raw.balanceRaw.trim();
    const cleanBalance = balanceStr.replace(/\s*(Cr|Dr)\.?\s*$/i, "").trim();
    const balanceParsed = parseIndianAmount(cleanBalance);
    balancePaise = balanceParsed?.paise;
  }

  // Parse narration
  const parsed = parseNarration(raw.narration, "SBI");

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
