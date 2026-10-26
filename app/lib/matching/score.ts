/**
 * Payment matching scoring module for S16.
 *
 * Pure, deterministic scoring functions for matching bank payments to invoices.
 * All amounts are in integer paise (1/100 of INR) to avoid floating-point errors.
 *
 * Scoring breakdown (0-100):
 * - Invoice/Order number in narration: +30 points
 * - Exact amount match: +20 points
 * - Partial amount match: +10 points
 * - Overpayment: +10 points (reduced, flags excess)
 * - Confirmed payer alias: +30 points (whole-word match on normalized name)
 * - Payer name match: +8 points (fuzzy match on normalized name)
 * - Email prefix match: +6 points
 *
 * NOTE: UTR matching is NOT awarded at the payment-to-candidate level because
 * the UTR is extracted from the payment's own narration and would give the same
 * score to every candidate. UTR is only useful for deduplication at import time.
 *
 * Thresholds:
 * - High confidence (>=80): Invoice ref + amount match + alias match
 * - Medium confidence (50-79): Amount + name match, needs review
 * - Low confidence (<50): Ambiguous, manual review required
 *
 * Caps and limits (for bounded combinatorics):
 * - MAX_INVOICES_FOR_SUBSET_SUM: 15 (max invoices to consider for multi-invoice match)
 * - MAX_SUBSET_SUM_ITERATIONS: 10000 (prevent runaway combinatorics)
 */

import type { PaymentRail } from "~/lib/banks/types";
import { normalizeName } from "./normalize";

/** Maximum invoices to consider for subset-sum (multi-invoice) matching */
export const MAX_INVOICES_FOR_SUBSET_SUM = 15;

/** Maximum iterations for subset-sum algorithm to prevent runaway computation */
export const MAX_SUBSET_SUM_ITERATIONS = 10000;

/** Confidence threshold below which matches require manual review */
export const CONFIDENCE_THRESHOLD = 80;

/** Score weight for invoice/order number in narration */
const WEIGHT_INVOICE_REF = 30;

/** Score weight for exact amount match */
const WEIGHT_AMOUNT_MATCH = 20;

/** Score weight for partial/overpayment amount match (reduced) */
const WEIGHT_AMOUNT_PARTIAL = 10;

/** Score weight for payer name match */
const WEIGHT_NAME_MATCH = 10;

/** Score weight for confirmed payer alias match (higher than fuzzy name) */
const WEIGHT_CONFIRMED_ALIAS = 30;

/** Reason types for match explanation */
export type MatchReasonType =
  | "invoice_ref"
  | "order_ref"
  | "amount_exact"
  | "amount_partial"
  | "amount_overpayment"
  | "payer_name"
  | "payer_alias"
  | "email_match"
  | "multi_invoice";

/** Individual reason for a match score */
export interface MatchReason {
  type: MatchReasonType;
  points: number;
  /** Non-PII detail (no emails, phone numbers, or addresses) */
  detail?: string;
}

/** Result of scoring a payment against an invoice */
export interface ScoreResult {
  /** Total score (0-100) */
  score: number;
  /** Breakdown of score reasons */
  reasons: MatchReason[];
  /** Amount to allocate in paise */
  allocatedPaise: bigint;
  /** Excess amount for overpayment (null if not overpayment) */
  excessPaise: bigint | null;
  /** Whether this is a partial payment */
  isPartial: boolean;
  /** Whether this is an overpayment */
  isOverpayment: boolean;
}

/** Invoice data needed for scoring */
export interface InvoiceForScoring {
  id: string;
  /** Invoice name/number (e.g., "#1001", "INV-1001") */
  name: string;
  /** Order ID if linked to order */
  orderId: string | null;
  /** Outstanding amount in paise */
  outstandingPaise: bigint;
  /** Buyer account ID */
  buyerAccountId: string;
  /** Due date for oldest-first sorting */
  dueAt: Date | null;
}

