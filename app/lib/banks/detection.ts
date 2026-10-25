/**
 * Bank statement detection for HDFC, ICICI, SBI, and Axis banks.
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

/**
 * SBI Header patterns (SYNTHETIC / UNVERIFIED)
 * Sources:
 * - https://www.tieout.in/banks/sbi/
 * - https://www.cleanstatement.in/sbi-bank-statement-to-excel
 * 
 * Note: Only using primary SBI header format to avoid collision with ICICI
 * headers that share similar column names (Transaction Date, Withdrawal, Deposit).
 */
const SBI_HEADERS = [
  "Txn Date",
  "Value Date",
  "Description",
  "Ref No./Cheque No.",
  "Debit",
  "Credit",
  "Balance",
];

/**
 * Axis Bank Header patterns (SYNTHETIC / UNVERIFIED)
 * Sources:
 * - https://www.tieout.in/banks/axis/
 * - https://www.cleanstatement.in/axis-bank-statement-to-excel
 */
const AXIS_HEADERS = [
  "Tran Date",
  "Chq No",
  "Particulars",
  "DR",
  "CR",
  "Balance",
];

const AXIS_HEADERS_ALT = ["Transaction Date", "Value Date", "Particulars", "Chq./Ref.No.", "Debit", "Credit", "Balance"];

const AXIS_HEADERS_CORPORATE = ["Tran Date", "Value Date", "Particulars", "Chq No", "Debit", "Credit", "Balance"];

/** Filename patterns */
const HDFC_FILENAME_PATTERNS = [/hdfc/i, /^AC_\d+_/i, /opStatement/i];

const ICICI_FILENAME_PATTERNS = [/icici/i, /^[0-9]+_statement/i, /e-statement/i];

const SBI_FILENAME_PATTERNS = [/sbi/i, /state\s*bank/i, /^SB\d+/i];

const AXIS_FILENAME_PATTERNS = [/axis/i, /^AXIS/i, /^SA\d+/i];

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

const SBI_PREAMBLE_PATTERNS = [
  /STATE\s*BANK\s*OF\s*INDIA/i,
  /www\.onlinesbi\.com/i,
  /www\.sbi\.co\.in/i,
];

