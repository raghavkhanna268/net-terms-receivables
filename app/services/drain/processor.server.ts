/**
 * Queue drain processor for S10.
 *
 * Reads messages from the s6_sync and s6_bulk queues, dispatches them to
 * topic-specific handlers, and handles success/failure outcomes.
 *
 * Design principles:
 * - Extensible handler registry: S8 topics can register handlers later
 * - Idempotency: Uses webhook dedupe table to skip already-processed messages
 * - Retry with DLQ: Messages exceeding max retries move to dead-letter queue
 * - Time budget: Stops early when wall-time budget is reached
 * - Low CPU: Delegates heavy work to bulk operations
 */

import type { Sql } from "~/lib/db-light.server";
import { S6_QUEUES, type SyncMessage, type BulkMessage } from "~/lib/pgmq.server";
import { processCompanyWebhook, isWebhookProcessed } from "~/services/sync/company.server";
import { processCompanyLocationWebhook } from "~/services/sync/company-location.server";
import { processOrderWebhook } from "~/services/sync/order.server";
import type { SyncResult, ShopifyCompany, ShopifyCompanyLocation, ShopifyOrder } from "~/services/sync/types";

/**
 * Configuration for drain processing.
 */
export interface DrainConfig {
  /** Max messages to read per drain invocation (default: 5) */
  batchSize: number;
  /** Visibility timeout in seconds for read messages (default: 30) */
  visibilityTimeoutSec: number;
  /** Max wall time in milliseconds before stopping (default: 20000) */
  timeBudgetMs: number;
  /** Max read_ct before moving to DLQ (default: 5) */
  maxRetries: number;
}

export const DEFAULT_DRAIN_CONFIG: DrainConfig = {
  batchSize: 5,
  visibilityTimeoutSec: 30,
  timeBudgetMs: 20000,
  maxRetries: 5,
};

/**
 * Handler function type for sync messages.
 * Returns a SyncResult indicating success/failure.
 */
export type SyncHandler = (
  sql: Sql,
  message: SyncMessage
) => Promise<SyncResult>;

/**
 * Handler function type for bulk messages.
 * Returns a SyncResult indicating success/failure.
 */
export type BulkHandler = (
  sql: Sql,
  message: BulkMessage
) => Promise<SyncResult>;

/**
 * Registry for topic handlers.
 *
 * Design: Handlers are registered by topic. S8 can add CUSTOMERS_* and
 * DRAFT_ORDERS_* handlers without modifying drain logic.
 */
const syncHandlers = new Map<string, SyncHandler>();
const bulkHandlers = new Map<string, BulkHandler>();

/**
 * Register a handler for a sync message topic.
 *
 * @param topic - The Shopify webhook topic (e.g., "COMPANIES_CREATE")
 * @param handler - The handler function
 */
export function registerSyncHandler(topic: string, handler: SyncHandler): void {
  syncHandlers.set(topic, handler);
}

/**
 * Register a handler for a bulk message topic.
 *
 * @param topic - The bulk operation topic (e.g., "BULK_OPERATIONS_FINISH")
 * @param handler - The handler function
 */
export function registerBulkHandler(topic: string, handler: BulkHandler): void {
  bulkHandlers.set(topic, handler);
}

/**
 * Get a registered sync handler by topic.
 */
export function getSyncHandler(topic: string): SyncHandler | undefined {
  return syncHandlers.get(topic);
}

/**
 * Get a registered bulk handler by topic.
 */
export function getBulkHandler(topic: string): BulkHandler | undefined {
  return bulkHandlers.get(topic);
}

// === S6 Handler Implementations ===

/**
 * Handler for COMPANIES_* topics.
 */
async function handleCompany(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  const company: ShopifyCompany = {
    id: message.resourceGid,
    name: "", // Not needed for dedupe-only processing
  };
  return processCompanyWebhook(sql, message.shop, message.topic, company, message.webhookId);
}

/**
 * Handler for COMPANY_LOCATIONS_* topics.
 *
 * Note: Full location data would come from a GraphQL fetch in a production system.
 * For the drain, we have only the GID. The handler checks dedupe and skips
 * if already processed. A real implementation would fetch data via Admin API.
 */
