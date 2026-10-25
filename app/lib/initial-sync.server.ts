/**
 * Initial Sync Helper for S23-04 + S8.
 *
 * Derives sync status from existing s6_bulk_operations and s6_dead_letter tables.
 * Provides enqueue function to trigger reconcile for a single shop.
 *
 * Status is derived from the LATEST run only (most recent s6_bulk_operations row
 * per reconcile stage). DLQ lookups are scoped to that run's bulk_operation_id.
 *
 * Reconcile sequence: companies → customers → orders
 *
 * Status states:
 * - not_started: No bulk operations with origin='reconcile' exist for the shop
 * - in_progress: Latest run exists but not all stages have completed
 * - done: All stages complete (companies, customers if applicable, orders)
 * - failed: Any stage has failure_count >= 5 or entries exist in DLQ for that run
 *
 * Customers stage detection:
 * The customers stage is only required if it was planned for the current run:
 * - If a customersOp exists for this run, the stage was planned
 * - If a RECONCILE_CUSTOMERS message is queued for this shop, the stage is planned
 * - Otherwise, the stage was skipped (no tag rules at run start, or pre-S8 run)
 *
 * This avoids marking old runs (pre-S8) as "in_progress" just because tag rules
 * exist now, and handles runs that started before tag rules were created.
 *
 * @module
 */

import type { Sql } from "./db-light.server";
import { safeLog, shopHash, toErrorCode } from "./log.server";
import { S6_QUEUES } from "./pgmq.server";
import type { ReconcileMessage } from "~/services/drain/reconcile.server";
import {
  recoverStaleBulkOperationsForShop,
  STALE_THRESHOLD_MINUTES,
  PAGE_LOAD_RECOVERY_LIMIT,
} from "~/services/drain/bulk-op-recovery.server";

/**
 * Maximum failure count before considering an operation failed.
 * Matches MAX_FAILURE_COUNT from bulk-jsonl-processor.server.ts.
 */
const MAX_FAILURE_COUNT = 5;

/**
 * Initial sync status for a shop.
 */
export type InitialSyncStatus = "not_started" | "in_progress" | "done" | "failed";

/**
 * Initial sync state for a shop.
 */
export interface InitialSyncState {
  status: InitialSyncStatus;
}

/**
 * Bulk operation row from s6_bulk_operations.
 */
interface BulkOperation {
  bulk_operation_id: string;
  reconcile_stage: string | null;
  completed_at: Date | null;
  failure_count: number;
  started_at: Date;
}

/**
 * Get the initial sync status for a shop.
 *
 * Derives status from the LATEST companies op as the "current run":
 * - not_started: No bulk operations with origin='reconcile' exist for the shop
 * - in_progress: Current run exists but not all stages have completed_at
 * - done: All required stages complete (companies, customers if applicable, orders)
 * - failed: Any stage has failure_count >= MAX_FAILURE_COUNT or in DLQ
 *
 * Stage ops are only considered if they started at or after the latest
 * companies op's started_at (to avoid mixing old failed ops with new runs).
 * DLQ lookups are scoped to the current run's bulk_operation_ids.
 *
 * Customers stage detection:
 * The customers stage is only required if it was planned for the current run:
 * - If a customersOp exists for this run, the stage was planned
 * - If a RECONCILE_CUSTOMERS message is queued for this shop, the stage is planned
 * - Otherwise, the stage was not planned (skipped because no tag rules at start,
 *   or a pre-S8 run that predates the customers stage)
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Initial sync state
 */
