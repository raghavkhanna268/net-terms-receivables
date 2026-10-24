/**
 * Payment match apply service (S17).
 *
 * Applies confirmed payment matches to invoices:
 * - Reduces Invoice.outstanding by the match amount
 * - Calls orderMarkAsPaid when invoice is fully paid
 * - Writes immutable audit events for compliance
 * - Enqueues credit status recompute after changes
 *
 * Design:
 * - Match.state transitions: suggested → confirmed → pushed
 * - DB writes happen in a transaction with FOR UPDATE locking
 * - Shopify mutation happens OUTSIDE the transaction to avoid holding locks
 * - If mutation fails, Match.state stays 'confirmed' (no partial push)
 * - Idempotent: re-applying a pushed match is a no-op
 *
 * Audit events use only IDs and amounts (no PII):
 * - match.applied: Match applied, invoice outstanding reduced
 * - invoice.paid: Invoice fully paid, orderMarkAsPaid called
 * - match.unmatched: Match reversed before push
 */

import type { Sql } from "~/lib/db-light.server";
import { shopifyGraphQLRequest, type ShopifyClientResult } from "./shopify-client.server";
import { enqueueRecomputeForInvoice } from "./credit-status-recompute.server";

/**
 * GraphQL mutation for marking an order as paid.
 * Uses only the order GID - no PII fields.
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
 * Result of applying a match.
 */
export interface ApplyMatchResult {
  success: boolean;
  /** Invoice is now fully paid */
  invoicePaid: boolean;
  /** orderMarkAsPaid was called successfully */
  shopifyPushSucceeded: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Reason code for audit (e.g., ALREADY_PAID_IN_SHOPIFY) */
  reasonCode?: string;
}

/**
 * Result of unmatching a match.
 */
export interface UnmatchResult {
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the match was already pushed and cannot be unmatched */
  alreadyPushed?: boolean;
}

/**
 * Data needed from a confirmed match for apply.
 */
interface MatchForApply {
  id: string;
  shopId: string;
  paymentId: string;
  invoiceId: string;
  amountPaise: bigint;
  state: "suggested" | "confirmed" | "pushed" | "unmatched";
  confirmedBy: string | null;
}

/**
 * Data needed from an invoice for apply.
 */
interface InvoiceForApply {
  id: string;
  shopId: string;
  orderId: string | null;
  outstandingPaise: bigint;
  status: "open" | "paid" | "cancelled";
  buyerAccountId: string;
}

/**
 * Apply a confirmed match to reduce invoice outstanding.
 *
 * Steps:
 * 1. Lock and validate match state (must be 'confirmed')
 * 2. Lock and validate invoice (must be 'open' with outstanding > 0)
 * 3. Reduce invoice outstanding by match amount (capped at outstanding)
 * 4. If fully paid, call Shopify orderMarkAsPaid
 * 5. Update Match.state to 'pushed'
 * 6. Write audit events
 * 7. Enqueue credit status recompute
 *
 * Idempotency:
 * - If match is already 'pushed', return success (no-op)
 * - If orderMarkAsPaid returns ALREADY_PAID userError, treat as success
 *
 * @param sql - Database connection
 * @param matchId - Match ID to apply
 * @param actor - User ID or 'system' for audit
 */