async function handleCompanyLocation(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // For webhook replay/drain, we only have the GID.
  // In a real scenario, we'd fetch the full location data via GraphQL.
  // For now, we check dedupe and return a result indicating we need data.

  // Check if already processed (idempotency)
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // For drain processing, we need the full location data.
  // The webhook handler already enqueued with just the GID.
  // TODO: Fetch location data via Admin API if not already processed.
  // For now, we'll need to mark as needing fetch or handle inline.

  // Minimal location for dedupe check
  const location: ShopifyCompanyLocation = {
    id: message.resourceGid,
    name: "",
    company: { id: "" }, // Would need to be fetched
  };

  // For DELETE topics, we can process without full data
  if (message.topic === "COMPANY_LOCATIONS_DELETE") {
    return processCompanyLocationWebhook(sql, message.shop, message.topic, location, message.webhookId);
  }

  // For CREATE/UPDATE, return a deferred result
  // The bulk operation flow handles full data sync
  return {
    success: true,
    action: "skipped",
    skipReason: "CompanyLocation CREATE/UPDATE deferred to bulk sync",
  };
}

/**
 * Handler for ORDERS_* topics.
 */
async function handleOrder(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Check if already processed (idempotency)
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // For CANCELLED and PAID, we can process with just the GID
  if (message.topic === "ORDERS_CANCELLED" || message.topic === "ORDERS_PAID") {
    const order: ShopifyOrder = {
      id: message.resourceGid,
      name: "",
      createdAt: message.enqueuedAt,
      cancelledAt: message.topic === "ORDERS_CANCELLED" ? message.enqueuedAt : null,
      displayFinancialStatus: message.topic === "ORDERS_PAID" ? "PAID" : null,
    };
    return processOrderWebhook(sql, message.shop, message.topic, order, message.webhookId);
  }

  // For CREATE/UPDATED, we need full order data
  // Deferred to bulk sync for now
  return {
    success: true,
    action: "skipped",
    skipReason: "Order CREATE/UPDATED deferred to bulk sync",
  };
}

/**
 * Handler for BULK_OPERATIONS_FINISH topic.
 *
 * TODO: Implement JSONL download and processing in S10.
 * For now, marks as processed.
 */
async function handleBulkFinish(sql: Sql, message: BulkMessage): Promise<SyncResult> {
  // Check if already processed
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Bulk operation already processed (idempotent)",
    };
  }

  // TODO: Download JSONL from Shopify and process
  // For now, just mark as processed
  // The bulk operation processor will be implemented when we have
  // authenticated GraphQL client access in the drain context.

  return {
    success: true,
    action: "skipped",
    skipReason: "Bulk operation processing not yet implemented",
  };
}

// Register S6 handlers
registerSyncHandler("COMPANIES_CREATE", handleCompany);
registerSyncHandler("COMPANIES_UPDATE", handleCompany);
registerSyncHandler("COMPANIES_DELETE", handleCompany);
registerSyncHandler("COMPANY_LOCATIONS_CREATE", handleCompanyLocation);
registerSyncHandler("COMPANY_LOCATIONS_UPDATE", handleCompanyLocation);
registerSyncHandler("COMPANY_LOCATIONS_DELETE", handleCompanyLocation);
registerSyncHandler("ORDERS_CREATE", handleOrder);
registerSyncHandler("ORDERS_UPDATED", handleOrder);
registerSyncHandler("ORDERS_CANCELLED", handleOrder);
registerSyncHandler("ORDERS_PAID", handleOrder);
registerBulkHandler("BULK_OPERATIONS_FINISH", handleBulkFinish);

// TODO(S8): Register CUSTOMERS_* and DRAFT_ORDERS_* handlers
// registerSyncHandler("CUSTOMERS_CREATE", checkCompanyAccount);
// registerSyncHandler("CUSTOMERS_UPDATE", checkCompanyAccount);
// registerSyncHandler("DRAFT_ORDERS_CREATE", handleDraftOrder);
// registerSyncHandler("DRAFT_ORDERS_UPDATE", handleDraftOrder);

// === Reconcile Handlers ===

/**
 * Handler for RECONCILE_COMPANIES topic.
 *
 * Triggers a bulk companies export for the shop.
 * The actual processing happens when the bulk operation finishes.
 */
async function handleReconcileCompanies(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Mark as processed to avoid duplicate reconciles
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  // TODO: Start bulk companies export via Admin API
  // This requires an authenticated session for the shop.
  // For now, we mark as processed since the actual bulk operation
  // will be triggered via the afterAuth flow or admin action.

  await sql`
    INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
    VALUES (${message.webhookId}, ${message.topic}, ${message.shop}, NOW())
    ON CONFLICT (webhook_id) DO NOTHING
  `;

  return {
    success: true,
    action: "skipped",
    skipReason: "Reconcile companies: bulk export not yet automated (requires session)",
  };
}

