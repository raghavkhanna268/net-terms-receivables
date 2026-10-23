/**
 * UTR-based deduplication for bank statement transactions.
 *
 * Part of S14/S15: Net Terms Receivables bank statement parsing.
 *
 * Generates stable dedupe keys for transactions:
 * - Primary: UTR when present (most reliable)
 * - Fallback: Hash of date + amount + narration
 */

import type { NormalisedTxn, TxnDirection } from "./types.js";

/**
 * Generate a dedupe key for a transaction.
 *
 * Strategy:
 * 1. If UTR is present, use it directly (globally unique)
 * 2. Otherwise, create a hash from date + amount + narration + direction
 *
 * @param date ISO date string
 * @param amountPaise Amount in paise
 * @param direction CR or DR
 * @param narration Full narration text
 * @param utr UTR/RRN if available
 * @returns Stable dedupe key
 */
export function generateDedupeKey(
  date: string,
  amountPaise: number,
  direction: TxnDirection,
  narration: string,
  utr?: string
): string {
  // UTR is the most reliable identifier
  if (utr) {
    return `utr:${utr}`;
  }

  // Fallback: hash of transaction details
  // Normalize narration for hashing (remove whitespace variations)
  const normalizedNarration = normalizeForHash(narration);
  const hashInput = `${date}|${amountPaise}|${direction}|${normalizedNarration}`;

  return `hash:${simpleHash(hashInput)}`;
}

/**
 * Normalize text for hashing - consistent whitespace and case.
 */
function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200); // Limit length for consistent hashing
}

/**
 * Simple deterministic hash function.
 * Uses FNV-1a algorithm for good distribution.
 * Returns a hex string.
 */
function simpleHash(str: string): string {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // FNV prime multiplication (using 32-bit math)
    hash = Math.imul(hash, 16777619);
  }
  // Convert to unsigned and then to hex
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Deduplicate transactions within a file.
 *
 * @param transactions List of transactions to dedupe
 * @returns Deduped list with duplicates removed
 */
export function dedupeWithinFile(transactions: NormalisedTxn[]): NormalisedTxn[] {
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
 *
 * @param transactions Raw transactions
 * @param existingKeys Optional set of existing keys to check against
 * @returns Deduped transactions
 */
export function dedupeTransactions(
  transactions: NormalisedTxn[],
  existingKeys?: Set<string>
): NormalisedTxn[] {
  // First, dedupe within the file
  let result = dedupeWithinFile(transactions);

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

  // If both have UTRs and they match, definitely duplicates
  if (a.parsed.utr && b.parsed.utr) {
    return a.parsed.utr === b.parsed.utr;
  }

  // If amounts, dates, and directions match, check narration similarity
  const narA = normalizeForHash(a.narration);
  const narB = normalizeForHash(b.narration);

  // Simple similarity check - more than 70% common characters
  const longer = narA.length > narB.length ? narA : narB;
  const shorter = narA.length > narB.length ? narB : narA;

  if (longer.includes(shorter)) {
    return true;
  }

  // Count common trigrams
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