export async function applyMatch(
  sql: Sql,
  matchId: string,
  actor: string
): Promise<ApplyMatchResult> {
  // Step 1: Fetch and validate match
  const [matchRow] = await sql<{
    id: string;
    shop_id: string;
    payment_id: string;
    invoice_id: string;
    amount_paise: string;
    state: string;
    confirmed_by: string | null;
  }[]>`
    SELECT
      id,
      "shopId" AS shop_id,
      "paymentId" AS payment_id,
      "invoiceId" AS invoice_id,
      (ROUND(amount * 100))::text AS amount_paise,
      state,
      "confirmedBy" AS confirmed_by
    FROM "Match"
    WHERE id = ${matchId}
    FOR UPDATE
  `;

  if (!matchRow) {
    return { success: false, invoicePaid: false, shopifyPushSucceeded: false, error: "Match not found" };
  }

  const match: MatchForApply = {
    id: matchRow.id,
    shopId: matchRow.shop_id,
    paymentId: matchRow.payment_id,
    invoiceId: matchRow.invoice_id,
    amountPaise: BigInt(matchRow.amount_paise),
    state: matchRow.state as MatchForApply["state"],
    confirmedBy: matchRow.confirmed_by,
  };

  // Idempotency: already pushed = success
  if (match.state === "pushed") {
    return { success: true, invoicePaid: false, shopifyPushSucceeded: false, reasonCode: "ALREADY_APPLIED" };
  }

  // Must be in 'confirmed' state to apply
  if (match.state !== "confirmed") {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: `Match is in '${match.state}' state, must be 'confirmed' to apply`,
    };
  }

  // Step 2: Fetch and validate invoice
  const [invoiceRow] = await sql<{
    id: string;
    shop_id: string;
    order_id: string | null;
    outstanding_paise: string;
    status: string;
    buyer_account_id: string;
    shop_domain: string;
  }[]>`
    SELECT
      i.id,
      i."shopId" AS shop_id,
      i."orderId" AS order_id,
      (ROUND(i.outstanding * 100))::text AS outstanding_paise,
      i.status,
      i."buyerAccountId" AS buyer_account_id,
      s.domain AS shop_domain
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i.id = ${match.invoiceId}
    FOR UPDATE OF i
  `;

  if (!invoiceRow) {
    return { success: false, invoicePaid: false, shopifyPushSucceeded: false, error: "Invoice not found" };
  }

  const invoice: InvoiceForApply = {
    id: invoiceRow.id,
    shopId: invoiceRow.shop_id,
    orderId: invoiceRow.order_id,
    outstandingPaise: BigInt(invoiceRow.outstanding_paise),
    status: invoiceRow.status as InvoiceForApply["status"],
    buyerAccountId: invoiceRow.buyer_account_id,
  };
  const shopDomain = invoiceRow.shop_domain;

  // Validate invoice is open
  if (invoice.status !== "open") {
    return {
      success: false,
      invoicePaid: false,
      shopifyPushSucceeded: false,
      error: `Invoice is '${invoice.status}', cannot apply match`,
    };
  }

  // Calculate reduction (cap at outstanding)
  const reductionPaise = match.amountPaise > invoice.outstandingPaise
    ? invoice.outstandingPaise
    : match.amountPaise;
  const newOutstandingPaise = invoice.outstandingPaise - reductionPaise;
  const invoiceWillBePaid = newOutstandingPaise === 0n;
  const newOutstandingDecimal = Number(newOutstandingPaise) / 100;

  // Step 3: Update invoice outstanding in transaction
  await sql`
    UPDATE "Invoice"
    SET
      outstanding = ${newOutstandingDecimal},
      status = ${invoiceWillBePaid ? "paid" : "open"},
      "updatedAt" = NOW()
    WHERE id = ${invoice.id}
  `;

  // Step 4: If fully paid and has orderId, call Shopify orderMarkAsPaid
  let shopifyPushSucceeded = false;
  let reasonCode: string | undefined;

  if (invoiceWillBePaid && invoice.orderId) {
    const shopifyResult = await callOrderMarkAsPaid(shopDomain, invoice.orderId);

    if (shopifyResult.success) {
      shopifyPushSucceeded = true;
    } else if (shopifyResult.alreadyPaid) {
      // S17-04: Already paid in Shopify = idempotent success
      shopifyPushSucceeded = true;
      reasonCode = "ALREADY_PAID_IN_SHOPIFY";
      console.log(
        `[apply] orderMarkAsPaid for ${invoice.orderId} returned already-paid, treating as success`
      );
    } else {
      // Shopify mutation failed - rollback invoice changes
      // Restore outstanding and status
      await sql`
        UPDATE "Invoice"
        SET
          outstanding = ${Number(invoice.outstandingPaise) / 100},
          status = 'open',
          "updatedAt" = NOW()
        WHERE id = ${invoice.id}
      `;

      return {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: shopifyResult.error ?? "Shopify orderMarkAsPaid failed",
        retryable: shopifyResult.retryable,
      };
    }
  }

  // Step 5: Update Match.state to 'pushed'
  await sql`
    UPDATE "Match"
    SET
      state = 'pushed',
      "updatedAt" = NOW()
    WHERE id = ${matchId}
  `;

  // Step 6: Write audit events (idempotent - check for existing)
  const auditEventId = `match-applied-${matchId}`;
  const [existingAudit] = await sql<{ id: string }[]>`
    SELECT id FROM "AuditEvent"
    WHERE id = ${auditEventId}
  `;

  if (!existingAudit) {
    // match.applied event
    await sql`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (
        ${auditEventId},
        ${match.shopId},
        ${actor},
        'match.applied',
        ${sql.json({
          matchId: match.id,
          invoiceId: invoice.id,
          paymentId: match.paymentId,
          amountPaise: reductionPaise.toString(),
          previousOutstandingPaise: invoice.outstandingPaise.toString(),
          newOutstandingPaise: newOutstandingPaise.toString(),
          reasonCode,
        })},
        NOW()
      )
    `;
  }

  // invoice.paid event if fully paid
  if (invoiceWillBePaid) {
    const paidEventId = `invoice-paid-${invoice.id}-${matchId}`;
    const [existingPaidAudit] = await sql<{ id: string }[]>`
      SELECT id FROM "AuditEvent"
      WHERE id = ${paidEventId}
    `;

    if (!existingPaidAudit) {
      await sql`
        INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
        VALUES (
          ${paidEventId},
          ${match.shopId},
          ${actor},
          'invoice.paid',
          ${sql.json({
            invoiceId: invoice.id,
            matchId: match.id,
            orderGid: invoice.orderId,
            shopifyPushSucceeded,
            reasonCode,
          })},
          NOW()
        )
      `;
    }
  }

  // Step 7: Enqueue credit status recompute (after successful changes)
  try {
    await enqueueRecomputeForInvoice(sql, invoice.id);
  } catch (err) {
    // Best-effort: log but don't fail the apply
    console.error(
      `[apply] Failed to enqueue credit status recompute for invoice ${invoice.id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return {
    success: true,
    invoicePaid: invoiceWillBePaid,
    shopifyPushSucceeded,
    reasonCode,
  };
}

/**
 * Apply multiple confirmed matches in a batch.
 * Processes each match independently - one failure doesn't stop others.
 *
 * @param sql - Database connection
 * @param matchIds - Array of match IDs to apply
 * @param actor - User ID or 'system' for audit
 */
export async function applyMatches(
  sql: Sql,
  matchIds: string[],
  actor: string
): Promise<Map<string, ApplyMatchResult>> {
  const results = new Map<string, ApplyMatchResult>();

  for (const matchId of matchIds) {
    try {
      const result = await applyMatch(sql, matchId, actor);
      results.set(matchId, result);
    } catch (err) {
      results.set(matchId, {
        success: false,
        invoicePaid: false,
        shopifyPushSucceeded: false,
        error: err instanceof Error ? err.message : "Unknown error",
        retryable: true,
      });
    }
  }

  return results;
}

/**
 * Unmatch a match before it's pushed to Shopify.
 *
 * - If Match.state is 'confirmed': restore to 'unmatched', no outstanding change
 *   (outstanding was never reduced - apply happens on push)
 * - If Match.state is 'pushed': blocked - cannot reverse after Shopify push
 * - If Match.state is 'suggested' or 'unmatched': no-op, return success
 *
 * S17-51: Unmatch after push is blocked. The order is already marked paid in
 * Shopify and cannot be automatically reverted. Merchant must manually
 * handle this in Shopify Admin.
 *
 * @param sql - Database connection
 * @param matchId - Match ID to unmatch
 * @param actor - User ID or 'system' for audit
 */
export async function unmatchMatch(
  sql: Sql,
  matchId: string,
  actor: string
): Promise<UnmatchResult> {
  // Fetch and lock match
  const [matchRow] = await sql<{
    id: string;
    shop_id: string;
    payment_id: string;
    invoice_id: string;
    amount_paise: string;
    state: string;
  }[]>`
    SELECT
      id,
      "shopId" AS shop_id,
      "paymentId" AS payment_id,
      "invoiceId" AS invoice_id,
      (ROUND(amount * 100))::text AS amount_paise,
      state
    FROM "Match"
    WHERE id = ${matchId}
    FOR UPDATE
  `;

  if (!matchRow) {
    return { success: false, error: "Match not found" };
  }

  const state = matchRow.state;

  // S17-51: Block unmatch after push
  if (state === "pushed") {
    return {
      success: false,
      error: "Cannot unmatch after the payment has been applied. Order is already marked as paid in Shopify.",
      alreadyPushed: true,
    };
  }

  // S17-52: Already unmatched or suggested = no-op success
  if (state === "unmatched" || state === "suggested") {
    return { success: true };
  }

  // State is 'confirmed' - can unmatch
  // Note: For confirmed matches, Invoice.outstanding was NOT yet reduced
  // (reduction happens during applyMatch, not confirmMatch)
  // So we just need to update Match.state

  await sql`
    UPDATE "Match"
    SET
      state = 'unmatched',
      "updatedAt" = NOW()
    WHERE id = ${matchId}
  `;

  // Write audit event (idempotent)
  const auditEventId = `match-unmatched-${matchId}`;
  const [existingAudit] = await sql<{ id: string }[]>`
    SELECT id FROM "AuditEvent"
    WHERE id = ${auditEventId}
  `;

  if (!existingAudit) {
    await sql`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (
        ${auditEventId},
        ${matchRow.shop_id},
        ${actor},
        'match.unmatched',
        ${sql.json({
          matchId: matchRow.id,
          invoiceId: matchRow.invoice_id,
          paymentId: matchRow.payment_id,
          amountPaise: matchRow.amount_paise,
          previousState: state,
        })},
        NOW()
      )
    `;
  }

  // Update payment status if needed
  // Check if there are still confirmed/pushed matches for this payment
  const [confirmedCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Match"
    WHERE "paymentId" = ${matchRow.payment_id}
      AND state IN ('confirmed', 'pushed')
  `;

  if (parseInt(confirmedCount?.count ?? "0", 10) === 0) {
    // No more confirmed matches - check for suggested
    const [suggestedCount] = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM "Match"
      WHERE "paymentId" = ${matchRow.payment_id}
        AND state = 'suggested'
    `;

    const newStatus = parseInt(suggestedCount?.count ?? "0", 10) > 0 ? "partial" : "unmatched";
    await sql`
      UPDATE "Payment"
      SET status = ${newStatus}, "updatedAt" = NOW()
      WHERE id = ${matchRow.payment_id}
    `;
  }

  return { success: true };
}

/**
 * Unmatch a pushed match (reverse the apply).
 *
 * IMPORTANT: This is only allowed if the invoice was NOT fully paid to Shopify.
 * If orderMarkAsPaid was called, this operation is blocked.
 *
 * For pushed matches on partially paid invoices (no Shopify call was made):
 * - Restore Invoice.outstanding
 * - Set Match.state to 'unmatched'
 * - Write audit event
 * - Enqueue credit status recompute
 *
 * @param sql - Database connection
 * @param matchId - Match ID to unmatch
 * @param actor - User ID or 'system' for audit
 */
export async function unmatchPushedMatch(
  sql: Sql,
  matchId: string,
  actor: string
): Promise<UnmatchResult> {
  // Fetch and lock match
  const [matchRow] = await sql<{
    id: string;
    shop_id: string;
    payment_id: string;
    invoice_id: string;
    amount_paise: string;
    state: string;
  }[]>`
    SELECT
      id,
      "shopId" AS shop_id,
      "paymentId" AS payment_id,
      "invoiceId" AS invoice_id,
      (ROUND(amount * 100))::text AS amount_paise,
      state
    FROM "Match"
    WHERE id = ${matchId}
    FOR UPDATE
  `;

  if (!matchRow) {
    return { success: false, error: "Match not found" };
  }

  if (matchRow.state !== "pushed") {
    // Use regular unmatch for non-pushed states
    return unmatchMatch(sql, matchId, actor);
  }

  // Fetch invoice to check if it's paid
  const [invoiceRow] = await sql<{
    id: string;
    shop_id: string;
    outstanding_paise: string;
    status: string;
    order_id: string | null;
  }[]>`
    SELECT
      id,
      "shopId" AS shop_id,
      (ROUND(outstanding * 100))::text AS outstanding_paise,
      status,
      "orderId" AS order_id
    FROM "Invoice"
    WHERE id = ${matchRow.invoice_id}
    FOR UPDATE
  `;

  if (!invoiceRow) {
    return { success: false, error: "Invoice not found" };
  }

  // S17-51: If invoice is fully paid (status=paid), we likely called orderMarkAsPaid
  // Block unmatch in this case
  if (invoiceRow.status === "paid") {
    return {
      success: false,
      error: "Cannot unmatch a pushed match for a fully paid invoice. Order has been marked as paid in Shopify.",
      alreadyPushed: true,
    };
  }

  // Invoice is still open (partial payment was pushed) - we can restore
  const matchAmountPaise = BigInt(matchRow.amount_paise);
  const currentOutstandingPaise = BigInt(invoiceRow.outstanding_paise);
  const newOutstandingPaise = currentOutstandingPaise + matchAmountPaise;
  const newOutstandingDecimal = Number(newOutstandingPaise) / 100;

  // Restore invoice outstanding
  await sql`
    UPDATE "Invoice"
    SET
      outstanding = ${newOutstandingDecimal},
      "updatedAt" = NOW()
    WHERE id = ${matchRow.invoice_id}
  `;

  // Update match state
  await sql`
    UPDATE "Match"
    SET
      state = 'unmatched',
      "updatedAt" = NOW()
    WHERE id = ${matchId}
  `;

  // Write audit event
  const auditEventId = `match-unmatched-pushed-${matchId}`;
  const [existingAudit] = await sql<{ id: string }[]>`
    SELECT id FROM "AuditEvent"
    WHERE id = ${auditEventId}
  `;

  if (!existingAudit) {
    await sql`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (
        ${auditEventId},
        ${matchRow.shop_id},
        ${actor},
        'match.unmatched',
        ${sql.json({
          matchId: matchRow.id,
          invoiceId: matchRow.invoice_id,
          paymentId: matchRow.payment_id,
          amountPaise: matchRow.amount_paise,
          previousState: 'pushed',
          previousOutstandingPaise: currentOutstandingPaise.toString(),
          newOutstandingPaise: newOutstandingPaise.toString(),
        })},
        NOW()
      )
    `;
  }

  // Enqueue credit status recompute
  try {
    await enqueueRecomputeForInvoice(sql, matchRow.invoice_id);
  } catch (err) {
    console.error(
      `[unmatch] Failed to enqueue credit status recompute for invoice ${matchRow.invoice_id}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  return { success: true };
}

/**
 * Call Shopify orderMarkAsPaid mutation.
 *
 * @param shopDomain - Shop domain
 * @param orderGid - Order GID
 * @returns Result with success/failure and whether order was already paid
 */
async function callOrderMarkAsPaid(
  shopDomain: string,
  orderGid: string
): Promise<{ success: boolean; alreadyPaid?: boolean; error?: string; retryable?: boolean }> {
  interface OrderMarkAsPaidResponse {
    orderMarkAsPaid: {
      order: { id: string; displayFinancialStatus: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }

  const result: ShopifyClientResult<OrderMarkAsPaidResponse> = await shopifyGraphQLRequest(
    shopDomain,
    ORDER_MARK_AS_PAID_MUTATION,
    { input: { id: orderGid } }
  );

  if (!result.success) {
    return {
      success: false,
      error: result.error ?? "Shopify request failed",
      retryable: result.retryable,
    };
  }

  const data = result.data?.orderMarkAsPaid;
  if (!data) {
    return { success: false, error: "Invalid response from Shopify", retryable: true };
  }

  // Check for userErrors
  if (data.userErrors.length > 0) {
    const errors = data.userErrors;

    // S17-04: Check for "already paid" type errors
    // Shopify returns userError when order is already paid
    const isAlreadyPaid = errors.some((e) =>
      e.message.toLowerCase().includes("already paid") ||
      e.message.toLowerCase().includes("cannot be marked as paid") ||
      e.message.toLowerCase().includes("has been paid") ||
      e.message.toLowerCase().includes("financial status is paid")
    );

    if (isAlreadyPaid) {
      return { success: false, alreadyPaid: true };
    }

    // Other userErrors are non-retryable
    return {
      success: false,
      error: `Shopify userErrors: ${errors.map((e) => e.message).join("; ")}`,
      retryable: false,
    };
  }

  // Success
  return { success: true };
}

/**
 * Get confirmed matches ready to apply for a shop.
 *
 * @param sql - Database connection
 * @param shopId - Shop ID
 * @param options - Pagination options
 */
export async function getConfirmedMatchesForApply(
  sql: Sql,
  shopId: string,
  options: { limit: number; offset: number } = { limit: 20, offset: 0 }
): Promise<{
  matches: Array<{
    id: string;
    paymentId: string;
    invoiceId: string;
    invoiceName: string;
    buyerName: string;
    amountPaise: bigint;
    confirmedBy: string | null;
    confirmedAt: Date | null;
  }>;
  totalCount: number;
}> {
  const rows = await sql<{
    id: string;
    payment_id: string;
    invoice_id: string;
    invoice_name: string;
    buyer_name: string;
    amount_paise: string;
    confirmed_by: string | null;
    confirmed_at: Date | null;
  }[]>`
    SELECT
      m.id,
      m."paymentId" AS payment_id,
      m."invoiceId" AS invoice_id,
      i.name AS invoice_name,
      ba.name AS buyer_name,
      (ROUND(m.amount * 100))::text AS amount_paise,
      m."confirmedBy" AS confirmed_by,
      m."confirmedAt" AS confirmed_at
    FROM "Match" m
    JOIN "Invoice" i ON i.id = m."invoiceId"
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE m."shopId" = ${shopId}
      AND m.state = 'confirmed'
    ORDER BY m."confirmedAt" ASC NULLS LAST, m.id
    LIMIT ${options.limit}
    OFFSET ${options.offset}
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Match"
    WHERE "shopId" = ${shopId}
      AND state = 'confirmed'
  `;

  return {
    matches: rows.map((row) => ({
      id: row.id,
      paymentId: row.payment_id,
      invoiceId: row.invoice_id,
      invoiceName: row.invoice_name,
      buyerName: row.buyer_name,
      amountPaise: BigInt(row.amount_paise),
      confirmedBy: row.confirmed_by,
      confirmedAt: row.confirmed_at,
    })),
    totalCount: parseInt(countRow?.count ?? "0", 10),
  };
}
