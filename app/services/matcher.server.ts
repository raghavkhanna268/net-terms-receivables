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
 * - PayerAlias is ONLY learned on merchant confirm (not from fuzzy matches)
 * - Rejected pairs are persisted and never re-suggested
 * - Transactions with FOR UPDATE locks prevent over-allocation
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
  getRejectedPairs,
  createRejectedMatch,
} from "~/lib/matching/queries.server";

/** Amount window multiplier for candidate filtering (0.5x to 2x payment) */
const AMOUNT_WINDOW_MIN_FACTOR = 0.5;
const AMOUNT_WINDOW_MAX_FACTOR = 2.0;

/**
 * Maximum payments to process per request (Workers Free 10ms CPU budget).
 * Use the pgmq job path for larger batches.
 */
const MAX_PAYMENTS_PER_REQUEST = 10;

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
  /** True when there are more payments to process (use offset for next batch) */
  hasMore: boolean;
}

/**
 * Run the matcher for unmatched payments in a shop.
 * This is the main entry point for batch matching.
 *
 * IMPORTANT: Limited to MAX_PAYMENTS_PER_REQUEST to respect 10ms CPU budget.
 * Use the pgmq job path for processing more payments.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param options - Processing options
 */
export async function runMatcher(
  sql: Sql,
  shopId: string,
  options: {
    /** Maximum payments to process in one run (capped at MAX_PAYMENTS_PER_REQUEST) */
    limit?: number;
    /** Offset for pagination */
    offset?: number;
  } = {}
): Promise<MatcherRunSummary> {
  // Cap the limit to respect CPU budget
  const requestedLimit = options.limit ?? MAX_PAYMENTS_PER_REQUEST;
  const limit = Math.min(requestedLimit, MAX_PAYMENTS_PER_REQUEST);
  const offset = options.offset ?? 0;

  const summary: MatcherRunSummary = {
    paymentsProcessed: 0,
    matchesCreated: 0,
    highConfidenceMatches: 0,
    errors: 0,
    results: [],
    hasMore: false,
  };

  // Get unmatched payments (fetch one extra to check hasMore)
  const { payments } = await getUnmatchedPayments(sql, shopId, {
    limit: limit + 1,
    offset,
  });

  if (payments.length === 0) {
    return summary;
  }

  // Check if there are more payments beyond this batch
  summary.hasMore = payments.length > limit;
  const paymentsToProcess = payments.slice(0, limit);

  // Load buyers with aliases (cached for the batch)
  const buyers = await getBuyersWithAliases(sql, shopId);

  if (buyers.length === 0) {
    // No buyers to match against
    return summary;
  }

  // Process each payment
  for (const payment of paymentsToProcess) {
    try {
      const result = await matchSinglePayment(sql, shopId, payment, buyers);
      summary.results.push(result);
      summary.paymentsProcessed++;
      summary.matchesCreated += result.matchesCreated;
      if (result.isHighConfidence) {
        summary.highConfidenceMatches++;
      }
    } catch (error) {
      console.error(
        `[matcher] Error processing payment ${payment.id}:`,
        error instanceof Error ? error.message : "Unknown error"
      );
      summary.errors++;
      summary.results.push({
        paymentId: payment.id,
        matchesCreated: 0,
        topScore: 0,
        isHighConfidence: false,
        error: "Processing failed",
      });
    }
  }

  return summary;
}

/**
 * Match a single payment against candidate invoices.
 * Does NOT learn PayerAlias from fuzzy matches (only on confirm).
 * Does NOT set 'partial' status on suggestions (only on confirmed allocations).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param payment - Payment to match
 * @param buyers - Pre-loaded buyers with aliases
 */
