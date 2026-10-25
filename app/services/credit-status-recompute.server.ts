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
import {
  syncCreditStatusMetafield,
  getCreditStatusDisplay,
  shouldSkipForBackoff,
  type CreditStatusSource,
} from "./credit-status.server";
import { safeLog } from "~/lib/log.server";

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
  /** Error code for safe logging (no PII) */
  errorCode?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Whether the account has no owner (no metafield write attempted) */
  noOwner?: boolean;
  /** Whether metafield write was skipped due to backoff (DB update still happened) */
  backoffSkipped?: boolean;
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
  metafieldSyncedAt: Date | null;
  metafieldSyncErrorAt: Date | null;
  metafieldSyncErrorCode: string | null;
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
 * @param source - Source of the recompute (for audit trail), defaults to 'unknown'
 * @returns Result indicating success and whether metafield was written
 */
export async function recomputeCreditStatus(
  sql: Sql,
  buyerAccountId: string,
  source: CreditStatusSource = "unknown",
): Promise<RecomputeResult> {
  // Fetch account data to check gated status, current hold, and backoff state
  const [account] = await sql<BuyerAccountForRecompute[]>`
    SELECT
      id,
      "holdState",
      bypass,
      gated_at AS "gatedAt",
      "syncPending",
      "metafieldSyncedAt",
      "metafieldSyncErrorAt",
      "metafieldSyncErrorCode"
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

  // Capture previous hold value BEFORE any updates
  const previousHold = account.holdState === "HELD" && !account.bypass;

  // Check backoff for persistent retryable failures.
  // Backoff applies ONLY when:
  // - metafieldSyncErrorCode is NULL (retryable streak, not a permanent failure)
  // - metafieldSyncErrorAt is set (we have a failure timestamp marking the streak start)
  // - The backoff period hasn't elapsed
  // 
  // IMPORTANT: Backoff only skips the Shopify metafield write.
  // The DB recompute (holdState calculation, hold apply/release, audit) ALWAYS runs.
  // This ensures holds and releases are computed and persisted for every trigger source
  // (invoice_change, manual edit, daily_sweep) even during backoff.
  //
  // Permanent failures (metafieldSyncErrorCode IS NOT NULL) are excluded by the sweep SQL,
  // so they shouldn't reach here via daily_sweep. If they do reach here via another path
  // (e.g., invoice_change), we still allow retry (success clears the marker).
  let skipMetafieldWrite = false;
  let backoffInfo: { errorAgeDays?: number; nextRetryDay?: number } | undefined;
  
  if (
    account.metafieldSyncErrorCode === null &&
    account.metafieldSyncErrorAt !== null
  ) {
    const backoffResult = shouldSkipForBackoff(account.metafieldSyncErrorAt);
    if (backoffResult.skip) {
      skipMetafieldWrite = true;
      backoffInfo = { errorAgeDays: backoffResult.errorAgeDays, nextRetryDay: backoffResult.nextRetryDay };
    }
  }

  // Get what the new hold would be by computing current state
  // (This is a read-only check for early exit optimization only)
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

  // Early return only when ALL of the following are true:
  // 1. Hold value hasn't changed
  // 2. No sync is pending (previous metafield write completed)
  // 3. Metafield has been written at least once (metafieldSyncedAt is not NULL)
  // 4. NOT in backoff (backoff requires DB update to keep syncPending=true)
  if (previousHold === newHold && !account.syncPending && account.metafieldSyncedAt !== null && !skipMetafieldWrite) {
    return {
      success: true,
      metafieldWritten: false,
      previousHold,
      newHold,
    };
  }

  // Route through syncCreditStatusMetafield which:
  // - Locks the BuyerAccount row with FOR UPDATE
  // - Computes holdState from current data (invoices, exposure, overdue status)
  // - Updates DB with new holdState, increments syncVersion
  // - Records hold_applied/hold_released audit events if effective hold changed
  // - Writes metafield to Shopify (unless skipMetafieldWrite is true)
  // - Clears syncPending on metafield success, leaves true on failure/skip
  const syncResult = await syncCreditStatusMetafield(sql, buyerAccountId, source, {
    skipMetafieldWrite,
  });

  if (!syncResult.success) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold,
      error: syncResult.error,
      errorCode: syncResult.errorCode,
      retryable: syncResult.retryable ?? true,
    };
  }

  // metafieldSyncPending tells us if the metafield write succeeded
  // Three cases when metafieldSyncPending is true:
  // 1. Metafield write failed (has error) - return failure for retry
  // 2. A newer syncVersion owns the sync (no error) - return success, not our problem
  // 3. Backoff skipped the metafield write - return success with backoffSkipped flag
  if (syncResult.metafieldSyncPending && syncResult.error) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold,
      error: syncResult.error,
      errorCode: syncResult.errorCode,
      retryable: syncResult.retryable ?? true,
    };
  }

  // For no-owner accounts, metafield was NOT written (no Shopify call made)
  // For normal accounts, metafieldWritten = !syncResult.metafieldSyncPending
  const metafieldWritten = syncResult.noOwner ? false : !syncResult.metafieldSyncPending;

  // Re-read the account to get the actual post-sync hold state
  const [postSyncAccount] = await sql<{ holdState: string; bypass: boolean }[]>`
    SELECT "holdState", bypass FROM "BuyerAccount" WHERE id = ${buyerAccountId}
  `;
  const finalHold = postSyncAccount?.holdState === "HELD" && !postSyncAccount?.bypass;

  // Log backoff skip with safeLog (buyerAccountId is in the allowlist, numbers pass through)
  if (skipMetafieldWrite && backoffInfo) {
    safeLog("info", "credit_status_sync_backoff_skip", {
      buyerAccountId,
      errorAgeDays: backoffInfo.errorAgeDays,
      nextRetryDay: backoffInfo.nextRetryDay,
    });
  }

  console.log(
    `[credit-status-recompute] ${metafieldWritten ? "Updated" : skipMetafieldWrite ? "Backoff-skipped" : "Synced"} ${buyerAccountId}: hold ${previousHold} -> ${finalHold}`,
  );

  return {
    success: true,
    metafieldWritten,
    previousHold,
    newHold: finalHold,
    noOwner: syncResult.noOwner,
    backoffSkipped: skipMetafieldWrite,
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
