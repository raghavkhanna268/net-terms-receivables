/**
 * Reconcile handlers for S10b.
 *
 * Handles RECONCILE_COMPANIES and RECONCILE_ORDERS messages by starting
 * bulk exports via the Admin API. Also provides the order refetch null
 * metric recording function.
 *
 * Flow:
 * 1. pg_cron calls /jobs/drain?reconcile=true at 02:00 UTC daily
 * 2. enqueueReconcileForAllShops enqueues RECONCILE_* messages per shop
 * 3. Drain processor calls these handlers
 * 4. Handler starts bulk operation via Admin API
 * 5. BULK_OPERATIONS_FINISH webhook triggers JSONL processing
 */

import type { Sql } from "~/lib/db-light.server";
import type { SyncResult } from "~/services/sync/types";
import { markWebhookProcessed } from "~/services/sync/company.server";
import { adminGraphQL } from "./admin-client.server";
import {
  BULK_COMPANIES_QUERY,
  BULK_ORDERS_QUERY,
  parseBulkOperationResult,
  registerBulkOperation,
} from "~/services/sync/bulk-operations.server";

/**
 * Start a reconcile bulk operation for a shop.
 *
 * Executes a bulkOperationRunQuery mutation and registers the operation
 * for tracking. The BULK_OPERATIONS_FINISH webhook will handle completion.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param kind - Type of reconcile ("companies" or "orders")
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result
 */
export async function startReconcileBulkOperation(
  sql: Sql,
  shop: string,
  kind: "companies" | "orders",
  webhookId: string
): Promise<SyncResult> {
  // Select the appropriate mutation
  const mutation = kind === "companies" ? BULK_COMPANIES_QUERY : BULK_ORDERS_QUERY;

  // Start the bulk operation
  const result = await adminGraphQL<{
    bulkOperationRunQuery?: {
      bulkOperation?: {
        id: string;
        status: string;
      } | null;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  }>(shop, mutation);

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  // Parse the mutation result
  const parsed = parseBulkOperationResult(result.data ?? null);

  if (!parsed.success || !parsed.bulkOperationId) {
    return {
      success: false,
      action: "skipped",
      error: parsed.error || "Failed to start bulk operation",
    };
  }

  // Register the bulk operation for tracking
  await registerBulkOperation(sql, parsed.bulkOperationId, shop, kind);

  // Mark webhook as processed
  await markWebhookProcessed(sql, webhookId, `RECONCILE_${kind.toUpperCase()}`, parsed.bulkOperationId);

  console.log(
    `[reconcile] Started ${kind} bulk operation for ${shop}: ${parsed.bulkOperationId}`
  );

  return {
    success: true,
    action: "created",
    entityId: parsed.bulkOperationId,
  };
}

/**
 * Record an order refetch null event.
 *
 * Called when an order re-fetch returns null (typically because the order
 * is >60 days old and we don't have read_all_orders scope).
 *
 * This is a metric counter, NOT a log with PII. It records:
 * - shop domain
 * - order GID (not a secret, not PII)
 * - topic that triggered the re-fetch
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param orderGid - Order GID that returned null
 * @param topic - Webhook topic (ORDERS_CREATE, ORDERS_UPDATED, etc.)
 */
export async function recordOrderRefetchNull(
  sql: Sql,
  shop: string,
  orderGid: string,
  topic: string
): Promise<void> {
  await sql`
    INSERT INTO s10b_order_refetch_null (shop, order_gid, topic)
    VALUES (${shop}, ${orderGid}, ${topic})
  `;
}

/**
 * Get order refetch null count for a shop.
 *
 * Used for monitoring and debugging. Returns the count of null re-fetches
 * for the shop, optionally filtered by date range.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param since - Optional: only count events after this date
 * @returns Count of null re-fetch events
 */
export async function getOrderRefetchNullCount(
  sql: Sql,
  shop: string,
  since?: Date
): Promise<number> {
  if (since) {
    const [result] = await sql<{ count: string }[]>`
      SELECT COUNT(*) as count
      FROM s10b_order_refetch_null
      WHERE shop = ${shop} AND recorded_at >= ${since}
    `;
    return parseInt(result?.count ?? "0", 10);
  }

  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*) as count
    FROM s10b_order_refetch_null
    WHERE shop = ${shop}
  `;
  return parseInt(result?.count ?? "0", 10);
}
