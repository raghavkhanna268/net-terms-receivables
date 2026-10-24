/**
 * Initial Sync Helper for S23-04.
 *
 * Derives sync status from existing s6_bulk_operations and s6_dead_letter tables.
 * Provides enqueue function to trigger reconcile for a single shop.
 *
 * Status is derived from the LATEST run only (most recent s6_bulk_operations row
 * per reconcile stage). DLQ lookups are scoped to that run's bulk_op_id.
 *
 * Status states:
 * - not_started: No bulk operations with origin='reconcile' exist for the shop
 * - in_progress: Latest run exists but companies or orders stage is incomplete
 * - done: Both companies and orders stages have completed_at set in latest run
 * - failed: Latest run has failure_count >= 5 or entries exist in DLQ for that run
 *
 * @module
 */

import type { Sql } from "./db-light.server";
import { safeLog, shopHash } from "./log.server";
import { S6_QUEUES } from "./pgmq.server";
import { ReconcileMessage } from "~/services/drain/reconcile.server";

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
  bulk_op_id: string;
  reconcile_stage: string | null;
  completed_at: Date | null;
  failure_count: number;
  started_at: Date;
}

/**
 * Get the initial sync status for a shop.
 *
 * Derives status from the LATEST s6_bulk_operations row per stage:
 * - not_started: No bulk operations with origin='reconcile' exist for the shop
 * - in_progress: Latest run exists but not all stages have completed_at
 * - done: Both companies and orders stages have completed_at set
 * - failed: Latest run has failure_count >= MAX_FAILURE_COUNT or in DLQ for that run
 *
 * DLQ lookups are scoped to the latest run's bulk_op_id.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Initial sync state
 */
export async function getInitialSyncState(
  sql: Sql,
  shopDomain: string
): Promise<InitialSyncState> {
  const operations = await sql<BulkOperation[]>`
    SELECT DISTINCT ON (reconcile_stage)
      bulk_op_id, reconcile_stage, completed_at, failure_count, started_at
    FROM s6_bulk_operations
    WHERE shop = ${shopDomain} AND origin = 'reconcile'
    ORDER BY reconcile_stage, started_at DESC
  `;

  if (operations.length === 0) {
    return { status: "not_started" };
  }

  const companiesOp = operations.find((op) => op.reconcile_stage === "companies");
  const ordersOp = operations.find((op) => op.reconcile_stage === "orders");

  const bulkOpIds = operations.map((op) => op.bulk_op_id).filter(Boolean);

  const dlqCount = bulkOpIds.length > 0 ? await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM s6_dead_letter
    WHERE message->>'bulkOperationId' = ANY(${bulkOpIds})
      AND message->>'topic' IN ('RECONCILE_COMPANIES', 'RECONCILE_ORDERS', 'BULK_OPERATIONS_FINISH')
  ` : [{ count: "0" }];

  const hasDlqEntries = parseInt(dlqCount[0]?.count ?? "0", 10) > 0;

  const hasFailedOperation = operations.some(
    (op) => op.failure_count >= MAX_FAILURE_COUNT
  );

  if (hasFailedOperation || hasDlqEntries) {
    return { status: "failed" };
  }

  const companiesComplete = companiesOp != null && companiesOp.completed_at !== null;
  const ordersComplete = ordersOp != null && ordersOp.completed_at !== null;

  if (companiesComplete && ordersComplete) {
    return { status: "done" };
  }

  if (companiesOp || ordersOp) {
    return { status: "in_progress" };
  }

  return { status: "not_started" };
}

/**
 * Generate a manual webhookId for initial sync.
 * Format: reconcile:<shop>:manual:<timestamp>:companies
 *
 * Uses a timestamp instead of date to allow multiple manual retries per day.
 * The drain accepts any webhookId format.
 */
function makeManualWebhookId(shopDomain: string): string {
  const timestamp = Date.now();
  return `reconcile:${shopDomain}:manual:${timestamp}:companies`;
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
 * After companies complete, RECONCILE_ORDERS is automatically enqueued.
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

  const webhookId = makeManualWebhookId(shopDomain);
  const now = new Date().toISOString();

  const message: ReconcileMessage = {
    topic: "RECONCILE_COMPANIES",
    shop: shopDomain,
    webhookId,
    enqueuedAt: now,
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
