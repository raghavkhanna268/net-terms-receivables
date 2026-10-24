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
 * - Schema errors: GraphQL schema validation errors are non-retryable → DLQ immediately
 * - Per-message isolation: One bad message never aborts the batch
 * - No-handler: Messages without handlers get visibility extended (not DLQ'd immediately)
 * - Time budget: Stops early when wall-time budget is reached
 * - Progress status: Bulk operations can return {status:'progress'} for continuation
 */

import type { Sql } from "~/lib/db-light.server";
import { S6_QUEUES, type SyncMessage, type BulkMessage } from "~/lib/pgmq.server";
import {
  processCompanyWebhook,
  isWebhookProcessed,
  markWebhookProcessed,
} from "~/services/sync/company.server";
import { processCustomerWebhook, type CustomerPiiMode } from "~/services/sync/customer.server";
import { getRequestEnv } from "~/lib/request-context.server";
import { processDraftOrderWebhook } from "~/services/sync/draft-order.server";
import { processCompanyLocationWebhook } from "~/services/sync/company-location.server";
import { processOrderWebhook } from "~/services/sync/order.server";
import type {
  SyncResult,
  ShopifyCompany,
  ShopifyCompanyLocation,
  ShopifyOrder,
  ShopifyCustomer,
  ShopifyDraftOrder,
} from "~/services/sync/types";
import {
  adminGraphQL,
  COMPANY_QUERY,
  COMPANY_LOCATION_QUERY,
  ORDER_QUERY,
  DRAFT_ORDER_QUERY,
} from "./admin-client.server";
import {
  fetchCustomerWithFallback,
  incrementCustomerPiiAccessDeniedFallback,
} from "./customer-fetch.server";
import {
  processBulkOperation,
  type BulkProcessResult,
} from "~/services/sync/bulk-jsonl-processor.server";
import {
  startReconcileBulkOperation,
  incrementOrderRefetchNull,
  enqueueReconcileOrders,
} from "./reconcile-handlers.server";

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
 * Returns a BulkProcessResult indicating success/failure and status.
 */
export type BulkHandler = (
  sql: Sql,
  message: BulkMessage
) => Promise<BulkProcessResult>;

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
  // Idempotency check first (S20: use shop for new table)
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
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
      retryable: result.retryable,
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
  // Idempotency check (S20: use shop for new table)
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
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
      retryable: result.retryable,
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
 * - Always increment order_refetch_null counter (no PII)
 *
 * S20: triggeredAt is stored for audit, not used for ordering (re-fetch gets latest state).
 */

/**
 * Run backstop only for ORDERS_CREATE redelivery.
 *
 * When a webhook was already processed but backstop failed (returned retryable),
 * on redelivery we skip order processing but must still run backstop.
 * Backstop is idempotent via backstop_processed_orders table.
 */
async function runBackstopOnly(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  const {
    applyBackstop,
    RetryableBackstopError,
    recordBackstopFailure,
    resolveInvoiceForOrder,
  } = await import("~/services/backstop.server");

  // Resolve invoice by shop domain + order GID
  const invoiceInfo = await resolveInvoiceForOrder(sql, message.shop, message.resourceGid);

  if (!invoiceInfo) {
    // No invoice found - this order may not be a net-terms order
    // Return success to avoid infinite retries for non-net-terms orders
    console.log(
      `[backstop] Redelivery skipped - no invoice found for ${message.resourceGid} (not a net-terms order?)`
    );
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed, no invoice to backstop",
    };
  }

  try {
    const backstopResult = await applyBackstop(sql, {
      shopDomain: message.shop,
      shopId: invoiceInfo.shopId,
      orderGid: message.resourceGid,
      buyerAccountId: invoiceInfo.buyerAccountId,
      invoiceId: invoiceInfo.invoiceId,
    });

    if (backstopResult.applied) {
      console.log(
        `[backstop] Applied on redelivery to ${message.resourceGid}: ${backstopResult.fulfillmentOrdersHeld} FOs held`
      );
    }

    // Backstop succeeded or skipped - return success
    return {
      success: true,
      action: "skipped",
      skipReason: backstopResult.skipped
        ? `Webhook processed, backstop skipped: ${backstopResult.skipReason}`
        : "Webhook processed, backstop applied on redelivery",
    };
  } catch (e) {
    if (e instanceof RetryableBackstopError) {
      console.warn(
        `[backstop] Redelivery retryable error for ${message.resourceGid}: ${e.message}`
      );
      return {
        success: false,
        action: "skipped" as const,
        error: `Backstop retryable error: ${e.message}`,
        retryable: true,
      };
    }

    // Non-retryable error: log, record failure, but allow message to complete
    console.error(`[backstop] Redelivery unexpected error for ${message.resourceGid}:`, e);
    await recordBackstopFailure(
      sql,
      invoiceInfo.shopId,
      message.resourceGid,
      invoiceInfo.buyerAccountId,
      e instanceof Error ? e.message : String(e),
    );

    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook processed, backstop failed (recorded)",
    };
  }
}