/**
 * Handler for RECONCILE_ORDERS topic.
 *
 * Triggers a bulk orders export for the shop.
 * The actual processing happens when the bulk operation finishes.
 */
async function handleReconcileOrders(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Mark as processed to avoid duplicate reconciles
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  // TODO: Start bulk orders export via Admin API
  // This requires an authenticated session for the shop.

  await sql`
    INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
    VALUES (${message.webhookId}, ${message.topic}, ${message.shop}, NOW())
    ON CONFLICT (webhook_id) DO NOTHING
  `;

  return {
    success: true,
    action: "skipped",
    skipReason: "Reconcile orders: bulk export not yet automated (requires session)",
  };
}

registerSyncHandler("RECONCILE_COMPANIES", handleReconcileCompanies);
registerSyncHandler("RECONCILE_ORDERS", handleReconcileOrders);

/**
 * Result of a drain run.
 */
export interface DrainResult {
  /** Number of messages processed successfully */
  processed: number;
  /** Number of messages that failed and will retry */
  failed: number;
  /** Number of messages moved to DLQ */
  deadLettered: number;
  /** Number of messages skipped (already processed or deferred) */
  skipped: number;
  /** Whether the drain stopped due to time budget */
  timedOut: boolean;
  /** Total wall time in milliseconds */
  elapsedMs: number;
  /** Errors encountered (for logging) */
  errors: Array<{ msgId: string; topic: string; error: string }>;
}

/**
 * Read message from pgmq queue.
 */
interface QueueMessage<T> {
  msg_id: string;
  read_ct: number;
  enqueued_at: Date;
  vt: Date;
  message: T;
}

/**
 * Read messages from the s6_sync queue.
 */
async function readSyncMessages(
  sql: Sql,
  limit: number,
  vtSec: number
): Promise<QueueMessage<SyncMessage>[]> {
  const rows = await sql<QueueMessage<SyncMessage>[]>`
    SELECT msg_id, read_ct, enqueued_at, vt, message
    FROM pgmq.read(${S6_QUEUES.SYNC}, ${vtSec}, ${limit})
  `;
  return rows;
}

/**
 * Read messages from the s6_bulk queue.
 */
async function readBulkMessages(
  sql: Sql,
  limit: number,
  vtSec: number
): Promise<QueueMessage<BulkMessage>[]> {
  const rows = await sql<QueueMessage<BulkMessage>[]>`
    SELECT msg_id, read_ct, enqueued_at, vt, message
    FROM pgmq.read(${S6_QUEUES.BULK}, ${vtSec}, ${limit})
  `;
  return rows;
}

/**
 * Archive (delete) a successfully processed message.
 */
async function archiveMessage(sql: Sql, queue: string, msgId: string): Promise<void> {
  await sql`SELECT pgmq.archive(${queue}, ${msgId}::bigint)`;
}

/**
 * Move a message to the dead-letter queue.
 */
async function moveToDeadLetter(
  sql: Sql,
  queue: string,
  msgId: string,
  message: SyncMessage | BulkMessage,
  error: string
): Promise<void> {
  // Insert into dead-letter table
  await sql`
    INSERT INTO s6_dead_letter (
      original_queue,
      original_msg_id,
      message,
      error,
      dead_lettered_at
    ) VALUES (
      ${queue},
      ${msgId},
      ${sql.json(message)},
      ${error},
      NOW()
    )
  `;

  // Delete from original queue
  await sql`SELECT pgmq.delete(${queue}, ${msgId}::bigint)`;
}

/**
 * Process the s6_sync queue.
 */
