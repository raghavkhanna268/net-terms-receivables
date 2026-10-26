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
import { sendBulkMessage, type BulkMessage, BULK_OPERATIONS_FINISH_TOPIC, S6_QUEUES } from "~/lib/pgmq.server";
import { adminGraphQL, BULK_OPERATION_STATUS_QUERY } from "./admin-client.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { BULK_ERROR_CODES } from "~/services/sync/bulk-jsonl-processor.server";

/**
 * Maximum number of stale operations to check on page load.
 * Limits the cost of recovery during user-facing requests.
 */
export const PAGE_LOAD_RECOVERY_LIMIT = 5;

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
 * Threshold in minutes for lease expiry recovery.
 *
 * When a processor dies after receiving the finish webhook but before completing,
 * the operation has finish_received_at set but completed_at NULL, and the
 * processing lease expires. The lease-contention DLQ path (bulk_lease_contention)
 * means no further finish messages will be retried.
 *
 * This threshold determines how long after lease expiry we consider the processor
 * dead. Must be >> PROCESSING_LEASE_SECONDS to avoid racing with slow processors.
 * 5 minutes (300s) vs 60s lease gives a 5x buffer.
 */
export const LEASE_EXPIRY_THRESHOLD_MINUTES = 5;

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
 * Field names match the log.server.ts allowlist (ending in Count).
 */
export interface RecoveryResult {
  /** Number of stale operations found */
  foundCount: number;
  /** Number successfully enqueued for processing (COMPLETED) */
  enqueuedCount: number;
  /** Number marked as failed (FAILED/CANCELED/EXPIRED/NOT_FOUND) */
  markedFailedCount: number;
  /** Number skipped (CREATED/RUNNING) */
  skippedCount: number;
  /** Number that encountered errors during recovery */
  errorCount: number;
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
 * S25: An operation is stale if:
 * - completed_at IS NULL (not finished)
 * - closed_at IS NULL (not closed by reinstall reset)
 * - failure_count < MAX_FAILURE_COUNT (not already marked failed)
 * - finish_received_at IS NULL (never received the finish webhook)
 * - processing_lease_until IS NULL OR < NOW() (not currently being processed)
 * - started_at < NOW() - STALE_THRESHOLD_MINUTES (old enough)
 * - Shop is still installed (uninstalledAt IS NULL)
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
    SELECT bo.bulk_operation_id, bo.shop, bo.bulk_type, bo.started_at
    FROM s6_bulk_operations bo
    INNER JOIN "Shop" s ON s.domain = bo.shop
    WHERE bo.completed_at IS NULL
      AND bo.closed_at IS NULL
      AND bo.failure_count < ${MAX_FAILURE_COUNT}
      AND bo.finish_received_at IS NULL
      AND (bo.processing_lease_until IS NULL OR bo.processing_lease_until < NOW())
      AND bo.started_at < NOW() - INTERVAL '1 minute' * ${thresholdMinutes}
      AND s."uninstalledAt" IS NULL
    ORDER BY bo.started_at ASC
  `;
  return rows;
}

/**
 * Find bulk operations with expired processing leases that need re-enqueueing.
 *
 * S25: This handles the "stranded op" case where:
 * - The finish webhook arrived (finish_received_at IS NOT NULL)
 * - Processing started but the processor died (lease expired)
 * - The finish message was DLQ'd as bulk_lease_contention
 * - No further retries will occur, leaving the op stuck
 *
 * Recovery re-enqueues such ops so they can be processed again.
 *
 * @param sql - postgres.js SQL client
 * @param thresholdMinutes - Minutes after lease expiry to consider dead
 * @returns List of lease-expired operations
 */
export async function findLeaseExpiredBulkOperations(
  sql: Sql,
  thresholdMinutes: number = LEASE_EXPIRY_THRESHOLD_MINUTES
): Promise<StaleBulkOperation[]> {
  const rows = await sql<StaleBulkOperation[]>`
    SELECT bo.bulk_operation_id, bo.shop, bo.bulk_type, bo.started_at
    FROM s6_bulk_operations bo
    INNER JOIN "Shop" s ON s.domain = bo.shop
    WHERE bo.completed_at IS NULL
      AND bo.closed_at IS NULL
      AND bo.failure_count < ${MAX_FAILURE_COUNT}
      AND bo.finish_received_at IS NOT NULL
      AND bo.processing_lease_until IS NOT NULL
      AND bo.processing_lease_until < NOW() - make_interval(mins => ${thresholdMinutes})
      AND s."uninstalledAt" IS NULL
    ORDER BY bo.started_at ASC
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

