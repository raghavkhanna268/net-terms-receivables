/**
 * Bulk operation recovery for stuck/orphaned operations.
 *
 * When a bulk_operations/finish webhook is missed (network, outage, status-case bug),
 * rows in s6_bulk_operations remain stuck open (completed_at IS NULL) forever.
 * This prevents initial sync and nightly reconciles from completing.
 *
 * This module provides a recovery mechanism that:
 * 1. Finds open rows older than STALE_THRESHOLD_MINUTES
 * 2. Queries Shopify for each operation's actual status
 * 3. For COMPLETED: enqueues BULK_OPERATIONS_FINISH to process normally
 * 4. For FAILED/CANCELED/EXPIRED/NOT_FOUND: marks as failed (failure_count=5)
 * 5. For CREATED/RUNNING: leaves alone (still in progress)
 *
 * Race safety: Uses conditional UPDATE with completed_at IS NULL check.
 * The BULK_OPERATIONS_FINISH handler already has idempotency via isWebhookProcessed.
 *
 * @module
 */

import type { Sql } from "~/lib/db-light.server";
import { sendBulkMessage, type BulkMessage } from "~/lib/pgmq.server";
import { adminGraphQL, BULK_OPERATION_STATUS_QUERY } from "./admin-client.server";
import { safeLog, shopHash } from "~/lib/log.server";

/**
 * Threshold in minutes after which an open bulk operation is considered stale.
 *
 * Justification: Shopify bulk operations typically complete within minutes for
 * small shops (< 1 hour even for large shops). 60 minutes provides a safe buffer
 * that allows legitimate long-running operations to complete while catching
 * genuinely stuck operations (e.g., from missed webhooks).
 *
 * This is intentionally conservative to avoid false positives. The nightly
 * reconcile runs at 02:00 UTC, so any operation started > 60 min ago during
 * that run would be recovered on the next nightly run.
 */
export const STALE_THRESHOLD_MINUTES = 60;

/**
 * Maximum failure count that marks an operation as failed.
 * Matches MAX_FAILURE_COUNT from bulk-jsonl-processor.server.ts.
 */
const MAX_FAILURE_COUNT = 5;

/**
 * Shopify bulk operation statuses (GraphQL enum).
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/enums/BulkOperationStatus
 */
type ShopifyBulkOperationStatus =
  | "CANCELED"
  | "CANCELING"
  | "COMPLETED"
  | "CREATED"
  | "EXPIRED"
  | "FAILED"
  | "RUNNING";

/**
 * Result of a single bulk operation recovery attempt.
 */
export interface RecoveryAttemptResult {
  bulkOperationId: string;
  shop: string;
  status: "enqueued" | "marked_failed" | "skipped" | "error";
  shopifyStatus?: string;
  error?: string;
}

/**
 * Result of the bulk operation recovery run.
 */
export interface RecoveryResult {
  /** Number of stale operations found */
  found: number;
  /** Number successfully enqueued for processing (COMPLETED) */
  enqueued: number;
  /** Number marked as failed (FAILED/CANCELED/EXPIRED/NOT_FOUND) */
  markedFailed: number;
  /** Number skipped (CREATED/RUNNING) */
  skipped: number;
  /** Number that encountered errors during recovery */
  errors: number;
  /** Individual attempt results */
  attempts: RecoveryAttemptResult[];
}

/**
 * Stale bulk operation row from the database.
 */
interface StaleBulkOperation {
  bulk_operation_id: string;
  shop: string;
  bulk_type: "companies" | "orders" | "customers";
  started_at: Date;
}

/**
 * Find stale bulk operations that need recovery.
 *
 * An operation is stale if:
 * - completed_at IS NULL (not finished)
 * - started_at < NOW() - STALE_THRESHOLD_MINUTES
 *
 * @param sql - postgres.js SQL client
 * @param thresholdMinutes - Optional override for threshold (for testing)
 * @returns List of stale operations
 */
export async function findStaleBulkOperations(
  sql: Sql,
  thresholdMinutes: number = STALE_THRESHOLD_MINUTES
): Promise<StaleBulkOperation[]> {
  const rows = await sql<StaleBulkOperation[]>`
    SELECT bulk_operation_id, shop, bulk_type, started_at
    FROM s6_bulk_operations
    WHERE completed_at IS NULL
      AND started_at < NOW() - INTERVAL '1 minute' * ${thresholdMinutes}
    ORDER BY started_at ASC
  `;
  return rows;
}

