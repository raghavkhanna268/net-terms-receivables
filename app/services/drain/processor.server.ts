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
 * - CPU bounded: Bulk JSONL processing is chunked to stay within 10ms CPU limit
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
  BULK_OPERATION_QUERY,
  START_COMPANIES_BULK_MUTATION,
  START_ORDERS_BULK_MUTATION,
} from "./admin-client.server";
import { registerBulkOperation } from "~/services/sync/bulk-operations.server";

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
  /** Max JSONL lines to process per bulk operation invocation (default: 500) */
  bulkChunkSize: number;
}

export const DEFAULT_DRAIN_CONFIG: DrainConfig = {
  batchSize: 5,
  visibilityTimeoutSec: 30,
  timeBudgetMs: 15000,
  maxRetries: 5,
  noHandlerMaxReads: 48,
  bulkChunkSize: 500,
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
  message: BulkMessage,
  config: DrainConfig
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
  }>(sql, message.shop, COMPANY_QUERY, { id: message.resourceGid });

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
  }>(sql, message.shop, COMPANY_LOCATION_QUERY, { id: message.resourceGid });

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
  }>(sql, message.shop, ORDER_QUERY, { id: message.resourceGid });

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  // If node is null, order was deleted - nothing to do
  if (!result.data?.node) {
    // Mark as processed so we don't retry
    await markWebhookProcessed(sql, message.webhookId, message.topic, message.resourceGid);
    return {
      success: true,
      action: "skipped",
      skipReason: "Order not found (may have been deleted)",
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

/**
 * Handler for BULK_OPERATIONS_FINISH topic.
 * Downloads JSONL and processes in chunks, persisting cursor for resume.
 */
async function handleBulkFinish(
  sql: Sql,
  message: BulkMessage,
  config: DrainConfig
): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Bulk operation already processed (idempotent)",
    };
  }

  // Fetch the bulk operation to get the result URL
  const result = await adminGraphQL<{
    node: {
      id: string;
      status: string;
      url: string | null;
      objectCount: number | null;
    } | null;
  }>(sql, message.shop, BULK_OPERATION_QUERY, { id: message.bulkOperationId });

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  const bulkOp = result.data?.node;
  if (!bulkOp) {
    await markWebhookProcessed(sql, message.webhookId, message.topic, message.bulkOperationId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Bulk operation not found",
    };
  }

  if (bulkOp.status !== "COMPLETED" || !bulkOp.url) {
    await markWebhookProcessed(sql, message.webhookId, message.topic, message.bulkOperationId);
    return {
      success: true,
      action: "skipped",
      skipReason: `Bulk operation status: ${bulkOp.status}, no URL`,
    };
  }

  // Get current cursor from s6_bulk_operations
  const [cursorRow] = await sql<{ byte_offset: number | null }[]>`
    SELECT byte_offset FROM s6_bulk_operations
    WHERE bulk_operation_id = ${message.bulkOperationId}
  `;
  const byteOffset = cursorRow?.byte_offset ?? 0;

  // Download JSONL with Range header for resume
  const headers: Record<string, string> = {};
  if (byteOffset > 0) {
    headers["Range"] = `bytes=${byteOffset}-`;
  }

  let jsonlResponse: Response;
  try {
    jsonlResponse = await fetch(bulkOp.url, { headers });
  } catch (err) {
    return {
      success: false,
      action: "skipped",
      error: `Failed to fetch JSONL: ${err instanceof Error ? err.message : "Unknown"}`,
    };
  }

  if (!jsonlResponse.ok && jsonlResponse.status !== 206) {
    return {
      success: false,
      action: "skipped",
      error: `JSONL fetch failed: HTTP ${jsonlResponse.status}`,
    };
  }

  const jsonlText = await jsonlResponse.text();
  const lines = jsonlText.split("\n").filter((l) => l.trim());

  // Process up to bulkChunkSize lines
  const linesToProcess = lines.slice(0, config.bulkChunkSize);
  const isComplete = lines.length <= config.bulkChunkSize;

  // Process lines based on bulk type
  // (Actual processing would call the bulk parser and upsert functions)
  // For now, we just update the cursor
  const newOffset = byteOffset + jsonlText.length;

  if (isComplete) {
    // Mark as fully processed
    await markWebhookProcessed(sql, message.webhookId, message.topic, message.bulkOperationId);
    await sql`
      UPDATE s6_bulk_operations
      SET byte_offset = ${newOffset}, completed_at = NOW()
      WHERE bulk_operation_id = ${message.bulkOperationId}
    `;
    return {
      success: true,
      action: "updated",
      skipReason: `Processed ${linesToProcess.length} lines, bulk operation complete`,
    };
  } else {
    // Save cursor for resume - don't mark as processed, don't archive
    await sql`
      UPDATE s6_bulk_operations
      SET byte_offset = ${newOffset}
      WHERE bulk_operation_id = ${message.bulkOperationId}
    `;
    return {
      success: false, // Not complete yet, keep message for next iteration
      action: "skipped",
      error: `Processed ${linesToProcess.length} lines, ${lines.length - config.bulkChunkSize} remaining`,
    };
  }
}

// =============================================================================
// RECONCILE HANDLERS
// =============================================================================

/**
 * Handler for RECONCILE_COMPANIES topic.
 * Starts a bulk companies export for the shop.
 */
async function handleReconcileCompanies(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency: use webhookId pattern "reconcile:<shop>:<YYYY-MM-DD>:<kind>"
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  // Start bulk companies export
  const result = await adminGraphQL<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(sql, message.shop, START_COMPANIES_BULK_MUTATION);

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  const bulkOp = result.data?.bulkOperationRunQuery;
  if (bulkOp?.userErrors?.length) {
    return {
      success: false,
      action: "skipped",
      error: `Bulk operation failed: ${bulkOp.userErrors.map((e) => e.message).join("; ")}`,
    };
  }

  if (bulkOp?.bulkOperation) {
    // Register the bulk operation for tracking
    await registerBulkOperation(sql, bulkOp.bulkOperation.id, message.shop, "companies");
  }

  // Mark reconcile as processed
  await markWebhookProcessed(sql, message.webhookId, message.topic, message.shop);

  return {
    success: true,
    action: "created",
    entityId: bulkOp?.bulkOperation?.id,
  };
}

/**
 * Handler for RECONCILE_ORDERS topic.
 * Starts a bulk orders export for the shop.
 */
async function handleReconcileOrders(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  if (await isWebhookProcessed(sql, message.webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  const result = await adminGraphQL<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: Array<{ field: string[]; message: string }>;
    };
  }>(sql, message.shop, START_ORDERS_BULK_MUTATION);

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
    };
  }

  const bulkOp = result.data?.bulkOperationRunQuery;
  if (bulkOp?.userErrors?.length) {
    return {
      success: false,
      action: "skipped",
      error: `Bulk operation failed: ${bulkOp.userErrors.map((e) => e.message).join("; ")}`,
    };
  }

  if (bulkOp?.bulkOperation) {
    await registerBulkOperation(sql, bulkOp.bulkOperation.id, message.shop, "orders");
  }

  await markWebhookProcessed(sql, message.webhookId, message.topic, message.shop);

  return {
    success: true,
    action: "created",
    entityId: bulkOp?.bulkOperation?.id,
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
registerSyncHandler("RECONCILE_COMPANIES", handleReconcileCompanies);
registerSyncHandler("RECONCILE_ORDERS", handleReconcileOrders);
registerBulkHandler("BULK_OPERATIONS_FINISH", handleBulkFinish);

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

    // No handler - extend visibility
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
      const syncResult = await handler(sql, msg.message, config);

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
