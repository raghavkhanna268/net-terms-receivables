/**
 * Initial Sync Helper for S23-04.
 *
 * Derives sync status from existing s6_bulk_operations and s6_dead_letter tables.
 * Provides enqueue function to trigger reconcile for a single shop.
 *
 * Status states:
 * - not_started: No bulk operations with origin='reconcile' exist for the shop
 * - in_progress: Operations exist but companies or orders stage is incomplete
 * - done: Both companies and orders stages have completed_at set
 * - failed: Operations have failure_count >= 5 or entries exist in s6_dead_letter
 *
 * @module
 */

import type { Sql } from "./db-light.server";
import { S6_QUEUES } from "./pgmq.server";
import { safeLog, shopHash } from "./log.server";

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
 * Get the initial sync status for a shop.
 *
 * Derives status from s6_bulk_operations and s6_dead_letter tables:
 * - not_started: No bulk operations with origin='reconcile' exist for the shop
 * - in_progress: Operations exist but not all stages have completed_at
 * - done: Both companies and orders stages have completed_at set
 * - failed: Operations have failure_count >= MAX_FAILURE_COUNT or in DLQ
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Initial sync state
 */
export async function getInitialSyncState(
  sql: Sql,
  shopDomain: string
): Promise<InitialSyncState> {
  const [operations, dlqCount] = await Promise.all([
    sql<{
      reconcile_stage: string | null;
      completed_at: Date | null;
      failure_count: number;
    }[]>`
      SELECT reconcile_stage, completed_at, failure_count
      FROM s6_bulk_operations
      WHERE shop = ${shopDomain} AND origin = 'reconcile'
      ORDER BY started_at DESC
      LIMIT 10
    `,
    sql<{ count: string }[]>`
      SELECT COUNT(*)::text as count
      FROM s6_dead_letter
      WHERE message->>'shop' = ${shopDomain}
        AND message->>'topic' IN ('RECONCILE_COMPANIES', 'RECONCILE_ORDERS', 'BULK_OPERATIONS_FINISH')
    `,
  ]);

  const hasDlqEntries = parseInt(dlqCount[0]?.count ?? "0", 10) > 0;

  if (operations.length === 0) {
    if (hasDlqEntries) {
      return { status: "failed" };
    }
    return { status: "not_started" };
  }

  const hasFailedOperation = operations.some(
    (op) => op.failure_count >= MAX_FAILURE_COUNT
  );

  if (hasFailedOperation || hasDlqEntries) {
    return { status: "failed" };
  }

  const companiesOp = operations.find((op) => op.reconcile_stage === "companies");
  const ordersOp = operations.find((op) => op.reconcile_stage === "orders");

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
 * Enqueue reconcile for a single shop.
 *
 * Starts the initial sync by enqueuing a RECONCILE_COMPANIES message.
 * The drain will process it and start the bulk operation.
 * After companies complete, RECONCILE_ORDERS is automatically enqueued.
 *
 * Idempotent: Uses webhookId format "reconcile:<shop>:<YYYY-MM-DD>:companies".
 * If today's reconcile is already enqueued or complete, this is a no-op.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Whether the message was enqueued (false if already in progress)
 */
export async function enqueueInitialSync(
  sql: Sql,
  shopDomain: string
): Promise<{ enqueued: boolean; reason?: string }> {
  const today = new Date().toISOString().split("T")[0];
  const webhookId = `reconcile:${shopDomain}:${today}:companies`;

  const [existing] = await sql<{ webhook_id: string }[]>`
    SELECT webhook_id
    FROM s6_processed_webhooks
    WHERE webhook_id = ${webhookId}
  `;

  if (existing) {
    return { enqueued: false, reason: "already_processed" };
  }

  const [inQueue] = await sql<{ msg_id: string }[]>`
    SELECT msg_id::text
    FROM pgmq.q_s6_sync
    WHERE message->>'webhookId' = ${webhookId}
    LIMIT 1
  `;

  if (inQueue) {
    return { enqueued: false, reason: "already_queued" };
  }

  const message = {
    topic: "RECONCILE_COMPANIES",
    shop: shopDomain,
    webhookId,
    enqueuedAt: new Date().toISOString(),
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
