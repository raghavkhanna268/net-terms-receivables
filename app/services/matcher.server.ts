/**
 * Payment matching service for S16.
 *
 * Orchestrates payment-to-invoice matching with:
 * - SQL-prefiltered candidate batches (respects 10ms CPU budget)
 * - Scoring via the pure matching module
 * - Confirm-only model (S17 applies changes)
 *
 * Design decisions:
 * - v1 is CONFIRM-ONLY: matcher produces suggestions, nothing is applied
 * - Matching is idempotent: re-running clears old suggestions first
 * - Respects activeAccountFragment for gated accounts
 * - All amounts in integer paise to avoid floating-point errors
 */

import type { Sql } from "~/lib/db-light.server";
import {
  scoreMultiInvoiceMatch,
  CONFIDENCE_THRESHOLD,
  MAX_INVOICES_FOR_SUBSET_SUM,
  type InvoiceForScoring,
  type BuyerForScoring,
  type MultiInvoiceMatchResult,
} from "~/lib/matching/score";
import {
  normalizeNarrationForLookup,
  findBestBuyerMatch,
} from "~/lib/matching/normalize";
import {
  getUnmatchedPayments,
  getOpenInvoicesInAmountWindow,
  getOpenInvoicesForBuyer,
  getBuyersWithAliases,
  createMatch,
  deleteSuggestedMatchesForPayment,
  updatePaymentStatus,
  findBuyerByAlias,
  upsertPayerAlias,
} from "~/lib/matching/queries.server";

/** Amount window multiplier for candidate filtering (0.5x to 2x payment) */
const AMOUNT_WINDOW_MIN_FACTOR = 0.5;
const AMOUNT_WINDOW_MAX_FACTOR = 2.0;

/** Result of running the matcher for a single payment */
export interface MatcherResult {
  paymentId: string;
  matchesCreated: number;
  topScore: number;
  isHighConfidence: boolean;
  error?: string;
}

/** Summary of a matching run */
export interface MatcherRunSummary {
  paymentsProcessed: number;
  matchesCreated: number;
  highConfidenceMatches: number;
  errors: number;
  results: MatcherResult[];
}

/**
 * Run the matcher for all unmatched payments in a shop.
 * This is the main entry point for batch matching.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param options - Processing options
 */
