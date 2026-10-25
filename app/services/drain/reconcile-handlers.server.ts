/**
 * Reconcile handlers for S10b + S8.
 *
 * Handles RECONCILE_COMPANIES, RECONCILE_CUSTOMERS, and RECONCILE_ORDERS
 * messages by starting bulk exports via the Admin API. Also provides the
 * order refetch null metric recording function.
 *
 * Flow:
 * 1. pg_cron calls /jobs/drain?reconcile=true at 02:00 UTC daily
 * 2. enqueueReconcileForAllShops enqueues RECONCILE_COMPANIES per shop
 * 3. Drain processor calls handleReconcileCompanies handler
 * 4. Handler starts companies bulk operation
 * 5. BULK_OPERATIONS_FINISH webhook completes companies
 * 6. After companies complete, handleBulkOperationsFinish enqueues RECONCILE_CUSTOMERS
 * 7. Customers reconcile runs (skipped if no tag rules)
 * 8. After customers complete, handleBulkOperationsFinish enqueues RECONCILE_ORDERS
 * 9. Orders reconcile runs similarly
 *
 * Sequential design: companies → customers → orders
 * - Companies must complete before customers (B2B contacts check)
 * - Customers must complete before orders (tagged customer buyer account existence)
 *
 * Customers stage skip: If a shop has no tag rules, the customers stage is
 * skipped entirely (no bulk op started) and the chain continues to orders.
 */

import type { Sql } from "~/lib/db-light.server";
import type { SyncResult } from "~/services/sync/types";
import type { ReconcileStage } from "~/services/sync/bulk-operations.server";
import { markWebhookProcessed } from "~/services/sync/company.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { adminGraphQL } from "./admin-client.server";
import {
  BULK_COMPANIES_QUERY,
  BULK_ORDERS_QUERY,
  parseBulkOperationResult,
  registerBulkOperation,
} from "~/services/sync/bulk-operations.server";
import { getBulkCustomersQuery } from "~/services/sync/customer-fields.server";
import { getTagRules } from "~/services/sync/customer.server";
import { getRequestEnv } from "~/lib/request-context.server";

/**
 * Extract manualKey from a webhookId if it follows the manual pattern.
 * Manual pattern: reconcile:<shop>:manual:<timestamp>:<stage>
 * Returns the "manual:<timestamp>" portion, or undefined for cron pattern.
 */
export function extractManualKey(webhookId: string): string | undefined {
  const match = webhookId.match(/^reconcile:[^:]+:(manual:\d+):/);
  return match ? match[1] : undefined;
}

/**
 * Get the manualKey for a bulk operation by looking up its source webhookId.
 * Used when chaining between stages after BULK_OPERATIONS_FINISH.
 *
 * Scoped to the shop to prevent cross-shop matches if two shops happen to
 * have the same bulk operation GID (unlikely but defensive).
 *
 * Looks up any reconcile stage topic (RECONCILE_COMPANIES, RECONCILE_CUSTOMERS,
 * RECONCILE_ORDERS) since the manual key is consistent across all stages.
 *
 * @param sql - postgres.js SQL client
 * @param bulkOperationId - The bulk operation GID
 * @param shop - Shop domain (for scoping the lookup)
 * @returns The manualKey if this was a manual run, undefined otherwise
 */
export async function getManualKeyForBulkOp(
  sql: Sql,
  bulkOperationId: string,
  shop: string
): Promise<string | undefined> {
  const prefix = `reconcile:${shop}:`;
  const [row] = await sql<{ webhook_id: string }[]>`
    SELECT webhook_id
    FROM s6_processed_webhooks
    WHERE resource_gid = ${bulkOperationId}
      AND topic IN ('RECONCILE_COMPANIES', 'RECONCILE_CUSTOMERS', 'RECONCILE_ORDERS')
      AND left(webhook_id, length(${prefix})) = ${prefix}
    LIMIT 1
  `;
  if (!row) return undefined;
  return extractManualKey(row.webhook_id);
}

/**
 * Start result with optional skip flag for customers stage.
 */
export interface StartReconcileResult extends SyncResult {
  skipped?: boolean;
}

/**
 * Build the GraphQL mutation for a reconcile stage.
 *
 * For customers stage, loads tag rules and builds a filtered query.
 * Returns null if the stage should be skipped (e.g., no tag rules for customers).
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param kind - Reconcile stage
 * @returns Mutation string or null to skip
 */
