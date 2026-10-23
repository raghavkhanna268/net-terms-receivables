/**
 * UTR-based deduplication for bank statement transactions.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Generates stable dedupe keys for transactions:
 * - Primary: UTR/RRN when present and valid for the rail
 * - Fallback: SHA-256 hash of canonical transaction string
 *
 * UTR formats by rail:
 * - NEFT: [A-Z]{4}N\d{11,17} (e.g., HDFCN26296123456)
 * - RTGS: [A-Z]{4}R\d{11,17} (e.g., HDFCR26296123456)
 * - IMPS/UPI: 12 digits (RRN)
 *
 * ACH, NACH, and cheque numbers are NOT treated as UTRs.
 */

import type { NormalisedTxn, TxnDirection, PaymentRail } from "./types.js";

/** Valid rails for UTR-based deduplication */
const UTR_RAILS: Set<PaymentRail> = new Set(["NEFT", "RTGS", "IMPS", "UPI"]);

/** NEFT UTR pattern: 4-letter bank code + N + 11-17 digits */
const NEFT_UTR_PATTERN = /^[A-Z]{4}N\d{11,17}$/;

/** RTGS UTR pattern: 4-letter bank code + R + 11-17 digits */
const RTGS_UTR_PATTERN = /^[A-Z]{4}R\d{11,17}$/;

/** IMPS/UPI RRN pattern: exactly 12 digits */
const RRN_PATTERN = /^\d{12}$/;

/**
 * Validate if a reference matches the expected UTR format for a rail.
 */
export function isValidUtrForRail(ref: string, rail: PaymentRail): boolean {
  if (!ref || !UTR_RAILS.has(rail)) {
    return false;
  }

  const normalized = ref.toUpperCase().trim();

  switch (rail) {
    case "NEFT":
      return NEFT_UTR_PATTERN.test(normalized);
    case "RTGS":
      return RTGS_UTR_PATTERN.test(normalized);
    case "IMPS":
    case "UPI":
      return RRN_PATTERN.test(normalized);
    default:
      return false;
  }
}

/**
 * Generate a dedupe key for a transaction.
 *
 * Strategy:
 * 1. If UTR is present AND valid for the rail, use namespaced key: utr:<rail>:<direction>:<ref>
 * 2. Otherwise, create SHA-256 hash from canonical transaction string
 *
 * The direction is included in UTR keys so that a NEFT/RTGS return (DR)
 * doesn't collapse with the original credit (CR) when they share the same UTR.
 *
 * @param date ISO date string
 * @param amountPaise Amount in paise
 * @param direction CR or DR
 * @param narration Full narration text
 * @param rail Payment rail
 * @param utr UTR/RRN if available
 * @param balancePaise Closing balance in paise (for fallback key uniqueness)
 * @param valueDateIso Value date if different from transaction date
 * @param refNo Reference number (for fallback key uniqueness)
 * @returns Promise resolving to stable dedupe key
 */
export async function generateDedupeKey(
  date: string,
  amountPaise: number,
  direction: TxnDirection,
  narration: string,
  rail: PaymentRail,
  utr?: string,
  balancePaise?: number,
  valueDateIso?: string,
  refNo?: string
): Promise<string> {
  // Check if UTR is valid for this rail
  if (utr && isValidUtrForRail(utr, rail)) {
    // Namespace: utr:<rail>:<direction>:<ref>
    // Direction included so CR and DR with same UTR don't collapse
    return `utr:${rail}:${direction}:${utr.toUpperCase().trim()}`;
  }

  // Fallback: SHA-256 hash of canonical transaction string
  // Include all distinguishing fields to avoid collisions
  const canonical = buildCanonicalString(
    date,
    amountPaise,
    direction,
    narration,
    balancePaise,
    valueDateIso,
    refNo
  );

  const hash = await sha256(canonical);
  return `sha256:${hash}`;
}

/**
 * Build canonical string for hashing.
 * Includes all fields that distinguish one transaction from another.
 */
function buildCanonicalString(
  date: string,
  amountPaise: number,
  direction: TxnDirection,
  narration: string,
  balancePaise?: number,
  valueDateIso?: string,
  refNo?: string
): string {
  // Normalize narration: lowercase, collapse whitespace, limit length
  const normalizedNarration = narration
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  // Build canonical string with all distinguishing fields
  const parts = [
    `date:${date}`,
    `amount:${amountPaise}`,
    `dir:${direction}`,
    `nar:${normalizedNarration}`,
  ];

  // Include balance - critical for distinguishing identical same-day transactions
  if (balancePaise !== undefined) {
    parts.push(`bal:${balancePaise}`);
  }

  // Include value date if present
  if (valueDateIso) {
    parts.push(`vdate:${valueDateIso}`);
  }

  // Include refNo if present
  if (refNo) {
    parts.push(`ref:${refNo.trim()}`);
  }

  return parts.join("|");
}