export async function getInitialSyncState(
  sql: Sql,
  shopDomain: string
): Promise<InitialSyncState> {
  const [companiesOp] = await sql<BulkOperation[]>`
    SELECT bulk_operation_id, reconcile_stage, completed_at, failure_count, started_at
    FROM s6_bulk_operations
    WHERE shop = ${shopDomain} AND origin = 'reconcile' AND reconcile_stage = 'companies'
    ORDER BY started_at DESC
    LIMIT 1
  `;

  if (!companiesOp) {
    return { status: "not_started" };
  }

  const [customersOp] = await sql<BulkOperation[]>`
    SELECT bulk_operation_id, reconcile_stage, completed_at, failure_count, started_at
    FROM s6_bulk_operations
    WHERE shop = ${shopDomain}
      AND origin = 'reconcile'
      AND reconcile_stage = 'customers'
      AND started_at >= ${companiesOp.started_at}
    ORDER BY started_at DESC
    LIMIT 1
  `;

  const [ordersOp] = await sql<BulkOperation[]>`
    SELECT bulk_operation_id, reconcile_stage, completed_at, failure_count, started_at
    FROM s6_bulk_operations
    WHERE shop = ${shopDomain}
      AND origin = 'reconcile'
      AND reconcile_stage = 'orders'
      AND started_at >= ${companiesOp.started_at}
    ORDER BY started_at DESC
    LIMIT 1
  `;

  const bulkOpIds = [companiesOp.bulk_operation_id];
  if (customersOp) {
    bulkOpIds.push(customersOp.bulk_operation_id);
  }
  if (ordersOp) {
    bulkOpIds.push(ordersOp.bulk_operation_id);
  }

  const dlqCount = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM s6_dead_letter
    WHERE message->>'bulkOperationId' IN ${sql(bulkOpIds)}
      AND message->>'topic' IN ('RECONCILE_COMPANIES', 'RECONCILE_CUSTOMERS', 'RECONCILE_ORDERS', 'BULK_OPERATIONS_FINISH')
  `;

  const hasDlqEntries = parseInt(dlqCount[0]?.count ?? "0", 10) > 0;

  const hasFailedCompanies = companiesOp.failure_count >= MAX_FAILURE_COUNT;
  const hasFailedCustomers = customersOp != null && customersOp.failure_count >= MAX_FAILURE_COUNT;
  const hasFailedOrders = ordersOp != null && ordersOp.failure_count >= MAX_FAILURE_COUNT;

  if (hasFailedCompanies || hasFailedCustomers || hasFailedOrders || hasDlqEntries) {
    return { status: "failed" };
  }

  const companiesComplete = companiesOp.completed_at !== null;
  const ordersComplete = ordersOp != null && ordersOp.completed_at !== null;

  let customersComplete: boolean;
  if (customersOp) {
    customersComplete = customersOp.completed_at !== null;
  } else {
    const [queuedCustomers] = await sql<{ msg_id: string }[]>`
      SELECT msg_id::text
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${shopDomain}
        AND message->>'topic' = 'RECONCILE_CUSTOMERS'
      LIMIT 1
    `;
    customersComplete = queuedCustomers == null;
  }

  if (companiesComplete && customersComplete && ordersComplete) {
    return { status: "done" };
  }

  return { status: "in_progress" };
}

/**
 * Generate a manual key base and webhookId for initial sync.
 * Format: reconcile:<shop>:manual:<timestamp>:companies
 *
 * Uses a timestamp instead of date to allow multiple manual retries per day.
 * The drain accepts any webhookId format.
 *
 * Returns both the manualKey (e.g. "manual:123456") and the full webhookId.
 */
function makeManualWebhookId(shopDomain: string): { manualKey: string; webhookId: string } {
  const timestamp = Date.now();
  const manualKey = `manual:${timestamp}`;
  const webhookId = `reconcile:${shopDomain}:${manualKey}:companies`;
  return { manualKey, webhookId };
}

/**
 * Check if a manual sync is already queued for this shop.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Whether a manual sync is queued
 */
async function hasManualSyncQueued(sql: Sql, shopDomain: string): Promise<boolean> {
  const [inQueue] = await sql<{ msg_id: string }[]>`
    SELECT msg_id::text
    FROM pgmq.q_s6_sync
    WHERE message->>'shop' = ${shopDomain}
      AND message->>'topic' = 'RECONCILE_COMPANIES'
      AND message->>'webhookId' LIKE 'reconcile:%:manual:%:companies'
    LIMIT 1
  `;
  return inQueue != null;
}

/**
 * Enqueue reconcile for a single shop (manual trigger).
 *
 * Starts the initial sync by enqueuing a RECONCILE_COMPANIES message.
 * The drain will process it and start the bulk operation.
 * After companies complete, RECONCILE_CUSTOMERS is enqueued (skipped if no tag rules),
 * then RECONCILE_ORDERS is automatically enqueued.
 *
 * Uses manual idempotency key: "reconcile:<shop>:manual:<timestamp>:companies"
 * This allows retries even if today's nightly cron key was already processed.
 *
 * In-flight protection (server-side):
 * - Returns already_queued if a manual sync message is still in the queue
 * - Returns in_progress if the latest sync run is still running
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Whether the message was enqueued (false if blocked)
 */
export async function enqueueInitialSync(
  sql: Sql,
  shopDomain: string
): Promise<{ enqueued: boolean; reason?: string }> {
  if (await hasManualSyncQueued(sql, shopDomain)) {
    return { enqueued: false, reason: "already_queued" };
  }

  const state = await getInitialSyncState(sql, shopDomain);
  if (state.status === "in_progress") {
    return { enqueued: false, reason: "in_progress" };
  }

  const { manualKey, webhookId } = makeManualWebhookId(shopDomain);
  const now = new Date().toISOString();

  const message: ReconcileMessage = {
    topic: "RECONCILE_COMPANIES",
    shop: shopDomain,
    webhookId,
    enqueuedAt: now,
    manualKey,
  };

  await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json(message)})`;

  const hash = await shopHash(shopDomain);
  safeLog("info", "onboarding.initial_sync_enqueued", { shopHash: hash });

  return { enqueued: true };
}