/** Payment data needed for scoring */
export interface PaymentForScoring {
  id: string;
  /** Amount in paise */
  amountPaise: bigint;
  /** Narration text */
  narration: string;
  /** Payer text from statement */
  payerText: string | null;
  /** UTR/RRN if extracted */
  utr: string | null;
  /** Payment rail */
  rail: PaymentRail | null;
}

/** Buyer data for name matching */
export interface BuyerForScoring {
  id: string;
  name: string;
  /** Normalized payer aliases */
  aliases: string[];
  /** Email if CUSTOMER_PII_FIELDS enabled (used for matching, NOT persisted in reasons) */
  email: string | null;
}

/** Result of multi-invoice matching */
export interface MultiInvoiceMatchResult {
  /** Individual invoice allocations */
  allocations: Array<{
    invoiceId: string;
    allocatedPaise: bigint;
    score: number;
    reasons: MatchReason[];
  }>;
  /** Total score for the match */
  totalScore: number;
  /** Excess after all allocations (overpayment) */
  excessPaise: bigint | null;
  /** Combined reasons */
  reasons: MatchReason[];
}

/**
 * Extract invoice/order numbers from narration text.
 * Only matches patterns with known prefixes or clear context to avoid false positives
 * from phone numbers, dates, or amount-like sequences.
 */
export function extractInvoiceRefs(narration: string): string[] {
  const refs: string[] = [];
  const text = narration.toUpperCase();

  // Match patterns with explicit prefixes only (avoids false positives)
  const patterns = [
    /#(\d{1,10})/g,                        // #1001 - hash prefix is explicit
    /\bINV[-.]?(\d{1,10})\b/g,             // INV-1001, INV.1001, INV1001
    /\bD(\d{1,10})\b/g,                    // D1001 (draft order)
    /\bORDER[-.]?(\d{1,10})\b/g,           // ORDER-1001
    /\bORD[-.]?(\d{1,10})\b/g,             // ORD-1001, ORD1001
    /\bPO[-.]?(\d{1,10})\b/g,              // PO-1001 (purchase order)
    /\bREF[-.]?(\d{5,10})\b/g,             // REF-12345 (5+ digits to avoid short refs)
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const ref = match[1];
      // Skip numbers that look like dates (DDMMYYYY, YYYYMMDD) or years
      if (ref.length === 8 && (ref.startsWith("20") || ref.startsWith("19"))) continue;
      if (ref.length === 4 && parseInt(ref, 10) >= 1900 && parseInt(ref, 10) <= 2100) continue;
      // Skip numbers that look like amounts (ending in 00)
      if (ref.length >= 4 && ref.endsWith("00") && !text.includes(`#${ref}`)) continue;
      
      if (!refs.includes(ref)) {
        refs.push(ref);
      }
    }
  }

  return refs;
}

/**
 * Check if an invoice name matches extracted references.
 */
export function matchInvoiceRef(
  invoiceName: string,
  extractedRefs: string[]
): boolean {
  // Extract numeric part from invoice name
  const nameUpper = invoiceName.toUpperCase();

  // Try different patterns
  const numericMatch = nameUpper.match(/(\d{1,10})/);
  if (!numericMatch) return false;

  const invoiceNum = numericMatch[1];
  return extractedRefs.includes(invoiceNum);
}

/**
 * Check if an order ID matches extracted references.
 */
export function matchOrderRef(
  orderId: string | null,
  extractedRefs: string[]
): boolean {
  if (!orderId) return false;

  // Extract order number from GID (gid://shopify/Order/12345)
  const match = orderId.match(/\/Order\/(\d+)/);
  if (!match) return false;

  return extractedRefs.includes(match[1]);
}

/**
 * Score a payment against a single invoice.
 */