async function buildReconcileMutation(
  sql: Sql,
  shop: string,
  kind: ReconcileStage
): Promise<string | null> {
  if (kind === "companies") {
    return BULK_COMPANIES_QUERY;
  }

  if (kind === "orders") {
    return BULK_ORDERS_QUERY;
  }

  if (kind === "customers") {
    const [shopRow] = await sql<{ id: string }[]>`
      SELECT id FROM "Shop" WHERE domain = ${shop}
    `;
    if (!shopRow) {
      return null;
    }

    const tagRules = await getTagRules(sql, shopRow.id);
    if (tagRules.length === 0) {
      return null;
    }

    const env = getRequestEnv() ?? {};
    return getBulkCustomersQuery(tagRules, env);
  }

  return null;
}

/**
 * Start a reconcile bulk operation for a shop.
 *
 * Executes a bulkOperationRunQuery mutation and registers the operation
 * for tracking. The BULK_OPERATIONS_FINISH webhook will handle completion.
 *
 * For customers stage: loads tag rules and builds filtered query. If no tag
 * rules exist, the stage is skipped and the result includes skipped=true.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param kind - Type of reconcile (companies, customers, or orders)
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result with optional skipped flag
 */
export async function startReconcileBulkOperation(
  sql: Sql,
  shop: string,
  kind: ReconcileStage,
  webhookId: string
): Promise<StartReconcileResult> {
  const mutation = await buildReconcileMutation(sql, shop, kind);

  if (!mutation) {
    safeLog("info", "reconcile_stage_skipped", {
      shopHash: await shopHash(shop),
      stage: kind,
      reason: kind === "customers" ? "no_tag_rules" : "unknown",
    });

    return {
      success: true,
      action: "skipped",
      skipReason: kind === "customers" ? "No tag rules configured" : "Stage skipped",
      skipped: true,
    };
  }

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

  const parsed = parseBulkOperationResult(result.data ?? null);

  if (!parsed.success || !parsed.bulkOperationId) {
    return {
      success: false,
      action: "skipped",
      error: parsed.error || "Failed to start bulk operation",
    };
  }

  await registerBulkOperation(
    sql,
    parsed.bulkOperationId,
    shop,
    kind,
    "reconcile",
    kind
  );

  await markWebhookProcessed(
    sql,
    webhookId,
    `RECONCILE_${kind.toUpperCase()}`,
    parsed.bulkOperationId
  );

  safeLog("info", "reconcile_bulk_operation_started", {
    shopHash: await shopHash(shop),
    bulkType: kind,
    operationId: parsed.bulkOperationId,
  });

  return {
    success: true,
    action: "created",
    entityId: parsed.bulkOperationId,
  };
}

/**
 * Enqueue a reconcile stage message for a shop.
 * Called after a stage completes to start the next stage.
 *
 * For manual runs, pass the manualKey from the previous stage so
 * the next stage uses the same key base (allowing retry even if day key is used).
 *
 * Guard: Does not enqueue if Shop no longer exists or is uninstalled (#239).
 * FOR SHARE serializes with deleteShop's leading FOR UPDATE on the Shop row.
 *
 * #293: Also checks that the previous stage's bulk operation is not closed.
 * If prevBulkOperationId is provided and that row is closed, the stage is not
 * enqueued (the reset already closed the pipeline). This serializes with the
 * reinstall reset's UPDATE lock on the bulk operation row.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param stage - Stage to enqueue (customers or orders)
 * @param manualKey - Optional manual key base from previous stage
 * @param prevBulkOperationId - Optional bulk operation ID of the previous stage
 * @returns Whether the message was enqueued (false if shop doesn't exist, uninstalled, or prev op closed)
 */
