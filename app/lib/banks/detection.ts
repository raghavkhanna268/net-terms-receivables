/**
 * Bank statement detection for HDFC and ICICI banks.
 * Detects bank from headers, preamble lines, and filename.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 */

import type { BankId, DetectionResult, SheetData } from "./types.js";

/** Header patterns for each bank */
const HDFC_HEADERS = [
  "Date",
  "Narration",
  "Chq./Ref.No.",
  "Value Dt",
  "Withdrawal Amt.",
  "Deposit Amt.",
  "Closing Balance",
];

const HDFC_HEADERS_ALT = ["Date", "Narration", "Chq./Ref. No.", "Value Dt"];

const HDFC_ENET_HEADERS = [
  "Date",
  "Transaction Description",
  "Chq/Ref. No",
  "Value Date",
  "Debit Amount",
  "Credit Amount",
  "Closing Balance",
];

const ICICI_HEADERS = [
  "S No.",
  "Transaction Date",
  "Cheque Number",
  "Remarks",
  "Withdrawal",
  "Deposit",
  "Balance",
];

const ICICI_HEADERS_ALT = ["S No.", "Transaction Date", "Cheque/Reference No.", "Remarks"];

const ICICI_CORPORATE_HEADERS = [
  "Tran ID",
  "Value Date",
  "Transaction Date",
  "Cheque/RefNo",
  "Withdrawal (Dr)",
  "Deposit (Cr)",
];

const ICICI_DETAILED_HEADERS = ["Date", "Particulars", "Chq. No.", "Withdrawals", "Deposits", "Balance"];

/** Filename patterns */
const HDFC_FILENAME_PATTERNS = [/hdfc/i, /^AC_\d+_/i, /opStatement/i];

const ICICI_FILENAME_PATTERNS = [/icici/i, /^[0-9]+_statement/i, /e-statement/i];

/** Preamble text patterns */
const HDFC_PREAMBLE_PATTERNS = [
  /HDFC\s*BANK/i,
  /www\.hdfcbank\.com/i,
  /HDFC\s*Bank\s*Limited/i,
  /SAVINGS\s*ACCOUNT\s*STATEMENT/i,
  /Account\s*No\.?\s*:\s*\d{10,14}/i,
];

const ICICI_PREAMBLE_PATTERNS = [
  /ICICI\s*BANK/i,
  /www\.icicibank\.com/i,
  /Saving\s*Account\s*no\.?/i,
  /ICICI\s*Bank\s*Ltd/i,
  /Statement\s*of\s*transactions/i,
];

/**
 * Detect bank from statement data.
 *
 * @param sheet Sheet data to analyze
 * @param fileName Optional filename for additional hints
 * @returns Detection result with confidence score
 */
export function detectBank(sheet: SheetData, fileName?: string): DetectionResult {
  let hdfcScore = 0;
  let iciciScore = 0;
  const reasons: string[] = [];

  // Check filename
  if (fileName) {
    const fnLower = fileName.toLowerCase();
    for (const pattern of HDFC_FILENAME_PATTERNS) {
      if (pattern.test(fileName)) {
        hdfcScore += 0.3;
        reasons.push(`Filename matches HDFC pattern: ${pattern}`);
        break;
      }
    }
    for (const pattern of ICICI_FILENAME_PATTERNS) {
      if (pattern.test(fileName)) {
        iciciScore += 0.3;
        reasons.push(`Filename matches ICICI pattern: ${pattern}`);
        break;
      }
    }
    // Direct name match
    if (fnLower.includes("hdfc") && !fnLower.includes("icici")) {
      hdfcScore += 0.2;
    }
    if (fnLower.includes("icici") && !fnLower.includes("hdfc")) {
      iciciScore += 0.2;
    }
  }

  // Check preamble (first 20 rows)
  const preambleRows = sheet.rows.slice(0, 20);
  for (const row of preambleRows) {
    const rowText = row.map((c) => String(c ?? "")).join(" ");
    for (const pattern of HDFC_PREAMBLE_PATTERNS) {
      if (pattern.test(rowText)) {
        hdfcScore += 0.2;
        reasons.push(`Preamble matches HDFC pattern: ${pattern}`);
        break;
      }
    }
    for (const pattern of ICICI_PREAMBLE_PATTERNS) {
      if (pattern.test(rowText)) {
        iciciScore += 0.2;
        reasons.push(`Preamble matches ICICI pattern: ${pattern}`);
        break;
      }
    }
  }

  // Check header rows
  const headerResult = detectHeaderRow(sheet);
  if (headerResult) {
    if (headerResult.bank === "HDFC") {
      hdfcScore += 0.5;
      reasons.push(`Header row matches HDFC format at row ${headerResult.row + 1}`);
    } else if (headerResult.bank === "ICICI") {
      iciciScore += 0.5;
      reasons.push(`Header row matches ICICI format at row ${headerResult.row + 1}`);
    }
  }

  // Determine winner
  const maxScore = Math.max(hdfcScore, iciciScore);
  if (maxScore < 0.3) {
    return {
      bank: "UNKNOWN",
      confidence: 0,
      reason: "No matching bank patterns found",
    };
  }

  if (hdfcScore > iciciScore) {
    return {
      bank: "HDFC",
      confidence: Math.min(hdfcScore, 1),
      reason: reasons.filter((r) => r.includes("HDFC")).join("; "),
    };
  } else if (iciciScore > hdfcScore) {
    return {
      bank: "ICICI",
      confidence: Math.min(iciciScore, 1),
      reason: reasons.filter((r) => r.includes("ICICI")).join("; "),
    };
  } else {
    // Equal scores - need more evidence
    return {
      bank: "UNKNOWN",
      confidence: maxScore * 0.5,
      reason: "Ambiguous - matches both HDFC and ICICI patterns",
    };
  }
}

