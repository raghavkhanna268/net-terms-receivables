/**
 * S17: Apply and unmatch payment matches with audit trail.
 *
 * This service handles:
 * - Applying confirmed matches to reduce invoice outstanding
 * - Full payments trigger Shopify orderMarkAsPaid
 * - Partial payments stay in ledger without Shopify call
 * - Unmatching confirmed or pushed matches (blocked after Shopify push for paid invoices)
 * - Immutable audit trail with random UUIDs
 *
 * TWO-PHASE COMMIT with 'pushing' STATE:
 * Full payments use a two-phase commit to safely call Shopify:
 * - TX1: Transition match confirmed→pushing, record push_claimed audit with outstanding
 * - Shopify call: Outside any transaction, call orderMarkAsPaid
 * - TX2: Finalize pushing→pushed, write match.applied and invoice.paid audits
 *
 * STALE SIBLING RECOVERY (pre-TX1):
 * Before TX1, applyMatch checks for stale 'pushing' siblings (> 5 min) on the same invoice.
 * If found, it recovers them first via handleStalePushingMatch. This means an Apply on B
 * can finalize a stale sibling A first, potentially paying the invoice before B proceeds.
 *
 * STALE INVOICE NOT OPEN (handleStaleInvoiceNotOpen):
 * When a stale match is retried but the invoice is no longer open:
 * - No push_claimed record → unmatch with INVOICE_NOT_OPEN
 * - Sibling's match.applied zeroed it → unmatch with INVOICE_NOT_OPEN
 * - Invoice 'paid' with no sibling → pushed with STALE_FINALIZED_EXTERNALLY_PAID
 * - Invoice 'cancelled' → unmatch with INVOICE_NOT_OPEN
 *
 * POST-SHOPIFY-SUCCESS INVARIANT:
 * After a successful Shopify push, never unmatch unless a sibling's applied audit or a
 * cancellation explains it. The finalize TX mirrors finalizeFullApply's backstop:
 * if invoice is 'paid' (typically from our ORDERS_PAID webhook), finalize to pushed with
 * match.applied rather than routing through the plain not-open unmatch.
 *
 * PUSHED WITHOUT AUDIT:
 * If a match is found in 'pushed' state without a match.applied audit, it's transitioned to
 * 'unmatched' with PUSHED_WITHOUT_AUDIT reason. Unmatch refuses to restore amounts without
 * a match.applied audit to prevent incorrect restoration.
 */

import type { Sql } from "~/lib/db-light.server";
import { shopifyGraphQLRequest, type ShopifyClientResult } from "./shopify-client.server";
import { enqueueRecomputeForInvoice } from "./credit-status-recompute.server";
import { safeLog, toErrorCode } from "~/lib/log.server";

/**
 * GraphQL mutation to mark a Shopify order as paid.
 * Uses write_orders scope which is already in the app's scope list.
 */
const ORDER_MARK_AS_PAID_MUTATION = `
  mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
    orderMarkAsPaid(input: $input) {
      order {
        id
        displayFinancialStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL query to check order's current financial status.
 * Used to verify if an order is already paid before treating userErrors as success.
 */
const ORDER_QUERY = `
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      displayFinancialStatus
    }
  }
