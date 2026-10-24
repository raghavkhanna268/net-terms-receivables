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
 * - Gated accounts are included (gating applies only to value-add actions)
 * - All amounts in integer paise to avoid floating-point errors
 * - PayerAlias is ONLY learned on merchant confirm (not from fuzzy matches)
 * - Rejected pairs are persisted and never re-suggested
 * - Transactions with FOR UPDATE locks prevent over-allocation
 * - Lock order: Payment FIRST, then Match rows ORDER BY id, then Invoices ORDER BY id
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
export const MAX_PAYMENTS_PER_REQUEST = 10;

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
 * CRITICAL: Lock order to prevent deadlocks:
 * 1. Payment row FIRST (SELECT ... FOR UPDATE)
 * 2. Match rows for this payment ORDER BY id FOR UPDATE
 * 3. Invoice rows ORDER BY id FOR UPDATE
 *
 * Split-payment behavior:
 * - Only drops OTHER buyers' suggestions for this payment
 * - Same-buyer sibling suggestions remain confirmable
 * - Each suggestion is capped at remaining payment/invoice outstanding
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
      // STEP 1: Lock the payment row FIRST (consistent lock order)
      // Note: Don't filter by match state here - we check state after locking to give specific error
      const [payment] = await tx<
        { id: string; amount_paise: string; payer_text: string | null }[]
      >`
        SELECT 
          id,
          (ROUND(amount * 100))::text AS amount_paise,
          "payerText" AS payer_text
        FROM "Payment"
        WHERE id = (
          SELECT "paymentId" FROM "Match" 
          WHERE id = ${matchId} AND "shopId" = ${shopId}
        )
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!payment) {
        return { success: false, error: "Payment not found" };
      }

      // STEP 2: Lock ALL match rows for this payment ORDER BY id (consistent lock order)
      const matchRows = await tx<
        {
          id: string;
          invoice_id: string;
          amount_paise: string;
          state: string;
          buyer_account_id: string;
        }[]
      >`
        SELECT 
          m.id,
          m."invoiceId" AS invoice_id,
          (ROUND(m.amount * 100))::text AS amount_paise,
          m.state,
          i."buyerAccountId" AS buyer_account_id
        FROM "Match" m
        JOIN "Invoice" i ON i.id = m."invoiceId"
        WHERE m."paymentId" = ${payment.id}
          AND m."shopId" = ${shopId}
        ORDER BY m.id
        FOR UPDATE OF m
      `;

      // Find the match we're confirming
      const matchRow = matchRows.find((m) => m.id === matchId);
      if (!matchRow) {
        return { success: false, error: "Match not found" };
      }
      // P3: Return specific error for already-confirmed match
      if (matchRow.state === "confirmed" || matchRow.state === "pushed") {
        return { success: false, error: "This match is already confirmed" };
      }
      if (matchRow.state !== "suggested") {
        return { success: false, error: "Match not found or already processed" };
      }
      const match = matchRow;

      // STEP 3: Lock invoice rows ORDER BY id (consistent lock order)
      const invoiceIds = [...new Set(matchRows.map((m) => m.invoice_id))].sort();
      const invoiceRows = await tx<
        { id: string; outstanding_paise: string }[]
      >`
        SELECT 
          id,
          (ROUND(outstanding * 100))::text AS outstanding_paise
        FROM "Invoice"
        WHERE id IN ${tx(invoiceIds)}
          AND "shopId" = ${shopId}
        ORDER BY id
        FOR UPDATE
      `;

      const invoiceMap = new Map(invoiceRows.map((i) => [i.id, BigInt(i.outstanding_paise)]));

      // STEP 4: Query ALL 'confirmed' matches across ALL payments for these invoices
      // P2: Count only 'confirmed' (not 'pushed') because 'pushed' is already reflected in Invoice.outstanding
      const allConfirmedForInvoices = await tx<
        { invoice_id: string; total_paise: string }[]
      >`
        SELECT 
          "invoiceId" AS invoice_id,
          (SUM(ROUND(amount * 100)))::text AS total_paise
        FROM "Match"
        WHERE "invoiceId" IN ${tx(invoiceIds)}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
        GROUP BY "invoiceId"
      `;
      const invoiceAllocatedCrossPayment = new Map(
        allConfirmedForInvoices.map((r) => [r.invoice_id, BigInt(r.total_paise)])
      );

      // Calculate total already allocated (confirmed + pushed) for this payment
      const confirmedMatches = matchRows.filter((m) => m.state === "confirmed" || m.state === "pushed");
      const paymentAmountPaise = BigInt(payment.amount_paise);
      const alreadyAllocatedPaise = confirmedMatches.reduce(
        (sum, m) => sum + BigInt(m.amount_paise),
        0n
      );
      const remainingPaymentPaise = paymentAmountPaise - alreadyAllocatedPaise;

      if (remainingPaymentPaise <= 0n) {
        return { success: false, error: "Payment fully allocated" };
      }

      // Use cross-payment confirmed allocations for invoice-side calculation
      const invoiceAllocated = new Map(invoiceAllocatedCrossPayment);

      const invoiceOutstandingPaise = invoiceMap.get(match.invoice_id) ?? 0n;
      const invoiceAlreadyAllocatedPaise = invoiceAllocated.get(match.invoice_id) ?? 0n;
      const invoiceRemainingPaise = invoiceOutstandingPaise - invoiceAlreadyAllocatedPaise;

      if (invoiceRemainingPaise <= 0n) {
        return { success: false, error: "Invoice fully allocated" };
      }

      // Calculate capped allocation amount
      const requestedPaise = BigInt(match.amount_paise);
      const cappedByPayment = requestedPaise > remainingPaymentPaise ? remainingPaymentPaise : requestedPaise;
      const finalAllocationPaise = cappedByPayment > invoiceRemainingPaise ? invoiceRemainingPaise : cappedByPayment;

      if (finalAllocationPaise <= 0n) {
        return { success: false, error: "No remaining allocation possible" };
      }

      const finalAmountDecimal = Number(finalAllocationPaise) / 100;

      // Confirm this match with capped amount using conditional UPDATE
      // Only transitions if state is still 'suggested' (idempotency)
      const [confirmedRow] = await tx<{ id: string }[]>`
        UPDATE "Match"
        SET
          state = 'confirmed',
          amount = ${finalAmountDecimal},
          "confirmedBy" = ${userId},
          "confirmedAt" = NOW(),
          "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
          AND state = 'suggested'
        RETURNING id
      `;

      // S17: Write audit event only if the transition actually happened
      if (confirmedRow) {
        await tx`
          INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
          VALUES (
            gen_random_uuid(),
            ${shopId},
            ${userId},
            'match.confirmed',
            ${tx.json({
              matchId,
              invoiceId: match.invoice_id,
              paymentId: payment.id,
              amountPaise: finalAllocationPaise.toString(),
            })}::jsonb,
            NOW()
          )
        `;
      }

      // Calculate new remaining payment after this confirmation
      const newRemainingPaymentPaise = remainingPaymentPaise - finalAllocationPaise;

      // Update invoice allocated map for this invoice
      invoiceAllocated.set(
        match.invoice_id,
        invoiceAlreadyAllocatedPaise + finalAllocationPaise
      );

      // P1: Drop competing suggestions - scoped correctly:
      // 1. Drop all OTHER buyers' suggestions for this payment
      // 2. For SAME buyer, only drop suggestions that no longer fit
      const suggestedSiblings = matchRows.filter(
        (m) => m.id !== matchId && m.state === "suggested"
      );

      const matchIdsToUnmatch: string[] = [];
      for (const sibling of suggestedSiblings) {
        if (sibling.buyer_account_id !== match.buyer_account_id) {
          // Different buyer - always drop
          matchIdsToUnmatch.push(sibling.id);
        } else {
          // Same buyer - only drop if no longer fits
          const siblingInvoiceOutstanding = invoiceMap.get(sibling.invoice_id) ?? 0n;
          const siblingInvoiceAllocated = invoiceAllocated.get(sibling.invoice_id) ?? 0n;
          const siblingInvoiceRemaining = siblingInvoiceOutstanding - siblingInvoiceAllocated;

          // Check if there's any room left for this sibling
          if (newRemainingPaymentPaise <= 0n || siblingInvoiceRemaining <= 0n) {
            matchIdsToUnmatch.push(sibling.id);
          }
          // Otherwise, keep the sibling suggested - it can still be confirmed
        }
      }

      if (matchIdsToUnmatch.length > 0) {
        await tx`
          UPDATE "Match"
          SET
            state = 'unmatched',
            "updatedAt" = NOW()
          WHERE id IN ${tx(matchIdsToUnmatch)}
            AND "shopId" = ${shopId}
        `;
      }

      // P1.4: Learn PayerAlias from confirmed match (NOT from fuzzy suggestions)
      if (payment.payer_text) {
        const normalizedPayer = normalizeNarrationForLookup(payment.payer_text);
        if (normalizedPayer.length >= 3) {
          await upsertPayerAlias(tx, match.buyer_account_id, normalizedPayer);
        }
      }

      // Update payment status based on confirmed allocations
      const newAllocatedTotal = alreadyAllocatedPaise + finalAllocationPaise;
      const isFullyAllocated = newAllocatedTotal >= paymentAmountPaise;
      const newStatus = isFullyAllocated ? "matched" : "partial";
      await updatePaymentStatus(tx, shopId, payment.id, newStatus);

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
 * Lock order to prevent deadlocks:
 * 1. Payment row FIRST
 * 2. Match rows ORDER BY id
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
      // STEP 1: Lock payment row FIRST (consistent lock order)
      const [payment] = await tx<{ id: string }[]>`
        SELECT id
        FROM "Payment"
        WHERE id = (
          SELECT "paymentId" FROM "Match" 
          WHERE id = ${matchId} AND "shopId" = ${shopId} AND state = 'suggested'
        )
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!payment) {
        return { success: false, error: "Payment not found or match not suggested" };
      }

      // STEP 2: Lock match rows ORDER BY id (consistent lock order)
      const matchRows = await tx<
        { id: string; invoice_id: string; state: string }[]
      >`
        SELECT id, "invoiceId" AS invoice_id, state
        FROM "Match"
        WHERE "paymentId" = ${payment.id}
          AND "shopId" = ${shopId}
        ORDER BY id
        FOR UPDATE
      `;

      const match = matchRows.find((m) => m.id === matchId && m.state === "suggested");
      if (!match) {
        return { success: false, error: "Match not found or already processed" };
      }

      // Update the match state to unmatched (rejected)
      // NOTE: Don't set confirmedBy for rejections - use rejectedBy in rejected_matches
      await tx`
        UPDATE "Match"
        SET
          state = 'unmatched',
          "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
      `;

      // Persist the rejection to prevent re-suggestion
      await createRejectedMatch(tx, {
        shopId,
        paymentId: payment.id,
        invoiceId: match.invoice_id,
        rejectedBy: userId,
      });

      // Check if all suggested matches for this payment are now processed
      const suggestedCount = matchRows.filter((m) => m.state === "suggested" && m.id !== matchId).length;

      if (suggestedCount === 0) {
        // All suggestions processed, check if any confirmed
        const confirmedCount = matchRows.filter(
          (m) => m.state === "confirmed" || m.state === "pushed"
        ).length;

        if (confirmedCount === 0) {
          // No confirmed matches, payment goes back to unmatched
          await updatePaymentStatus(tx, shopId, payment.id, "unmatched");
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
 * Lock order to prevent deadlocks:
 * 1. Payment row FIRST
 * 2. Match rows ORDER BY id
 * 3. Invoice rows ORDER BY id
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
      // STEP 1: Lock payment row FIRST (consistent lock order)
      const [payment] = await tx<{ id: string; amount_paise: string }[]>`
        SELECT 
          id,
          (ROUND(amount * 100))::text AS amount_paise
        FROM "Payment"
        WHERE id = (
          SELECT "paymentId" FROM "Match" 
          WHERE id = ${matchId} AND "shopId" = ${shopId} AND state = 'suggested'
        )
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!payment) {
        return { success: false, error: "Payment not found or match not suggested" };
      }

      // STEP 2: Lock match rows ORDER BY id (consistent lock order)
      const matchRows = await tx<
        { id: string; invoice_id: string; amount_paise: string; state: string }[]
      >`
        SELECT 
          id,
          "invoiceId" AS invoice_id,
          (ROUND(amount * 100))::text AS amount_paise,
          state
        FROM "Match"
        WHERE "paymentId" = ${payment.id}
          AND "shopId" = ${shopId}
        ORDER BY id
        FOR UPDATE
      `;

      const match = matchRows.find((m) => m.id === matchId && m.state === "suggested");
      if (!match) {
        return { success: false, error: "Match not found or already confirmed" };
      }

      // STEP 3: Lock invoice rows ORDER BY id (consistent lock order)
      const invoiceIds = [...new Set(matchRows.map((m) => m.invoice_id))].sort();
      const invoiceRows = await tx<{ id: string; outstanding_paise: string }[]>`
        SELECT 
          id,
          (ROUND(outstanding * 100))::text AS outstanding_paise
        FROM "Invoice"
        WHERE id IN ${tx(invoiceIds)}
          AND "shopId" = ${shopId}
        ORDER BY id
        FOR UPDATE
      `;

      const invoiceMap = new Map(invoiceRows.map((i) => [i.id, BigInt(i.outstanding_paise)]));

      // STEP 4: Query ALL 'confirmed' matches across ALL payments for these invoices
      // P2: Count only 'confirmed' (not 'pushed') because 'pushed' is already reflected in Invoice.outstanding
      const allConfirmedForInvoices = await tx<
        { invoice_id: string; total_paise: string }[]
      >`
        SELECT 
          "invoiceId" AS invoice_id,
          (SUM(ROUND(amount * 100)))::text AS total_paise
        FROM "Match"
        WHERE "invoiceId" IN ${tx(invoiceIds)}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
        GROUP BY "invoiceId"
      `;
      const invoiceAllocatedCrossPayment = new Map(
        allConfirmedForInvoices.map((r) => [r.invoice_id, BigInt(r.total_paise)])
      );

      // Calculate remaining payment (after confirmed + pushed)
      const confirmedMatches = matchRows.filter((m) => m.state === "confirmed" || m.state === "pushed");
      const paymentAmountPaise = BigInt(payment.amount_paise);
      const alreadyAllocatedPaise = confirmedMatches.reduce(
        (sum, m) => sum + BigInt(m.amount_paise),
        0n
      );
      const remainingPaymentPaise = paymentAmountPaise - alreadyAllocatedPaise;

      // Use cross-payment confirmed allocations for invoice-side calculation
      const invoiceOutstandingPaise = invoiceMap.get(match.invoice_id) ?? 0n;
      const invoiceAlreadyAllocatedPaise = invoiceAllocatedCrossPayment.get(match.invoice_id) ?? 0n;
      const invoiceRemainingPaise = invoiceOutstandingPaise - invoiceAlreadyAllocatedPaise;

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