/**
 * Query Shopify for a bulk operation's current status.
 *
 * @param shop - Shop domain
 * @param bulkOperationId - Bulk operation GID
 * @returns Status string or null if not found
 */
async function queryShopifyBulkOperationStatus(
  shop: string,
  bulkOperationId: string
): Promise<{ status: ShopifyBulkOperationStatus | null; error?: string }> {
  const result = await adminGraphQL<{
    node: { id: string; status: string } | null;
  }>(shop, BULK_OPERATION_STATUS_QUERY, { id: bulkOperationId });

  if (!result.success) {
    return { status: null, error: result.error };
  }

  if (!result.data?.node) {
    return { status: null };
  }

  return { status: result.data.node.status as ShopifyBulkOperationStatus };
}

/**
 * Mark a bulk operation as failed by setting failure_count to MAX_FAILURE_COUNT.
 *
 * Uses conditional UPDATE with completed_at IS NULL to avoid race with
 * concurrent finish webhook processing.
 *
 * @param sql - postgres.js SQL client
 * @param bulkOperationId - Bulk operation GID
 * @returns True if the row was updated, false if already completed
 */
export async function markBulkOperationFailed(
  sql: Sql,
  bulkOperationId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE s6_bulk_operations
    SET failure_count = ${MAX_FAILURE_COUNT}
    WHERE bulk_operation_id = ${bulkOperationId}
      AND completed_at IS NULL
  `;
  return result.count > 0;
}

/**
 * Enqueue a BULK_OPERATIONS_FINISH message to process a completed operation.
 *
 * Uses conditional check to avoid race: only enqueues if operation is still
 * open (completed_at IS NULL). The BULK_OPERATIONS_FINISH handler has its
 * own idempotency via isWebhookProcessed.
 *
 * @param sql - postgres.js SQL client
 * @param op - The stale bulk operation
 * @returns True if enqueued, false if already completed or failed
 */
async function enqueueCompletedOperation(
  sql: Sql,
  op: StaleBulkOperation
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [stillOpen] = await tx<{ bulk_operation_id: string }[]>`
      SELECT bulk_operation_id
      FROM s6_bulk_operations
      WHERE bulk_operation_id = ${op.bulk_operation_id}
        AND completed_at IS NULL
      FOR UPDATE
    `;

    if (!stillOpen) {
      return false;
    }

    const recoveryWebhookId = `recovery:${op.shop}:${Date.now()}:${op.bulk_operation_id}`;
    const message: BulkMessage = {
      topic: "bulk_operations/finish",
      shop: op.shop,
      webhookId: recoveryWebhookId,
      bulkOperationId: op.bulk_operation_id,
      bulkType: op.bulk_type,
      enqueuedAt: new Date().toISOString(),
    };

    await sendBulkMessage(tx, message);
    return true;
  });
}

/**
 * Recover a single stale bulk operation.
 *
 * @param sql - postgres.js SQL client
 * @param op - The stale bulk operation
 * @returns Result of the recovery attempt
 */
async function recoverSingleOperation(
  sql: Sql,
  op: StaleBulkOperation
): Promise<RecoveryAttemptResult> {
  const { status, error } = await queryShopifyBulkOperationStatus(
    op.shop,
    op.bulk_operation_id
  );

  if (error) {
    return {
      bulkOperationId: op.bulk_operation_id,
      shop: op.shop,
      status: "error",
      error,
    };
  }

  if (status === null) {
    const marked = await markBulkOperationFailed(sql, op.bulk_operation_id);
    return {
      bulkOperationId: op.bulk_operation_id,
      shop: op.shop,
      status: marked ? "marked_failed" : "skipped",
      shopifyStatus: "NOT_FOUND",
    };
  }

  switch (status) {
    case "COMPLETED": {
      const enqueued = await enqueueCompletedOperation(sql, op);
      return {
        bulkOperationId: op.bulk_operation_id,
        shop: op.shop,
        status: enqueued ? "enqueued" : "skipped",
        shopifyStatus: status,
      };
    }

    case "FAILED":
    case "CANCELED":
    case "EXPIRED": {
      const marked = await markBulkOperationFailed(sql, op.bulk_operation_id);
      return {
        bulkOperationId: op.bulk_operation_id,
        shop: op.shop,
        status: marked ? "marked_failed" : "skipped",
        shopifyStatus: status,
      };
    }

    case "CREATED":
    case "RUNNING":
    case "CANCELING":
    default:
      return {
        bulkOperationId: op.bulk_operation_id,
        shop: op.shop,
        status: "skipped",
        shopifyStatus: status,
      };
  }
}

/**
 * Recover stale bulk operations.
 *
 * This is the main entry point for the recovery mechanism. It:
 * 1. Finds all stale operations (open > STALE_THRESHOLD_MINUTES)
 * 2. Queries Shopify for each operation's status
 * 3. Takes appropriate action based on status
 *
 * Safe to call repeatedly; idempotent via conditional updates and
 * existing webhook deduplication.
 *
 * @param sql - postgres.js SQL client
 * @param thresholdMinutes - Optional override for threshold (for testing)
 * @returns Recovery statistics
 */
export async function recoverStaleBulkOperations(
  sql: Sql,
  thresholdMinutes: number = STALE_THRESHOLD_MINUTES
): Promise<RecoveryResult> {
  const staleOps = await findStaleBulkOperations(sql, thresholdMinutes);

  const result: RecoveryResult = {
    found: staleOps.length,
    enqueued: 0,
    markedFailed: 0,
    skipped: 0,
    errors: 0,
    attempts: [],
  };

  if (staleOps.length === 0) {
    return result;
  }

  for (const op of staleOps) {
    const attemptResult = await recoverSingleOperation(sql, op);
    result.attempts.push(attemptResult);

    switch (attemptResult.status) {
      case "enqueued":
        result.enqueued++;
        break;
      case "marked_failed":
        result.markedFailed++;
        break;
      case "skipped":
        result.skipped++;
        break;
      case "error":
        result.errors++;
        break;
    }
  }

  if (result.enqueued > 0 || result.markedFailed > 0) {
    const hash = staleOps.length > 0 ? await shopHash(staleOps[0].shop) : "unknown";
    safeLog("info", "bulk_op_recovery_completed", {
      shopHash: hash,
      found: result.found,
      enqueued: result.enqueued,
      markedFailed: result.markedFailed,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  if (result.errors > 0) {
    safeLog("warn", "bulk_op_recovery_failed", {
      found: result.found,
      errors: result.errors,
    });
  }

  return result;
}

/**
 * Recover stale bulk operations for a specific shop.
 *
 * Used when onboarding detects an in_progress state that's older than
 * the threshold. More targeted than the global recovery.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param thresholdMinutes - Optional override for threshold (for testing)
 * @returns Recovery statistics for the shop
 */
export async function recoverStaleBulkOperationsForShop(
  sql: Sql,
  shop: string,
  thresholdMinutes: number = STALE_THRESHOLD_MINUTES
): Promise<RecoveryResult> {
  const staleOps = await sql<StaleBulkOperation[]>`
    SELECT bulk_operation_id, shop, bulk_type, started_at
    FROM s6_bulk_operations
    WHERE shop = ${shop}
      AND completed_at IS NULL
      AND started_at < NOW() - INTERVAL '1 minute' * ${thresholdMinutes}
    ORDER BY started_at ASC
  `;

  const result: RecoveryResult = {
    found: staleOps.length,
    enqueued: 0,
    markedFailed: 0,
    skipped: 0,
    errors: 0,
    attempts: [],
  };

  if (staleOps.length === 0) {
    return result;
  }

  for (const op of staleOps) {
    const attemptResult = await recoverSingleOperation(sql, op);
    result.attempts.push(attemptResult);

    switch (attemptResult.status) {
      case "enqueued":
        result.enqueued++;
        break;
      case "marked_failed":
        result.markedFailed++;
        break;
      case "skipped":
        result.skipped++;
        break;
      case "error":
        result.errors++;
        break;
    }
  }

  if (result.enqueued > 0 || result.markedFailed > 0) {
    const hash = await shopHash(shop);
    safeLog("info", "bulk_op_recovery_completed", {
      shopHash: hash,
      found: result.found,
      enqueued: result.enqueued,
      markedFailed: result.markedFailed,
      skipped: result.skipped,
      errors: result.errors,
    });
  }

  if (result.errors > 0) {
    const hash = await shopHash(shop);
    safeLog("warn", "bulk_op_recovery_failed", {
      shopHash: hash,
      found: result.found,
      errors: result.errors,
    });
  }

  return result;
}