`;

export interface ApplyMatchResult {
  success: boolean;
  invoicePaid: boolean;
  shopifyPushSucceeded: boolean;
  error?: string;
  retryable?: boolean;
  reasonCode?: string;
}

export interface UnmatchResult {
  success: boolean;
  error?: string;
  alreadyPushed?: boolean;
}

/**
 * Apply a confirmed match to reduce invoice outstanding.
 *
 * SECURITY: shopId must come from the authenticated session (route), not from user input.
 * All queries include AND "shopId" = ... to prevent IDOR attacks.
 *
 * The decision between partial and full payment is made UNDER THE LOCK to prevent
 * race conditions where concurrent applies could miscalculate (Issue #2).
 *
 * STALE SIBLING RECOVERY: Before TX1, this function checks for stale 'pushing' siblings
 * (> 5 min) on the same invoice and recovers them first. This means an Apply on B can
 * finalize a stale sibling A first, potentially paying the invoice before B proceeds.
 * If A pays the invoice, B will fail with INVOICE_NOT_OPEN.
 *
 * Flow:
 * 0. Pre-TX1: Recover any stale 'pushing' siblings on the same invoice
 * 1. TX1: Lock invoice FOR UPDATE, claim match, compute reduction from LOCKED outstanding
 *    - If partial: complete in same TX, write audit, return
 *    - If full: record need for Shopify push, commit
 * 2. Call Shopify orderMarkAsPaid (only for full payment)
 * 3. TX2: Finalize - re-verify invoice state, set to paid, write audit events
 */
export async function applyMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  actor: string
): Promise<ApplyMatchResult> {
  // Phase 1: Fetch match metadata (outside transaction)
  // IDOR protection: filter by shopId from authenticated session
  const [matchRow] = await sql<{
    id: string;
    shopId: string;
    paymentId: string;
    invoiceId: string;
    amountPaise: string;
    state: string;
  }[]>`
    SELECT
      id,
      "shopId" AS "shopId",
      "paymentId" AS "paymentId",
      "invoiceId" AS "invoiceId",
      (ROUND(amount * 100))::text AS "amountPaise",
      state
    FROM "Match"
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
  `;

  if (!matchRow) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: "Match not found",
    };
  }

  // Handle already-pushed state (idempotency)
  if (matchRow.state === "pushed") {
    return handlePushedMatch(sql, shopId, matchId, matchRow, actor);
  }

  // Handle 'pushing' state (stale re-claim recovery)
  if (matchRow.state === "pushing") {
    return handleStalePushingMatch(sql, shopId, matchId, matchRow, actor);
  }

  if (matchRow.state !== "confirmed") {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: `Match state is '${matchRow.state}', expected 'confirmed'`,
    };
  }

  // Fetch invoice metadata - IDOR protection: filter by shopId
  const [invoiceRow] = await sql<{
    id: string;
    orderId: string | null;
    shopDomain: string;
    buyerAccountId: string;
  }[]>`
    SELECT
      i.id,
      i."orderId" AS "orderId",
      s.domain AS "shopDomain",
      i."buyerAccountId" AS "buyerAccountId"
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i.id = ${matchRow.invoiceId}
      AND i."shopId" = ${shopId}
  `;

  if (!invoiceRow) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: "Invoice not found",
    };
  }

  // Before TX1, check for stale 'pushing' siblings and try to recover them
  // This prevents a crashed 'pushing' match from blocking the invoice forever
  const staleSiblings = await sql<{
    id: string;
    paymentId: string;
    amountPaise: string;
  }[]>`
    SELECT id, "paymentId" AS "paymentId", (ROUND(amount * 100))::text AS "amountPaise"
    FROM "Match"
    WHERE "invoiceId" = ${invoiceRow.id}
      AND "shopId" = ${shopId}
      AND id != ${matchId}
      AND state = 'pushing'
      AND "updatedAt" < NOW() - interval '5 minutes'
  `;

  for (const sibling of staleSiblings) {
    // Try to recover the stale sibling
    const siblingMatchRow = {
      id: sibling.id,
      shopId,
      paymentId: sibling.paymentId,
      invoiceId: matchRow.invoiceId,
      amountPaise: sibling.amountPaise,
    };
    const recoveryResult = await handleStalePushingMatch(sql, shopId, sibling.id, siblingMatchRow, actor);

    // If recovery failed with an error (not just "not stale"), warn but continue
    // The TX1 guard will catch any remaining issues
    if (!recoveryResult.success && recoveryResult.reasonCode !== "PUSH_IN_PROGRESS") {
      safeLog("warn", "apply_stale_sibling_recovery_failed", {
        matchId: sibling.id,
        ...(recoveryResult.reasonCode ? { reasonCode: recoveryResult.reasonCode } : {}),
        err: toErrorCode(recoveryResult.error),
      });
    }
  }

  // TX1: Lock invoice, claim match, decide partial vs full UNDER LOCK
  const tx1Result = await claimMatchAndDecide(
    sql,
    shopId,
    matchId,
    matchRow,
    invoiceRow,
    actor
  );

  if (!tx1Result.success) {
    return {
      success: tx1Result.success,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: tx1Result.error,
      reasonCode: tx1Result.reasonCode,
    };
  }

  // If partial, we're done (already handled in tx1)
  if (tx1Result.isPartial) {
    // Enqueue credit status recompute
    await safeEnqueueRecompute(sql, invoiceRow.id);

    return {
      success: true,
      invoicePaid: false,
      shopifyPushSucceeded: false,
    };
  }

  // Full payment path: call Shopify outside transaction, then finalize
  let pushSucceeded = false;
  let reasonCode: string | undefined;

  if (invoiceRow.orderId) {
    const shopifyResult = await callOrderMarkAsPaid(
      invoiceRow.shopDomain,
      invoiceRow.orderId
    );

    if (shopifyResult.success) {
      pushSucceeded = true;
    } else if (shopifyResult.alreadyPaid) {
      // Order was already paid - treat as success
      pushSucceeded = true;
      reasonCode = "ALREADY_PAID_IN_SHOPIFY";
    } else {
      // Shopify call failed - release the claim
      await releaseMatchClaim(sql, shopId, matchId);
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: shopifyResult.retryable ? "retryable:shopify_api_error" : "permanent:shopify_api_error",
        retryable: shopifyResult.retryable,
      };
    }
  } else {
    // No Shopify order to mark - local-only invoice
    pushSucceeded = true;
  }

  // TX2: Finalize - mark invoice as paid, write audit events
  // Pass the outstanding TX1 saw for race condition check
  const tx2Result = await finalizeFullApply(
    sql,
    shopId,
    matchId,
    matchRow,
    invoiceRow,
    actor,
    pushSucceeded,
    reasonCode,
    tx1Result.appliedAmountPaise ?? matchRow.amountPaise,
    tx1Result.previousOutstandingPaise ?? "0"
  );

  if (!tx2Result.success) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: pushSucceeded,
      error: tx2Result.error,
    };
  }

  // Enqueue credit status recompute
  await safeEnqueueRecompute(sql, invoiceRow.id);

  return {
    success: true,
    invoicePaid: true,
    shopifyPushSucceeded: pushSucceeded,
    reasonCode,
  };
}

/**
 * Handle a match that's already in 'pushed' state.
 *
 * This handles two cases:
 * 1. Idempotent retry - match was already successfully applied (has match.applied audit)
 * 2. Inconsistent state - match is 'pushed' but has no match.applied audit
 *
 * For case 2, we refuse to proceed and transition the match to 'unmatched' with
 * PUSHED_WITHOUT_AUDIT audit. The user must re-confirm and apply again.
 *
 * We detect successful application by looking for a match.applied audit event:
 * - For full payments: also check invoice status is 'paid'
 * - For partial payments: presence of match.applied audit is sufficient
 */
async function handlePushedMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  matchRow: { id: string; shopId: string; paymentId: string; invoiceId: string; amountPaise: string },
  actor: string
): Promise<ApplyMatchResult> {
  // Check invoice and audit state to determine if this is idempotent or inconsistent
  // IDOR protection: filter by shopId
  const [invoiceRow] = await sql<{
    id: string;
    status: string;
    orderId: string | null;
    shopDomain: string;
    outstandingPaise: string;
  }[]>`
    SELECT
      i.id,
      i.status,
      i."orderId" AS "orderId",
      s.domain AS "shopDomain",
      (ROUND(i.outstanding * 100))::text AS "outstandingPaise"
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i.id = ${matchRow.invoiceId}
      AND i."shopId" = ${shopId}
  `;

  if (!invoiceRow) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: "Invoice not found",
    };
  }

  // If invoice is already paid, this is a successful idempotent retry (full payment)
  if (invoiceRow.status === "paid") {
    return {
      success: true,
      invoicePaid: true,
      shopifyPushSucceeded: true,
      reasonCode: "ALREADY_APPLIED",
    };
  }

  // Check if this match was already applied by looking for audit event
  // This handles idempotent retry of partial payments
  const appliedAmount = await getAppliedAmountFromAudit(sql, matchRow.shopId, matchId);
  if (appliedAmount !== null) {
    // Match was already applied (partial payment idempotent retry)
    return {
      success: true,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      reasonCode: "ALREADY_APPLIED",
    };
  }

  // P1: No 'pushed' without match.applied audit. Invoice is no longer open OR
  // there was a crash before the audit was written. Transition to 'unmatched'
  // with an audit event explaining the situation.
  safeLog("warn", "apply_pushed_without_audit", {
    matchId,
    invoiceId: invoiceRow.id,
    status: invoiceRow.status,
  });

  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE "Match"
        SET state = 'unmatched', "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
          AND state = 'pushed'
      `;

      await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
        matchId,
        invoiceId: invoiceRow.id,
        paymentId: matchRow.paymentId,
        previousState: "pushed",
        reason: "PUSHED_WITHOUT_AUDIT",
        invoiceStatus: invoiceRow.status,
      });

      // Free up the payment
      await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);
    });

    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: "Match was in inconsistent state and has been unmatched. Please re-confirm and apply.",
      reasonCode: "PUSHED_WITHOUT_AUDIT",
    };
  } catch (error) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: `permanent:${toErrorCode(error)}`,
      reasonCode: "RECOVERY_FAILED",
    };
  }
}

/**
 * Handle a match that's in 'pushing' state (stale re-claim recovery).
 *
 * Uses conditional UPDATE with 5-minute timeout to ensure only one retrier wins.
 * Before re-pushing, checks Shopify order status - if already PAID, finalizes locally.
 */