export function scorePaymentToInvoice(
  payment: PaymentForScoring,
  invoice: InvoiceForScoring,
  buyer: BuyerForScoring,
  extractedRefs: string[]
): ScoreResult {
  const reasons: MatchReason[] = [];
  let score = 0;

  // 1. Invoice/Order reference in narration (most discriminating factor)
  if (matchInvoiceRef(invoice.name, extractedRefs)) {
    score += WEIGHT_INVOICE_REF;
    reasons.push({
      type: "invoice_ref",
      points: WEIGHT_INVOICE_REF,
      detail: `Invoice: ${invoice.name}`,
    });
  } else if (matchOrderRef(invoice.orderId, extractedRefs)) {
    score += WEIGHT_INVOICE_REF;
    reasons.push({
      type: "order_ref",
      points: WEIGHT_INVOICE_REF,
      detail: `Order ref matched`,
    });
  }

  // 2. Amount matching
  const paymentAmount = payment.amountPaise;
  const outstandingAmount = invoice.outstandingPaise;

  let allocatedPaise: bigint;
  let excessPaise: bigint | null = null;
  let isPartial = false;
  let isOverpayment = false;

  if (paymentAmount === outstandingAmount) {
    // Exact match
    allocatedPaise = paymentAmount;
    score += WEIGHT_AMOUNT_MATCH;
    reasons.push({
      type: "amount_exact",
      points: WEIGHT_AMOUNT_MATCH,
      detail: `Exact amount`,
    });
  } else if (paymentAmount < outstandingAmount) {
    // Partial payment
    allocatedPaise = paymentAmount;
    isPartial = true;
    score += WEIGHT_AMOUNT_PARTIAL;
    reasons.push({
      type: "amount_partial",
      points: WEIGHT_AMOUNT_PARTIAL,
      detail: `Partial payment`,
    });
  } else {
    // Overpayment - reduced points (flags for review)
    allocatedPaise = outstandingAmount;
    excessPaise = paymentAmount - outstandingAmount;
    isOverpayment = true;
    score += WEIGHT_AMOUNT_PARTIAL; // Reduced from full amount match
    reasons.push({
      type: "amount_overpayment",
      points: WEIGHT_AMOUNT_PARTIAL,
      detail: `Overpayment (excess flagged)`,
    });
  }

  // 3. Payer name matching
  if (payment.payerText) {
    const nameScore = scorePayerNameMatch(payment.payerText, buyer);
    if (nameScore.matched) {
      score += nameScore.points;
      reasons.push({
        type: nameScore.type,
        points: nameScore.points,
        detail: nameScore.detail,
      });
    }
  }

  // Cap score at 100
  score = Math.min(100, score);

  return {
    score,
    reasons,
    allocatedPaise,
    excessPaise,
    isPartial,
    isOverpayment,
  };
}

/** Result of payer name matching */
interface PayerNameMatchResult {
  matched: boolean;
  type: "payer_alias" | "payer_name" | "email_match";
  points: number;
  detail: string;
}

/**
 * Check if `needle` appears as a whole word (at token boundaries) within `haystack`.
 * Both strings should be normalized (lowercase, single-space-separated, no punctuation).
 * Returns true if needle equals haystack or if needle appears surrounded by spaces or at string edges.
 * Checks ALL occurrences of needle, not just the first.
 */
function containsWholeWord(haystack: string, needle: string): boolean {
  if (needle.length === 0 || haystack.length === 0) return false;
  if (haystack === needle) return true;

  // Pad with spaces to simplify boundary checks at start/end
  // For normalized single-space strings, this correctly detects whole-word matches
  return (" " + haystack + " ").includes(" " + needle + " ");
}

/**
 * Generic business words that do NOT establish payer identity.
 * A payer-alias match requires at least one NON-GENERIC token to earn the bonus.
 * This prevents false positives from common corporate suffixes/descriptors.
 *
 * List intentionally kept short and stable:
 * - TRADERS, ENTERPRISES, AGENCIES: Common business type descriptors
 * - CORPORATION, CO: Corporate structure indicators
 * - PVT, LTD: Private/Limited (common in Indian company names)
 */
const GENERIC_ALIAS_WORDS = new Set([
  "traders",
  "enterprises",
  "agencies",
  "corporation",
  "co",
  "pvt",
  "ltd",
]);

/**
 * Check if ALL tokens in the given normalized string are generic business words.
 */
