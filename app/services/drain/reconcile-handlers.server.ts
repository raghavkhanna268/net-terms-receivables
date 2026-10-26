/**
 * Reconcile handlers for S10b + S8.
 *
 * Handles RECONCILE_COMPANIES, RECONCILE_CUSTOMERS, RECONCILE_ORDERS, and
 * RECONCILE_DRAFT_ORDERS messages by starting bulk exports via the Admin API.
 * Also provides the order refetch null metric recording function.
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
 * 10. After orders complete, handleBulkOperationsFinish enqueues RECONCILE_DRAFT_ORDERS
 * 11. Draft orders reconcile runs for pending credit exposure tracking
 *
 * Sequential design: companies → customers → orders → draft_orders
 * - Companies must complete before customers (B2B contacts check)
 * - Customers must complete before orders (tagged customer buyer account existence)
 * - Orders must complete before draft_orders (buyer account existence)
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
  getBulkCompaniesQuery,
  BULK_ORDERS_QUERY,
  BULK_DRAFT_ORDERS_QUERY,
  parseBulkOperationResult,
  registerBulkOperation,
} from "~/services/sync/bulk-operations.server";
import { getBulkCustomersQuery, validateCustomerQuery } from "~/services/sync/customer-fields.server";
import { getTagRules } from "~/services/sync/customer.server";
import { getRequestEnv } from "~/lib/request-context.server";
import { markNextStageEnqueued } from "~/services/sync/bulk-jsonl-processor.server";

/**
 * Claim age threshold in minutes for re-claimable claims.
 * S25: A claim with bulk_operation_id NULL older than this can be reclaimed.
 */
const CLAIM_RECLAIM_MINUTES = 5;

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
 * Extract chain key from a webhookId.
 * S25: The chain_key is per-shop scoped: <shop>:<date> or <shop>:manual:<ts>.
 * This ensures two shops on the same date get separate claims.
 * 
 * Patterns:
 * - reconcile:<shop>:<YYYY-MM-DD>:<stage> -> <shop>:<YYYY-MM-DD>
 * - reconcile:<shop>:manual:<timestamp>:<stage> -> <shop>:manual:<timestamp>
 */
export function extractChainKey(webhookId: string): string | undefined {
  // Try manual pattern first: reconcile:<shop>:manual:<ts>:<stage>
  const manualMatch = webhookId.match(/^reconcile:([^:]+):(manual:\d+):/);
  if (manualMatch) {
    return `${manualMatch[1]}:${manualMatch[2]}`;
  }
  // Try date pattern: reconcile:<shop>:<YYYY-MM-DD>:<stage>
  const dateMatch = webhookId.match(/^reconcile:([^:]+):(\d{4}-\d{2}-\d{2}):/);
  if (dateMatch) {
    return `${dateMatch[1]}:${dateMatch[2]}`;
  }
  return undefined;
}

/**
 * Result of claimReconcileStage.
 * - claimed: Successfully claimed the stage
 * - already_running: Another processor has claimed with a bulk_operation_id and the op row exists (skip)
 * - retry_pending: A claim exists with NULL bulk_operation_id and is younger than threshold (retryable)
 * - { orphan: bulkOperationId }: Claim has bulk_operation_id but no op row exists (adopt/register it)
 */
export type ClaimResult = "claimed" | "already_running" | "retry_pending" | { orphan: string };

/**
 * Claim a reconcile stage for exactly-once stage starts.
 * S25: INSERT ON CONFLICT DO NOTHING RETURNING to prevent duplicate ops.
 * 
 * A claim with bulk_operation_id NULL older than CLAIM_RECLAIM_MINUTES is re-claimable.
 * This handles the case where a mutation failed after claiming.
 * 
 * @returns ClaimResult indicating the outcome
 */