export async function enqueueReconcileStage(
  sql: Sql,
  shop: string,
  stage: "customers" | "orders",
  manualKey?: string,
  prevBulkOperationId?: string
): Promise<boolean> {
  let webhookId: string;
  if (manualKey) {
    webhookId = `reconcile:${shop}:${manualKey}:${stage}`;
  } else {
    const today = new Date().toISOString().split("T")[0];
    webhookId = `reconcile:${shop}:${today}:${stage}`;
  }

  const topic = `RECONCILE_${stage.toUpperCase()}` as const;
  const message: { topic: string; shop: string; webhookId: string; enqueuedAt: string; manualKey?: string } = {
    topic,
    shop,
    webhookId,
    enqueuedAt: new Date().toISOString(),
  };

  if (manualKey) {
    message.manualKey = manualKey;
  }

  // Guard: check and send in one transaction with FOR SHARE (#239, #293).
  // FOR SHARE serializes with deleteShop's leading FOR UPDATE on the Shop row
  // and with reinstall reset's UPDATE lock on the bulk operation row.
  const enqueued = await sql.begin(async (tx) => {
    const [shopRow] = await tx<[{ id: string }?]>`
      SELECT id FROM "Shop"
      WHERE domain = ${shop}
        AND "uninstalledAt" IS NULL
      FOR SHARE
    `;
    if (!shopRow) {
      return false;
    }

    // #293: Check that the previous stage's bulk operation is not closed
    if (prevBulkOperationId) {
      const [prevOp] = await tx<[{ bulk_operation_id: string }?]>`
        SELECT bulk_operation_id FROM s6_bulk_operations
        WHERE bulk_operation_id = ${prevBulkOperationId}
          AND closed_at IS NULL
        FOR SHARE
      `;
      if (!prevOp) {
        return false;
      }
    }

    await tx`SELECT pgmq.send('s6_sync', ${tx.json(message)})`;
    return true;
  });

  if (enqueued) {
    safeLog("info", "reconcile_stage_enqueued", {
      shopHash: await shopHash(shop),
      stage,
    });
  }
  return enqueued;
}

/**
 * Enqueue RECONCILE_ORDERS message for a shop.
 * @deprecated Use enqueueReconcileStage(sql, shop, "orders", manualKey) instead.
 * Kept for backward compatibility with existing tests.
 */
export async function enqueueReconcileOrders(
  sql: Sql,
  shop: string,
  manualKey?: string
): Promise<boolean> {
  return enqueueReconcileStage(sql, shop, "orders", manualKey);
}

/**
 * Increment the order refetch null counter for a shop.
 *
 * Called when an order re-fetch returns null (typically because the order
 * is >60 days old and we don't have read_all_orders scope).
 *
 * Uses an aggregate table (shop, day, count) - no PII, no individual order IDs.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 */
export async function incrementOrderRefetchNull(
  sql: Sql,
  shop: string
): Promise<void> {
  await sql`
    INSERT INTO s10b_order_refetch_null (shop, day, count)
    VALUES (${shop}, CURRENT_DATE, 1)
    ON CONFLICT (shop, day)
    DO UPDATE SET count = s10b_order_refetch_null.count + 1
  `;
}

/**
 * Increment the order outstanding missing counter for a shop.
 *
 * Called when an order's totalOutstandingSet field is missing.
 * This tracks orders where we had to fall back to total or existing outstanding.
 *
 * Uses an aggregate table (shop, day, count) - no PII, no individual order IDs.
 * Best-effort: failures are logged but never fail the invoice write.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 */
export async function incrementOrderOutstandingMissing(
  sql: Sql,
  shop: string,
  n: number = 1
): Promise<void> {
  if (n <= 0) return;
  await sql`
    INSERT INTO order_outstanding_missing (shop, day, count)
    VALUES (${shop}, CURRENT_DATE, ${n})
    ON CONFLICT (shop, day)
    DO UPDATE SET count = order_outstanding_missing.count + ${n}
  `;
}

/**
 * Get order refetch null count for a shop.
 *
 * Used for monitoring and debugging. Returns the total count of null re-fetches
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
    const [result] = await sql<{ total: string }[]>`
      SELECT COALESCE(SUM(count), 0)::text as total
      FROM s10b_order_refetch_null
      WHERE shop = ${shop} AND day >= ${since.toISOString().split("T")[0]}::date
    `;
    return parseInt(result?.total ?? "0", 10);
  }

  const [result] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(count), 0)::text as total
    FROM s10b_order_refetch_null
    WHERE shop = ${shop}
  `;
  return parseInt(result?.total ?? "0", 10);
}

/**
 * Purge order refetch null records older than 90 days.
 * Called by the nightly pg_cron job and during shop deletion.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Optional shop domain to limit purge to one shop
 * @returns Number of records deleted
 */
export async function purgeOldOrderRefetchNull(
  sql: Sql,
  shop?: string
): Promise<number> {
  if (shop) {
    const result = await sql`
      DELETE FROM s10b_order_refetch_null
      WHERE shop = ${shop}
    `;
    return result.count;
  }

  const result = await sql`
    DELETE FROM s10b_order_refetch_null
    WHERE day < CURRENT_DATE - INTERVAL '90 days'
  `;
  return result.count;
}
