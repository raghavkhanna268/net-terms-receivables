/**
 * Bank statement parsing types for HDFC and ICICI banks.
 * Browser-safe module with no Node-only APIs.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 */

/** Known bank identifiers */
export type BankId = "HDFC" | "ICICI" | "UNKNOWN";

/** Transaction direction */
export type TxnDirection = "CR" | "DR";

/** Payment rail type */
export type PaymentRail = "NEFT" | "RTGS" | "IMPS" | "UPI" | "ACH" | "CHEQUE" | "OTHER";

/** Confidence level for bank detection */
export interface DetectionResult {
  bank: BankId;
  /** 0-1 confidence score. >= 0.8 is high confidence */
  confidence: number;
  /** Human-readable reason for the detection */
  reason: string;
}

/** Raw parsed row before normalization (bank-specific) */
export interface RawTxnRow {
  /** Original date string as found in the statement */
  dateRaw: string;
  /** Value date string if present */
  valueDateRaw?: string;
  /** Full narration text */
  narration: string;
  /** Cheque or reference number */
  refNo?: string;
  /** Withdrawal amount as string */
  debitRaw?: string;
  /** Deposit amount as string */
  creditRaw?: string;
  /** Closing balance as string */
  balanceRaw?: string;
  /** Original row index in the spreadsheet (1-indexed) */
  sourceRow: number;
}

/**
 * Normalised transaction type for uniform handling.
 * All amounts are in paise (1/100 of INR) as integers.
 */
export interface NormalisedTxn {
  /** ISO 8601 date string (YYYY-MM-DD) */
  date: string;
  /** Value date as ISO 8601, if different from transaction date */
  valueDate?: string;
  /** Amount in paise (always positive) */
  amountPaise: number;
  /** CR = credit/deposit, DR = debit/withdrawal */
  direction: TxnDirection;
  /** Original narration text */
  narration: string;
  /** Reference/cheque number if present */
  refNo?: string;
  /** Closing balance in paise after this transaction */
  balancePaise?: number;
  /** Parsed narration details */
  parsed: ParsedNarration;
  /** Dedupe key for this transaction */
  dedupeKey: string;
  /** Original row index (1-indexed) */
  sourceRow: number;
}

/** Extracted information from narration text */
export interface ParsedNarration {
  /** Payment rail type */
  rail: PaymentRail;
  /**
   * UTR (Unique Transaction Reference) for NEFT/RTGS/IMPS
   * or RRN (Retrieval Reference Number) for UPI
   */
  utr?: string;
  /** Payer/payee name if extractable */
  payerName?: string;
  /** Payer bank name or IFSC if extractable */
  payerBank?: string;
  /** Additional reference from UPI (like VPA) */
  upiId?: string;
}

/** Result of parsing a bank statement file */
export interface ParseResult {
  /** Detected bank and confidence */
  detection: DetectionResult;
  /** Successfully parsed and normalised transactions */
  transactions: NormalisedTxn[];
  /** Rows that failed to parse with errors */
  errors: ParseError[];
  /** Total rows found in the file */
  totalRows: number;
  /** Rows identified as preamble/header/footer (skipped) */
  skippedRows: number;
}

/** Error during row parsing */
export interface ParseError {
  row: number;
  message: string;
  rawData?: unknown;
}

/** Options for bank statement parsing */
export interface ParseOptions {
  /** Sheet name or index to parse (default: first sheet) */
  sheetIndex?: number;
  /** Set of existing dedupe keys to check against */
  existingKeys?: Set<string>;
  /** File name (used for bank detection hints) */
  fileName?: string;
}

/** Supported file types */
export type FileType = "xlsx" | "xls" | "csv" | "txt";

/** Sheet data from spreadsheet parsers */
export interface SheetData {
  name: string;
  rows: (string | number | Date | boolean | null)[][];
}