export async function claimReconcileStage(
  sql: Sql,
  chainKey: string,
  stage: ReconcileStage,
  shop: string
): Promise<ClaimResult> {
  // First try to insert
  const insertResult = await sql`
    INSERT INTO s6_reconcile_stage_claims (chain_key, stage, shop)
    VALUES (${chainKey}, ${stage}, ${shop})
    ON CONFLICT (chain_key, stage) DO NOTHING
    RETURNING chain_key
  `;
  
  if (insertResult.count > 0) {
    return "claimed";
  }
  
  // Conflict - check if it's re-claimable (bulk_operation_id NULL and old)
  const updateResult = await sql`
    UPDATE s6_reconcile_stage_claims
    SET claimed_at = now(), bulk_operation_id = NULL, shop = ${shop}
    WHERE chain_key = ${chainKey}
      AND stage = ${stage}
      AND bulk_operation_id IS NULL
      AND claimed_at < now() - make_interval(mins => ${CLAIM_RECLAIM_MINUTES})
    RETURNING chain_key
  `;
  
  if (updateResult.count > 0) {
    return "claimed";
  }
  
  // Check if there's an existing claim with bulk_operation_id set (another op running)
  const [existingClaim] = await sql<{ bulk_operation_id: string | null; claimed_at: Date }[]>`
    SELECT bulk_operation_id, claimed_at FROM s6_reconcile_stage_claims
    WHERE chain_key = ${chainKey} AND stage = ${stage}
  `;
  
  if (existingClaim?.bulk_operation_id) {
    // S25: Verify the op row actually exists for THIS shop.
    const [opExists] = await sql<{ bulk_operation_id: string }[]>`
      SELECT bulk_operation_id FROM s6_bulk_operations
      WHERE bulk_operation_id = ${existingClaim.bulk_operation_id}
        AND shop = ${shop}
    `;
    
    if (opExists) {
      return "already_running";
    }
    
    // Op row doesn't exist. Check if the claim is old enough to be considered orphan.
    // If claimed_at is recent (within CLAIM_RECLAIM_MINUTES), the registration might
    // still be in progress. Return retry_pending in that case.
    const claimAgeMs = Date.now() - existingClaim.claimed_at.getTime();
    const claimAgeMinutes = claimAgeMs / (60 * 1000);
    
    if (claimAgeMinutes < CLAIM_RECLAIM_MINUTES) {
      // Claim is recent - registration might be in progress, retry later
      return "retry_pending";
    }
    
    // Op row doesn't exist and claim is old - this is an orphan claim (op created on
    // Shopify but registration failed). Per Team Lead ruling #2: return the orphan op
    // id so the caller can register/adopt it without starting a new Shopify op.
    return { orphan: existingClaim.bulk_operation_id };
  }
  
  // Claim exists with NULL bulk_operation_id but is younger than threshold - retry later
  return "retry_pending";
}

/**
 * Record the bulk_operation_id on a claim after successful mutation.
 */
export async function recordClaimBulkOperationId(
  sql: Sql,
  chainKey: string,
  stage: ReconcileStage,
  shop: string,
  bulkOperationId: string
): Promise<void> {
  await sql`
    UPDATE s6_reconcile_stage_claims
    SET bulk_operation_id = ${bulkOperationId}
    WHERE chain_key = ${chainKey}
      AND stage = ${stage}
      AND shop = ${shop}
  `;
}

/**
 * Release a claim on retryable error by deleting it.
 * S25: DELETE allows immediate retry claim without waiting CLAIM_RECLAIM_MINUTES.
 */
export async function releaseReconcileStageClaim(
  sql: Sql,
  chainKey: string,
  stage: ReconcileStage,
  shop: string
): Promise<void> {
  await sql`
    DELETE FROM s6_reconcile_stage_claims
    WHERE chain_key = ${chainKey}
      AND stage = ${stage}
      AND shop = ${shop}
  `;
}

/**
 * Delete claims for a shop (used on uninstall/shop-redact).
 */
export async function deleteShopReconcileClaims(
  sql: Sql,
  shop: string
): Promise<number> {
  const result = await sql`
    DELETE FROM s6_reconcile_stage_claims
    WHERE shop = ${shop}
  `;
  return result.count;
}

/**
 * Purge old reconcile stage claims (older than 30 days).
 * S25: Called by nightly reconcile or cron.
 */
export async function purgeOldReconcileClaims(sql: Sql): Promise<number> {
  const result = await sql`
    DELETE FROM s6_reconcile_stage_claims
    WHERE claimed_at < now() - interval '30 days'
  `;
  return result.count;
}