/**
 * Compute SHA-256 hash using Web Crypto API.
 * Available in browsers and Node.js (via crypto.subtle).
 */
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  // crypto.subtle is available in browsers and Node.js 15+
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);

  // Convert to hex string
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Deduplicate transactions within a file.
 * Now async due to SHA-256 hashing.
 *
 * @param transactions List of transactions to dedupe
 * @returns Deduped list with duplicates removed
 */
export async function dedupeWithinFile(transactions: NormalisedTxn[]): Promise<NormalisedTxn[]> {
  const seen = new Set<string>();
  const result: NormalisedTxn[] = [];

  for (const txn of transactions) {
    if (!seen.has(txn.dedupeKey)) {
      seen.add(txn.dedupeKey);
      result.push(txn);
    }
  }

  return result;
}

/**
 * Filter out transactions that exist in the provided set.
 *
 * @param transactions New transactions to check
 * @param existingKeys Set of existing dedupe keys
 * @returns Transactions not in existing set
 */
export function filterExisting(
  transactions: NormalisedTxn[],
  existingKeys: Set<string>
): NormalisedTxn[] {
  return transactions.filter((txn) => !existingKeys.has(txn.dedupeKey));
}

/**
 * Full deduplication pipeline.
 * Now async due to SHA-256 hashing.
 *
 * @param transactions Raw transactions
 * @param existingKeys Optional set of existing keys to check against
 * @returns Deduped transactions
 */
export async function dedupeTransactions(
  transactions: NormalisedTxn[],
  existingKeys?: Set<string>
): Promise<NormalisedTxn[]> {
  // First, dedupe within the file
  let result = await dedupeWithinFile(transactions);

  // Then, filter against existing keys if provided
  if (existingKeys && existingKeys.size > 0) {
    result = filterExisting(result, existingKeys);
  }

  return result;
}

/**
 * Extract all dedupe keys from a list of transactions.
 * Useful for building the existing keys set.
 */
export function extractDedupeKeys(transactions: NormalisedTxn[]): Set<string> {
  return new Set(transactions.map((t) => t.dedupeKey));
}

/**
 * Check if two transactions are likely duplicates based on
 * amount, date, and direction (for cases where UTR might be different).
 * This is a softer check than exact key matching.
 */
export function arePossibleDuplicates(a: NormalisedTxn, b: NormalisedTxn): boolean {
  // Same date, amount, and direction
  if (a.date !== b.date || a.amountPaise !== b.amountPaise || a.direction !== b.direction) {
    return false;
  }

  // If both have valid UTRs for their rail and they match, definitely duplicates
  if (a.parsed.utr && b.parsed.utr && a.parsed.rail === b.parsed.rail) {
    if (
      isValidUtrForRail(a.parsed.utr, a.parsed.rail) &&
      isValidUtrForRail(b.parsed.utr, b.parsed.rail)
    ) {
      return a.parsed.utr === b.parsed.utr;
    }
  }

  // If amounts, dates, directions, and balances match, check narration similarity
  if (a.balancePaise !== b.balancePaise) {
    return false; // Different balances = different transactions
  }

  const narA = a.narration.toLowerCase().replace(/\s+/g, " ").trim();
  const narB = b.narration.toLowerCase().replace(/\s+/g, " ").trim();

  // Simple similarity check - one contains the other
  if (narA.includes(narB) || narB.includes(narA)) {
    return true;
  }

  // Count common trigrams
  const shorter = narA.length < narB.length ? narA : narB;
  const longer = narA.length < narB.length ? narB : narA;

  const trigramsA = new Set<string>();
  for (let i = 0; i < shorter.length - 2; i++) {
    trigramsA.add(shorter.slice(i, i + 3));
  }

  let matches = 0;
  for (let i = 0; i < longer.length - 2; i++) {
    if (trigramsA.has(longer.slice(i, i + 3))) {
      matches++;
    }
  }

  const similarity = trigramsA.size > 0 ? matches / trigramsA.size : 0;
  return similarity > 0.5;
}