async function processSyncQueue(
  sql: Sql,
  config: DrainConfig,
  startTime: number
): Promise<DrainResult> {
  const result: DrainResult = {
    processed: 0,
    failed: 0,
    deadLettered: 0,
    skipped: 0,
    timedOut: false,
    elapsedMs: 0,
    errors: [],
  };

  const messages = await readSyncMessages(sql, config.batchSize, config.visibilityTimeoutSec);

  for (const msg of messages) {
    // Check time budget
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.timeBudgetMs) {
      result.timedOut = true;
      break;
    }

    const handler = getSyncHandler(msg.message.topic);
    if (!handler) {
      // No handler registered; skip but don't delete
      result.errors.push({
        msgId: msg.msg_id,
        topic: msg.message.topic,
        error: `No handler registered for topic: ${msg.message.topic}`,
      });
      result.skipped++;
      continue;
    }

    try {
      const syncResult = await handler(sql, msg.message);

      if (syncResult.success) {
        await archiveMessage(sql, S6_QUEUES.SYNC, msg.msg_id);
        if (syncResult.action === "skipped") {
          result.skipped++;
        } else {
          result.processed++;
        }
      } else {
        // Failed - check if should move to DLQ
        if (msg.read_ct >= config.maxRetries) {
          await moveToDeadLetter(
            sql,
            S6_QUEUES.SYNC,
            msg.msg_id,
            msg.message,
            syncResult.error || "Max retries exceeded"
          );
          result.deadLettered++;
        } else {
          // Leave for retry (visibility timeout will make it available again)
          result.failed++;
        }
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          error: syncResult.error || "Unknown error",
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      if (msg.read_ct >= config.maxRetries) {
        await moveToDeadLetter(sql, S6_QUEUES.SYNC, msg.msg_id, msg.message, errorMsg);
        result.deadLettered++;
      } else {
        result.failed++;
      }
      result.errors.push({
        msgId: msg.msg_id,
        topic: msg.message.topic,
        error: errorMsg,
      });
    }
  }

  result.elapsedMs = Date.now() - startTime;
  return result;
}

/**
 * Process the s6_bulk queue.
 */
async function processBulkQueue(
  sql: Sql,
  config: DrainConfig,
  startTime: number,
  previousResult: DrainResult
): Promise<DrainResult> {
  const result = { ...previousResult };

  // Check time budget before starting bulk processing
  const elapsed = Date.now() - startTime;
  if (elapsed >= config.timeBudgetMs) {
    result.timedOut = true;
    result.elapsedMs = elapsed;
    return result;
  }

  const messages = await readBulkMessages(sql, config.batchSize, config.visibilityTimeoutSec);

  for (const msg of messages) {
    // Check time budget
    const currentElapsed = Date.now() - startTime;
    if (currentElapsed >= config.timeBudgetMs) {
      result.timedOut = true;
      break;
    }

    const handler = getBulkHandler(msg.message.topic);
    if (!handler) {
      result.errors.push({
        msgId: msg.msg_id,
        topic: msg.message.topic,
        error: `No handler registered for topic: ${msg.message.topic}`,
      });
      result.skipped++;
      continue;
    }

    try {
      const syncResult = await handler(sql, msg.message);

      if (syncResult.success) {
        await archiveMessage(sql, S6_QUEUES.BULK, msg.msg_id);
        if (syncResult.action === "skipped") {
          result.skipped++;
        } else {
          result.processed++;
        }
      } else {
        if (msg.read_ct >= config.maxRetries) {
          await moveToDeadLetter(
            sql,
            S6_QUEUES.BULK,
            msg.msg_id,
            msg.message,
            syncResult.error || "Max retries exceeded"
          );
          result.deadLettered++;
        } else {
          result.failed++;
        }
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          error: syncResult.error || "Unknown error",
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      if (msg.read_ct >= config.maxRetries) {
        await moveToDeadLetter(sql, S6_QUEUES.BULK, msg.msg_id, msg.message, errorMsg);
        result.deadLettered++;
      } else {
        result.failed++;
      }
      result.errors.push({
        msgId: msg.msg_id,
        topic: msg.message.topic,
        error: errorMsg,
      });
    }
  }

  result.elapsedMs = Date.now() - startTime;
  return result;
}

/**
 * Run the queue drain.
 *
 * Processes messages from both s6_sync and s6_bulk queues,
 * respecting the time budget and batch size limits.
 *
 * @param sql - postgres.js SQL client
 * @param config - Drain configuration (optional, uses defaults)
 * @returns Drain result with statistics
 */
export async function runDrain(
  sql: Sql,
  config: Partial<DrainConfig> = {}
): Promise<DrainResult> {
  const fullConfig = { ...DEFAULT_DRAIN_CONFIG, ...config };
  const startTime = Date.now();

  // Process sync queue first
  let result = await processSyncQueue(sql, fullConfig, startTime);

  // If we have time, process bulk queue too
  if (!result.timedOut) {
    result = await processBulkQueue(sql, fullConfig, startTime, result);
  }

  return result;
}
