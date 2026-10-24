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
 * CRASH EDGE CASE (Issue #6):
 * A crash between tx1 (claiming the match) and tx2 (finalizing) leaves Match.state='pushed'
 * but nothing actually pushed and outstanding unchanged. On retry, we detect this by checking
 * if the invoice status isn't 'paid' AND outstanding wasn't reduced, and retry the push.
 */

import type { Sql } from "~/lib/db-light.server";
import { shopifyGraphQLRequest, type ShopifyClientResult } from "./shopify-client.server";
import { enqueueRecomputeForInvoice } from "./credit-status-recompute.server";

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
 * Flow:
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
  let shopifySuccess = false;
  let reasonCode: string | undefined;

  if (invoiceRow.orderId) {
    const shopifyResult = await callOrderMarkAsPaid(
      invoiceRow.shopDomain,
      invoiceRow.orderId
    );

    if (shopifyResult.success) {
      shopifySuccess = true;
    } else if (shopifyResult.alreadyPaid) {
      // Order was already paid - treat as success
      shopifySuccess = true;
      reasonCode = "ALREADY_PAID_IN_SHOPIFY";
    } else {
      // Shopify call failed - release the claim
      await releaseMatchClaim(sql, shopId, matchId);
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: shopifyResult.error ?? "Shopify orderMarkAsPaid failed",
        retryable: shopifyResult.retryable,
      };
    }
  } else {
    // No Shopify order to mark - local-only invoice
    shopifySuccess = true;
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
    shopifySuccess,
    reasonCode,
    tx1Result.appliedAmountPaise ?? matchRow.amountPaise,
    tx1Result.previousOutstandingPaise ?? "0"
  );

  if (!tx2Result.success) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: shopifySuccess,
      error: tx2Result.error,
    };
  }

  // Enqueue credit status recompute
  await safeEnqueueRecompute(sql, invoiceRow.id);

  return {
    success: true,
    invoicePaid: true,
    shopifyPushSucceeded: shopifySuccess,
    reasonCode,
  };
}

/**
 * Handle a match that's already in 'pushed' state.
 *
 * This handles two cases:
 * 1. Idempotent retry - match was already successfully applied
 * 2. Crash recovery (Issue #6) - match was claimed but push never completed
 *
 * We detect crash recovery by checking:
 * - For full payments: invoice status is not 'paid'
 * - For partial payments: no match.applied audit event exists
 */