/**
 * Get the manualKey for a bulk operation by looking up its source webhookId.
 * Used when chaining between stages after BULK_OPERATIONS_FINISH.
 *
 * Scoped to the shop to prevent cross-shop matches if two shops happen to
 * have the same bulk operation GID (unlikely but defensive).
 *
 * Looks up any reconcile stage topic (RECONCILE_COMPANIES, RECONCILE_CUSTOMERS,
 * RECONCILE_ORDERS, RECONCILE_DRAFT_ORDERS) since the manual key is consistent
 * across all stages.
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
      AND topic IN ('RECONCILE_COMPANIES', 'RECONCILE_CUSTOMERS', 'RECONCILE_ORDERS', 'RECONCILE_DRAFT_ORDERS')
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
  const env = getRequestEnv() ?? {};

  if (kind === "companies") {
    const query = getBulkCompaniesQuery(env);
    validateCustomerQuery(query, env);
    return query;
  }

  if (kind === "orders") {
    return BULK_ORDERS_QUERY;
  }

  if (kind === "draft_orders") {
    return BULK_DRAFT_ORDERS_QUERY;
  }

  if (kind === "customers") {
    const [shopRow] = await sql<{ id: string }[]>`
      SELECT id FROM "Shop" WHERE domain = ${shop}
    `;
    if (!shopRow) {
      return "shop_not_found";
    }

    const tagRules = await getTagRules(sql, shopRow.id);
    if (tagRules.length === 0) {
      return null;
    }

    return getBulkCustomersQuery(tagRules, env);
  }

  return null;
}

/**
 * Start a reconcile bulk operation for a shop.
 *
 * S25: Uses claim mechanism to prevent duplicate ops per chain stage.
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
  // S25: Extract chain key and claim the stage before mutation
  const chainKey = extractChainKey(webhookId);
  if (chainKey) {
    const claimResult = await claimReconcileStage(sql, chainKey, kind, shop);
    if (claimResult === "already_running") {
      safeLog("info", "reconcile_stage_already_claimed", {
        shopHash: await shopHash(shop),
        stage: kind,
      });
      return {
        success: true,
        action: "skipped",
        skipReason: "Stage already claimed by another processor",
      };
    }
    if (claimResult === "retry_pending") {
      return {
        success: false,
        action: "skipped",
        error: "reconcile_claim_retry_pending",
        errorCode: "reconcile_claim_retry_pending",
        retryable: true,
      };
    }
    // S25: Handle orphan claim - op was created on Shopify but registration failed.
    // Per Team Lead ruling #2: adopt the existing op id without starting a new Shopify op.
    if (typeof claimResult === "object" && "orphan" in claimResult) {
      const orphanOpId = claimResult.orphan;
      safeLog("info", "reconcile_adopting_orphan_op", {
        shopHash: await shopHash(shop),
        stage: kind,
        operationId: orphanOpId,
      });

      // Register the orphan operation (it already exists on Shopify)
      await registerBulkOperation(sql, orphanOpId, shop, kind, "reconcile", kind);

      await markWebhookProcessed(
        sql,
        webhookId,
        `RECONCILE_${kind.toUpperCase()}`,
        orphanOpId
      );

      return {
        success: true,
        action: "created",
        entityId: orphanOpId,
      };
    }
  }

  const mutation = await buildReconcileMutation(sql, shop, kind);

  if (mutation === "shop_not_found") {
    if (chainKey) {
      await releaseReconcileStageClaim(sql, chainKey, kind, shop);
    }
    return {
      success: false,
      action: "skipped",
      error: "shop_not_found",
      errorCode: "shop_not_found",
    };
  }

  if (!mutation) {
    // Release claim since we're skipping (no mutation to run)
    if (chainKey) {
      await releaseReconcileStageClaim(sql, chainKey, kind, shop);
    }
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

  // Use try/finally to ensure claim is released on retryable error (but NOT if we have an op id)
  let bulkOperationId: string | undefined;
  try {
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
        errorCode: "reconcile_mutation_failed",
        retryable: result.retryable,
      };
    }

    const parsed = parseBulkOperationResult(result.data ?? null);

    if (!parsed.success || !parsed.bulkOperationId) {
      return {
        success: false,
        action: "skipped",
        error: parsed.error || "Failed to start bulk operation",
        errorCode: "reconcile_mutation_parse_failed",
      };
    }

    bulkOperationId = parsed.bulkOperationId;

    // S25: Once we have bulkOperationId from Shopify, record it on the claim FIRST.
    // This ensures that if registerBulkOperation fails, the claim still has the op id,
    // preventing a retry from starting a SECOND Shopify op. The retry will see
    // "already_running" from claimReconcileStage and skip.
    //
    // RESIDUAL RISK: If recordClaimBulkOperationId fails (DB error), the claim keeps
    // NULL bulk_operation_id. After CLAIM_RECLAIM_MINUTES, claimReconcileStage's
    // reclaim path returns "claimed" (not "orphan" because there's no op row yet),
    // allowing a retry to start a SECOND Shopify op. This requires: (1) DB failure
    // on bind, (2) this call crashes before registerBulkOperation, (3) 5+ minutes
    // pass, (4) retry claims and starts another op. Shopify allows 5 concurrent
    // bulk ops (as of 2026-01), so this doesn't fail immediately, but creates
    // duplicate work. Mitigation: the original op will complete and can be adopted
    // by the orphan path if the claim eventually gets its op id recorded.
    if (chainKey) {
      await recordClaimBulkOperationId(sql, chainKey, kind, shop, bulkOperationId);
    }

    // Now register the bulk operation. If this fails, we do NOT release the claim
    // because it has the op id and Shopify already started the operation.
    await registerBulkOperation(
      sql,
      bulkOperationId,
      shop,
      kind,
      "reconcile",
      kind
    );

    await markWebhookProcessed(
      sql,
      webhookId,
      `RECONCILE_${kind.toUpperCase()}`,
      bulkOperationId
    );

    safeLog("info", "reconcile_bulk_operation_started", {
      shopHash: await shopHash(shop),
      bulkType: kind,
      operationId: bulkOperationId,
    });

    return {
      success: true,
      action: "created",
      entityId: bulkOperationId,
    };
  } finally {
    // R2: Release claim only if mutation failed BEFORE we got a bulkOperationId.
    // Key on bulkOperationId being set, NOT on opIdRecorded. If recordClaimBulkOperationId
    // threw after Shopify returned an op id, we must NOT release (claim already has op id).
    if (!bulkOperationId && chainKey) {
      await releaseReconcileStageClaim(sql, chainKey, kind, shop);
    }
  }
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
 * S25: Sets next_stage_enqueued_at atomically before enqueuing to prevent
 * duplicate nextStage enqueues.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param stage - Stage to enqueue (customers, orders, or draft_orders)
 * @param manualKey - Optional manual key base from previous stage
 * @param prevBulkOperationId - Optional bulk operation ID of the previous stage
 * @returns Whether the message was enqueued (false if shop doesn't exist, uninstalled, or prev op closed)
 */