/**
 * Find and identify the header row.
 *
 * @param sheet Sheet data
 * @returns Header detection result or null
 */
export function detectHeaderRow(
  sheet: SheetData
): { bank: BankId; row: number; columns: string[] } | null {
  // Check first 30 rows for header pattern
  const maxRows = Math.min(30, sheet.rows.length);

  for (let i = 0; i < maxRows; i++) {
    const row = sheet.rows[i];
    if (!row || row.length < 4) continue;

    // Normalize cell values for comparison
    const cells = row.map((c) => normalizeHeaderCell(c));

    // Check HDFC patterns
    if (matchesHeaderPattern(cells, HDFC_HEADERS) || matchesHeaderPattern(cells, HDFC_HEADERS_ALT)) {
      return { bank: "HDFC", row: i, columns: cells };
    }
    if (matchesHeaderPattern(cells, HDFC_ENET_HEADERS)) {
      return { bank: "HDFC", row: i, columns: cells };
    }

    // Check ICICI patterns
    if (
      matchesHeaderPattern(cells, ICICI_HEADERS) ||
      matchesHeaderPattern(cells, ICICI_HEADERS_ALT)
    ) {
      return { bank: "ICICI", row: i, columns: cells };
    }
    if (matchesHeaderPattern(cells, ICICI_CORPORATE_HEADERS)) {
      return { bank: "ICICI", row: i, columns: cells };
    }
    if (matchesHeaderPattern(cells, ICICI_DETAILED_HEADERS)) {
      return { bank: "ICICI", row: i, columns: cells };
    }
  }

  return null;
}

/**
 * Normalize a header cell value for comparison.
 */
function normalizeHeaderCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  return String(cell)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.$/, "");
}

/**
 * Check if row cells match a header pattern (fuzzy match).
 */
function matchesHeaderPattern(cells: string[], pattern: string[]): boolean {
  // Need at least 60% of pattern columns to match
  let matches = 0;
  const required = Math.ceil(pattern.length * 0.6);

  for (const expected of pattern) {
    const normalizedExpected = expected.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " ");
    for (const cell of cells) {
      const normalizedCell = cell.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " ");
      if (normalizedCell === normalizedExpected || normalizedCell.includes(normalizedExpected)) {
        matches++;
        break;
      }
    }
  }

  return matches >= required;
}

/**
 * Find footer/summary rows that should be skipped.
 * Returns indices of rows that are summary/footer content.
 */
export function detectFooterRows(sheet: SheetData, dataStartRow: number): Set<number> {
  const footerIndices = new Set<number>();

  // Patterns that indicate footer/summary rows
  const footerPatterns = [
    /^Opening\s*Balance/i,
    /^Closing\s*Balance/i,
    /^Total\s*(?:Debit|Credit|Withdrawal|Deposit)/i,
    /^Dr\s*Count/i,
    /^Cr\s*Count/i,
    /^B\/F$/i, // Brought forward
    /^Statement\s*(?:Period|Summary)/i,
    /^\*+\s*Disclaimer/i,
    /^This\s*is\s*a\s*computer/i,
    /^Registered\s*Office/i,
    /^Page\s*\d+\s*of\s*\d+$/i,
    /^Generated\s*on/i,
    /^\s*\*{3,}/,
  ];

  for (let i = dataStartRow; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    if (!row || row.length === 0) continue;

    const firstCell = String(row[0] ?? "").trim();
    const rowText = row.map((c) => String(c ?? "")).join(" ");

    // Check against footer patterns
    for (const pattern of footerPatterns) {
      if (pattern.test(firstCell) || pattern.test(rowText)) {
        footerIndices.add(i);
        break;
      }
    }

    // Empty row often indicates end of data
    const nonEmptyCells = row.filter((c) => c !== null && c !== undefined && String(c).trim());
    if (nonEmptyCells.length <= 1) {
      // Check if subsequent rows are also empty or footer-like
      let allEmpty = true;
      for (let j = i + 1; j < Math.min(i + 5, sheet.rows.length); j++) {
        const nextRow = sheet.rows[j];
        if (nextRow) {
          const nextNonEmpty = nextRow.filter(
            (c) => c !== null && c !== undefined && String(c).trim()
          );
          if (nextNonEmpty.length > 2) {
            allEmpty = false;
            break;
          }
        }
      }
      if (allEmpty) {
        // Mark remaining rows as footer
        for (let j = i; j < sheet.rows.length; j++) {
          footerIndices.add(j);
        }
        break;
      }
    }
  }

  return footerIndices;
}

/**
 * Detect if a row is a continuation of the previous row's narration.
 * HDFC often wraps long narrations across multiple rows.
 */
export function isNarrationContinuation(row: (string | number | Date | boolean | null)[]): boolean {
  if (!row || row.length === 0) return false;

  // Count non-empty cells
  let nonEmptyCount = 0;
  let hasDateLikeFirst = false;
  let hasAmountLike = false;

  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    if (cell === null || cell === undefined || String(cell).trim() === "") {
      continue;
    }
    nonEmptyCount++;
    const str = String(cell).trim();

    // Check if first cell looks like a date
    if (i === 0 && str.match(/^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}/)) {
      hasDateLikeFirst = true;
    }

    // Check if any cell looks like an amount
    if (str.match(/^-?[\d,]+\.?\d*$/)) {
      hasAmountLike = true;
    }
  }

  // Continuation rows typically have:
  // - No date in first column
  // - Very few non-empty cells (just narration text)
  // - No amount-like values
  return !hasDateLikeFirst && nonEmptyCount <= 2 && !hasAmountLike;
}
