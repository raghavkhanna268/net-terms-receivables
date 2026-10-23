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
 * - No-handler: Messages without handlers get visibility extended (not DLQ'd immediately)
 * - Time budget: Stops early when wall-time budget is reached
 *
 * NOTE: BULK_OPERATIONS_FINISH and RECONCILE_* handlers are NOT implemented yet.
 * They will go through the no-handler path (visibility extended, eventual DLQ).
 * Nightly reconcile cron is also not scheduled until bulk processing works.
 */

import type { Sql } from "~/lib/db-light.server";
import { S6_QUEUES, type SyncMessage, type BulkMessage } from "~/lib/pgmq.server";
import {
  processCompanyWebhook,
  isWebhookProcessed,
  markWebhookProcessed,
} from "~/services/sync/company.server";
import { processCompanyLocationWebhook } from "~/services/sync/company-location.server";
import { processOrderWebhook } from "~/services/sync/order.server";
import type {
  SyncResult,
  ShopifyCompany,
  ShopifyCompanyLocation,
  ShopifyOrder,
} from "~/services/sync/types";
import {
  adminGraphQL,
  COMPANY_QUERY,
  COMPANY_LOCATION_QUERY,
  ORDER_QUERY,
} from "./admin-client.server";

/**
 * Configuration for drain processing.
 */
export interface DrainConfig {
  /** Max messages to read per drain invocation (default: 5) */
  batchSize: number;
  /** Visibility timeout in seconds for read messages (default: 30) */
  visibilityTimeoutSec: number;
  /** Max wall time in milliseconds before stopping (default: 15000) */
  timeBudgetMs: number;
  /** Max read_ct before moving to DLQ (default: 5) */
  maxRetries: number;
  /** Max read_ct for no-handler messages before DLQ (default: 48, ~2 days) */
  noHandlerMaxReads: number;
}

export const DEFAULT_DRAIN_CONFIG: DrainConfig = {
  batchSize: 5,
  visibilityTimeoutSec: 30,
  timeBudgetMs: 15000,
  maxRetries: 5,
  noHandlerMaxReads: 48,
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
 */
export function registerSyncHandler(topic: string, handler: SyncHandler): void {
  syncHandlers.set(topic, handler);
}

/**
 * Register a handler for a bulk message topic.
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

// =============================================================================
// S6 HANDLER IMPLEMENTATIONS
// =============================================================================

/**
 * Handler for COMPANIES_* topics.
 * Fetches the company via GraphQL and processes it.
 */
async function handleCompany(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency check first
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // For DELETE, we don't need to fetch - just mark processed
  if (message.topic === "COMPANIES_DELETE") {
    const company: ShopifyCompany = {
      id: message.resourceGid,
      name: "",
    };
    return processCompanyWebhook(sql, message.shop, message.topic, company, message.webhookId);
  }

  // Fetch company data via GraphQL
  const result = await adminGraphQL<{
    node: ShopifyCompany | null;
  }>(message.shop, COMPANY_QUERY, { id: message.resourceGid });

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  // If node is null, the resource was deleted
  if (!result.data?.node) {
    // Treat as delete
    const company: ShopifyCompany = {
      id: message.resourceGid,
      name: "",
    };
    return processCompanyWebhook(sql, message.shop, "COMPANIES_DELETE", company, message.webhookId);
  }

  return processCompanyWebhook(
    sql,
    message.shop,
    message.topic,
    result.data.node,
    message.webhookId
  );
}

/**
 * Handler for COMPANY_LOCATIONS_* topics.
 * Fetches the location via GraphQL and processes it.
 */
async function handleCompanyLocation(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // For DELETE, process without fetch
  if (message.topic === "COMPANY_LOCATIONS_DELETE") {
    const location: ShopifyCompanyLocation = {
      id: message.resourceGid,
      name: "",
      company: { id: "" },
    };
    return processCompanyLocationWebhook(sql, message.shop, message.topic, location, message.webhookId);
  }

  // Fetch location data via GraphQL
  const result = await adminGraphQL<{
    node: ShopifyCompanyLocation | null;
  }>(message.shop, COMPANY_LOCATION_QUERY, { id: message.resourceGid });

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  // If node is null, treat as delete
  if (!result.data?.node) {
    const location: ShopifyCompanyLocation = {
      id: message.resourceGid,
      name: "",
      company: { id: "" },
    };
    return processCompanyLocationWebhook(sql, message.shop, "COMPANY_LOCATIONS_DELETE", location, message.webhookId);
  }

  return processCompanyLocationWebhook(
    sql,
    message.shop,
    message.topic,
    result.data.node,
    message.webhookId
  );
}

/**
 * Handler for ORDERS_* topics.
 * Fetches the order via GraphQL and processes it.
 *
 * Null refetch handling:
 * Without read_all_orders, Shopify returns null for orders >60 days old.
 * Net 60/90 invoices live in that territory, so null must NOT be treated as deleted.
 *
 * On null refetch:
 * - ORDERS_PAID: Use topic as evidence of paid state, call markInvoicePaid via processOrderWebhook
 * - ORDERS_CANCELLED: Use topic as evidence of cancelled state, call cancelInvoice via processOrderWebhook
 * - ORDERS_CREATE/UPDATED: Keep ledger state unchanged (can't process without data)
 * - Always log order_refetch_null warning
 */
async function handleOrder(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // Always fetch the real order - never fabricate data
  const result = await adminGraphQL<{
    node: ShopifyOrder | null;
  }>(message.shop, ORDER_QUERY, { id: message.resourceGid });

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  // If node is null, order may be >60 days old (without read_all_orders)
  // NEVER assume deleted - this would break Net 60/90 invoices
  if (!result.data?.node) {
    // Log distinct warning (shop and order GID only, no PII)
    console.warn(
      `[order_refetch_null] shop=${message.shop} order=${message.resourceGid} topic=${message.topic}`
    );

    // For PAID/CANCELLED, the topic itself tells us the state
    // Use processOrderWebhook with minimal order data to go through S6 functions
    if (message.topic === "ORDERS_PAID" || message.topic === "ORDERS_CANCELLED") {
      // Create minimal order with just the ID for markInvoicePaid/cancelInvoice
      // These functions only need shopId and orderId, which we have
      const minimalOrder: ShopifyOrder = {
        id: message.resourceGid,
        name: "", // Not used by paid/cancelled handlers
        createdAt: new Date().toISOString(),
        // paymentTerms required for processOrderWebhook to not skip
        // For PAID/CANCELLED, it's only used to check if we should process
        // The actual handlers (markInvoicePaid, cancelInvoice) don't need it
        paymentTerms: {
          id: "unknown",
          paymentTermsName: "unknown",
          paymentTermsType: "UNKNOWN",
          dueInDays: 0,
        },
      };

      return processOrderWebhook(
        sql,
        message.shop,
        message.topic,
        minimalOrder,
        message.webhookId
      );
    }

    // For CREATE/UPDATED, we can't process without full order data
    // Keep ledger state unchanged, mark webhook processed
    await markWebhookProcessed(sql, message.webhookId, message.topic, message.resourceGid);
    return {
      success: true,
      action: "skipped",
      skipReason: "Order refetch returned null (may be >60 days old). Ledger state unchanged.",
    };
  }

  return processOrderWebhook(
    sql,
    message.shop,
    message.topic,
    result.data.node,
    message.webhookId
  );
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

// NOTE: BULK_OPERATIONS_FINISH handler is NOT registered.
// Bulk JSONL processing requires byte-accurate HTTP Range chunking which
// is not yet implemented. Messages will go through no-handler path.

// NOTE: RECONCILE_* handlers are NOT registered.
// Reconcile depends on bulk operations working. Will be added in follow-up PR.

// TODO(S8): Register CUSTOMERS_* and DRAFT_ORDERS_* handlers
// registerSyncHandler("CUSTOMERS_CREATE", checkCompanyAccount);
// registerSyncHandler("CUSTOMERS_UPDATE", checkCompanyAccount);
// registerSyncHandler("DRAFT_ORDERS_CREATE", handleDraftOrder);
// registerSyncHandler("DRAFT_ORDERS_UPDATE", handleDraftOrder);

// =============================================================================
// DRAIN RESULT & QUEUE OPERATIONS
// =============================================================================

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
  /** Number of messages with no handler (visibility extended) */
  noHandler: number;
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
 * Extend visibility timeout for a message (e.g., no handler available).
 */
async function extendVisibility(sql: Sql, queue: string, msgId: string, seconds: number): Promise<void> {
  await sql`SELECT pgmq.set_vt(${queue}, ${msgId}::bigint, ${seconds})`;
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
    noHandler: 0,
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

    // No handler registered - extend visibility and potentially DLQ
    if (!handler) {
      if (msg.read_ct >= config.noHandlerMaxReads) {
        await moveToDeadLetter(
          sql,
          S6_QUEUES.SYNC,
          msg.msg_id,
          msg.message,
          `No handler registered for topic after ${msg.read_ct} reads: ${msg.message.topic}`
        );
        result.deadLettered++;
      } else {
        // Extend visibility by 1 hour
        await extendVisibility(sql, S6_QUEUES.SYNC, msg.msg_id, 3600);
        result.noHandler++;
      }
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

    // No handler - extend visibility (BULK_OPERATIONS_FINISH goes here for now)
    if (!handler) {
      if (msg.read_ct >= config.noHandlerMaxReads) {
        await moveToDeadLetter(
          sql,
          S6_QUEUES.BULK,
          msg.msg_id,
          msg.message,
          `No handler registered for topic after ${msg.read_ct} reads: ${msg.message.topic}`
        );
        result.deadLettered++;
      } else {
        await extendVisibility(sql, S6_QUEUES.BULK, msg.msg_id, 3600);
        result.noHandler++;
      }
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
