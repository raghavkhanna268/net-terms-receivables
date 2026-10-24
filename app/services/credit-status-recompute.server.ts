/**
 * Credit Status Recompute Service.
 *
 * Handles both event-driven and time-driven credit status recomputation.
 * Routes through syncCreditStatusMetafield for proper locking and syncVersion handling.
 *
 * Event-driven triggers:
 * - Invoice created (order webhook)
 * - Invoice paid (payment match or ORDERS_PAID webhook)
 * - Invoice cancelled/voided
 * - Outstanding amount changed
 *
 * Time-driven triggers:
 * - Daily pg_cron job enqueues CREDIT_STATUS_RECOMPUTE messages for accounts
 *   with invoices that crossed the overdue threshold (dueAt < NOW() - 1 day)
 *
 * Design:
 * - ONE code path: routes through syncCreditStatusMetafield (no parallel impl)
 * - FOR UPDATE lock + syncVersion guard prevent races
 * - syncPending cleared only when synced version matches
 * - Idempotent: only writes metafield when hold value actually changes
 * - No new scopes: uses existing metafieldsSet on CompanyLocation/Customer
 * - Worker-friendly: designed for 10ms CPU budget
 */

import type { Sql } from "~/lib/db-light.server";
import { syncCreditStatusMetafield, getCreditStatusDisplay } from "./credit-status.server";

/**
 * Result of a credit status recompute.
 */
export interface RecomputeResult {
  success: boolean;
  /** Whether the hold value changed and metafield was written */
  metafieldWritten: boolean;
  /** Previous hold value (before recompute) */
  previousHold: boolean;
  /** New hold value (after recompute) */
  newHold: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
}

/**
 * Buyer account data needed for recompute.
 */
interface BuyerAccountForRecompute {
  id: string;
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  bypass: boolean;
  gatedAt: Date | null;
  syncPending: boolean;
}

/**
 * Recompute credit status for a buyer account.
 *
 * Routes through syncCreditStatusMetafield which provides:
 * - FOR UPDATE locking in transaction
 * - syncVersion guard for clearing syncPending
 * - Proper metafield write with userError handling
 *
 * Idempotent behavior:
 * - Only writes metafield when the hold value actually changes
 * - Safe to call multiple times for the same account
 *
 * @param sql - Database connection
 * @param buyerAccountId - Buyer account ID to recompute
 * @returns Result indicating success and whether metafield was written
 */
export async function recomputeCreditStatus(
  sql: Sql,
  buyerAccountId: string,
): Promise<RecomputeResult> {
  // Fetch account data to check gated status and current hold
  const [account] = await sql<BuyerAccountForRecompute[]>`
    SELECT
      id,
      "holdState",
      bypass,
      gated_at AS "gatedAt",
      "syncPending"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold: false,
      newHold: false,
      error: "Buyer account not found",
      retryable: false,
    };
  }

  // Skip gated accounts - report real stored values
  if (account.gatedAt !== null) {
    const previousHold = account.holdState === "HELD" && !account.bypass;
    return {
      success: true,
      metafieldWritten: false,
      previousHold,
      newHold: previousHold,
    };
  }

  // Capture previous hold value
  const previousHold = account.holdState === "HELD" && !account.bypass;

  // Get what the new hold would be by computing current state
  // (This is a read-only check to determine if metafield write is needed)
  const statusDisplay = await getCreditStatusDisplay(sql, buyerAccountId);
  if (!statusDisplay) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold: previousHold,
      error: "Could not compute credit status",
      retryable: false,
    };
  }

  const newHold = statusDisplay.isOnHold;

  // Early return only when:
  // 1. Hold value hasn't changed, AND
  // 2. No sync is pending (previous metafield write completed)
  if (previousHold === newHold && !account.syncPending) {
    return {
      success: true,
      metafieldWritten: false,
      previousHold,
      newHold,
    };
  }

  // Route through syncCreditStatusMetafield which has:
  // - FOR UPDATE lock on BuyerAccount row
  // - syncVersion increment and guard
  // - Proper metafield write error handling
  const syncResult = await syncCreditStatusMetafield(sql, buyerAccountId);

  if (!syncResult.success) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold,
      error: syncResult.error,
      retryable: true,
    };
  }

  // metafieldSyncPending tells us if the metafield write succeeded
  // If syncPending is still true, the metafield write failed - return failure for retry
  if (syncResult.metafieldSyncPending) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold,
      error: syncResult.error ?? "Metafield write failed, pending retry",
      retryable: true,
    };
  }

  const metafieldWritten = true;

  // Re-read the account to get the actual post-sync hold state
  const [postSyncAccount] = await sql<{ holdState: string; bypass: boolean }[]>`
    SELECT "holdState", bypass FROM "BuyerAccount" WHERE id = ${buyerAccountId}
  `;
  const finalHold = postSyncAccount?.holdState === "HELD" && !postSyncAccount?.bypass;

  console.log(
    `[credit-status-recompute] ${metafieldWritten ? "Updated" : "Synced"} ${buyerAccountId}: hold ${previousHold} -> ${finalHold}`,
  );

  return {
    success: true,
    metafieldWritten,
    previousHold,
    newHold: finalHold,
  };
}

/**
 * Enqueue a credit status recompute for a buyer account.
 *
 * Uses a deterministic dedupe key per account per day to prevent duplicate
 * messages from the daily cron job.
 *
 * @param sql - Database connection
 * @param shopDomain - Shop domain (e.g., "store.myshopify.com")
 * @param buyerAccountId - Buyer account ID to recompute
 * @param source - Source of the recompute (for audit)
 */
export async function enqueueCreditStatusRecompute(
  sql: Sql,
  shopDomain: string,
  buyerAccountId: string,
  source: "invoice_change" | "daily_sweep" | "manual",
): Promise<void> {
  // Deterministic dedupe key: account ID + date (for daily sweep deduplication)
  // For event-driven, use a unique key per event
  const today = new Date().toISOString().split("T")[0];
  const dedupeKey =
    source === "daily_sweep"
      ? `credit_recompute:${buyerAccountId}:${today}`
      : `credit_recompute:${buyerAccountId}:${Date.now()}`;

  const message = {
    topic: "CREDIT_STATUS_RECOMPUTE",
    shop: shopDomain,
    buyerAccountId,
    source,
    webhookId: dedupeKey,
    resourceGid: buyerAccountId,
  };

  await sql`
    SELECT pgmq.send('s6_sync', ${sql.json(message)})
  `;
}

/**
 * Enqueue credit status recompute for a buyer account after an invoice change.
 *
 * This is the event-driven entry point called after:
 * - Invoice created
 * - Invoice paid
 * - Invoice cancelled/voided
 * - Outstanding amount changed
 *
 * @param sql - Database connection
 * @param invoiceId - Invoice ID that changed
 */
export async function enqueueRecomputeForInvoice(
  sql: Sql,
  invoiceId: string,
): Promise<void> {
  // Look up the invoice to get shop domain and buyer account
  const [invoice] = await sql<{
    buyerAccountId: string | null;
    shopDomain: string;
  }[]>`
    SELECT i."buyerAccountId", s.domain AS "shopDomain"
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i.id = ${invoiceId}
  `;

  if (!invoice?.buyerAccountId) {
    return;
  }

  await enqueueCreditStatusRecompute(
    sql,
    invoice.shopDomain,
    invoice.buyerAccountId,
    "invoice_change",
  );
}