const AXIS_PREAMBLE_PATTERNS = [
  /AXIS\s*BANK/i,
  /www\.axisbank\.com/i,
  /Axis\s*Bank\s*Ltd/i,
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
  let sbiScore = 0;
  let axisScore = 0;
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
    for (const pattern of SBI_FILENAME_PATTERNS) {
      if (pattern.test(fileName)) {
        sbiScore += 0.3;
        reasons.push(`Filename matches SBI pattern: ${pattern}`);
        break;
      }
    }
    for (const pattern of AXIS_FILENAME_PATTERNS) {
      if (pattern.test(fileName)) {
        axisScore += 0.3;
        reasons.push(`Filename matches Axis pattern: ${pattern}`);
        break;
      }
    }
    // Direct name match
    if (fnLower.includes("hdfc") && !fnLower.includes("icici") && !fnLower.includes("sbi") && !fnLower.includes("axis")) {
      hdfcScore += 0.2;
    }
    if (fnLower.includes("icici") && !fnLower.includes("hdfc") && !fnLower.includes("sbi") && !fnLower.includes("axis")) {
      iciciScore += 0.2;
    }
    if (fnLower.includes("sbi") && !fnLower.includes("hdfc") && !fnLower.includes("icici") && !fnLower.includes("axis")) {
      sbiScore += 0.2;
    }
    if (fnLower.includes("axis") && !fnLower.includes("hdfc") && !fnLower.includes("icici") && !fnLower.includes("sbi")) {
      axisScore += 0.2;
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
    for (const pattern of SBI_PREAMBLE_PATTERNS) {
      if (pattern.test(rowText)) {
        sbiScore += 0.2;
        reasons.push(`Preamble matches SBI pattern: ${pattern}`);
        break;
      }
    }
    for (const pattern of AXIS_PREAMBLE_PATTERNS) {
      if (pattern.test(rowText)) {
        axisScore += 0.2;
        reasons.push(`Preamble matches Axis pattern: ${pattern}`);
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
    } else if (headerResult.bank === "SBI") {
      sbiScore += 0.5;
      reasons.push(`Header row matches SBI format at row ${headerResult.row + 1}`);
    } else if (headerResult.bank === "AXIS") {
      axisScore += 0.5;
      reasons.push(`Header row matches Axis format at row ${headerResult.row + 1}`);
    }
  }

  // Determine winner
  const scores = [
    { bank: "HDFC" as BankId, score: hdfcScore },
    { bank: "ICICI" as BankId, score: iciciScore },
    { bank: "SBI" as BankId, score: sbiScore },
    { bank: "AXIS" as BankId, score: axisScore },
  ];
  scores.sort((a, b) => b.score - a.score);

  const maxScore = scores[0].score;
  const secondScore = scores[1].score;

  if (maxScore < 0.3) {
    return {
      bank: "UNKNOWN",
      confidence: 0,
      reason: "No matching bank patterns found",
    };
  }

  // Check for tie between top two
  if (maxScore === secondScore) {
    return {
      bank: "UNKNOWN",
      confidence: maxScore * 0.5,
      reason: `Ambiguous - matches both ${scores[0].bank} and ${scores[1].bank} patterns`,
    };
  }

  const winningBank = scores[0].bank;
  // Filter reasons case-insensitively to handle banks like "AXIS" vs "Axis" in reason text
  const winningBankLower = winningBank.toLowerCase();
  return {
    bank: winningBank,
    confidence: Math.min(maxScore, 1),
    reason: reasons.filter((r) => r.toLowerCase().includes(winningBankLower)).join("; "),
  };
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

    // Check Axis patterns BEFORE ICICI (UNVERIFIED)
    // Axis has more specific header names like "Tran Date" which could be 
    // falsely matched by ICICI's "Date" via substring matching
    if (
      matchesHeaderPattern(cells, AXIS_HEADERS) ||
      matchesHeaderPattern(cells, AXIS_HEADERS_ALT)
    ) {
      return { bank: "AXIS", row: i, columns: cells };
    }
    if (matchesHeaderPattern(cells, AXIS_HEADERS_CORPORATE)) {
      return { bank: "AXIS", row: i, columns: cells };
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

    // Check SBI patterns (UNVERIFIED)
    if (matchesHeaderPattern(cells, SBI_HEADERS)) {
      return { bank: "SBI", row: i, columns: cells };
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
 * Short headers that must match as whole words/cells to avoid false positives.
 * E.g., "DR" should not match "Withdrawals" via substring.
 */
const WHOLE_WORD_ONLY_HEADERS = new Set(["dr", "cr"]);

/**
 * Check if row cells match a header pattern (fuzzy match).
 */
function matchesHeaderPattern(cells: string[], pattern: string[]): boolean {
  // Need at least 60% of pattern columns to match
  let matches = 0;
  const required = Math.ceil(pattern.length * 0.6);

  for (const expected of pattern) {
    const normalizedExpected = expected.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " ");
    const requireWholeWord = WHOLE_WORD_ONLY_HEADERS.has(normalizedExpected);

    for (const cell of cells) {
      const normalizedCell = cell.toLowerCase().replace(/[./]/g, "").replace(/\s+/g, " ");
      
      if (normalizedCell === normalizedExpected) {
        // Exact match always counts
        matches++;
        break;
      } else if (!requireWholeWord && normalizedCell.includes(normalizedExpected)) {
        // Substring match only for non-whole-word headers
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
    /^\s*\*{3,}/, // HDFC asterisk separator rows
    /^Legends\b/i, // ICICI Legends block footer
    /^---\s*End\s*Of\s*Statement/i, // HDFC end marker
  ];

  for (let i = dataStartRow; i < sheet.rows.length; i++) {
    const row = sheet.rows[i];
    if (!row || row.length === 0) continue;

    const firstCell = String(row[0] ?? "").trim();
    const rowText = row.map((c) => String(c ?? "")).join(" ");
    
    // Find first non-empty cell (for formats like ICICI where column A is blank)
    let firstNonEmptyCell = firstCell;
    if (!firstCell) {
      for (const cell of row) {
        const cellStr = String(cell ?? "").trim();
        if (cellStr) {
          firstNonEmptyCell = cellStr;
          break;
        }
      }
    }

    // Check against footer patterns
    let isFooter = false;
    let isTerminalFooter = false;
    for (const pattern of footerPatterns) {
      if (pattern.test(firstCell) || pattern.test(firstNonEmptyCell) || pattern.test(rowText)) {
        footerIndices.add(i);
        isFooter = true;
        // Legends and End Of Statement mark the end of data region
        if (/^Legends\b/i.test(firstNonEmptyCell) || /^---\s*End\s*Of\s*Statement/i.test(firstNonEmptyCell)) {
          isTerminalFooter = true;
        }
        break;
      }
    }
    
    // Terminal footer patterns end the data region - mark all remaining rows as footer
    if (isTerminalFooter) {
      for (let j = i; j < sheet.rows.length; j++) {
        footerIndices.add(j);
      }
      break;
    }
    
    // HDFC summary-values row: numeric values only, no text labels
    // This row follows "Opening Balance" label row and has numbers in A, E, F, G
    // but no text label. Detect it by checking if it's all numbers after a footer row.
    if (!isFooter && i > 0 && footerIndices.has(i - 1)) {
      // Previous row was a footer row - check if this is a values-only row
      const allNumeric = row.every((c) => {
        if (c === null || c === undefined) return true;
        const s = String(c).trim();
        if (s === "") return true;
        // Check if it's a number (with optional commas and decimal)
        return /^-?[\d,]+\.?\d*$/.test(s.replace(/[,\s]/g, ""));
      });
      const hasNumbers = row.some((c) => {
        if (c === null || c === undefined) return false;
        const s = String(c).trim();
        return s !== "" && /\d/.test(s);
      });
      if (allNumeric && hasNumbers) {
        footerIndices.add(i);
        isFooter = true;
      }
    }

    // Empty row often indicates end of data, but be careful not to mark
    // narration continuation rows (which have only 1-2 non-empty cells)
    const nonEmptyCells = row.filter((c) => c !== null && c !== undefined && String(c).trim());
    
    // Skip the empty-row heuristic if this looks like a narration continuation row
    // (has text in middle columns but empty first column - typical of overflow rows)
    const looksLikeContinuation = nonEmptyCells.length >= 1 && 
      nonEmptyCells.length <= 2 &&
      firstCell === "" &&
      row.some((c, idx) => idx > 0 && idx < row.length - 1 && 
        c !== null && c !== undefined && String(c).trim().length > 3);
    
    if (nonEmptyCells.length <= 1 && (isFooter || !looksLikeContinuation)) {
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
 *
 * A row may be treated as narration continuation ONLY if:
 * - The first cell (date column) is empty
 * - All amount-like cells are empty
 * - Very few non-empty cells (just narration text)
 */
export function isNarrationContinuation(row: (string | number | Date | boolean | null)[]): boolean {
  if (!row || row.length === 0) return false;

  // First cell (date column) must be empty for continuation
  const firstCell = row[0];
  if (firstCell !== null && firstCell !== undefined && String(firstCell).trim() !== "") {
    return false;
  }

  // Count non-empty cells and check for amount-like values
  let nonEmptyCount = 0;
  let hasAmountLike = false;

  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    if (cell === null || cell === undefined || String(cell).trim() === "") {
      continue;
    }
    nonEmptyCount++;
    const str = String(cell).trim();

    // Check if any cell looks like an amount
    if (str.match(/^-?[\d,]+\.?\d*$/)) {
      hasAmountLike = true;
    }
  }

  // Continuation rows typically have:
  // - Empty first cell (checked above)
  // - At least one non-empty cell (the narration text) - fully blank rows are skips
  // - Very few non-empty cells (just narration text)
  // - No amount-like values
  return nonEmptyCount >= 1 && nonEmptyCount <= 2 && !hasAmountLike;
}

/**
 * Column-aware continuation check for formats where date is not in the first column.
 * Used by ICICI where column 0 is S No., not the date.
 */
export function isNarrationContinuationWithDateCol(
  row: (string | number | Date | boolean | null)[],
  dateCol: number
): boolean {
  if (!row || row.length === 0) return false;

  // Date column must be empty for continuation
  const dateCell = row[dateCol];
  if (dateCell !== null && dateCell !== undefined && String(dateCell).trim() !== "") {
    return false;
  }

  // Count non-empty cells and check for amount-like values
  let nonEmptyCount = 0;
  let hasAmountLike = false;

  for (let i = 0; i < row.length; i++) {
    const cell = row[i];
    if (cell === null || cell === undefined || String(cell).trim() === "") {
      continue;
    }
    nonEmptyCount++;
    const str = String(cell).trim();

    // Check if any cell looks like an amount
    if (str.match(/^-?[\d,]+\.?\d*$/)) {
      hasAmountLike = true;
    }
  }

  // Continuation rows typically have:
  // - Empty date cell (checked above)
  // - At least one non-empty cell (the narration text) - fully blank rows are skips
  // - Very few non-empty cells (just narration text)
  // - No amount-like values
  return nonEmptyCount >= 1 && nonEmptyCount <= 2 && !hasAmountLike;
}