export async function enqueueReconcileStage(
  sql: Sql,
  shop: string,
  stage: "customers" | "orders" | "draft_orders",
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
  // LOCK ORDER: Shop row first, then s6_bulk_operations rows. This matches
  // deleteShop and reinstall reset which also lock Shop first. Violating this
  // order risks deadlock (40P01) when these paths run concurrently.
  const enqueued = await sql.begin(async (tx) => {
    // 1. Lock Shop row first (FOR SHARE serializes with deleteShop's FOR UPDATE)
    const [shopRow] = await tx<[{ id: string }?]>`
      SELECT id FROM "Shop"
      WHERE domain = ${shop}
        AND "uninstalledAt" IS NULL
      FOR SHARE
    `;
    if (!shopRow) {
      return false;
    }

    // 2. Check/update s6_bulk_operations rows (after Shop lock)
    // S25: markNextStageEnqueued's UPDATE includes closed_at IS NULL guard,
    // so we don't need a separate SELECT. This avoids lock-upgrade deadlock
    // (two FOR SHARE holders both trying to UPDATE would deadlock).
    if (prevBulkOperationId) {
      const markedEnqueued = await markNextStageEnqueued(tx, prevBulkOperationId, shop);
      if (!markedEnqueued) {
        // Either already enqueued, or op is closed
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
 * Guard (#239 PR2): Only inserts if the Shop row exists. The Shop FOR SHARE
 * in the CTE serializes with deleteShop's leading FOR UPDATE, preventing
 * residual writes after shop/redact completes.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @returns true if the counter was incremented, false if shop is missing
 */
export async function incrementOrderRefetchNull(
  sql: Sql,
  shop: string
): Promise<boolean> {
  const result = await sql`
    WITH shop_check AS (
      SELECT 1 FROM "Shop" WHERE domain = ${shop} FOR SHARE
    )
    INSERT INTO s10b_order_refetch_null (shop, day, count)
    SELECT ${shop}, CURRENT_DATE, 1
    WHERE EXISTS (SELECT 1 FROM shop_check)
    ON CONFLICT (shop, day)
    DO UPDATE SET count = s10b_order_refetch_null.count + 1
  `;
  return result.count > 0;
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
 * Guard (#239 PR2): Only inserts if the Shop row exists. The Shop FOR SHARE
 * in the CTE serializes with deleteShop's leading FOR UPDATE, preventing
 * residual writes after shop/redact completes.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @returns true if the counter was incremented, false if shop is missing
 */
export async function incrementOrderOutstandingMissing(
  sql: Sql,
  shop: string,
  n: number = 1
): Promise<boolean> {
  if (n <= 0) return false;
  const result = await sql`
    WITH shop_check AS (
      SELECT 1 FROM "Shop" WHERE domain = ${shop} FOR SHARE
    )
    INSERT INTO order_outstanding_missing (shop, day, count)
    SELECT ${shop}, CURRENT_DATE, ${n}
    WHERE EXISTS (SELECT 1 FROM shop_check)
    ON CONFLICT (shop, day)
    DO UPDATE SET count = order_outstanding_missing.count + ${n}
  `;
  return result.count > 0;
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