/**
 * Check if initial sync can be started or retried.
 *
 * Returns true only if status is "not_started" or "failed".
 * Returns false if "in_progress" or "done".
 *
 * @param status - Current sync status
 * @returns Whether sync can be started/retried
 */
export function canStartSync(status: InitialSyncStatus): boolean {
  return status === "not_started" || status === "failed";
}

/**
 * Get the initial sync state with automatic recovery for stale operations.
 *
 * If the state is "in_progress" and the latest companies operation is older
 * than STALE_THRESHOLD_MINUTES, this function attempts to recover any stale
 * operations before returning the (potentially updated) state.
 *
 * Use this variant in user-facing contexts (e.g., onboarding page) where
 * automatic recovery is desirable. For internal checks where you just want
 * the raw state, use getInitialSyncState directly.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Initial sync state (potentially updated after recovery)
 */
export async function getInitialSyncStateWithRecovery(
  sql: Sql,
  shopDomain: string
): Promise<InitialSyncState> {
  const state = await getInitialSyncState(sql, shopDomain);

  if (state.status !== "in_progress") {
    return state;
  }

  const [companiesOp] = await sql<{ started_at: Date | null }[]>`
    SELECT started_at
    FROM s6_bulk_operations
    WHERE shop = ${shopDomain} AND origin = 'reconcile' AND reconcile_stage = 'companies'
    ORDER BY started_at DESC
    LIMIT 1
  `;

  if (!companiesOp || !companiesOp.started_at) {
    return state;
  }

  const ageMinutes = (Date.now() - companiesOp.started_at.getTime()) / (1000 * 60);

  if (ageMinutes < STALE_THRESHOLD_MINUTES) {
    return state;
  }

  try {
    const hash = await shopHash(shopDomain);
    safeLog("info", "bulk_op_recovery_triggered", {
      shopHash: hash,
    });

    await recoverStaleBulkOperationsForShop(sql, shopDomain, STALE_THRESHOLD_MINUTES, PAGE_LOAD_RECOVERY_LIMIT);
  } catch (err) {
    const hash = await shopHash(shopDomain);
    safeLog("error", "bulk_op_recovery_triggered_error", {
      shopHash: hash,
      err: toErrorCode(err),
    });
  }

  return getInitialSyncState(sql, shopDomain);
}
