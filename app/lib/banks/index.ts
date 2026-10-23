/**
 * Bank statement parsing for HDFC and ICICI banks.
 * Browser-safe module with no Node-only APIs.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Usage:
 * ```typescript
 * import { parseBankStatement } from '~/lib/banks';
 *
 * // From a file input
 * const file = inputElement.files[0];
 * const result = await parseBankStatement(file);
 *
 * // From an ArrayBuffer
 * const result = await parseBankStatement(arrayBuffer, { fileName: 'statement.xlsx' });
 *
 * if (result.detection.bank === 'UNKNOWN') {
 *   console.log('Unknown bank format');
 * } else {
 *   console.log(`Parsed ${result.transactions.length} transactions from ${result.detection.bank}`);
 * }
 * ```
 */

// Re-export types
export type {
  BankId,
  TxnDirection,
  PaymentRail,
  DetectionResult,
  RawTxnRow,
  NormalisedTxn,
  ParsedNarration,
  ParseResult,
  ParseError,
  ParseOptions,
  FileType,
  SheetData,
} from "./types.js";

// Re-export utilities
export { parseIndianDate, parseIndianAmount, isBlankOrZero, formatPaiseToDisplay } from "./normalisers.js";
export { parseNarration, extractUtrForDedupe } from "./narration-parser.js";
export { detectBank, detectHeaderRow, detectFooterRows } from "./detection.js";
export {
  generateDedupeKey,
  dedupeWithinFile,
  filterExisting,
  dedupeTransactions,
  extractDedupeKeys,
  arePossibleDuplicates,
} from "./dedupe.js";
export { detectFileType, loadSpreadsheet, getSheetNames } from "./spreadsheet-loader.js";

// Import for main parser
import type { ParseResult, ParseOptions } from "./types.js";
import { detectFileType, loadSpreadsheet } from "./spreadsheet-loader.js";
import { detectBank } from "./detection.js";
import { parseHdfcStatement } from "./parsers/hdfc.js";
import { parseIciciStatement } from "./parsers/icici.js";

/**
 * Parse a bank statement file.
 *
 * @param input File object or ArrayBuffer
 * @param options Parse options
 * @returns Parse result with detected bank, transactions, and any errors
 */
export async function parseBankStatement(
  input: File | ArrayBuffer,
  options: ParseOptions = {}
): Promise<ParseResult> {
  // Get content as ArrayBuffer
  let content: ArrayBuffer;
  let fileName = options.fileName;

  if (input instanceof File) {
    content = await input.arrayBuffer();
    fileName = fileName || input.name;
  } else {
    content = input;
  }

  // Detect file type
  const fileType = detectFileType(fileName || "", content);

  // Load spreadsheet data
  const sheet = await loadSpreadsheet(content, fileType, options.sheetIndex);

  // Detect bank
  const detection = detectBank(sheet, fileName);

  // Route to appropriate parser
  switch (detection.bank) {
    case "HDFC":
      return parseHdfcStatement(sheet, detection, options.existingKeys);
    case "ICICI":
      return parseIciciStatement(sheet, detection, options.existingKeys);
    default:
      // Unknown bank - return empty result with detection info
      return {
        detection,
        transactions: [],
        errors: [
          {
            row: 0,
            message: `Unknown bank format. Confidence: ${detection.confidence.toFixed(2)}. ${detection.reason}`,
          },
        ],
        totalRows: sheet.rows.length,
        skippedRows: sheet.rows.length,
      };
  }
}

/**
 * Parse a bank statement and filter against existing transactions.
 * Convenience wrapper for common use case.
 *
 * @param input File or ArrayBuffer
 * @param existingKeys Set of existing dedupe keys to filter against
 * @param options Additional options
 * @returns Parse result with only new transactions
 */
export async function parseAndFilterStatement(
  input: File | ArrayBuffer,
  existingKeys: Set<string>,
  options: Omit<ParseOptions, "existingKeys"> = {}
): Promise<ParseResult> {
  return parseBankStatement(input, { ...options, existingKeys });
}