async function handleStalePushingMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  matchRow: { id: string; shopId: string; paymentId: string; invoiceId: string; amountPaise: string },
  actor: string
): Promise<ApplyMatchResult> {
  // Try to claim the stale 'pushing' match (only if > 5 minutes old)
  // Conditional UPDATE ensures only one retrier wins
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE "Match"
    SET "updatedAt" = NOW()
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
      AND state = 'pushing'
      AND "updatedAt" < NOW() - interval '5 minutes'
    RETURNING id
  `;

  if (!claimed) {
    // Either not stale yet (< 5 minutes) or another retrier won
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: "Push in progress (not yet stale)",
      reasonCode: "PUSH_IN_PROGRESS",
    };
  }

  // We won the re-claim. Now check invoice and Shopify status.
  const [invoiceRow] = await sql<{
    id: string;
    status: string;
    orderId: string | null;
    shopDomain: string;
    outstandingPaise: string;
  }[]>`
    SELECT
      i.id,
      i.status,
      i."orderId" AS "orderId",
      s.domain AS "shopDomain",
      (ROUND(i.outstanding * 100))::text AS "outstandingPaise"
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i.id = ${matchRow.invoiceId}
      AND i."shopId" = ${shopId}
  `;

  if (!invoiceRow) {
    // Release claim back to confirmed
    await sql`
      UPDATE "Match"
      SET state = 'confirmed', "updatedAt" = NOW()
      WHERE id = ${matchId} AND "shopId" = ${shopId}
    `;
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: "Invoice not found",
    };
  }

  // If invoice is already paid or not open locally, handle appropriately
  // Must lock invoice FOR UPDATE and re-check status under the lock
  if (invoiceRow.status !== "open") {
    const result = await sql.begin(async (tx) => {
      // Lock invoice and re-check status
      const [lockedInvoice] = await tx<{ status: string }[]>`
        SELECT status
        FROM "Invoice"
        WHERE id = ${matchRow.invoiceId}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!lockedInvoice) {
        return { action: "error" as const, invoicePaid: false, error: "Invoice not found" };
      }

      // Re-check status after locking - it might have changed to 'open'
      if (lockedInvoice.status === "open") {
        return { action: "retry" as const, invoicePaid: false };
      }

      return handleStaleInvoiceNotOpen(tx, shopId, matchId, matchRow, lockedInvoice.status, actor);
    });

    if (result.action === "error") {
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: result.error ?? "Invoice not found",
      };
    }

    if (result.action === "retry") {
      // Invoice is now open - fall through to normal processing
      // This is a rare race condition; for simplicity, ask for retry
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: "Invoice status changed, please retry",
        retryable: true,
      };
    }

    if (result.action === "unmatched") {
      // Recompute credit status for the invoice
      await safeEnqueueRecompute(sql, matchRow.invoiceId);
    }

    return {
      success: result.action === "pushed",
      invoicePaid: result.invoicePaid,
      shopifyPushSucceeded: result.action === "pushed",
      reasonCode: result.action === "pushed"
        ? "STALE_RECLAIM_ALREADY_PAID"
        : "INVOICE_NOT_OPEN",
    };
  }

  // Check Shopify order status before re-pushing
  if (invoiceRow.orderId) {
    const isAlreadyPaid = await verifyOrderIsPaid(invoiceRow.shopDomain, invoiceRow.orderId);

    if (isAlreadyPaid) {
      // Shopify already marked as paid - finalize locally without re-pushing
      // MUST lock invoice FOR UPDATE, re-check status, and decide partial vs full from LOCKED outstanding
      try {
        const result = await sql.begin(async (tx) => {
          const [lockedInvoice] = await tx<{ outstandingPaise: string; status: string }[]>`
            SELECT
              (ROUND(outstanding * 100))::text AS "outstandingPaise",
              status
            FROM "Invoice"
            WHERE id = ${invoiceRow.id}
              AND "shopId" = ${shopId}
            FOR UPDATE
          `;

          if (!lockedInvoice) {
            throw new Error("Invoice not found during stale reclaim");
          }

          // Re-check status after locking
          if (lockedInvoice.status !== "open") {
            // Invoice already paid/cancelled - use proper stale handling
            const staleResult = await handleStaleInvoiceNotOpen(
              tx,
              shopId,
              matchId,
              matchRow,
              lockedInvoice.status,
              actor
            );
            return {
              invoicePaid: staleResult.invoicePaid,
              isPartial: false,
              alreadyFinalized: true,
              wasUnmatched: staleResult.action === "unmatched",
            };
          }

          // Decide partial vs full from LOCKED outstanding
          const matchAmountPaise = BigInt(matchRow.amountPaise);
          const currentOutstanding = BigInt(lockedInvoice.outstandingPaise);
          const reduction = matchAmountPaise > currentOutstanding ? currentOutstanding : matchAmountPaise;
          const newOutstanding = currentOutstanding - reduction;
          const isFullPayment = newOutstanding === 0n;

          if (isFullPayment) {
            // Full payment - conditionally mark invoice as paid (only if still open)
            const [flippedInvoice] = await tx<{ id: string }[]>`
              UPDATE "Invoice"
              SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
              WHERE id = ${invoiceRow.id}
                AND "shopId" = ${shopId}
                AND status = 'open'
              RETURNING id
            `;

            await tx`
              UPDATE "Match"
              SET state = 'pushed', "updatedAt" = NOW()
              WHERE id = ${matchId}
                AND "shopId" = ${shopId}
            `;

            await writeAuditEvent(tx, shopId, actor, "match.applied", {
              matchId,
              invoiceId: invoiceRow.id,
              paymentId: matchRow.paymentId,
              amountPaise: reduction.toString(),
              previousOutstandingPaise: currentOutstanding.toString(),
              newOutstandingPaise: "0",
              staleReclaim: true,
              shopifyAlreadyPaid: true,
            });

            // Only write invoice.paid if THIS transaction flipped open→paid
            if (flippedInvoice) {
              await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
                invoiceId: invoiceRow.id,
                matchId,
                orderGid: invoiceRow.orderId,
                shopifyPushSucceeded: true,
                staleReclaim: true,
                shopifyAlreadyPaid: true,
              });
            }

            return { invoicePaid: true, isPartial: false, alreadyFinalized: false };
          } else {
            // Partial payment - reduce outstanding but don't mark paid
            await tx`
              UPDATE "Invoice"
              SET outstanding = ${Number(newOutstanding) / 100}, "updatedAt" = NOW()
              WHERE id = ${invoiceRow.id}
                AND "shopId" = ${shopId}
            `;

            await tx`
              UPDATE "Match"
              SET state = 'pushed', "updatedAt" = NOW()
              WHERE id = ${matchId}
                AND "shopId" = ${shopId}
            `;

            await writeAuditEvent(tx, shopId, actor, "match.applied", {
              matchId,
              invoiceId: invoiceRow.id,
              paymentId: matchRow.paymentId,
              amountPaise: reduction.toString(),
              previousOutstandingPaise: currentOutstanding.toString(),
              newOutstandingPaise: newOutstanding.toString(),
              staleReclaim: true,
              shopifyAlreadyPaid: true,
            });

            return { invoicePaid: false, isPartial: true, alreadyFinalized: false };
          }
        });

        await safeEnqueueRecompute(sql, invoiceRow.id);

        // Handle unmatched case from stale recovery (invoice no longer open)
        if (result.wasUnmatched) {
          return {
            success: false,
            invoicePaid: result.invoicePaid,
            shopifyPushSucceeded: false,
            reasonCode: "INVOICE_NOT_OPEN",
          };
        }

        // Successful local finalization - we verified Shopify was already paid,
        // but we didn't push ourselves, so shopifyPushSucceeded is false
        return {
          success: true,
          invoicePaid: result.invoicePaid,
          shopifyPushSucceeded: false,
          reasonCode: result.isPartial
            ? "STALE_RECLAIM_SHOPIFY_ALREADY_PAID_PARTIAL"
            : "STALE_RECLAIM_SHOPIFY_ALREADY_PAID",
        };
      } catch (error) {
        return {
          success: false,
          invoicePaid: false,
          shopifyPushSucceeded: false,
          error: `retryable:${toErrorCode(error)}`,
        };
      }
    }
  }

  // Shopify not yet paid - need to determine partial vs full from LOCKED outstanding
  // then either finalize locally (partial) or call Shopify (full)
  const matchAmountPaise = BigInt(matchRow.amountPaise);

  // First, lock invoice to determine partial vs full and get accurate outstanding
  try {
    const decisionResult = await sql.begin(async (tx) => {
      const [lockedInvoice] = await tx<{ outstandingPaise: string; status: string }[]>`
        SELECT
          (ROUND(outstanding * 100))::text AS "outstandingPaise",
          status
        FROM "Invoice"
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!lockedInvoice) {
        return { error: "Invoice not found during stale reclaim" };
      }

      // Re-check status after locking
      if (lockedInvoice.status !== "open") {
        // Invoice no longer open - use proper stale handling
        const staleResult = await handleStaleInvoiceNotOpen(
          tx,
          shopId,
          matchId,
          matchRow,
          lockedInvoice.status,
          actor
        );
        return {
          alreadyFinalized: true,
          invoicePaid: staleResult.invoicePaid,
          wasUnmatched: staleResult.action === "unmatched",
        };
      }

      const currentOutstanding = BigInt(lockedInvoice.outstandingPaise);
      const reduction = matchAmountPaise > currentOutstanding ? currentOutstanding : matchAmountPaise;
      const newOutstanding = currentOutstanding - reduction;
      const isFullPayment = newOutstanding === 0n;

      if (!isFullPayment) {
        // PARTIAL: finalize locally in this transaction
        await tx`
          UPDATE "Invoice"
          SET outstanding = ${Number(newOutstanding) / 100}, "updatedAt" = NOW()
          WHERE id = ${invoiceRow.id}
            AND "shopId" = ${shopId}
        `;

        await tx`
          UPDATE "Match"
          SET state = 'pushed', "updatedAt" = NOW()
          WHERE id = ${matchId}
            AND "shopId" = ${shopId}
        `;

        await writeAuditEvent(tx, shopId, actor, "match.applied", {
          matchId,
          invoiceId: invoiceRow.id,
          paymentId: matchRow.paymentId,
          amountPaise: reduction.toString(),
          previousOutstandingPaise: currentOutstanding.toString(),
          newOutstandingPaise: newOutstanding.toString(),
          staleReclaim: true,
        });

        return { isPartial: true, currentOutstanding: currentOutstanding.toString() };
      }

      // FULL: need Shopify call - return outstanding for later use
      return { isPartial: false, currentOutstanding: currentOutstanding.toString() };
    });

    if ("error" in decisionResult) {
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: decisionResult.error,
      };
    }

    if (decisionResult.alreadyFinalized) {
      await safeEnqueueRecompute(sql, invoiceRow.id);

      // Handle unmatched case from stale recovery
      if (decisionResult.wasUnmatched) {
        return {
          success: false,
          invoicePaid: decisionResult.invoicePaid ?? false,
          shopifyPushSucceeded: false,
          reasonCode: "INVOICE_NOT_OPEN",
        };
      }

      // Invoice was paid (no sibling), finalized with STALE_FINALIZED_EXTERNALLY_PAID
      return {
        success: true,
        invoicePaid: decisionResult.invoicePaid ?? false,
        shopifyPushSucceeded: true,
        reasonCode: "STALE_RECLAIM_ALREADY_FINALIZED",
      };
    }

    if (decisionResult.isPartial) {
      await safeEnqueueRecompute(sql, invoiceRow.id);
      return {
        success: true,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        reasonCode: "STALE_RECLAIM_PARTIAL",
      };
    }

    // FULL payment path: call Shopify outside transaction
    let pushSucceeded = false;
    let reasonCode: string | undefined;

    if (invoiceRow.orderId) {
      const shopifyResult = await callOrderMarkAsPaid(
        invoiceRow.shopDomain,
        invoiceRow.orderId
      );

      if (shopifyResult.success) {
        pushSucceeded = true;
      } else if (shopifyResult.alreadyPaid) {
        pushSucceeded = true;
        reasonCode = "STALE_RECLAIM_ALREADY_PAID_IN_SHOPIFY";
      } else {
        // Shopify call failed - leave in 'pushing' for another retry
        return {
          success: false,
          invoicePaid: false,
          shopifyPushSucceeded: false,
          error: shopifyResult.retryable ? "retryable:shopify_api_error" : "permanent:shopify_api_error",
          retryable: shopifyResult.retryable,
        };
      }
    } else {
      pushSucceeded = true;
    }

    // Finalize: lock invoice again, re-check status, then mark paid
    // INVARIANT: After a successful Shopify push, never unmatch unless a sibling's
    // applied audit or a cancellation explains it.
    const finalizeResult = await sql.begin(async (tx) => {
      const [lockedInvoice] = await tx<{ outstandingPaise: string; status: string }[]>`
        SELECT
          (ROUND(outstanding * 100))::text AS "outstandingPaise",
          status
        FROM "Invoice"
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!lockedInvoice) {
        throw new Error("Invoice not found during stale reclaim finalize");
      }

      // Use outstanding from THIS transaction's lock
      const finalizeOutstandingPaise = lockedInvoice.outstandingPaise;

      // Re-check status after locking
      if (lockedInvoice.status !== "open") {
        // Invoice no longer open after our successful Shopify push.
        // Mirror finalizeFullApply's backstop: only unmatch if sibling paid or cancelled.
        if (lockedInvoice.status === "paid") {
          // Check if a sibling's match.applied zeroed it (explains why it's paid)
          const pushClaimed = await getPushClaimedAudit(tx, shopId, matchId);
          const siblingPaid = pushClaimed
            ? await didSiblingPayInvoice(tx, shopId, matchRow.invoiceId, matchId, pushClaimed.at)
            : false;

          if (siblingPaid) {
            // Sibling paid it - unmatch this match
            await tx`
              UPDATE "Match"
              SET state = 'unmatched', "updatedAt" = NOW()
              WHERE id = ${matchId} AND "shopId" = ${shopId}
            `;
            await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
              matchId,
              invoiceId: matchRow.invoiceId,
              paymentId: matchRow.paymentId,
              reason: "INVOICE_NOT_OPEN",
              appliedPaise: "0",
              invoiceStatus: "paid",
              siblingPaid: true,
            });
            await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);
            return { wasUnmatched: true, invoicePaid: true };
          }

          // No sibling paid it - our push reached Shopify and webhook marked it paid.
          // Finalize with match.applied to stay consistent with Shopify state.
          // Use push_claimed amounts (not current locked outstanding which is 0).
          const outstandingAtClaim = pushClaimed?.outstandingAtClaimPaise ?? matchRow.amountPaise;
          const matchAmount = BigInt(matchRow.amountPaise);
          const claimAmount = BigInt(outstandingAtClaim);
          const appliedAmount = matchAmount > claimAmount ? claimAmount : matchAmount;

          await tx`
            UPDATE "Invoice"
            SET outstanding = 0, "updatedAt" = NOW()
            WHERE id = ${invoiceRow.id} AND "shopId" = ${shopId}
          `;
          await tx`
            UPDATE "Match"
            SET state = 'pushed', "updatedAt" = NOW()
            WHERE id = ${matchId} AND "shopId" = ${shopId}
          `;
          await writeAuditEvent(tx, shopId, actor, "match.applied", {
            matchId,
            invoiceId: invoiceRow.id,
            paymentId: matchRow.paymentId,
            amountPaise: appliedAmount.toString(),
            previousOutstandingPaise: outstandingAtClaim,
            newOutstandingPaise: "0",
            reasonCode: "STALE_FINALIZED_EXTERNALLY_PAID",
            staleReclaim: true,
            backstopTriggered: true,
          });
          // Update Payment status to 'matched'
          await updatePaymentStatusAfterApply(tx, shopId, matchRow.paymentId);
          return { wasUnmatched: false, invoicePaid: true };
        }

        // Invoice is cancelled - unmatch (cancellation explains it)
        await tx`
          UPDATE "Match"
          SET state = 'unmatched', "updatedAt" = NOW()
          WHERE id = ${matchId} AND "shopId" = ${shopId}
        `;
        await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
          matchId,
          invoiceId: matchRow.invoiceId,
          paymentId: matchRow.paymentId,
          reason: "INVOICE_NOT_OPEN",
          appliedPaise: "0",
          invoiceStatus: lockedInvoice.status,
        });
        await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);
        return { wasUnmatched: true, invoicePaid: false };
      }

      // Invoice is still open - normal finalize
      // Conditionally mark invoice as paid (only if still open, atomic with check)
      const [flippedInvoice] = await tx<{ id: string }[]>`
        UPDATE "Invoice"
        SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
          AND status = 'open'
        RETURNING id
      `;

      await tx`
        UPDATE "Match"
        SET state = 'pushed', "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
      `;

      await writeAuditEvent(tx, shopId, actor, "match.applied", {
        matchId,
        invoiceId: invoiceRow.id,
        paymentId: matchRow.paymentId,
        amountPaise: finalizeOutstandingPaise,
        previousOutstandingPaise: finalizeOutstandingPaise,
        newOutstandingPaise: "0",
        reasonCode,
        staleReclaim: true,
      });

      // Only write invoice.paid if THIS transaction flipped open→paid
      if (flippedInvoice) {
        await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
          invoiceId: invoiceRow.id,
          matchId,
          orderGid: invoiceRow.orderId,
          shopifyPushSucceeded: pushSucceeded,
          reasonCode,
          staleReclaim: true,
        });
      }

      return { wasUnmatched: false, invoicePaid: true };
    });

    // Handle case where match was unmatched during finalize (invoice no longer open)
    if (finalizeResult.wasUnmatched) {
      await safeEnqueueRecompute(sql, invoiceRow.id);
      return {
        success: false,
        invoicePaid: finalizeResult.invoicePaid,
        shopifyPushSucceeded: false,
        reasonCode: "INVOICE_NOT_OPEN",
      };
    }

    await safeEnqueueRecompute(sql, invoiceRow.id);

    return {
      success: true,
      invoicePaid: true,
      shopifyPushSucceeded: pushSucceeded,
      reasonCode: reasonCode ?? "STALE_RECLAIM_FULL",
    };
  } catch (error) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: `retryable:${toErrorCode(error)}`,
    };
  }
}