  const status = String(result.data.node.status ?? "").toUpperCase();
  return { status: status as ShopifyBulkOperationStatus };
}

/**
 * Mark a bulk operation as failed by setting failure_count to MAX_FAILURE_COUNT.
 *
 * S25: Also writes a DLQ row with error code bulk_stale_recovery so the FAILED
 * initial-sync state can be explained.
 *
 * Uses conditional UPDATE with completed_at IS NULL and shop to avoid race with
 * concurrent finish webhook processing and cross-shop mismatches.
 *
 * @param sql - postgres.js SQL client
 * @param bulkOperationId - Bulk operation GID
 * @param shop - Shop domain
 * @param bulkType - Type of bulk operation (for DLQ message)
 * @param shopifyStatus - Shopify status that caused the failure
 * @returns True if the row was updated, false if already completed
 */
export async function markBulkOperationFailed(
  sql: Sql,
  bulkOperationId: string,
  shop: string,
  bulkType?: "companies" | "orders" | "customers",
  shopifyStatus?: string
): Promise<boolean> {
  const marked = await sql.begin(async (tx) => {
    const result = await tx`
      UPDATE s6_bulk_operations
      SET failure_count = ${MAX_FAILURE_COUNT}
      WHERE bulk_operation_id = ${bulkOperationId}
        AND shop = ${shop}
        AND completed_at IS NULL
        AND closed_at IS NULL
      RETURNING bulk_operation_id, bulk_type
    `;
    
    if (result.count === 0) {
      return false;
    }
    
    // S25: Write DLQ row with bulk_stale_recovery error code
    const opBulkType = bulkType || result[0]?.bulk_type || "unknown";
    const dlqMessage: BulkMessage = {
      topic: BULK_OPERATIONS_FINISH_TOPIC,
      shop,
      webhookId: `stale-recovery:${bulkOperationId}`,
      bulkOperationId,
      bulkType: opBulkType as "companies" | "orders" | "customers",
      enqueuedAt: new Date().toISOString(),
    };
    
    await tx`
      INSERT INTO s6_dead_letter (
        original_queue,
        original_msg_id,
        message,
        error,
        dead_lettered_at
      ) VALUES (
        ${S6_QUEUES.BULK},
        ${`stale-recovery-${bulkOperationId}`},
        ${tx.json(dlqMessage)},
        ${BULK_ERROR_CODES.STALE_RECOVERY},
        NOW()
      )
    `;
    
    return true;
  });

  // S25: Log when marking failed with allowlisted keys only
  if (marked) {
    const hash = await shopHash(shop);
    safeLog("warn", "bulk_op_recovery_marked_failed", {
      shopHash: hash,
      bulkType: bulkType ?? "unknown",
      status: shopifyStatus ?? "unknown",
    });
  }

  return marked;
}

/**
 * Enqueue a BULK_OPERATIONS_FINISH message to process a completed operation.
 *
 * Uses conditional check to avoid race: only enqueues if operation is still
 * open (completed_at IS NULL). Also checks for existing unprocessed messages
 * with the same webhookId to ensure idempotency across multiple recovery calls.
 *
 * @param sql - postgres.js SQL client
 * @param op - The stale bulk operation
 * @returns True if enqueued, false if already completed, failed, or message exists
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
        AND shop = ${op.shop}
        AND completed_at IS NULL
        AND closed_at IS NULL
      FOR UPDATE
    `;

    if (!stillOpen) {
      return false;
    }

    const [existingMsg] = await tx<{ msg_id: string }[]>`
      SELECT msg_id::text
      FROM pgmq.q_s6_bulk
      WHERE message->>'topic' = ${BULK_OPERATIONS_FINISH_TOPIC}
        AND message->>'shop' = ${op.shop}
        AND message->>'bulkOperationId' = ${op.bulk_operation_id}
      LIMIT 1
    `;

    if (existingMsg) {
      return false;
    }

    const recoveryWebhookId = `recovery:${op.bulk_operation_id}`;

    const message: BulkMessage = {
      topic: BULK_OPERATIONS_FINISH_TOPIC,
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
    const marked = await markBulkOperationFailed(sql, op.bulk_operation_id, op.shop, op.bulk_type, "NOT_FOUND");
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
      const marked = await markBulkOperationFailed(sql, op.bulk_operation_id, op.shop, op.bulk_type, status);
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
 * 1. Finds all stale operations (open > STALE_THRESHOLD_MINUTES, no finish webhook)
 * 2. Finds lease-expired operations (finish arrived, processor died)
 * 3. Queries Shopify for each operation's status
 * 4. Takes appropriate action based on status
 *
 * Safe to call repeatedly; idempotent via conditional updates and
 * existing webhook deduplication.
 *
 * @param sql - postgres.js SQL client
 * @param thresholdMinutes - Optional override for stale threshold (for testing)
 * @param leaseExpiryThresholdMinutes - Optional override for lease expiry threshold
 * @returns Recovery statistics
 */