function isAllGenericTokens(normalizedText: string): boolean {
  if (normalizedText.length === 0) return true;
  const tokens = normalizedText.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return true;
  return tokens.every((token) => GENERIC_ALIAS_WORDS.has(token));
}

/**
 * Check if the alias match includes at least one non-generic token.
 * Returns true if the match should earn the alias bonus.
 *
 * Rules:
 * - If the alias is all-generic (e.g., "traders"), no bonus (need substantive identity)
 * - If the payer matches only generic tokens from a multi-token alias, no bonus
 * - If at least one non-generic alias token is matched whole-word in the payer, bonus OK
 */
function hasNonGenericAliasMatch(
  normalizedPayer: string,
  alias: string
): boolean {
  const aliasTokens = alias.split(/\s+/).filter((t) => t.length > 0);
  if (aliasTokens.length === 0) return false;

  // If the alias is entirely generic tokens, no bonus regardless of match quality
  if (aliasTokens.every((token) => GENERIC_ALIAS_WORDS.has(token))) {
    return false;
  }

  // Check if at least one non-generic alias token appears as whole word in payer
  const payerTokens = new Set(
    normalizedPayer.split(/\s+/).filter((t) => t.length > 0)
  );
  for (const aliasToken of aliasTokens) {
    if (!GENERIC_ALIAS_WORDS.has(aliasToken) && payerTokens.has(aliasToken)) {
      return true;
    }
  }

  return false;
}

/**
 * Score payer name match against buyer data.
 * IMPORTANT: Detail fields must NOT contain PII (no email, phone, address).
 */
function scorePayerNameMatch(
  payerText: string,
  buyer: BuyerForScoring
): PayerNameMatchResult {
  const normalizedPayer = normalizePayerName(payerText);

  // Guard: empty/whitespace payer text gets no name-based points
  if (normalizedPayer.length === 0) {
    return {
      matched: false,
      type: "payer_name",
      points: 0,
      detail: "",
    };
  }

  // Check aliases first (highest confidence - confirmed aliases only)
  // Use whole-word (token-boundary) matching to avoid false positives from partial substrings
  // Require minimum 3 chars for BOTH sides to avoid false positives
  // Generic-word guard: alias bonus requires at least one non-generic token match
  for (const alias of buyer.aliases) {
    const isExactMatch = alias === normalizedPayer;
    const payerContainsAlias = normalizedPayer.length >= 3 && alias.length >= 3 && containsWholeWord(normalizedPayer, alias);
    const aliasContainsPayer = normalizedPayer.length >= 3 && alias.length >= 3 && containsWholeWord(alias, normalizedPayer);
    if (isExactMatch || payerContainsAlias || aliasContainsPayer) {
      // Generic-word guard: require at least one non-generic token match for alias bonus
      if (!hasNonGenericAliasMatch(normalizedPayer, alias)) {
        continue; // Skip this alias, try others or fall through to payer_name
      }
      return {
        matched: true,
        type: "payer_alias",
        points: WEIGHT_CONFIRMED_ALIAS,
        detail: `Alias matched`, // No PII - just indicate match type
      };
    }
  }

  // Check buyer name
  const normalizedBuyerName = normalizePayerName(buyer.name);
  if (fuzzyNameMatch(normalizedPayer, normalizedBuyerName)) {
    return {
      matched: true,
      type: "payer_name",
      points: Math.floor(WEIGHT_NAME_MATCH * 0.8),
      detail: `Name matched`, // No PII
    };
  }

  // Check email if available (but don't store email in detail)
  // Require minimum 3 chars for email prefix to avoid false positives from empty/short payers
  if (buyer.email) {
    const emailPrefix = buyer.email.split("@")[0].toLowerCase();
    const payerNoSpaces = normalizedPayer.replace(/\s/g, "");
    // Only match if both email prefix and payer are at least 3 characters
    if (
      emailPrefix.length >= 3 &&
      payerNoSpaces.length >= 3 &&
      (normalizedPayer.includes(emailPrefix) || emailPrefix.includes(payerNoSpaces))
    ) {
      return {
        matched: true,
        type: "email_match",
        points: Math.floor(WEIGHT_NAME_MATCH * 0.6),
        detail: `Email prefix matched`, // NO email address stored
      };
    }
  }

  return {
    matched: false,
    type: "payer_name",
    points: 0,
    detail: "",
  };
}