/**
 * TX1: Lock invoice, claim match, compute reduction under lock.
 *
 * This addresses Issue #2: partial vs full must be decided UNDER THE LOCK.
 * Returns previousOutstandingPaise for TX2's race condition check.
 */
async function claimMatchAndDecide(
  sql: Sql,
  shopId: string,
  matchId: string,
  matchRow: { id: string; shopId: string; paymentId: string; invoiceId: string; amountPaise: string },
  invoiceRow: { id: string },
  actor: string
): Promise<{
  success: boolean;
  isPartial?: boolean;
  appliedAmountPaise?: string;
  previousOutstandingPaise?: string;
  error?: string;
  reasonCode?: string;
}> {
  try {
    return await sql.begin(async (tx) => {
      // Lock invoice FIRST (consistent lock order)
      // IDOR protection: filter by shopId
      const [lockedInvoice] = await tx<{
        outstandingPaise: string;
        status: string;
      }[]>`
        SELECT
          (ROUND(outstanding * 100))::text AS "outstandingPaise",
          status
        FROM "Invoice"
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!lockedInvoice) {
        return { success: false, error: "Invoice not found" };
      }

      if (lockedInvoice.status !== "open") {
        return {
          success: false,
          error: `Invoice status is '${lockedInvoice.status}', expected 'open'`,
          reasonCode: "INVOICE_NOT_OPEN",
        };
      }

      // RACE CHECK: Refuse apply while another match on this invoice has a FRESH in-flight push
      // (state='pushing' means TX1 claimed it but TX2 hasn't finalized yet)
      // Siblings older than 5 min are considered stale and don't block - they'll be recovered
      const [inFlightPush] = await tx<{ id: string; updatedAt: Date }[]>`
        SELECT id, "updatedAt" FROM "Match"
        WHERE "invoiceId" = ${invoiceRow.id}
          AND "shopId" = ${shopId}
          AND id != ${matchId}
          AND state = 'pushing'
          AND "updatedAt" >= NOW() - interval '5 minutes'
        LIMIT 1
      `;

      if (inFlightPush) {
        return {
          success: false,
          error: "Another payment is being applied to this invoice",
          reasonCode: "PUSH_IN_PROGRESS",
        };
      }

      // Claim the match with conditional UPDATE - transition to 'pushing' (in-flight)
      // IDOR protection: filter by shopId
      const [transitioned] = await tx<{ id: string }[]>`
        UPDATE "Match"
        SET state = 'pushing', "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
        RETURNING id
      `;

      if (!transitioned) {
        // Check current state for idempotency
        const [currentMatch] = await tx<{ state: string }[]>`
          SELECT state FROM "Match" WHERE id = ${matchId} AND "shopId" = ${shopId}
        `;
        if (currentMatch?.state === "pushed") {
          return { success: true, reasonCode: "ALREADY_APPLIED", isPartial: false };
        }
        if (currentMatch?.state === "pushing") {
          // In-flight push - refuse with retryable error
          return { success: false, error: "Push in progress", reasonCode: "PUSH_IN_PROGRESS" };
        }
        return { success: false, error: `Match state is '${currentMatch?.state ?? "unknown"}'` };
      }

      // Calculate reduction from LOCKED outstanding
      const matchAmountPaise = BigInt(matchRow.amountPaise);
      const invoiceOutstandingPaise = BigInt(lockedInvoice.outstandingPaise);
      const reductionPaise = matchAmountPaise > invoiceOutstandingPaise
        ? invoiceOutstandingPaise
        : matchAmountPaise;
      const newOutstandingPaise = invoiceOutstandingPaise - reductionPaise;
      const isFullPayment = newOutstandingPaise === 0n;

      if (!isFullPayment) {
        // PARTIAL PAYMENT: complete in same transaction (no Shopify call needed)
        if (reductionPaise < 0n) {
          throw new Error("Match amount exceeds outstanding");
        }

        await tx`
          UPDATE "Invoice"
          SET outstanding = ${Number(newOutstandingPaise) / 100}, "updatedAt" = NOW()
          WHERE id = ${invoiceRow.id}
            AND "shopId" = ${shopId}
        `;

        // Finalize state to 'pushed' (partial applies complete in same TX)
        await tx`
          UPDATE "Match"
          SET state = 'pushed', "updatedAt" = NOW()
          WHERE id = ${matchId}
            AND "shopId" = ${shopId}
        `;

        // Write audit event for partial apply
        await writeAuditEvent(tx, shopId, actor, "match.applied", {
          matchId,
          invoiceId: invoiceRow.id,
          paymentId: matchRow.paymentId,
          amountPaise: reductionPaise.toString(),
          previousOutstandingPaise: invoiceOutstandingPaise.toString(),
          newOutstandingPaise: newOutstandingPaise.toString(),
        });

        return {
          success: true,
          isPartial: true,
          appliedAmountPaise: reductionPaise.toString(),
          previousOutstandingPaise: invoiceOutstandingPaise.toString(),
        };
      }

      // FULL PAYMENT: just claim, don't update invoice yet (need Shopify call)
      // Write push_claimed audit event to record claim time and outstanding
      // This is used by stale recovery to determine if a sibling paid the invoice
      await writeAuditEvent(tx, shopId, actor, "match.push_claimed", {
        matchId,
        invoiceId: invoiceRow.id,
        paymentId: matchRow.paymentId,
        outstandingAtClaimPaise: invoiceOutstandingPaise.toString(),
      });

      // Return previousOutstandingPaise for TX2's race condition check
      return {
        success: true,
        isPartial: false,
        appliedAmountPaise: reductionPaise.toString(),
        previousOutstandingPaise: invoiceOutstandingPaise.toString(),
      };
    });
  } catch (error) {
    return {
      success: false,
      error: `retryable:${toErrorCode(error)}`,
    };
  }
}

/**
 * Release a match claim if Shopify call fails.
 * IDOR protection: filter by shopId
 */
async function releaseMatchClaim(sql: Sql, shopId: string, matchId: string): Promise<void> {
  try {
    await sql`
      UPDATE "Match"
      SET state = 'confirmed', "updatedAt" = NOW()
      WHERE id = ${matchId}
        AND "shopId" = ${shopId}
        AND state = 'pushing'
    `;
  } catch (error) {
    safeLog("error", "apply_release_claim_failed", {
      matchId,
      err: toErrorCode(error),
    });
  }
}

/**
 * TX2: Finalize full payment - mark invoice as paid, write audit events.
 *
 * RACE CONDITION CHECK: Re-verify under FOR UPDATE that invoice is still:
 * - status = 'open'
 * - outstanding matches what TX1 saw
 * If not (e.g. a partial landed during Shopify call), release the claim and fail gracefully.
 */
async function finalizeFullApply(
  sql: Sql,
  shopId: string,
  matchId: string,
  matchRow: { id: string; shopId: string; paymentId: string; invoiceId: string; amountPaise: string },
  invoiceRow: { id: string; orderId: string | null },
  actor: string,
  pushSucceeded: boolean,
  reasonCode: string | undefined,
  appliedAmountPaise: string,
  expectedOutstandingPaise: string
): Promise<{ success: boolean; error?: string; raceDetected?: boolean }> {
  try {
    const result = await sql.begin(async (tx) => {
      // Lock invoice - IDOR protection: filter by shopId
      const [lockedInvoice] = await tx<{ outstandingPaise: string; status: string }[]>`
        SELECT
          (ROUND(outstanding * 100))::text AS "outstandingPaise",
          status
        FROM "Invoice"
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!lockedInvoice) {
        throw new Error("Invoice not found");
      }

      // BACKSTOP CHECK: Verify invoice state hasn't changed during Shopify call
      // With TX1's PUSH_IN_PROGRESS guard, this should never trip. If it does after
      // Shopify succeeded, finalize locally to match Shopify state rather than reverting.
      if (lockedInvoice.status !== "open" || lockedInvoice.outstandingPaise !== expectedOutstandingPaise) {
        // Log this unexpected condition - indicates the TX1 guard was somehow bypassed
        safeLog("error", "apply_backstop_triggered", {
          matchId,
          invoiceId: invoiceRow.id,
          status: lockedInvoice.status,
          success: pushSucceeded,
        });

        if (pushSucceeded) {
          // Shopify already paid - finalize locally to match Shopify state
          // Don't revert the match, instead force-finalize to stay consistent with Shopify
          // Use conditional UPDATE to detect if THIS transaction actually flips open→paid
          const [flippedInvoice] = await tx<{ id: string }[]>`
            UPDATE "Invoice"
            SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
            WHERE id = ${invoiceRow.id}
              AND "shopId" = ${shopId}
              AND status = 'open'
            RETURNING id
          `;

          // If invoice wasn't open, force outstanding=0 to match Shopify (status might be 'paid' already)
          if (!flippedInvoice) {
            await tx`
              UPDATE "Invoice"
              SET outstanding = 0, "updatedAt" = NOW()
              WHERE id = ${invoiceRow.id}
                AND "shopId" = ${shopId}
            `;
          }

          // Finalize match state to 'pushed'
          await tx`
            UPDATE "Match"
            SET state = 'pushed', "updatedAt" = NOW()
            WHERE id = ${matchId}
              AND "shopId" = ${shopId}
          `;

          // Write audit events with backstop flag
          // Use expectedOutstandingPaise from TX1 (not lockedInvoice.outstandingPaise which may be 0)
          await writeAuditEvent(tx, shopId, actor, "match.applied", {
            matchId,
            invoiceId: invoiceRow.id,
            paymentId: matchRow.paymentId,
            amountPaise: appliedAmountPaise,
            previousOutstandingPaise: expectedOutstandingPaise,
            newOutstandingPaise: "0",
            reasonCode,
            backstopTriggered: true,
          });

          // Only write invoice.paid if THIS transaction flipped open→paid
          if (flippedInvoice) {
            await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
              invoiceId: invoiceRow.id,
              matchId,
              orderGid: invoiceRow.orderId,
              shopifyPushSucceeded: pushSucceeded,
              reasonCode,
              backstopTriggered: true,
            });
          }

          return { success: true, backstopTriggered: true };
        }

        // Shopify didn't succeed - safe to release claim back to 'confirmed'
        await tx`
          UPDATE "Match"
          SET state = 'confirmed', "updatedAt" = NOW()
          WHERE id = ${matchId}
            AND "shopId" = ${shopId}
            AND state = 'pushing'
        `;
        return {
          raceDetected: true,
          error: `Invoice state changed during push (status=${lockedInvoice.status}, outstanding=${lockedInvoice.outstandingPaise})`,
        };
      }

      const previousOutstanding = lockedInvoice.outstandingPaise;

      // Conditionally mark invoice as paid (atomic check-and-update)
      const [flippedInvoice] = await tx<{ id: string }[]>`
        UPDATE "Invoice"
        SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
          AND status = 'open'
        RETURNING id
      `;

      // Finalize match state to 'pushed'
      await tx`
        UPDATE "Match"
        SET state = 'pushed', "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
      `;

      // Write match.applied audit event
      await writeAuditEvent(tx, shopId, actor, "match.applied", {
        matchId,
        invoiceId: invoiceRow.id,
        paymentId: matchRow.paymentId,
        amountPaise: appliedAmountPaise,
        previousOutstandingPaise: previousOutstanding,
        newOutstandingPaise: "0",
        reasonCode,
      });

      // Only write invoice.paid if THIS transaction flipped open→paid
      if (flippedInvoice) {
        await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
          invoiceId: invoiceRow.id,
          matchId,
          orderGid: invoiceRow.orderId,
          shopifyPushSucceeded: pushSucceeded,
          reasonCode,
        });
      }

      return { success: true };
    });

    if (result.raceDetected) {
      return { success: false, error: result.error, raceDetected: true };
    }

    return { success: true };
  } catch (error) {
    safeLog("error", "apply_tx2_failed", {
      matchId,
      invoiceId: invoiceRow.id,
      err: toErrorCode(error),
    });
    return {
      success: false,
      error: `Database error: ${toErrorCode(error)}`,
    };
  }
}