async function matchSinglePayment(
  sql: Sql,
  shopId: string,
  payment: {
    id: string;
    amountPaise: bigint;
    narration: string;
    payerText: string | null;
    utr: string | null;
    rail: string | null;
  },
  buyers: BuyerForScoring[]
): Promise<MatcherResult> {
  // Clear any existing suggested matches for idempotency
  await deleteSuggestedMatchesForPayment(sql, shopId, payment.id);

  // Get rejected pairs to exclude from suggestions
  const rejectedPairs = await getRejectedPairs(sql, shopId, payment.id);
  const rejectedInvoiceIds = new Set(rejectedPairs.map((r) => r.invoiceId));

  // Try to identify the buyer from payer text or narration (using confirmed aliases only)
  let targetBuyer: BuyerForScoring | null = null;

  if (payment.payerText) {
    // Try alias lookup first (only looks at confirmed/persisted aliases)
    const normalizedPayer = normalizeNarrationForLookup(payment.payerText);
    targetBuyer = await findBuyerByAlias(sql, shopId, normalizedPayer);

    // NOTE: We do NOT learn PayerAlias from fuzzy matches here.
    // Aliases are only learned when a merchant explicitly confirms a match.
    if (!targetBuyer) {
      const match = findBestBuyerMatch(payment.payerText, buyers);
      if (match) {
        targetBuyer = buyers.find((b) => b.id === match.buyerId) ?? null;
        // P1.4: Do NOT call upsertPayerAlias here - only on confirmMatch
      }
    }
  }

  // Calculate amount window for candidate filtering
  const minPaise = BigInt(
    Math.floor(Number(payment.amountPaise) * AMOUNT_WINDOW_MIN_FACTOR)
  );
  const maxPaise = BigInt(
    Math.ceil(Number(payment.amountPaise) * AMOUNT_WINDOW_MAX_FACTOR)
  );

  let candidateInvoices: InvoiceForScoring[];

  if (targetBuyer) {
    // If we identified a buyer, get their invoices
    candidateInvoices = await getOpenInvoicesForBuyer(
      sql,
      shopId,
      targetBuyer.id
    );
  } else {
    // Otherwise, get invoices in the amount window
    candidateInvoices = await getOpenInvoicesInAmountWindow(
      sql,
      shopId,
      minPaise,
      maxPaise
    );
  }

  // Filter out rejected invoices
  candidateInvoices = candidateInvoices.filter(
    (inv) => !rejectedInvoiceIds.has(inv.id)
  );

  if (candidateInvoices.length === 0) {
    return {
      paymentId: payment.id,
      matchesCreated: 0,
      topScore: 0,
      isHighConfidence: false,
    };
  }

  // Limit candidates for bounded combinatorics
  const limitedCandidates = candidateInvoices.slice(
    0,
    MAX_INVOICES_FOR_SUBSET_SUM
  );

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

  // P2.3: Do NOT set 'partial' status on suggestions - only on confirmed allocations
  // Payment status remains 'unmatched' until a match is confirmed

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
 * CRITICAL: Runs in a transaction with FOR UPDATE locks to prevent over-allocation.
 * - Locks the payment row to get current allocated total
 * - Locks affected invoice rows to get current outstanding
 * - Caps allocation at remaining payment amount
 * - Caps allocation at invoice remaining outstanding
 * - Drops competing suggestions for the same payment (including other buyers)
 * - Learns PayerAlias from confirmed matches
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
): Promise<{ success: boolean; error?: string }> {
  try {
    return await sql.begin(async (tx) => {
      // Get the match with FOR UPDATE SKIP LOCKED to prevent concurrent confirmations
      const [match] = await tx<
        {
          id: string;
          payment_id: string;
          invoice_id: string;
          amount_paise: string;
          buyer_account_id: string;
        }[]
      >`
        SELECT 
          m.id,
          m."paymentId" AS payment_id,
          m."invoiceId" AS invoice_id,
          (ROUND(m.amount * 100))::text AS amount_paise,
          i."buyerAccountId" AS buyer_account_id
        FROM "Match" m
        JOIN "Invoice" i ON i.id = m."invoiceId"
        WHERE m.id = ${matchId}
          AND m."shopId" = ${shopId}
          AND m.state = 'suggested'
        FOR UPDATE OF m SKIP LOCKED
      `;

      if (!match) {
        return { success: false, error: "Match not found or already processed" };
      }

      // Lock the payment row and get payment details
      const [payment] = await tx<
        { id: string; amount_paise: string; payer_text: string | null }[]
      >`
        SELECT 
          id,
          (ROUND(amount * 100))::text AS amount_paise,
          "payerText" AS payer_text
        FROM "Payment"
        WHERE id = ${match.payment_id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!payment) {
        return { success: false, error: "Payment not found" };
      }

      // Get total already confirmed allocations for this payment
      const [confirmedTotal] = await tx<{ total_paise: string }[]>`
        SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::text AS total_paise
        FROM "Match"
        WHERE "paymentId" = ${match.payment_id}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
      `;

      const paymentAmountPaise = BigInt(payment.amount_paise);
      const alreadyAllocatedPaise = BigInt(confirmedTotal?.total_paise ?? "0");
      const remainingPaymentPaise = paymentAmountPaise - alreadyAllocatedPaise;

      if (remainingPaymentPaise <= 0n) {
        return {
          success: false,
          error: "Payment fully allocated",
        };
      }

      // Lock the invoice row and get current outstanding
      const [invoice] = await tx<{ id: string; outstanding_paise: string }[]>`
        SELECT 
          id,
          (ROUND(outstanding * 100))::text AS outstanding_paise
        FROM "Invoice"
        WHERE id = ${match.invoice_id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!invoice) {
        return { success: false, error: "Invoice not found" };
      }

      // Get total already confirmed allocations for this invoice
      const [invoiceConfirmedTotal] = await tx<{ total_paise: string }[]>`
        SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::text AS total_paise
        FROM "Match"
        WHERE "invoiceId" = ${match.invoice_id}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
      `;

      const invoiceOutstandingPaise = BigInt(invoice.outstanding_paise);
      const invoiceAlreadyAllocatedPaise = BigInt(
        invoiceConfirmedTotal?.total_paise ?? "0"
      );
      const invoiceRemainingPaise =
        invoiceOutstandingPaise - invoiceAlreadyAllocatedPaise;

      if (invoiceRemainingPaise <= 0n) {
        return {
          success: false,
          error: "Invoice fully allocated",
        };
      }

      // Calculate the capped allocation amount
      const requestedPaise = BigInt(match.amount_paise);
      const cappedByPayment =
        requestedPaise > remainingPaymentPaise
          ? remainingPaymentPaise
          : requestedPaise;
      const finalAllocationPaise =
        cappedByPayment > invoiceRemainingPaise
          ? invoiceRemainingPaise
          : cappedByPayment;

      if (finalAllocationPaise <= 0n) {
        return {
          success: false,
          error: "No remaining allocation possible",
        };
      }

      const finalAmountDecimal = Number(finalAllocationPaise) / 100;

      // Update the match state to confirmed with capped amount
      await tx`
        UPDATE "Match"
        SET
          state = 'confirmed',
          amount = ${finalAmountDecimal},
          "confirmedBy" = ${userId},
          "confirmedAt" = NOW(),
          "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
      `;

      // P1.1: Drop competing suggestions for this payment (all buyers)
      await tx`
        UPDATE "Match"
        SET
          state = 'unmatched',
          "updatedAt" = NOW()
        WHERE "paymentId" = ${match.payment_id}
          AND "shopId" = ${shopId}
          AND state = 'suggested'
          AND id != ${matchId}
      `;

      // P1.4: Learn PayerAlias from confirmed match (NOT from fuzzy suggestions)
      if (payment.payer_text) {
        const normalizedPayer = normalizeNarrationForLookup(payment.payer_text);
        if (normalizedPayer.length >= 3) {
          await upsertPayerAlias(tx, match.buyer_account_id, normalizedPayer);
        }
      }

      // P2.3: Update payment status based on confirmed allocations
      const newAllocatedTotal = alreadyAllocatedPaise + finalAllocationPaise;
      const isFullyAllocated = newAllocatedTotal >= paymentAmountPaise;
      const newStatus = isFullyAllocated ? "matched" : "partial";
      await updatePaymentStatus(tx, shopId, match.payment_id, newStatus);

      return { success: true };
    });
  } catch (error) {
    console.error(
      `[confirmMatch] Error confirming match ${matchId}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return { success: false, error: "Confirmation failed" };
  }
}

/**
 * Reject a suggested match.
 * Persists the rejection to prevent future re-suggestion.
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
): Promise<{ success: boolean; error?: string }> {
  try {
    return await sql.begin(async (tx) => {
      // Get the match details with FOR UPDATE
      const [match] = await tx<
        { payment_id: string; invoice_id: string }[]
      >`
        SELECT "paymentId" AS payment_id, "invoiceId" AS invoice_id
        FROM "Match"
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
          AND state = 'suggested'
        FOR UPDATE
      `;

      if (!match) {
        return {
          success: false,
          error: "Match not found or already processed",
        };
      }

      // Update the match state to unmatched (rejected)
      await tx`
        UPDATE "Match"
        SET
          state = 'unmatched',
          "confirmedBy" = ${userId},
          "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
      `;

      // P2.2: Persist the rejection to prevent re-suggestion
      await createRejectedMatch(tx, {
        shopId,
        paymentId: match.payment_id,
        invoiceId: match.invoice_id,
        rejectedBy: userId,
      });

      // Check if all suggested matches for this payment are now processed
      const [remaining] = await tx<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM "Match"
        WHERE "paymentId" = ${match.payment_id}
          AND "shopId" = ${shopId}
          AND state = 'suggested'
      `;

      if (parseInt(remaining?.count ?? "0", 10) === 0) {
        // All suggestions processed, check if any confirmed
        const [confirmed] = await tx<{ count: string }[]>`
          SELECT COUNT(*)::text AS count
          FROM "Match"
          WHERE "paymentId" = ${match.payment_id}
            AND "shopId" = ${shopId}
            AND state = 'confirmed'
        `;

        if (parseInt(confirmed?.count ?? "0", 10) === 0) {
          // No confirmed matches, payment goes back to unmatched
          await updatePaymentStatus(tx, shopId, match.payment_id, "unmatched");
        }
        // If there are confirmed matches, payment status stays as is (matched/partial)
      }

      return { success: true };
    });
  } catch (error) {
    console.error(
      `[rejectMatch] Error rejecting match ${matchId}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return { success: false, error: "Rejection failed" };
  }
}

/**
 * Update the allocation amount for a match before confirming.
 * Used for editing partial payment allocations.
 *
 * IMPORTANT: Must be called within a transaction for proper locking.
 * Consider removing this in favor of the Edit Allocation action that
 * uses the same caps and locks as confirmMatch.
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
): Promise<{ success: boolean; error?: string }> {
  try {
    return await sql.begin(async (tx) => {
      // Get the match with FOR UPDATE
      const [match] = await tx<
        { payment_id: string; invoice_id: string }[]
      >`
        SELECT "paymentId" AS payment_id, "invoiceId" AS invoice_id
        FROM "Match"
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
          AND state = 'suggested'
        FOR UPDATE
      `;

      if (!match) {
        return {
          success: false,
          error: "Match not found or already confirmed",
        };
      }

      // Lock payment and get remaining unallocated amount
      const [payment] = await tx<{ amount_paise: string }[]>`
        SELECT (ROUND(amount * 100))::text AS amount_paise
        FROM "Payment"
        WHERE id = ${match.payment_id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!payment) {
        return { success: false, error: "Payment not found" };
      }

      // Get total confirmed allocations for this payment
      const [confirmedTotal] = await tx<{ total_paise: string }[]>`
        SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::text AS total_paise
        FROM "Match"
        WHERE "paymentId" = ${match.payment_id}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
      `;

      const paymentAmountPaise = BigInt(payment.amount_paise);
      const alreadyAllocatedPaise = BigInt(confirmedTotal?.total_paise ?? "0");
      const remainingPaymentPaise = paymentAmountPaise - alreadyAllocatedPaise;

      // Lock invoice and get remaining outstanding
      const [invoice] = await tx<{ outstanding_paise: string }[]>`
        SELECT (ROUND(outstanding * 100))::text AS outstanding_paise
        FROM "Invoice"
        WHERE id = ${match.invoice_id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!invoice) {
        return { success: false, error: "Invoice not found" };
      }

      // Get total confirmed allocations for this invoice
      const [invoiceConfirmedTotal] = await tx<{ total_paise: string }[]>`
        SELECT COALESCE(SUM(ROUND(amount * 100)), 0)::text AS total_paise
        FROM "Match"
        WHERE "invoiceId" = ${match.invoice_id}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
      `;

      const invoiceOutstandingPaise = BigInt(invoice.outstanding_paise);
      const invoiceAlreadyAllocatedPaise = BigInt(
        invoiceConfirmedTotal?.total_paise ?? "0"
      );
      const invoiceRemainingPaise =
        invoiceOutstandingPaise - invoiceAlreadyAllocatedPaise;

      // Cap the new amount at remaining payment and invoice amounts
      let cappedAmount = newAmountPaise;
      if (cappedAmount > remainingPaymentPaise) {
        cappedAmount = remainingPaymentPaise;
      }
      if (cappedAmount > invoiceRemainingPaise) {
        cappedAmount = invoiceRemainingPaise;
      }

      if (cappedAmount <= 0n) {
        return { success: false, error: "No remaining allocation available" };
      }

      const newAmountDecimal = Number(cappedAmount) / 100;

      await tx`
        UPDATE "Match"
        SET
          amount = ${newAmountDecimal},
          "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
      `;

      return { success: true };
    });
  } catch (error) {
    console.error(
      `[updateMatchAllocation] Error updating match ${matchId}:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    return { success: false, error: "Update failed" };
  }
}