export async function runMatcher(
  sql: Sql,
  shopId: string,
  options: {
    /** Maximum payments to process in one run */
    limit?: number;
    /** Offset for pagination */
    offset?: number;
  } = {}
): Promise<MatcherRunSummary> {
  const { limit = 50, offset = 0 } = options;

  const summary: MatcherRunSummary = {
    paymentsProcessed: 0,
    matchesCreated: 0,
    highConfidenceMatches: 0,
    errors: 0,
    results: [],
  };

  // Get unmatched payments
  const { payments } = await getUnmatchedPayments(sql, shopId, { limit, offset });

  if (payments.length === 0) {
    return summary;
  }

  // Load buyers with aliases (cached for the batch)
  const buyers = await getBuyersWithAliases(sql, shopId);

  if (buyers.length === 0) {
    // No buyers to match against
    return summary;
  }

  // Process each payment
  for (const payment of payments) {
    try {
      const result = await matchSinglePayment(sql, shopId, payment, buyers);
      summary.results.push(result);
      summary.paymentsProcessed++;
      summary.matchesCreated += result.matchesCreated;
      if (result.isHighConfidence) {
        summary.highConfidenceMatches++;
      }
    } catch (error) {
      summary.errors++;
      summary.results.push({
        paymentId: payment.id,
        matchesCreated: 0,
        topScore: 0,
        isHighConfidence: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return summary;
}

/**
 * Match a single payment against candidate invoices.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param payment - Payment to match
 * @param buyers - Pre-loaded buyers with aliases
 */
async function matchSinglePayment(
  sql: Sql,
  shopId: string,
  payment: { id: string; amountPaise: bigint; narration: string; payerText: string | null; utr: string | null; rail: string | null },
  buyers: BuyerForScoring[]
): Promise<MatcherResult> {
  // Clear any existing suggested matches for idempotency
  await deleteSuggestedMatchesForPayment(sql, shopId, payment.id);

  // Try to identify the buyer from payer text or narration
  let targetBuyer: BuyerForScoring | null = null;

  if (payment.payerText) {
    // Try alias lookup first
    const normalizedPayer = normalizeNarrationForLookup(payment.payerText);
    targetBuyer = await findBuyerByAlias(sql, shopId, normalizedPayer);

    // If no alias match, try fuzzy matching
    if (!targetBuyer) {
      const match = findBestBuyerMatch(payment.payerText, buyers);
      if (match) {
        targetBuyer = buyers.find((b) => b.id === match.buyerId) ?? null;

        // Create alias for future lookups if high confidence
        if (targetBuyer && match.score >= 0.8) {
          await upsertPayerAlias(sql, targetBuyer.id, normalizedPayer);
        }
      }
    }
  }

  // Calculate amount window for candidate filtering
  const minPaise = BigInt(Math.floor(Number(payment.amountPaise) * AMOUNT_WINDOW_MIN_FACTOR));
  const maxPaise = BigInt(Math.ceil(Number(payment.amountPaise) * AMOUNT_WINDOW_MAX_FACTOR));

  let candidateInvoices: InvoiceForScoring[];

  if (targetBuyer) {
    // If we identified a buyer, get their invoices
    candidateInvoices = await getOpenInvoicesForBuyer(sql, shopId, targetBuyer.id);
  } else {
    // Otherwise, get invoices in the amount window
    candidateInvoices = await getOpenInvoicesInAmountWindow(sql, shopId, minPaise, maxPaise);
  }

  if (candidateInvoices.length === 0) {
    return {
      paymentId: payment.id,
      matchesCreated: 0,
      topScore: 0,
      isHighConfidence: false,
    };
  }

  // Limit candidates for bounded combinatorics
  const limitedCandidates = candidateInvoices.slice(0, MAX_INVOICES_FOR_SUBSET_SUM);

  // Group invoices by buyer for multi-invoice matching
  const invoicesByBuyer = new Map<string, InvoiceForScoring[]>();
  for (const invoice of limitedCandidates) {
    const existing = invoicesByBuyer.get(invoice.buyerAccountId) ?? [];
    existing.push(invoice);
    invoicesByBuyer.set(invoice.buyerAccountId, existing);
  }

  // Score against each buyer's invoices
  const allResults: Array<{
    result: MultiInvoiceMatchResult;
    buyer: BuyerForScoring;
  }> = [];

  for (const [buyerId, invoices] of invoicesByBuyer) {
    const buyer = buyers.find((b) => b.id === buyerId);
    if (!buyer) continue;

    const result = scoreMultiInvoiceMatch(
      {
        id: payment.id,
        amountPaise: payment.amountPaise,
        narration: payment.narration,
        payerText: payment.payerText,
        utr: payment.utr,
        rail: payment.rail as never,
      },
      invoices,
      buyer
    );

    if (result) {
      allResults.push({ result, buyer });
    }
  }

  if (allResults.length === 0) {
    return {
      paymentId: payment.id,
      matchesCreated: 0,
      topScore: 0,
      isHighConfidence: false,
    };
  }

  // Sort by score and create matches
  allResults.sort((a, b) => b.result.totalScore - a.result.totalScore);

  let matchesCreated = 0;
  let topScore = 0;

  // Create match records for top candidates
  // We create matches for the best result per buyer, limited to top 3
  const seenBuyers = new Set<string>();
  for (const { result, buyer } of allResults.slice(0, 5)) {
    if (seenBuyers.has(buyer.id)) continue;
    seenBuyers.add(buyer.id);

    for (const allocation of result.allocations) {
      await createMatch(sql, {
        shopId,
        paymentId: payment.id,
        invoiceId: allocation.invoiceId,
        amountPaise: allocation.allocatedPaise,
        score: allocation.score,
        reasons: allocation.reasons,
      });
      matchesCreated++;
    }

    if (result.totalScore > topScore) {
      topScore = result.totalScore;
    }
  }

  // Update payment status based on matches
  if (matchesCreated > 0) {
    await updatePaymentStatus(sql, shopId, payment.id, "partial");
  }

  return {
    paymentId: payment.id,
    matchesCreated,
    topScore,
    isHighConfidence: topScore >= CONFIDENCE_THRESHOLD,
  };
}

/**
 * Confirm a suggested match.
 * This records the merchant's decision for S17 to apply later.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param matchId - Match ID to confirm
 * @param userId - User ID confirming the match
 */
export async function confirmMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  userId: string
): Promise<boolean> {
  // Verify the match exists and belongs to the shop
  const [match] = await sql<{ payment_id: string }[]>`
    SELECT "paymentId" AS payment_id
    FROM "Match"
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  if (!match) {
    return false;
  }

  // Update the match state
  const result = await sql`
    UPDATE "Match"
    SET
      state = 'confirmed',
      "confirmedBy" = ${userId},
      "confirmedAt" = NOW(),
      "updatedAt" = NOW()
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  if (result.count === 0) {
    return false;
  }

  // Check if all suggested matches for this payment are now confirmed/rejected
  // and update payment status accordingly
  const [remaining] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Match"
    WHERE "paymentId" = ${match.payment_id}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  if (parseInt(remaining?.count ?? "0", 10) === 0) {
    // All suggestions processed, check if any confirmed
    const [confirmed] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "Match"
      WHERE "paymentId" = ${match.payment_id}
        AND "shopId" = ${shopId}
        AND state = 'confirmed'
    `;

    if (parseInt(confirmed?.count ?? "0", 10) > 0) {
      await updatePaymentStatus(sql, shopId, match.payment_id, "matched");
    }
  }

  return true;
}

/**
 * Reject a suggested match.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param matchId - Match ID to reject
 * @param userId - User ID rejecting the match
 */
export async function rejectMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  userId: string
): Promise<boolean> {
  // Verify the match exists and belongs to the shop
  const [match] = await sql<{ payment_id: string }[]>`
    SELECT "paymentId" AS payment_id
    FROM "Match"
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  if (!match) {
    return false;
  }

  // Update the match state to unmatched (rejected)
  const result = await sql`
    UPDATE "Match"
    SET
      state = 'unmatched',
      "confirmedBy" = ${userId},
      "updatedAt" = NOW()
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  if (result.count === 0) {
    return false;
  }

  // Check if all suggested matches for this payment are now processed
  const [remaining] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Match"
    WHERE "paymentId" = ${match.payment_id}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  if (parseInt(remaining?.count ?? "0", 10) === 0) {
    // All suggestions processed, check if any confirmed
    const [confirmed] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "Match"
      WHERE "paymentId" = ${match.payment_id}
        AND "shopId" = ${shopId}
        AND state = 'confirmed'
    `;

    if (parseInt(confirmed?.count ?? "0", 10) === 0) {
      // No confirmed matches, payment goes back to unmatched
      await updatePaymentStatus(sql, shopId, match.payment_id, "unmatched");
    } else {
      await updatePaymentStatus(sql, shopId, match.payment_id, "matched");
    }
  }

  return true;
}

/**
 * Update the allocation amount for a match before confirming.
 * Used for editing partial payment allocations.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param matchId - Match ID to update
 * @param newAmountPaise - New allocation amount in paise
 */
export async function updateMatchAllocation(
  sql: Sql,
  shopId: string,
  matchId: string,
  newAmountPaise: bigint
): Promise<boolean> {
  const newAmountDecimal = Number(newAmountPaise) / 100;

  const result = await sql`
    UPDATE "Match"
    SET
      amount = ${newAmountDecimal},
      "updatedAt" = NOW()
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'suggested'
  `;

  return result.count > 0;
}