/**
 * Normalize payer name for matching.
 * Removes common suffixes, punctuation, and normalizes to lowercase.
 *
 * IMPORTANT: This function delegates to normalizeName() from normalize.ts to ensure
 * the SAME normalization is used for both alias storage (confirmMatch) and matching
 * (scorePayerNameMatch). This unification prevents mismatches where an alias stored
 * as "test buyer" wouldn't match a payer normalized differently.
 */
export function normalizePayerName(name: string): string {
  return normalizeName(name);
}

/**
 * Fuzzy name match using token overlap.
 */
function fuzzyNameMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  // Token-based matching
  const tokensA = new Set(a.split(/\s+/).filter((t) => t.length > 2));
  const tokensB = new Set(b.split(/\s+/).filter((t) => t.length > 2));

  if (tokensA.size === 0 || tokensB.size === 0) return false;

  // Check for significant overlap
  let overlap = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) overlap++;
  }

  const minSize = Math.min(tokensA.size, tokensB.size);
  return overlap >= Math.ceil(minSize * 0.5);
}

/**
 * Find the best combination of invoices that sum to the payment amount.
 * Uses bounded subset-sum with oldest-due-first preference.
 *
 * @param paymentPaise Payment amount in paise
 * @param invoices Invoices sorted by due date (oldest first)
 * @returns Indices of invoices to allocate, or null if no exact/close match
 */
export function findSubsetSum(
  paymentPaise: bigint,
  invoices: Array<{ outstandingPaise: bigint; index: number }>
): number[] | null {
  // Limit invoice count for bounded combinatorics
  const limitedInvoices = invoices.slice(0, MAX_INVOICES_FOR_SUBSET_SUM);
  const n = limitedInvoices.length;

  if (n === 0) return null;

  // Try single invoice first
  for (let i = 0; i < n; i++) {
    if (limitedInvoices[i].outstandingPaise === paymentPaise) {
      return [limitedInvoices[i].index];
    }
  }

  // Dynamic programming approach with iteration limit
  // Use a map to track which combinations sum to each amount
  const sums = new Map<string, number[]>();
  sums.set("0", []);

  let iterations = 0;

  for (let i = 0; i < n && iterations < MAX_SUBSET_SUM_ITERATIONS; i++) {
    const invoice = limitedInvoices[i];
    const newSums = new Map<string, number[]>();

    for (const [sumStr, indices] of sums) {
      iterations++;
      if (iterations >= MAX_SUBSET_SUM_ITERATIONS) break;

      const currentSum = BigInt(sumStr);
      const newSum = currentSum + invoice.outstandingPaise;

      if (newSum <= paymentPaise) {
        const newSumStr = newSum.toString();
        if (!sums.has(newSumStr) && !newSums.has(newSumStr)) {
          const newIndices = [...indices, invoice.index];
          newSums.set(newSumStr, newIndices);

          // Check for exact match
          if (newSum === paymentPaise) {
            return newIndices;
          }
        }
      }
    }

    // Merge new sums
    for (const [k, v] of newSums) {
      sums.set(k, v);
    }
  }

  // No exact match found, find closest without exceeding
  let bestSum = 0n;
  let bestIndices: number[] = [];

  for (const [sumStr, indices] of sums) {
    const sum = BigInt(sumStr);
    if (sum > bestSum && sum <= paymentPaise && indices.length > 0) {
      bestSum = sum;
      bestIndices = indices;
    }
  }

  return bestIndices.length > 0 ? bestIndices : null;
}

/**
 * Score a payment against multiple invoices for the same buyer.
 * Returns the best allocation strategy.
 */