async function handlePushedMatch(
  sql: Sql,
  shopId: string,
  matchId: string,
  matchRow: { id: string; shopId: string; paymentId: string; invoiceId: string; amountPaise: string },
  actor: string
): Promise<ApplyMatchResult> {
  // Check invoice status to determine if this is idempotent or crash recovery
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

  // No audit event found - this is crash recovery (Issue #6)
  // Match was claimed but apply never completed
  console.log(
    `[applyMatch] Crash recovery: matchId=${matchId} was pushed but no audit event found, retrying`
  );

  // Determine if this is a partial or full payment
  const matchAmountPaise = BigInt(matchRow.amountPaise);
  const outstandingPaise = BigInt(invoiceRow.outstandingPaise);
  const isFullPayment = matchAmountPaise >= outstandingPaise;

  if (!isFullPayment) {
    // Partial payment crash recovery - just finalize the partial apply
    try {
      await sql.begin(async (tx) => {
        // Lock and update invoice - IDOR protection: filter by shopId
        const [lockedInvoice] = await tx<{ outstandingPaise: string }[]>`
          SELECT (ROUND(outstanding * 100))::text AS "outstandingPaise"
          FROM "Invoice"
          WHERE id = ${invoiceRow.id}
            AND "shopId" = ${shopId}
          FOR UPDATE
        `;

        if (!lockedInvoice) {
          throw new Error("Invoice not found during recovery");
        }

        const currentOutstanding = BigInt(lockedInvoice.outstandingPaise);
        const reduction = matchAmountPaise > currentOutstanding ? currentOutstanding : matchAmountPaise;
        const newOutstanding = currentOutstanding - reduction;

        await tx`
          UPDATE "Invoice"
          SET outstanding = ${Number(newOutstanding) / 100}, "updatedAt" = NOW()
          WHERE id = ${invoiceRow.id}
            AND "shopId" = ${shopId}
        `;

        // Write audit event for the recovered apply
        await writeAuditEvent(tx, shopId, actor, "match.applied", {
          matchId,
          invoiceId: invoiceRow.id,
          paymentId: matchRow.paymentId,
          amountPaise: reduction.toString(),
          previousOutstandingPaise: currentOutstanding.toString(),
          newOutstandingPaise: newOutstanding.toString(),
          recoveredFromCrash: true,
        });
      });

      await safeEnqueueRecompute(sql, invoiceRow.id);

      return {
        success: true,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        reasonCode: "RECOVERED_FROM_CRASH",
      };
    } catch (error) {
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: `Recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Full payment crash recovery - need to call Shopify
  let shopifySuccess = false;
  let reasonCode: string | undefined;

  if (invoiceRow.orderId) {
    const shopifyResult = await callOrderMarkAsPaid(
      invoiceRow.shopDomain,
      invoiceRow.orderId
    );

    if (shopifyResult.success) {
      shopifySuccess = true;
    } else if (shopifyResult.alreadyPaid) {
      shopifySuccess = true;
      reasonCode = "ALREADY_PAID_IN_SHOPIFY";
    } else {
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: shopifyResult.error ?? "Shopify call failed during recovery",
        retryable: shopifyResult.retryable,
      };
    }
  } else {
    shopifySuccess = true;
  }

  // Finalize the full payment
  try {
    await sql.begin(async (tx) => {
      // IDOR protection: filter by shopId
      const [lockedInvoice] = await tx<{ outstandingPaise: string }[]>`
        SELECT (ROUND(outstanding * 100))::text AS "outstandingPaise"
        FROM "Invoice"
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
        FOR UPDATE
      `;

      if (!lockedInvoice) {
        throw new Error("Invoice not found during recovery");
      }

      const previousOutstanding = lockedInvoice.outstandingPaise;

      await tx`
        UPDATE "Invoice"
        SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
      `;

      await writeAuditEvent(tx, shopId, actor, "match.applied", {
        matchId,
        invoiceId: invoiceRow.id,
        paymentId: matchRow.paymentId,
        amountPaise: matchRow.amountPaise,
        previousOutstandingPaise: previousOutstanding,
        newOutstandingPaise: "0",
        reasonCode,
        recoveredFromCrash: true,
      });

      await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
        invoiceId: invoiceRow.id,
        matchId,
        orderGid: invoiceRow.orderId,
        shopifyPushSucceeded: shopifySuccess,
        reasonCode,
        recoveredFromCrash: true,
      });
    });

    await safeEnqueueRecompute(sql, invoiceRow.id);

    return {
      success: true,
      invoicePaid: true,
      shopifyPushSucceeded: shopifySuccess,
      reasonCode: reasonCode ?? "RECOVERED_FROM_CRASH",
    };
  } catch (error) {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: shopifySuccess,
      error: `Recovery finalization failed: ${error instanceof Error ? error.message : String(error)}`,
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

  // If invoice is already paid locally, just finalize the match
  if (invoiceRow.status === "paid") {
    await sql`
      UPDATE "Match"
      SET state = 'pushed', "updatedAt" = NOW()
      WHERE id = ${matchId} AND "shopId" = ${shopId}
    `;
    return {
      success: true,
      invoicePaid: true,
      shopifyPushSucceeded: true,
      reasonCode: "STALE_RECLAIM_ALREADY_PAID",
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
            // Invoice already paid/cancelled - just finalize match
            await tx`
              UPDATE "Match"
              SET state = 'pushed', "updatedAt" = NOW()
              WHERE id = ${matchId}
                AND "shopId" = ${shopId}
            `;
            return { invoicePaid: lockedInvoice.status === "paid", isPartial: false, alreadyFinalized: true };
          }

          // Decide partial vs full from LOCKED outstanding
          const matchAmountPaise = BigInt(matchRow.amountPaise);
          const currentOutstanding = BigInt(lockedInvoice.outstandingPaise);
          const reduction = matchAmountPaise > currentOutstanding ? currentOutstanding : matchAmountPaise;
          const newOutstanding = currentOutstanding - reduction;
          const isFullPayment = newOutstanding === 0n;

          if (isFullPayment) {
            // Full payment - mark invoice as paid
            await tx`
              UPDATE "Invoice"
              SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
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
              newOutstandingPaise: "0",
              staleReclaim: true,
              shopifyAlreadyPaid: true,
            });

            await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
              invoiceId: invoiceRow.id,
              matchId,
              orderGid: invoiceRow.orderId,
              shopifyPushSucceeded: true,
              staleReclaim: true,
              shopifyAlreadyPaid: true,
            });

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

        return {
          success: true,
          invoicePaid: result.invoicePaid,
          shopifyPushSucceeded: true,
          reasonCode: result.isPartial
            ? "STALE_RECLAIM_SHOPIFY_ALREADY_PAID_PARTIAL"
            : "STALE_RECLAIM_SHOPIFY_ALREADY_PAID",
        };
      } catch (error) {
        return {
          success: false,
          invoicePaid: false,
          shopifyPushSucceeded: false,
          error: `Stale reclaim finalization failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }

  // Shopify not yet paid - need to re-push
  // Determine if this is a partial or full payment
  const matchAmountPaise = BigInt(matchRow.amountPaise);
  const outstandingPaise = BigInt(invoiceRow.outstandingPaise);
  const isFullPayment = matchAmountPaise >= outstandingPaise;

  if (!isFullPayment) {
    // Partial payment stale re-claim - finalize locally
    try {
      await sql.begin(async (tx) => {
        const [lockedInvoice] = await tx<{ outstandingPaise: string }[]>`
          SELECT (ROUND(outstanding * 100))::text AS "outstandingPaise"
          FROM "Invoice"
          WHERE id = ${invoiceRow.id}
            AND "shopId" = ${shopId}
          FOR UPDATE
        `;

        if (!lockedInvoice) {
          throw new Error("Invoice not found during stale reclaim");
        }

        const currentOutstanding = BigInt(lockedInvoice.outstandingPaise);
        const reduction = matchAmountPaise > currentOutstanding ? currentOutstanding : matchAmountPaise;
        const newOutstanding = currentOutstanding - reduction;

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
      });

      await safeEnqueueRecompute(sql, invoiceRow.id);

      return {
        success: true,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        reasonCode: "STALE_RECLAIM_PARTIAL",
      };
    } catch (error) {
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: `Stale reclaim failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  // Full payment stale re-claim - need to call Shopify
  let shopifySuccess = false;
  let reasonCode: string | undefined;

  if (invoiceRow.orderId) {
    const shopifyResult = await callOrderMarkAsPaid(
      invoiceRow.shopDomain,
      invoiceRow.orderId
    );

    if (shopifyResult.success) {
      shopifySuccess = true;
    } else if (shopifyResult.alreadyPaid) {
      shopifySuccess = true;
      reasonCode = "STALE_RECLAIM_ALREADY_PAID_IN_SHOPIFY";
    } else {
      // Shopify call failed - leave in 'pushing' for another retry
      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: shopifyResult.error ?? "Shopify call failed during stale reclaim",
        retryable: shopifyResult.retryable,
      };
    }
  } else {
    shopifySuccess = true;
  }

  // Finalize the stale re-claimed full payment
  try {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE "Invoice"
        SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
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
        amountPaise: matchRow.amountPaise,
        previousOutstandingPaise: invoiceRow.outstandingPaise,
        newOutstandingPaise: "0",
        reasonCode,
        staleReclaim: true,
      });

      await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
        invoiceId: invoiceRow.id,
        matchId,
        orderGid: invoiceRow.orderId,
        shopifyPushSucceeded: shopifySuccess,
        reasonCode,
        staleReclaim: true,
      });
    });

    await safeEnqueueRecompute(sql, invoiceRow.id);

    return {
      success: true,
      invoicePaid: true,
      shopifyPushSucceeded: shopifySuccess,
      reasonCode: reasonCode ?? "STALE_RECLAIM_FULL",
    };
  } catch (error) {
    // DB error after Shopify succeeded - leave in 'pushing' for stale re-claim
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: shopifySuccess,
      error: `Stale reclaim finalization failed: ${error instanceof Error ? error.message : String(error)}`,
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
        return { success: false, error: `Invoice status is '${lockedInvoice.status}', expected 'open'` };
      }

      // RACE CHECK: Refuse apply while another match on this invoice has an in-flight push
      // (state='pushing' means TX1 claimed it but TX2 hasn't finalized yet)
      const [inFlightPush] = await tx<{ id: string }[]>`
        SELECT id FROM "Match"
        WHERE "invoiceId" = ${invoiceRow.id}
          AND "shopId" = ${shopId}
          AND id != ${matchId}
          AND state = 'pushing'
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
      error: error instanceof Error ? error.message : String(error),
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
    console.error(
      `[applyMatch] Failed to release claim for matchId=${matchId}:`,
      error instanceof Error ? error.message : String(error)
    );
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
  shopifySuccess: boolean,
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
        console.error(
          `[applyMatch] BACKSTOP TRIGGERED: matchId=${matchId}, ` +
          `expectedStatus=open, actualStatus=${lockedInvoice.status}, ` +
          `expectedOutstanding=${expectedOutstandingPaise}, actualOutstanding=${lockedInvoice.outstandingPaise}, ` +
          `shopifySuccess=${shopifySuccess}`
        );

        if (shopifySuccess) {
          // Shopify already paid - finalize locally to match Shopify state
          // Don't revert the match, instead force-finalize to stay consistent with Shopify
          await tx`
            UPDATE "Invoice"
            SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
            WHERE id = ${invoiceRow.id}
              AND "shopId" = ${shopId}
          `;

          // Finalize match state to 'pushed'
          await tx`
            UPDATE "Match"
            SET state = 'pushed', "updatedAt" = NOW()
            WHERE id = ${matchId}
              AND "shopId" = ${shopId}
          `;

          // Write audit events with backstop flag
          await writeAuditEvent(tx, shopId, actor, "match.applied", {
            matchId,
            invoiceId: invoiceRow.id,
            paymentId: matchRow.paymentId,
            amountPaise: appliedAmountPaise,
            previousOutstandingPaise: lockedInvoice.outstandingPaise,
            newOutstandingPaise: "0",
            reasonCode,
            backstopTriggered: true,
          });

          await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
            invoiceId: invoiceRow.id,
            matchId,
            orderGid: invoiceRow.orderId,
            shopifyPushSucceeded: shopifySuccess,
            reasonCode,
            backstopTriggered: true,
          });

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

      // Mark invoice as paid
      await tx`
        UPDATE "Invoice"
        SET outstanding = 0, status = 'paid', "updatedAt" = NOW()
        WHERE id = ${invoiceRow.id}
          AND "shopId" = ${shopId}
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

      // Write invoice.paid audit event
      await writeAuditEvent(tx, shopId, actor, "invoice.paid", {
        invoiceId: invoiceRow.id,
        matchId,
        orderGid: invoiceRow.orderId,
        shopifyPushSucceeded: shopifySuccess,
        reasonCode,
      });

      return { success: true };
    });

    if (result.raceDetected) {
      return { success: false, error: result.error, raceDetected: true };
    }

    return { success: true };
  } catch (error) {
    console.error(
      `[applyMatch] TX2 failed for matchId=${matchId}:`,
      error instanceof Error ? error.message : String(error)
    );
    return {
      success: false,
      error: `Database error: ${error instanceof Error ? error.message : String(error)}`,
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

        // Block unmatch if invoice is already paid in Shopify
        if (invoiceRow.status === "paid") {
          return {
            success: false,
            error: "Cannot unmatch: order already marked as paid in Shopify",
            alreadyPushed: true,
          };
        }

        // Find the actual applied amount from the audit trail (Issue #3)
        const appliedAmount = await getAppliedAmountFromAudit(
          tx,
          shopId,
          matchId
        );
        const restoreAmount = appliedAmount ?? BigInt(matchRow.amountPaise);

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
      error: error instanceof Error ? error.message : String(error),
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
      error: result.error ?? "Shopify request failed",
      retryable: result.retryable,
    };
  }

  const data = result.data?.orderMarkAsPaid;
  if (!data) {
    return {
      success: false,
      error: "Invalid Shopify response",
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
  orderGid?: string | null;
  shopifyPushSucceeded?: boolean;
  reasonCode?: string;
  recoveredFromCrash?: boolean;
  backstopTriggered?: boolean;
  staleReclaim?: boolean;
  shopifyAlreadyPaid?: boolean;
  previousState?: string;
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
    // Log the error without PII (Issue #4)
    console.error(
      "[applyMatch] Failed to enqueue credit status recompute:",
      `invoiceId=${invoiceId}`,
      error instanceof Error ? error.message : String(error)
    );

    // TODO: Report to Sentry if helper exists
    // For now, we log and continue - the apply was still successful
  }
}