export async function recoverStaleBulkOperations(
  sql: Sql,
  thresholdMinutes: number = STALE_THRESHOLD_MINUTES,
  leaseExpiryThresholdMinutes: number = LEASE_EXPIRY_THRESHOLD_MINUTES
): Promise<RecoveryResult> {
  const staleOps = await findStaleBulkOperations(sql, thresholdMinutes);
  const leaseExpiredOps = await findLeaseExpiredBulkOperations(sql, leaseExpiryThresholdMinutes);

  const seenIds = new Set(staleOps.map((op) => op.bulk_operation_id));
  // Handle case where leaseExpiredOps might not be an array in unit tests with mocked SQL
  const leaseExpiredOpsArray = Array.isArray(leaseExpiredOps) ? leaseExpiredOps : [];
  const uniqueLeaseExpiredOps = leaseExpiredOpsArray.filter(
    (op) => !seenIds.has(op.bulk_operation_id)
  );
  const allOps = [...staleOps, ...uniqueLeaseExpiredOps];

  const result: RecoveryResult = {
    foundCount: allOps.length,
    enqueuedCount: 0,
    markedFailedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    attempts: [],
  };

  if (allOps.length === 0) {
    return result;
  }

  for (const op of allOps) {
    const attemptResult = await recoverSingleOperation(sql, op);
    result.attempts.push(attemptResult);

    switch (attemptResult.status) {
      case "enqueued":
        result.enqueuedCount++;
        break;
      case "marked_failed":
        result.markedFailedCount++;
        break;
      case "skipped":
        result.skippedCount++;
        break;
      case "error":
        result.errorCount++;
        break;
    }
  }

  if (result.enqueuedCount > 0 || result.markedFailedCount > 0) {
    safeLog("info", "bulk_op_recovery_completed", {
      foundCount: result.foundCount,
      enqueuedCount: result.enqueuedCount,
      markedFailedCount: result.markedFailedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });
  }

  if (result.errorCount > 0) {
    safeLog("warn", "bulk_op_recovery_errors", {
      foundCount: result.foundCount,
      errorCount: result.errorCount,
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
 * @param limit - Optional limit on number of operations to check (for page load)
 * @returns Recovery statistics for the shop
 */
export async function recoverStaleBulkOperationsForShop(
  sql: Sql,
  shop: string,
  thresholdMinutes: number = STALE_THRESHOLD_MINUTES,
  limit?: number
): Promise<RecoveryResult> {
  const effectiveLimit = limit ?? 1000;
  const staleOps = await sql<StaleBulkOperation[]>`
    SELECT bulk_operation_id, shop, bulk_type, started_at
    FROM s6_bulk_operations
    WHERE shop = ${shop}
      AND completed_at IS NULL
      AND closed_at IS NULL
      AND failure_count < ${MAX_FAILURE_COUNT}
      AND started_at < NOW() - INTERVAL '1 minute' * ${thresholdMinutes}
    ORDER BY started_at ASC
    LIMIT ${effectiveLimit}
  `;

  const result: RecoveryResult = {
    foundCount: staleOps.length,
    enqueuedCount: 0,
    markedFailedCount: 0,
    skippedCount: 0,
    errorCount: 0,
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
        result.enqueuedCount++;
        break;
      case "marked_failed":
        result.markedFailedCount++;
        break;
      case "skipped":
        result.skippedCount++;
        break;
      case "error":
        result.errorCount++;
        break;
    }
  }

  if (result.enqueuedCount > 0 || result.markedFailedCount > 0) {
    const hash = await shopHash(shop);
    safeLog("info", "bulk_op_recovery_shop_completed", {
      shopHash: hash,
      foundCount: result.foundCount,
      enqueuedCount: result.enqueuedCount,
      markedFailedCount: result.markedFailedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
    });
  }

  if (result.errorCount > 0) {
    const hash = await shopHash(shop);
    safeLog("warn", "bulk_op_recovery_shop_errors", {
      shopHash: hash,
      foundCount: result.foundCount,
      errorCount: result.errorCount,
    });
  }

  return result;
}