async function handleOrder(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Parse triggeredAt from message (S20: stored for audit, not used for ordering)
  const triggeredAt = message.triggeredAt ? new Date(message.triggeredAt) : null;

  // Idempotency check
  const webhookAlreadyProcessed = await isWebhookProcessed(sql, message.webhookId, message.shop);

  // For ORDERS_CREATE, backstop MUST run even on redelivery (backstop is idempotent via
  // backstop_processed_orders table). For other topics, early return is fine.
  if (webhookAlreadyProcessed && message.topic !== "ORDERS_CREATE") {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // ORDERS_CREATE redelivery: skip order processing but still run backstop
  if (webhookAlreadyProcessed && message.topic === "ORDERS_CREATE") {
    return runBackstopOnly(sql, message);
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
      retryable: result.retryable,
    };
  }

  // If node is null, order may be >60 days old (without read_all_orders)
  // NEVER assume deleted - this would break Net 60/90 invoices
  if (!result.data?.node) {
    // Log distinct warning (shop and order GID only, no PII)
    console.warn(
      `[order_refetch_null] shop=${message.shop} order=${message.resourceGid} topic=${message.topic}`
    );

    // Increment metric counter (S10b aggregate table)
    await incrementOrderRefetchNull(sql, message.shop);

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
        message.webhookId,
        triggeredAt
      );
    }

    // For CREATE/UPDATED, we can't process without full order data
    // Keep ledger state unchanged, mark webhook processed
    await markWebhookProcessed(sql, message.webhookId, message.topic, message.resourceGid, message.shop);
    return {
      success: true,
      action: "skipped",
      skipReason: "Order refetch returned null (may be >60 days old). Ledger state unchanged.",
    };
  }

  const orderResult = await processOrderWebhook(
    sql,
    message.shop,
    message.topic,
    result.data.node,
    message.webhookId,
    triggeredAt
  );

  // S13: Apply backstop for ORDERS_CREATE on held accounts
  // Always try to apply backstop on ORDERS_CREATE, even on redelivery when orderResult
  // indicates the webhook was already processed (no entityId). The webhook marks the
  // order processed at order.server.ts:156, but backstop must still run on retries.
  if (message.topic === "ORDERS_CREATE") {
    const {
      applyBackstop,
      RetryableBackstopError,
      recordBackstopFailure,
      resolveInvoiceForOrder,
    } = await import("~/services/backstop.server");

    // Resolve invoice info - either from webhook result or by looking up by order GID
    let invoiceInfo: { shopId: string; buyerAccountId: string | null; invoiceId: string } | null = null;

    if (orderResult.success && orderResult.entityId) {
      // First attempt: use the invoice ID from webhook processing
      const [info] = await sql<{
        shopId: string;
        buyerAccountId: string | null;
        invoiceId: string;
      }[]>`
        SELECT "shopId", "buyerAccountId", id AS "invoiceId"
        FROM "Invoice"
        WHERE id = ${orderResult.entityId}
      `;
      invoiceInfo = info ?? null;
    } else {
      // Redelivery or webhook skipped: resolve invoice by shop domain + order GID
      invoiceInfo = await resolveInvoiceForOrder(sql, message.shop, message.resourceGid);
    }

    if (invoiceInfo) {
      try {
        const backstopResult = await applyBackstop(sql, {
          shopDomain: message.shop,
          shopId: invoiceInfo.shopId,
          orderGid: message.resourceGid,
          buyerAccountId: invoiceInfo.buyerAccountId,
          invoiceId: invoiceInfo.invoiceId,
        });

        if (backstopResult.applied) {
          console.log(
            `[backstop] Applied to order ${message.resourceGid}: ${backstopResult.fulfillmentOrdersHeld} fulfillment orders held`
          );
        }
      } catch (e) {
        if (e instanceof RetryableBackstopError) {
          // Retryable error: return failure to trigger pgmq retry
          console.warn(
            `[backstop] Retryable error for ${message.resourceGid}: ${e.message} (reason: ${e.reason})`
          );

          return {
            success: false,
            action: "skipped" as const,
            error: `Backstop retryable error: ${e.message}`,
            retryable: true,
          };
        }

        // Non-RetryableBackstopError: log and record failure, but don't block order processing
        console.error(`[backstop] Unexpected error for ${message.resourceGid}:`, e);
        await recordBackstopFailure(
          sql,
          invoiceInfo.shopId,
          message.resourceGid,
          invoiceInfo.buyerAccountId,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  return orderResult;
}

// =============================================================================
// S8 HANDLER IMPLEMENTATIONS
// =============================================================================

/**
 * Handler for CUSTOMERS_* topics.
 * Fetches the customer via GraphQL and processes it.
 *
 * DPDP compliance (Level 1 + Name + Email):
 * - Always fetches: id, tags
 * - Optional PII (CUSTOMER_PII_FIELDS=1): email, displayName
 * - NEVER fetches: phone, addresses
 *
 * ACCESS_DENIED fallback:
 * If PCD approval is pending and Shopify returns ACCESS_DENIED for PII fields,
 * we retry with base fields only (id, tags) and process without PII.
 * This avoids dead-lettering every customer message while awaiting approval.
 */
async function handleCustomer(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency check (S20: use shop for new table)
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // Determine PII mode based on env config
  const env = getRequestEnv() ?? {};
  const piiEnabled = env.CUSTOMER_PII_FIELDS === "1";

  // For DELETE, we don't need to fetch - just process
  // Use 'disabled' mode since we're not fetching PII anyway
  if (message.topic === "CUSTOMERS_DELETE") {
    const customer: ShopifyCustomer = {
      id: message.resourceGid,
      tags: [],
    };
    return processCustomerWebhook(
      sql, message.shop, message.topic, customer, message.webhookId,
      piiEnabled ? "fetched" : "disabled"
    );
  }

  // Fetch customer data via GraphQL with ACCESS_DENIED fallback
  const result = await fetchCustomerWithFallback(message.shop, message.resourceGid);

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
      retryable: result.retryable,
    };
  }

  // If node is null, the resource was deleted
  if (!result.data) {
    const customer: ShopifyCustomer = {
      id: message.resourceGid,
      tags: [],
    };
    return processCustomerWebhook(
      sql, message.shop, "CUSTOMERS_DELETE", customer, message.webhookId,
      piiEnabled ? "fetched" : "disabled"
    );
  }

  // Determine piiMode:
  // - 'fallback': ACCESS_DENIED retry was used - preserve existing values
  // - 'fetched': PII query succeeded - write values as returned
  // - 'disabled': CUSTOMER_PII_FIELDS !== '1' - clear PII
  let piiMode: CustomerPiiMode;
  if (!piiEnabled) {
    piiMode = "disabled";
  } else if (result.usedFallback) {
    piiMode = "fallback";
  } else {
    piiMode = "fetched";
  }

  // Log warning if fallback was used
  if (result.usedFallback) {
    console.warn(
      `[customer_pii_access_denied_fallback] shop=${message.shop} ` +
        `customer=${message.resourceGid} topic=${message.topic} ` +
        `fields=email,displayName`
    );
  }

  // Process the customer
  const syncResult = await processCustomerWebhook(
    sql,
    message.shop,
    message.topic,
    result.data,
    message.webhookId,
    piiMode
  );

  // Best-effort counter increment after successful processing
  // Wrapped in try/catch so a failed insert (e.g., migration not applied) never fails the message
  if (result.usedFallback && syncResult.success) {
    try {
      await incrementCustomerPiiAccessDeniedFallback(sql, message.shop);
    } catch (err) {
      console.warn(
        `[customer_pii_access_denied_fallback] counter increment failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return syncResult;
}

/**
 * Handler for DRAFT_ORDERS_* topics.
 * Fetches the draft order via GraphQL and processes it.
 */
async function handleDraftOrder(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency check (S20: use shop for new table)
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // For DELETE, we don't need to fetch - just process
  if (message.topic === "DRAFT_ORDERS_DELETE") {
    const draftOrder: ShopifyDraftOrder = {
      id: message.resourceGid,
      name: "",
      createdAt: new Date().toISOString(),
    };
    return processDraftOrderWebhook(sql, message.shop, message.topic, draftOrder, message.webhookId);
  }

  // Fetch draft order data via GraphQL
  const result = await adminGraphQL<{
    node: ShopifyDraftOrder | null;
  }>(message.shop, DRAFT_ORDER_QUERY, { id: message.resourceGid });

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
      retryable: result.retryable,
    };
  }

  // If node is null, the resource was deleted
  if (!result.data?.node) {
    const draftOrder: ShopifyDraftOrder = {
      id: message.resourceGid,
      name: "",
      createdAt: new Date().toISOString(),
    };
    return processDraftOrderWebhook(sql, message.shop, "DRAFT_ORDERS_DELETE", draftOrder, message.webhookId);
  }

  return processDraftOrderWebhook(
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

// Register S8 handlers
registerSyncHandler("CUSTOMERS_CREATE", handleCustomer);
registerSyncHandler("CUSTOMERS_UPDATE", handleCustomer);
registerSyncHandler("CUSTOMERS_DELETE", handleCustomer);
registerSyncHandler("DRAFT_ORDERS_CREATE", handleDraftOrder);
registerSyncHandler("DRAFT_ORDERS_UPDATE", handleDraftOrder);
registerSyncHandler("DRAFT_ORDERS_DELETE", handleDraftOrder);

// =============================================================================
// S10b BULK OPERATIONS HANDLER
// =============================================================================

/**
 * Handler for BULK_OPERATIONS_FINISH topic.
 * Downloads JSONL in chunks using HTTP Range and processes via S6 services.
 *
 * For reconcile operations (companies bulk type):
 * - When companies reconcile completes, enqueue RECONCILE_ORDERS
 * - This ensures companies exist before order-to-account mapping
 * - Uses chainToOrders flag from result (based on origin/stage in s6_bulk_operations)
 */
async function handleBulkOperationsFinish(sql: Sql, message: BulkMessage): Promise<BulkProcessResult> {
  const result = await processBulkOperation(sql, message);

  // If companies reconcile completed successfully, chain to orders reconcile
  // The chainToOrders flag is set based on origin='reconcile' and reconcile_stage='companies'
  // from the s6_bulk_operations row, not from webhookId
  if (result.chainToOrders) {
    await enqueueReconcileOrders(sql, message.shop);
  }

  return result;
}

// Register BULK_OPERATIONS_FINISH handler
registerBulkHandler("BULK_OPERATIONS_FINISH", handleBulkOperationsFinish);

// =============================================================================
// S10b RECONCILE HANDLERS
// =============================================================================

/**
 * Handler for RECONCILE_COMPANIES topic.
 * Starts a bulk companies export for the shop.
 */
async function handleReconcileCompanies(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  return startReconcileBulkOperation(sql, message.shop, "companies", message.webhookId);
}

/**
 * Handler for RECONCILE_ORDERS topic.
 * Starts a bulk orders export for the shop.
 */
async function handleReconcileOrders(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  return startReconcileBulkOperation(sql, message.shop, "orders", message.webhookId);
}

// Register RECONCILE_* handlers
registerSyncHandler("RECONCILE_COMPANIES", handleReconcileCompanies);
registerSyncHandler("RECONCILE_ORDERS", handleReconcileOrders);

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
        // Failed - determine if DLQ based on retryable flag
        // Non-retryable errors (schema/auth) go to DLQ immediately on first read
        // Retryable errors use read_ct threshold
        const shouldDlq =
          syncResult.retryable === false || msg.read_ct >= config.maxRetries;

        if (shouldDlq) {
          const dlqReason =
            syncResult.retryable === false
              ? `Non-retryable error: ${syncResult.error || "Unknown"}`
              : syncResult.error || "Max retries exceeded";

          // S13: Record backstop.failed for ORDERS_CREATE when DLQ'ing
          if (msg.message.topic === "ORDERS_CREATE") {
            const { recordBackstopFailure, resolveInvoiceForOrder } = await import(
              "~/services/backstop.server"
            );
            const invoiceInfo = await resolveInvoiceForOrder(
              sql,
              msg.message.shop,
              msg.message.resourceGid
            );
            if (invoiceInfo) {
              await recordBackstopFailure(
                sql,
                invoiceInfo.shopId,
                msg.message.resourceGid,
                invoiceInfo.buyerAccountId,
                dlqReason
              );
            }
          }

          await moveToDeadLetter(
            sql,
            S6_QUEUES.SYNC,
            msg.msg_id,
            msg.message,
            dlqReason
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
      // Uncaught exceptions are treated as retryable (transient failures)
      // Only DLQ after max retries to avoid losing messages on transient issues
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      if (msg.read_ct >= config.maxRetries) {
        // S13: Record backstop.failed for ORDERS_CREATE when DLQ'ing
        if (msg.message.topic === "ORDERS_CREATE") {
          const { recordBackstopFailure, resolveInvoiceForOrder } = await import(
            "~/services/backstop.server"
          );
          const invoiceInfo = await resolveInvoiceForOrder(
            sql,
            msg.message.shop,
            msg.message.resourceGid
          );
          if (invoiceInfo) {
            await recordBackstopFailure(
              sql,
              invoiceInfo.shopId,
              msg.message.resourceGid,
              invoiceInfo.buyerAccountId,
              errorMsg
            );
          }
        }

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
      const bulkResult = await handler(sql, msg.message);

      if (bulkResult.success) {
        // Check status for progress vs complete
        if (bulkResult.status === "progress") {
          // Atomically send continuation and archive old message in one transaction.
          // This eliminates the duplicate-message window entirely:
          // - If transaction commits: new message exists, old is archived
          // - If transaction fails/crashes: old message retries normally
          await sql.begin(async (tx) => {
            await tx`SELECT pgmq.send(${S6_QUEUES.BULK}, ${tx.json(msg.message)})`;
            await tx`SELECT pgmq.archive(${S6_QUEUES.BULK}, ${msg.msg_id}::bigint)`;
          });

          result.processed++; // Count as progress
        } else {
          // Complete or other success - archive
          await archiveMessage(sql, S6_QUEUES.BULK, msg.msg_id);
          if (bulkResult.action === "skipped") {
            result.skipped++;
          } else {
            result.processed++;
          }
        }
      } else {
        // Error handling based on errorType classification
        const errorType = bulkResult.errorType;

        if (errorType === "permanent") {
          // Permanent error (4xx, bad data, exhausted retries) - go to DLQ
          await moveToDeadLetter(
            sql,
            S6_QUEUES.BULK,
            msg.msg_id,
            msg.message,
            bulkResult.error || "Permanent error"
          );
          result.deadLettered++;
        } else if (errorType === "retryable") {
          // Retryable error - leave message in queue for retry via read_ct
          // The failure_count was already incremented by processBulkOperation
          // Message will be retried on next read (visibility timeout reset)
          result.failed++;
        } else {
          // Unknown error type or legacy path - use read_ct for DLQ
          if (msg.read_ct >= config.maxRetries) {
            await moveToDeadLetter(
              sql,
              S6_QUEUES.BULK,
              msg.msg_id,
              msg.message,
              bulkResult.error || "Max retries exceeded"
            );
            result.deadLettered++;
          } else {
            result.failed++;
          }
        }
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          error: bulkResult.error || "Unknown error",
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