export function scoreMultiInvoiceMatch(
  payment: PaymentForScoring,
  invoices: InvoiceForScoring[],
  buyer: BuyerForScoring
): MultiInvoiceMatchResult | null {
  if (invoices.length === 0) return null;

  const extractedRefs = extractInvoiceRefs(payment.narration);

  // Sort invoices by due date (oldest first) for allocation preference
  const sortedInvoices = [...invoices].sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return 0;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.getTime() - b.dueAt.getTime();
  });

  // Try exact amount match with subset-sum
  const invoicesForSubset = sortedInvoices.map((inv, index) => ({
    outstandingPaise: inv.outstandingPaise,
    index,
  }));

  const subsetIndices = findSubsetSum(payment.amountPaise, invoicesForSubset);

  if (subsetIndices && subsetIndices.length > 1) {
    // Multi-invoice match found
    const allocations = subsetIndices.map((idx) => {
      const invoice = sortedInvoices[idx];
      const result = scorePaymentToInvoice(payment, invoice, buyer, extractedRefs);
      return {
        invoiceId: invoice.id,
        allocatedPaise: invoice.outstandingPaise,
        score: result.score,
        reasons: result.reasons,
      };
    });

    const totalAllocated = allocations.reduce(
      (sum, a) => sum + a.allocatedPaise,
      0n
    );
    const excessPaise =
      payment.amountPaise > totalAllocated
        ? payment.amountPaise - totalAllocated
        : null;

    // Calculate average score plus bonus for multi-invoice match
    const avgScore =
      allocations.reduce((sum, a) => sum + a.score, 0) / allocations.length;
    const multiBonus = 5; // Small bonus for finding a combination

    const reasons: MatchReason[] = [
      {
        type: "multi_invoice",
        points: multiBonus,
        detail: `Matched ${allocations.length} invoices`,
      },
    ];

    return {
      allocations,
      totalScore: Math.min(100, Math.round(avgScore + multiBonus)),
      excessPaise,
      reasons,
    };
  }

  // No multi-invoice match, try single best match
  let bestResult: ScoreResult | null = null;
  let bestInvoice: InvoiceForScoring | null = null;

  for (const invoice of sortedInvoices) {
    const result = scorePaymentToInvoice(payment, invoice, buyer, extractedRefs);
    if (!bestResult || result.score > bestResult.score) {
      bestResult = result;
      bestInvoice = invoice;
    }
  }

  if (!bestResult || !bestInvoice) return null;

  return {
    allocations: [
      {
        invoiceId: bestInvoice.id,
        allocatedPaise: bestResult.allocatedPaise,
        score: bestResult.score,
        reasons: bestResult.reasons,
      },
    ],
    totalScore: bestResult.score,
    excessPaise: bestResult.excessPaise,
    reasons: bestResult.reasons,
  };
}

/**
 * Serialize score result for JSON storage.
 * Converts bigints to strings.
 */
export function serializeScoreResult(result: ScoreResult): {
  score: number;
  reasons: MatchReason[];
  allocatedPaise: string;
  excessPaise: string | null;
  isPartial: boolean;
  isOverpayment: boolean;
} {
  return {
    score: result.score,
    reasons: result.reasons,
    allocatedPaise: result.allocatedPaise.toString(),
    excessPaise: result.excessPaise?.toString() ?? null,
    isPartial: result.isPartial,
    isOverpayment: result.isOverpayment,
  };
}

/**
 * Validate that match reasons contain no PII.
 * Used in tests to ensure compliance.
 */
export function reasonsContainNoPII(reasons: MatchReason[]): boolean {
  const piiPatterns = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Email
    /\b\d{10}\b/, // Phone number (10 digits)
    /\b\d{5,6}\b.*\b(street|road|lane|avenue|colony)/i, // Address with PIN
  ];
  
  for (const reason of reasons) {
    if (reason.detail) {
      for (const pattern of piiPatterns) {
        if (pattern.test(reason.detail)) {
          return false;
        }
      }
    }
  }
  return true;
}