/**
 * Unmatch a confirmed or pushed match.
 *
 * SECURITY: shopId must come from the authenticated session (route), not from user input.
 * All queries include AND "shopId" = ... to prevent IDOR attacks.
 *
 * - Confirmed matches: simply revert to 'unmatched'
 * - Pushed matches (partial): restore the EXACT applied amount to invoice outstanding (Issue #3)
 * - Pushed matches (full/paid): blocked with clear message
 *
 * Also updates Payment.status on the confirmed path (Issue #3).
 */
export async function unmatchMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  actor: string
): Promise<UnmatchResult> {
  try {
    const result = await sql.begin(async (tx) => {
      // Lock and fetch match - IDOR protection: filter by shopId
      const [matchRow] = await tx<{
        id: string;
        shopId: string;
        paymentId: string;
        invoiceId: string;
        amountPaise: string;
        state: string;
      }[]>`
        SELECT
          id,
          "shopId" AS "shopId",
          "paymentId" AS "paymentId",
          "invoiceId" AS "invoiceId",
          (ROUND(amount * 100))::text AS "amountPaise",
          state
        FROM "Match"
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!matchRow) {
        return { success: false, error: "Match not found" };
      }

      // Already unmatched or suggested - idempotent success
      if (matchRow.state === "unmatched" || matchRow.state === "suggested") {
        return { success: true };
      }

      // Refuse unmatch while push is in flight
      if (matchRow.state === "pushing") {
        return {
          success: false,
          error: "Cannot unmatch: push is in progress",
          alreadyPushed: false,
        };
      }

      if (matchRow.state === "pushed") {
        // Pushed match - need to check invoice status and restore outstanding
        // IDOR protection: filter by shopId
        const [invoiceRow] = await tx<{
          outstandingPaise: string;
          status: string;
        }[]>`
          SELECT
            (ROUND(outstanding * 100))::text AS "outstandingPaise",
            status
          FROM "Invoice"
          WHERE id = ${matchRow.invoiceId}
            AND "shopId" = ${shopId}
          FOR UPDATE
        `;

        if (!invoiceRow) {
          return { success: false, error: "Invoice not found" };
        }

        // Block unmatch if invoice is already paid in Shopify,
        // UNLESS the match was finalized via STALE_FINALIZED_EXTERNALLY_PAID
        // (our push may have paid it, but we didn't actually apply any amount locally)
        if (invoiceRow.status === "paid") {
          const isStaleExternal = await isStaleExternallyPaidMatch(tx, shopId, matchId);

          if (isStaleExternal) {
            // Allow unmatch - this match was finalized externally and didn't apply locally
            const [transitioned] = await tx<{ id: string }[]>`
              UPDATE "Match"
              SET state = 'unmatched', "updatedAt" = NOW()
              WHERE id = ${matchId}
                AND "shopId" = ${shopId}
                AND state = 'pushed'
              RETURNING id
            `;

            if (transitioned) {
              // Don't restore outstanding - nothing was applied locally
              await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
                matchId: matchRow.id,
                invoiceId: matchRow.invoiceId,
                paymentId: matchRow.paymentId,
                reason: "STALE_EXTERNAL_PAID_RELEASED",
                restoredPaise: "0",
                previousState: "pushed",
              });

              // Free up the payment
              await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);
            }

            return { success: true, invoiceId: matchRow.invoiceId };
          }

          return {
            success: false,
            error: "Cannot unmatch: order already marked as paid in Shopify",
            alreadyPushed: true,
          };
        }

        // P1: Find the actual applied amount from the audit trail.
        // Never restore Match.amount without an applied audit.
        const appliedAmount = await getAppliedAmountFromAudit(
          tx,
          shopId,
          matchId
        );

        if (appliedAmount === null) {
          // No audit found - cannot determine how much was actually applied.
          // This is an inconsistent state; refuse the unmatch.
          return {
            success: false,
            error: "Cannot unmatch: no applied audit found for this match",
            alreadyPushed: false,
          };
        }

        const restoreAmount = appliedAmount;

        // Transition to unmatched - IDOR protection: filter by shopId
        const [transitioned] = await tx<{ id: string }[]>`
          UPDATE "Match"
          SET state = 'unmatched', "updatedAt" = NOW()
          WHERE id = ${matchId}
            AND "shopId" = ${shopId}
            AND state = 'pushed'
          RETURNING id
        `;

        if (transitioned) {
          // Restore the exact applied amount to outstanding
          const currentOutstanding = BigInt(invoiceRow.outstandingPaise);
          const newOutstanding = currentOutstanding + restoreAmount;

          // IDOR protection: filter by shopId
          await tx`
            UPDATE "Invoice"
            SET outstanding = ${Number(newOutstanding) / 100}, "updatedAt" = NOW()
            WHERE id = ${matchRow.invoiceId}
              AND "shopId" = ${shopId}
          `;

          // Write audit event
          await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
            matchId: matchRow.id,
            invoiceId: matchRow.invoiceId,
            paymentId: matchRow.paymentId,
            restoredAmountPaise: restoreAmount.toString(),
            previousState: "pushed",
          });

          // Update Payment.status (Issue #3)
          await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);

          return { success: true, invoiceId: matchRow.invoiceId };
        }

        return { success: true };
      }

      // Confirmed state - simple unmatch - IDOR protection: filter by shopId
      const [transitioned] = await tx<{ id: string }[]>`
        UPDATE "Match"
        SET state = 'unmatched', "updatedAt" = NOW()
        WHERE id = ${matchId}
          AND "shopId" = ${shopId}
          AND state = 'confirmed'
        RETURNING id
      `;

      if (transitioned) {
        // Write audit event
        await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
          matchId: matchRow.id,
          invoiceId: matchRow.invoiceId,
          paymentId: matchRow.paymentId,
          amountPaise: matchRow.amountPaise,
          previousState: "confirmed",
        });

        // Update Payment.status (Issue #3)
        await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);
      }

      return { success: true };
    });

    // Enqueue credit status recompute if invoice was affected
    if (result.success && "invoiceId" in result && result.invoiceId) {
      await safeEnqueueRecompute(sql, result.invoiceId);
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: `retryable:${toErrorCode(error)}`,
    };
  }
}

/**
 * Get the actual applied amount from the audit trail.
 * This ensures we restore exactly what was taken, not the original match amount
 * which may have been capped (Issue #3).
 */
async function getAppliedAmountFromAudit(
  sql: Sql,
  shopId: string,
  matchId: string
): Promise<bigint | null> {
  const [auditRow] = await sql<{ data: { amountPaise?: string } }[]>`
    SELECT data
    FROM "AuditEvent"
    WHERE "shopId" = ${shopId}
      AND type = 'match.applied'
      AND data->>'matchId' = ${matchId}
    ORDER BY at DESC
    LIMIT 1
  `;

  if (auditRow?.data?.amountPaise) {
    return BigInt(auditRow.data.amountPaise);
  }

  return null;
}

/**
 * Check if the latest match.applied audit has reasonCode STALE_FINALIZED_EXTERNALLY_PAID.
 * Such matches can be unmatched even if the invoice is paid.
 */
async function isStaleExternallyPaidMatch(
  sql: Sql,
  shopId: string,
  matchId: string
): Promise<boolean> {
  const [auditRow] = await sql<{ data: { reasonCode?: string } }[]>`
    SELECT data
    FROM "AuditEvent"
    WHERE "shopId" = ${shopId}
      AND type = 'match.applied'
      AND data->>'matchId' = ${matchId}
    ORDER BY at DESC
    LIMIT 1
  `;

  return auditRow?.data?.reasonCode === "STALE_FINALIZED_EXTERNALLY_PAID";
}

/**
 * Get the push_claimed audit event for a match.
 * Returns null if no push_claimed exists (shouldn't happen after the fix).
 */
async function getPushClaimedAudit(
  sql: Sql,
  shopId: string,
  matchId: string
): Promise<{ at: Date; outstandingAtClaimPaise: string } | null> {
  const [auditRow] = await sql<{ at: Date; data: { outstandingAtClaimPaise?: string } }[]>`
    SELECT at, data
    FROM "AuditEvent"
    WHERE "shopId" = ${shopId}
      AND type = 'match.push_claimed'
      AND data->>'matchId' = ${matchId}
    ORDER BY at DESC
    LIMIT 1
  `;

  if (auditRow?.data?.outstandingAtClaimPaise) {
    return {
      at: auditRow.at,
      outstandingAtClaimPaise: auditRow.data.outstandingAtClaimPaise,
    };
  }

  return null;
}

/**
 * Check if another match on this invoice has a match.applied audit created
 * AFTER the given timestamp and zeroed the invoice (newOutstandingPaise = '0').
 */
async function didSiblingPayInvoice(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  matchId: string,
  afterTime: Date
): Promise<boolean> {
  const [siblingApplied] = await sql<{ matchId: string }[]>`
    SELECT data->>'matchId' AS "matchId"
    FROM "AuditEvent"
    WHERE "shopId" = ${shopId}
      AND type = 'match.applied'
      AND data->>'invoiceId' = ${invoiceId}
      AND data->>'matchId' != ${matchId}
      AND data->>'newOutstandingPaise' = '0'
      AND at > ${afterTime}
    LIMIT 1
  `;

  return siblingApplied !== undefined;
}

/**
 * Handle stale 'pushing' match when invoice is not open.
 * Applies the following rules:
 * 1. If no push_claimed exists (legacy/bug) → unmatch with INVOICE_NOT_OPEN
 * 2. If a sibling paid the invoice after our push_claimed → unmatch with INVOICE_NOT_OPEN
 * 3. If invoice is 'paid' with no sibling → pushed WITH match.applied (STALE_FINALIZED_EXTERNALLY_PAID)
 * 4. If invoice is 'cancelled' or other non-open → unmatch with INVOICE_NOT_OPEN
 *
 * INVARIANT: Every state='pushed' must have a match.applied audit in the same TX.
 */
async function handleStaleInvoiceNotOpen(
  tx: Sql,
  shopId: string,
  matchId: string,
  matchRow: { id: string; paymentId: string; invoiceId: string; amountPaise: string },
  invoiceStatus: string,
  actor: string
): Promise<{ action: "unmatched" | "pushed"; invoicePaid: boolean }> {
  // Get the push_claimed audit to determine when this match was claimed
  const pushClaimed = await getPushClaimedAudit(tx, shopId, matchId);

  if (!pushClaimed) {
    // No push_claimed record - this is legacy data or a bug. Unmatch it.
    await tx`
      UPDATE "Match"
      SET state = 'unmatched', "updatedAt" = NOW()
      WHERE id = ${matchId}
        AND "shopId" = ${shopId}
    `;

    await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
      matchId,
      invoiceId: matchRow.invoiceId,
      paymentId: matchRow.paymentId,
      reason: "INVOICE_NOT_OPEN",
      appliedPaise: "0",
      invoiceStatus,
    });

    await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);

    return { action: "unmatched", invoicePaid: invoiceStatus === "paid" };
  }

  // Check if a sibling match paid the invoice after our claim
  const siblingPaid = await didSiblingPayInvoice(
    tx,
    shopId,
    matchRow.invoiceId,
    matchId,
    pushClaimed.at
  );

  if (siblingPaid) {
    // A sibling paid the invoice after our claim. Unmatch this match.
    await tx`
      UPDATE "Match"
      SET state = 'unmatched', "updatedAt" = NOW()
      WHERE id = ${matchId}
        AND "shopId" = ${shopId}
    `;

    await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
      matchId,
      invoiceId: matchRow.invoiceId,
      paymentId: matchRow.paymentId,
      reason: "INVOICE_NOT_OPEN",
      appliedPaise: "0",
      invoiceStatus,
    });

    await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);

    return { action: "unmatched", invoicePaid: invoiceStatus === "paid" };
  }

  // No sibling paid it. If invoice is 'paid', our push likely reached Shopify
  // and the ORDERS_PAID webhook marked it locally. Finalize with audit.
  if (invoiceStatus === "paid") {
    const outstandingAtClaim = BigInt(pushClaimed.outstandingAtClaimPaise);
    const matchAmount = BigInt(matchRow.amountPaise);
    const appliedAmount = matchAmount > outstandingAtClaim ? outstandingAtClaim : matchAmount;

    await tx`
      UPDATE "Match"
      SET state = 'pushed', "updatedAt" = NOW()
      WHERE id = ${matchId}
        AND "shopId" = ${shopId}
    `;

    await writeAuditEvent(tx, shopId, actor, "match.applied", {
      matchId,
      invoiceId: matchRow.invoiceId,
      paymentId: matchRow.paymentId,
      amountPaise: appliedAmount.toString(),
      reasonCode: "STALE_FINALIZED_EXTERNALLY_PAID",
      staleReclaim: true,
    });

    // Update Payment status to 'matched'
    await updatePaymentStatusAfterApply(tx, shopId, matchRow.paymentId);

    return { action: "pushed", invoicePaid: true };
  }

  // Invoice is cancelled or other non-open, non-paid status. Unmatch.
  await tx`
    UPDATE "Match"
    SET state = 'unmatched', "updatedAt" = NOW()
    WHERE id = ${matchId}
      AND "shopId" = ${shopId}
  `;

  await writeAuditEvent(tx, shopId, actor, "match.unmatched", {
    matchId,
    invoiceId: matchRow.invoiceId,
    paymentId: matchRow.paymentId,
    reason: "INVOICE_NOT_OPEN",
    appliedPaise: "0",
    invoiceStatus,
  });

  await updatePaymentStatusAfterUnmatch(tx, shopId, matchRow.paymentId);

  return { action: "unmatched", invoicePaid: false };
}

/**
 * Update Payment.status after applying (pushing) a match.
 * Sets to 'matched' when the payment has a pushed match.
 * IDOR protection: filter by shopId
 */
async function updatePaymentStatusAfterApply(
  sql: Sql,
  shopId: string,
  paymentId: string
): Promise<void> {
  await sql`
    UPDATE "Payment"
    SET status = 'matched', "updatedAt" = NOW()
    WHERE id = ${paymentId}
      AND "shopId" = ${shopId}
  `;
}

/**
 * Update Payment.status after unmatching.
 * Sets to 'partial' if there are remaining suggested matches, otherwise 'unmatched'.
 * IDOR protection: filter by shopId
 */
async function updatePaymentStatusAfterUnmatch(
  sql: Sql,
  shopId: string,
  paymentId: string
): Promise<void> {
  // Check if there are any remaining confirmed/pushing/pushed matches
  const [activeCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Match"
    WHERE "paymentId" = ${paymentId}
      AND "shopId" = ${shopId}
      AND state IN ('confirmed', 'pushing', 'pushed')
  `;

  if (parseInt(activeCount?.count ?? "0", 10) === 0) {
    // No active matches - check for suggested
    const [suggestedCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "Match"
      WHERE "paymentId" = ${paymentId}
        AND "shopId" = ${shopId}
        AND state = 'suggested'
    `;

    const hassuggested = parseInt(suggestedCount?.count ?? "0", 10) > 0;
    const newStatus = hassuggested ? "partial" : "unmatched";

    await sql`
      UPDATE "Payment"
      SET status = ${newStatus}, "updatedAt" = NOW()
      WHERE id = ${paymentId}
        AND "shopId" = ${shopId}
    `;
  }
}

/**
 * Alias for unmatchMatch - kept for backward compatibility.
 */
export const unmatchPushedMatch = unmatchMatch;

/**
 * Call Shopify orderMarkAsPaid mutation.
 *
 * Issue #5: Better already-paid detection - we verify by querying the order's
 * displayFinancialStatus instead of loose string matching on error messages.
 */
async function callOrderMarkAsPaid(
  shopDomain: string,
  orderGid: string
): Promise<{
  success: boolean;
  alreadyPaid?: boolean;
  error?: string;
  retryable?: boolean;
}> {
  interface OrderMarkAsPaidResponse {
    orderMarkAsPaid: {
      order: { id: string; displayFinancialStatus: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }

  const result: ShopifyClientResult<OrderMarkAsPaidResponse> =
    await shopifyGraphQLRequest(shopDomain, ORDER_MARK_AS_PAID_MUTATION, {
      input: { id: orderGid },
    });

  if (!result.success) {
    return {
      success: false,
      error: result.retryable ? "retryable:shopify_api_error" : "permanent:shopify_api_error",
      retryable: result.retryable,
    };
  }

  const data = result.data?.orderMarkAsPaid;
  if (!data) {
    return {
      success: false,
      error: "retryable:shopify_invalid_response",
      retryable: true,
    };
  }

  // Success case - order was marked as paid
  if (data.order && data.userErrors.length === 0) {
    return { success: true };
  }

  // UserErrors present - check if order is already paid
  if (data.userErrors.length > 0) {
    // Query the order to verify its actual status (Issue #5)
    const isAlreadyPaid = await verifyOrderIsPaid(shopDomain, orderGid);
    if (isAlreadyPaid) {
      return { success: false, alreadyPaid: true };
    }

    // Not already paid - return the actual error
    const errorMessage = data.userErrors.map((e) => e.message).join("; ");
    return {
      success: false,
      error: errorMessage,
      retryable: false,
    };
  }

  return { success: true };
}

/**
 * Verify if an order is already paid by querying its displayFinancialStatus.
 * This is more reliable than string-matching error messages (Issue #5).
 */
async function verifyOrderIsPaid(
  shopDomain: string,
  orderGid: string
): Promise<boolean> {
  interface OrderQueryResponse {
    order: {
      id: string;
      displayFinancialStatus: string;
    } | null;
  }

  const result: ShopifyClientResult<OrderQueryResponse> =
    await shopifyGraphQLRequest(shopDomain, ORDER_QUERY, { id: orderGid });

  if (!result.success || !result.data?.order) {
    return false;
  }

  return result.data.order.displayFinancialStatus === "PAID";
}

type AuditData = {
  matchId?: string;
  invoiceId?: string;
  paymentId?: string;
  amountPaise?: string;
  previousOutstandingPaise?: string;
  newOutstandingPaise?: string;
  restoredAmountPaise?: string;
  restoredPaise?: string;
  orderGid?: string | null;
  shopifyPushSucceeded?: boolean;
  reasonCode?: string;
  recoveredFromCrash?: boolean;
  backstopTriggered?: boolean;
  staleReclaim?: boolean;
  shopifyAlreadyPaid?: boolean;
  previousState?: string;
  reason?: string;
  invoiceStatus?: string;
  outstandingAtClaimPaise?: string;
  appliedPaise?: string;
  siblingPaid?: boolean;
};

/**
 * Write an audit event with random UUID (idempotency via conditional UPDATE RETURNING).
 */
async function writeAuditEvent(
  sql: Sql,
  shopId: string,
  actor: string,
  type: string,
  data: AuditData
): Promise<void> {
  const jsonData: { readonly [prop: string]: string | boolean | null | undefined } = data;
  await sql`
    INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
    VALUES (
      gen_random_uuid(),
      ${shopId},
      ${actor},
      ${type},
      ${sql.json(jsonData)}::jsonb,
      NOW()
    )
  `;
}

/**
 * Safely enqueue credit status recompute, logging any failures (Issue #4).
 * Failures are logged but don't affect the apply result.
 */
async function safeEnqueueRecompute(sql: Sql, invoiceId: string): Promise<void> {
  try {
    await enqueueRecomputeForInvoice(sql, invoiceId);
  } catch (error) {
    safeLog("error", "apply_enqueue_recompute_failed", {
      invoiceId,
      err: toErrorCode(error),
    });
  }
}
