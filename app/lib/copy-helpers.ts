/**
 * Copy helpers for merchant-facing text.
 * 
 * Provides:
 * - Pluralisation helper for day/days patterns
 * - Supported banks list derived from parser registry
 * - Error code label maps for human-readable messages
 * - GID formatting to avoid raw Shopify IDs
 */

import type { BankId } from "./banks/types.js";

/**
 * Pluralise a unit based on count.
 * 
 * @param count - The numeric count
 * @param singular - The singular form (e.g. "day")
 * @param plural - Optional plural form (defaults to singular + "s")
 * @returns The appropriate form based on count
 * 
 * @example
 * pluralize(1, "day") // "day"
 * pluralize(5, "day") // "days"
 * pluralize(0, "row", "rows") // "rows"
 */
export function pluralize(count: number, singular: string, plural?: string): string {
  const effectivePlural = plural ?? `${singular}s`;
  return Math.abs(count) === 1 ? singular : effectivePlural;
}

/**
 * Format a count with its pluralised unit.
 * 
 * @param count - The numeric count
 * @param singular - The singular form (e.g. "day")
 * @param plural - Optional plural form (defaults to singular + "s")
 * @returns Formatted string like "1 day" or "5 days"
 * 
 * @example
 * pluralizeWithCount(1, "day") // "1 day"
 * pluralizeWithCount(5, "day") // "5 days"
 * pluralizeWithCount(0, "location") // "0 locations"
 */
export function pluralizeWithCount(count: number, singular: string, plural?: string): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

/**
 * Supported banks for bank statement import.
 * Derived from the parser registry - matches HDFC, ICICI, SBI, AXIS.
 * "UNKNOWN" is excluded as it represents unrecognised statements.
 */
export const SUPPORTED_BANKS: readonly Exclude<BankId, "UNKNOWN">[] = [
  "HDFC",
  "ICICI",
  "SBI",
  "AXIS",
] as const;

/**
 * Human-readable names for supported banks.
 */
export const BANK_DISPLAY_NAMES: Record<Exclude<BankId, "UNKNOWN">, string> = {
  HDFC: "HDFC Bank",
  ICICI: "ICICI Bank",
  SBI: "State Bank of India",
  AXIS: "Axis Bank",
} as const;

/**
 * Format the supported banks as a comma-separated list with "or" before the last item.
 * 
 * @returns Formatted string like "HDFC, ICICI, SBI or Axis Bank"
 */
export function formatSupportedBankList(): string {
  if (SUPPORTED_BANKS.length === 0) return "";
  if (SUPPORTED_BANKS.length === 1) return SUPPORTED_BANKS[0];
  const bankNames = SUPPORTED_BANKS.map((b) => b === "AXIS" ? "Axis Bank" : b);
  const allButLast = bankNames.slice(0, -1);
  const last = bankNames[bankNames.length - 1];
  return `${allButLast.join(", ")} or ${last}`;
}

/**
 * Human-readable labels for import error codes.
 * Used to replace raw technical codes like "ROW_PARSE_FAILED" in the UI.
 */
export const IMPORT_ERROR_LABELS: Record<string, string> = {
  ROW_PARSE_FAILED: "Couldn't read row",
  NORMALIZE_FAILED: "Couldn't process transaction",
  NO_HEADER_ROW: "Missing header row",
  COLUMN_MAP_FAILED: "Unrecognised column layout",
  UNKNOWN_BANK_FORMAT: "Unrecognised bank format",
} as const;

/**
 * Get a human-readable label for an import error code.
 * Falls back to "Error" for unknown codes.
 * 
 * @param code - The error code from the parser
 * @returns Human-readable label
 */
export function getImportErrorLabel(code: string): string {
  return IMPORT_ERROR_LABELS[code] ?? "Error";
}

/**
 * Format a validation error path for display.
 * Converts internal paths like "credits.3.amountPaise" to "Row 4: amount".
 * 
 * @param path - The validation error path
 * @param message - The error message
 * @returns Human-readable error description
 */
export function formatValidationError(path: string, message: string): string {
  const match = path.match(/^credits\.(\d+)\.(\w+)$/);
  if (match) {
    const rowIndex = parseInt(match[1], 10);
    const field = match[2];
    const fieldLabel = VALIDATION_FIELD_LABELS[field] ?? field;
    return `Row ${rowIndex + 1}: ${fieldLabel} ${formatValidationMessage(message)}`;
  }
  
  if (path === "credits" || path === "") {
    return message;
  }
  
  return message;
}

const VALIDATION_FIELD_LABELS: Record<string, string> = {
  date: "date",
  amountPaise: "amount",
  valueDate: "value date",
  balancePaise: "balance",
  rail: "payment type",
  utr: "UTR",
  payerName: "payer name",
  narration: "narration",
  refNo: "reference number",
} as const;

function formatValidationMessage(message: string): string {
  if (message.includes("positive integer")) return "could not be read";
  if (message.includes("YYYY-MM-DD")) return "is not a valid date";
  if (message.includes("must be")) return "is invalid";
  return "could not be read";
}

/**
 * Extract a human label from a Shopify GID.
 * Never renders raw GIDs like "gid://shopify/Customer/123" in the UI.
 * 
 * @param gid - The Shopify Global ID
 * @param fallback - Optional fallback label (defaults to the resource type)
 * @returns Human-readable label like "Customer" or the provided fallback
 */
export function formatShopifyGid(gid: string, fallback?: string): string {
  const match = gid.match(/^gid:\/\/shopify\/(\w+)\//);
  if (match) {
    return fallback ?? match[1];
  }
  return fallback ?? "Customer";
}

/**
 * Check if a string looks like a raw Shopify GID.
 * 
 * @param value - The string to check
 * @returns True if the string is a Shopify GID format
 */
export function isShopifyGid(value: string): boolean {
  return value.startsWith("gid://shopify/");
}
