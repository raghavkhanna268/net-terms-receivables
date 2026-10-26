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
import { validateCustomerQuery } from "~/services/sync/customer-fields.server";
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
  ORDER_QUERY,
  DRAFT_ORDER_QUERY,
  getCompanyLocationQuery,
  getCompanyLocationQueryWithoutContact,
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
  enqueueReconcileStage,
  getManualKeyForBulkOp,
  type StartReconcileResult,
} from "./reconcile-handlers.server";
import { toErrorCode, safeLog, shopHash } from "~/lib/log.server";
import { isShopCurrencySupported } from "~/lib/shop-currency.server";
import {
  isShopNotFoundReason,
  sanitizeSyncMessage,
  sanitizeBulkMessage,
  type SanitizedDeadLetterMessage,
} from "./dead-letter-sanitize.server";

/**
 * Check if a no_session error should be relabelled as shop_not_found.
 *
 * Used by COMPANIES_*, COMPANY_LOCATIONS_*, and ORDERS_* handlers to detect
 * post-uninstall webhooks. When adminGraphQL fails with no_session and the Shop
 * row is missing or uninstalledAt is set, we return a shop_not_found result.
 *
 * For COMPANIES_* and COMPANY_LOCATIONS_* CREATE/UPDATE, the caller returns
 * the result directly (goes to DLQ with sanitization).
 *
 * For ORDERS_*, the caller converts this to success:true to ACK immediately
 * without DLQ entry or recordBackstopFailure.
 *
 * Part of #239.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain to check
 * @returns SyncResult with shop_not_found if shop is missing/uninstalled, null otherwise
 */
async function checkNoSessionForUninstalledShop(
  sql: Sql,
  shopDomain: string
): Promise<SyncResult | null> {
  const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
    SELECT "uninstalledAt" FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop || shop.uninstalledAt !== null) {
    // Shop is missing or uninstalled—relabel to shop_not_found.
    // For COMPANIES_* and COMPANY_LOCATIONS_*: returned directly → goes to DLQ with sanitization.
    // For ORDERS_*: caller converts to success:true → ACKed immediately (no DLQ).
    // Omit `retryable` because shop_not_found is non-retryable by definition and the
    // drain uses errorCode (not retryable flag) to decide sanitization eligibility.
    return {
      success: false,
      action: "skipped",
      error: "shop_not_found",
      errorCode: "shop_not_found",
    };
  }

  return null;
}

/**
 * #292 G8: Terminal topics that must reach handlers even for non-INR shops.
 * These update existing rows without importing new amounts:
 * - ORDERS_PAID: marks existing invoice as paid
 * - ORDERS_CANCELLED: marks existing invoice as cancelled  
 * - DRAFT_ORDERS_DELETE: deletes existing draft order
 */
const TERMINAL_TOPICS = new Set([
  "ORDERS_PAID",
  "ORDERS_CANCELLED",
  "DRAFT_ORDERS_DELETE",
]);

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
    // Part of #239: Check if this is a no_session error on a CREATE/UPDATE webhook.
    if (
      result.errorCode === "no_session" &&
      (message.topic === "COMPANIES_CREATE" || message.topic === "COMPANIES_UPDATE")
    ) {
      const shopNotFound = await checkNoSessionForUninstalledShop(sql, message.shop);
      if (shopNotFound) return shopNotFound;
    }
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
 *
 * PII handling: Uses getRequestEnv() to read CUSTOMER_PII_FIELDS flag.
 * When flag is on, mainContact.customer { email displayName } are stored.
 * The query is built dynamically to only request PII when the flag is on.
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

  // Get Worker env for PII flag (passed to sync functions)
  const env = getRequestEnv() ?? {};

  // For DELETE, process without fetch
  if (message.topic === "COMPANY_LOCATIONS_DELETE") {
    const location: ShopifyCompanyLocation = {
      id: message.resourceGid,
      name: "",
      company: { id: "" },
    };
    return processCompanyLocationWebhook(sql, message.shop, message.topic, location, message.webhookId, env);
  }

  // Build query dynamically based on PII flag (data minimization)
  const query = getCompanyLocationQuery(env);
  validateCustomerQuery(query, env);

  // Fetch location data via GraphQL
  const result = await adminGraphQL<{
    node: ShopifyCompanyLocation | null;
  }>(message.shop, query, { id: message.resourceGid });

  if (!result.success) {
    // Handle access denied on mainContact gracefully - don't fail the whole sync
    // Match only on errorCode, not message text (more reliable)
    if (result.errorCode === "ACCESS_DENIED") {
      safeLog("warn", "company_location_contact_access_denied", {
        shopHash: await shopHash(message.shop),
        locationGid: message.resourceGid,
      });
      // Retry with a query that completely omits mainContact
      const baseResult = await adminGraphQL<{
        node: ShopifyCompanyLocation | null;
      }>(message.shop, getCompanyLocationQueryWithoutContact(), { id: message.resourceGid });
      
      if (baseResult.success && baseResult.data?.node) {
        // Pass contactKnown=false to preserve any existing stored contact
        return processCompanyLocationWebhook(
          sql,
          message.shop,
          message.topic,
          baseResult.data.node,
          message.webhookId,
          env,
          false // contactKnown=false: preserve existing stored contact
        );
      }
    }
    // Part of #239: Check if this is a no_session error on a CREATE/UPDATE webhook.
    if (
      result.errorCode === "no_session" &&
      (message.topic === "COMPANY_LOCATIONS_CREATE" || message.topic === "COMPANY_LOCATIONS_UPDATE")
    ) {
      const shopNotFound = await checkNoSessionForUninstalledShop(sql, message.shop);
      if (shopNotFound) return shopNotFound;
    }
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
    return processCompanyLocationWebhook(sql, message.shop, "COMPANY_LOCATIONS_DELETE", location, message.webhookId, env);
  }

  return processCompanyLocationWebhook(
    sql,
    message.shop,
    message.topic,
    result.data.node,
    message.webhookId,
    env
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
 * Shared backstop execution helper.
 *
 * Runs applyBackstop with proper error handling. ALL errors are retryable
 * so they reach DLQ (which writes backstop.failed) instead of being silently archived.
 *
 * @param isRedelivery - True if this is a redelivery (affects logging only)
 * @returns SyncResult with backstop outcome, or null if no invoiceInfo
 */
async function executeBackstop(
  sql: Sql,
  shopDomain: string,
  orderGid: string,
  invoiceInfo: { shopId: string; buyerAccountId: string | null; invoiceId: string },
  isRedelivery: boolean
): Promise<SyncResult | null> {
  const { applyBackstop, RetryableBackstopError } = await import("~/services/backstop.server");
  const context = isRedelivery ? "Redelivery" : "First-attempt";

  try {
    const backstopResult = await applyBackstop(sql, {
      shopDomain,
      shopId: invoiceInfo.shopId,
      orderGid,
      buyerAccountId: invoiceInfo.buyerAccountId,
      invoiceId: invoiceInfo.invoiceId,
    });

    if (backstopResult.applied) {
      console.log(
        `[backstop] Applied (${context.toLowerCase()}) to ${orderGid}: ${backstopResult.fulfillmentOrdersHeld} FOs held`
      );
    }

    // Only return a result for redelivery path; first-attempt returns orderResult
    if (isRedelivery) {
      return {
        success: true,
        action: "skipped",
        skipReason: backstopResult.skipped
          ? `Webhook processed, backstop skipped: ${backstopResult.skipReason}`
          : "Webhook processed, backstop applied on redelivery",
      };
    }

    return null; // First-attempt: caller returns orderResult
  } catch (e) {
    const errorCode = toErrorCode(e);
    const isRetryableError = e instanceof RetryableBackstopError;

    safeLog("warn", "backstop_error", {
      orderGid,
      err: errorCode,
      retryable: isRetryableError,
    });

    return {
      success: false,
      action: "skipped" as const,
      error: errorCode,
      errorCode,
      retryable: true,
    };
  }
}

/**
 * Run backstop only for ORDERS_CREATE redelivery.
 *
 * When a webhook was already processed but backstop failed (returned retryable),
 * on redelivery we skip order processing but must still run backstop.
 * Backstop is idempotent via backstop_processed_orders table.
 */
async function runBackstopOnly(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  const { resolveInvoiceForOrder } = await import("~/services/backstop.server");

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

  const result = await executeBackstop(sql, message.shop, message.resourceGid, invoiceInfo, true);
  return result!; // Always returns a result for redelivery
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
    // Part of #239: Check if this is a no_session error for ORDERS_* webhooks.
    // If shop is missing or uninstalled, ACK the message immediately (no DLQ).
    // Unlike COMPANIES_*, ORDERS_* are ACKed to avoid DLQ entry and recordBackstopFailure
    // for post-uninstall webhooks.
    if (result.errorCode === "no_session") {
      const shopNotFound = await checkNoSessionForUninstalledShop(sql, message.shop);
      if (shopNotFound) {
        safeLog("info", "order_webhook_uninstalled_shop_acked", {
          shopHash: await shopHash(message.shop),
          topic: message.topic,
        });
        return {
          success: true,
          action: "skipped",
          skipReason: "shop_not_found",
        };
      }
    }
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
    safeLog("warn", "order_refetch_null", {
      shopHash: await shopHash(message.shop),
      orderGid: message.resourceGid,
      topic: message.topic,
    });

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
  if (message.topic === "ORDERS_CREATE") {
    const { resolveInvoiceForOrder } = await import("~/services/backstop.server");

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
      // Webhook skipped: resolve invoice by shop domain + order GID
      invoiceInfo = await resolveInvoiceForOrder(sql, message.shop, message.resourceGid);
    }

    if (invoiceInfo) {
      const backstopResult = await executeBackstop(
        sql,
        message.shop,
        message.resourceGid,
        invoiceInfo,
        false // first-attempt
      );

      // If backstop returned an error result, propagate it
      if (backstopResult) {
        return backstopResult;
      }
      // Otherwise backstop succeeded, continue to return orderResult
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
    safeLog("warn", "customer_pii_access_denied_fallback", {
      shopHash: await shopHash(message.shop),
      customerId: message.resourceGid,
      topic: message.topic,
      fields: "email,displayName",
    });
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

  if (result.usedFallback && syncResult.success) {
    try {
      await incrementCustomerPiiAccessDeniedFallback(sql, message.shop);
    } catch (err) {
      safeLog("warn", "customer_pii_access_denied_fallback_counter_failed", {
        err: toErrorCode(err),
      });
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
 * For reconcile operations:
 * - Chains to the next stage in sequence: companies → customers → orders
 * - Uses nextStage from result (based on origin/stage in s6_bulk_operations)
 * - Manual key is propagated from the original stage's webhookId
 *
 * #293: Passes prevBulkOperationId to enqueueReconcileStage so it can check
 * that the previous stage's bulk operation is not closed (reinstall reset).
 */
async function handleBulkOperationsFinish(sql: Sql, message: BulkMessage): Promise<BulkProcessResult> {
  const result = await processBulkOperation(sql, message);

  if (result.nextStage) {
    const manualKey = await getManualKeyForBulkOp(sql, message.bulkOperationId, message.shop);
    await enqueueReconcileStage(sql, message.shop, result.nextStage, manualKey, message.bulkOperationId);
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
 * Handler for RECONCILE_CUSTOMERS topic.
 * Starts a bulk customers export for the shop (filtered by tag rules).
 *
 * If the shop has no tag rules, the stage is skipped and the next stage
 * (orders) is enqueued immediately.
 */
async function handleReconcileCustomers(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  const result = await startReconcileBulkOperation(sql, message.shop, "customers", message.webhookId) as StartReconcileResult;

  if (result.skipped) {
    const manualKey = message.manualKey;
    await enqueueReconcileStage(sql, message.shop, "orders", manualKey);
    await markWebhookProcessed(sql, message.webhookId, "RECONCILE_CUSTOMERS", "skipped", message.shop);
  }

  return result;
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

/**
 * Handler for RECONCILE_DRAFT_ORDERS topic.
 * Starts a bulk draft orders export for the shop.
 *
 * Exports draft orders with status=open or status=invoice_sent for
 * pending credit exposure tracking.
 */
async function handleReconcileDraftOrders(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reconcile already processed (idempotent)",
    };
  }

  return startReconcileBulkOperation(sql, message.shop, "draft_orders", message.webhookId);
}

// Register RECONCILE_* handlers
registerSyncHandler("RECONCILE_COMPANIES", handleReconcileCompanies);
registerSyncHandler("RECONCILE_CUSTOMERS", handleReconcileCustomers);
registerSyncHandler("RECONCILE_ORDERS", handleReconcileOrders);
registerSyncHandler("RECONCILE_DRAFT_ORDERS", handleReconcileDraftOrders);

// =============================================================================
// CREDIT STATUS RECOMPUTE HANDLER
// =============================================================================

/**
 * Handler for CREDIT_STATUS_RECOMPUTE topic.
 *
 * Recomputes credit status for a buyer account and writes the metafield
 * only when the hold value actually changes.
 *
 * Used by both:
 * - Event-driven recompute (after invoice changes)
 * - Time-driven recompute (daily cron via pgmq)
 *
 * Idempotent: safe to process the same message multiple times.
 */
async function handleCreditStatusRecompute(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, message.webhookId, message.shop)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Credit status recompute already processed (idempotent)",
    };
  }

  // Extract buyerAccountId and source from message
  const extendedMessage = message as SyncMessage & { buyerAccountId?: string; source?: string };
  const buyerAccountId = extendedMessage.buyerAccountId;
  if (!buyerAccountId) {
    return {
      success: false,
      action: "skipped",
      error: "Missing buyerAccountId in CREDIT_STATUS_RECOMPUTE message",
      retryable: false,
    };
  }

  const { recomputeCreditStatus } = await import("~/services/credit-status-recompute.server");
  const { CREDIT_STATUS_SOURCES } = await import("~/services/credit-status.server");
  type CreditStatusSource = (typeof CREDIT_STATUS_SOURCES)[number];

  // Map source string from message to CreditStatusSource (defaults to 'unknown')
  const messageSource = extendedMessage.source;
  const source: CreditStatusSource = 
    messageSource && (CREDIT_STATUS_SOURCES as readonly string[]).includes(messageSource) 
      ? (messageSource as CreditStatusSource) 
      : "unknown";
  const result = await recomputeCreditStatus(sql, buyerAccountId, source);

  if (!result.success) {
    return {
      success: false,
      action: "skipped",
      error: result.error,
      errorCode: result.errorCode,
      retryable: result.retryable ?? true,
    };
  }

  // Mark as processed
  await markWebhookProcessed(sql, message.webhookId, message.topic, message.resourceGid, message.shop);

  let skipReason: string | undefined;
  if (!result.metafieldWritten) {
    if (result.noOwner) {
      skipReason = "No owner GID, holdState persisted but metafield not written";
    } else if (result.backoffSkipped) {
      skipReason = "Backoff active, holdState persisted but metafield write skipped";
    } else if (result.previousHold !== result.newHold) {
      skipReason = "Hold value changed, DB updated but metafield sync pending";
    } else {
      skipReason = "Hold value unchanged, no metafield write needed";
    }
  }

  return {
    success: true,
    action: result.metafieldWritten ? "created" : "skipped",
    skipReason,
  };
}

// Register CREDIT_STATUS_RECOMPUTE handler
registerSyncHandler("CREDIT_STATUS_RECOMPUTE", handleCreditStatusRecompute);

// =============================================================================
// S18 REMINDER HANDLERS
// =============================================================================

/**
 * Handler for REMINDER_SEND topic.
 * Sends payment reminder emails via Resend.
 */
async function handleReminderSend(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  const { handleReminderSend: processReminder, isReminderSendMessage } = await import(
    "~/jobs/reminders"
  );

  if (!isReminderSendMessage(message)) {
    return {
      success: false,
      action: "skipped",
      error: "Invalid REMINDER_SEND message format",
      retryable: false,
    };
  }

  return processReminder(sql, message);
}

/**
 * Handler for REMINDER_CATCHUP topic.
 * Sends catch-up reminders for delayed (capped) entries.
 */
async function handleReminderCatchup(sql: Sql, message: SyncMessage): Promise<SyncResult> {
  const { handleReminderCatchup: processCatchup, isReminderCatchupMessage } = await import(
    "~/jobs/reminders"
  );

  if (!isReminderCatchupMessage(message)) {
    return {
      success: false,
      action: "skipped",
      error: "Invalid REMINDER_CATCHUP message format",
      retryable: false,
    };
  }

  return processCatchup(sql, message);
}

// Register REMINDER_SEND handler
registerSyncHandler("REMINDER_SEND", handleReminderSend);

// Register REMINDER_CATCHUP handler
registerSyncHandler("REMINDER_CATCHUP", handleReminderCatchup);

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
  /** Number of DLQ attempts where the message was already gone (e.g., shop/redact) */
  deadLetterAlreadyGoneCount: number;
  /** Number of messages skipped (already processed or deferred) */
  skipped: number;
  /** Number of messages with no handler (visibility extended) */
  noHandler: number;
  /** Whether the drain stopped due to time budget */
  timedOut: boolean;
  /** Total wall time in milliseconds */
  elapsedMs: number;
  /** Errors encountered (for logging) - code only, no raw messages */
  errors: Array<{ msgId: string; topic: string; code: string }>;
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
 *
 * Delete-first design for shop/redact safety (#239):
 * If shop/redact deleted this message while we held it under VT, pgmq.delete
 * returns false and we skip the s6_dead_letter INSERT. This prevents the
 * DLQ write from re-creating data that the redact just cleaned up.
 *
 * Shop-not-found sanitization (#239 part a):
 * When the error is shop_not_found and the topic has reconcile coverage
 * (companies, company_locations, orders, bulk companies/orders), the message
 * is sanitized to an allowlisted object without PII. Draft orders and customers
 * keep their full message because nothing re-fetches those after install.
 *
 * @param sql - postgres.js SQL client
 * @param queue - Queue name (s6_sync or s6_bulk)
 * @param msgId - Message ID from the queue
 * @param message - Original message (sync or bulk)
 * @param error - Error reason (e.g., 'shop_not_found', 'permanent:shop_not_found')
 * @param readCt - Read count for attempt tracking (required for sanitization)
 * @returns true if the message was successfully dead-lettered, false if
 *          the message was already deleted (e.g., by shop/redact)
 */
async function moveToDeadLetter(
  sql: Sql,
  queue: string,
  msgId: string,
  message: SyncMessage | BulkMessage,
  error: string,
  readCt: number
): Promise<boolean> {
  let messageToStore: SyncMessage | BulkMessage | SanitizedDeadLetterMessage = message;

  if (isShopNotFoundReason(error)) {
    if (queue === S6_QUEUES.SYNC) {
      const sanitized = sanitizeSyncMessage(message as SyncMessage, msgId, readCt);
      if (sanitized) {
        messageToStore = sanitized;
        safeLog("info", "dlq_sanitized_shop_not_found", {
          topic: message.topic,
          originalMsgId: msgId,
        });
      }
    } else if (queue === S6_QUEUES.BULK) {
      const sanitized = sanitizeBulkMessage(message as BulkMessage, msgId, readCt);
      if (sanitized) {
        messageToStore = sanitized;
        safeLog("info", "dlq_sanitized_shop_not_found", {
          topic: message.topic,
          bulkType: (message as BulkMessage).bulkType,
          originalMsgId: msgId,
        });
      }
    }
  }

  return sql.begin(async (tx) => {
    const [result] = await tx<[{ delete: boolean }]>`
      SELECT pgmq.delete(${queue}, ${msgId}::bigint)
    `;

    if (!result.delete) {
      return false;
    }

    await tx`
      INSERT INTO s6_dead_letter (
        original_queue,
        original_msg_id,
        message,
        error,
        dead_lettered_at
      ) VALUES (
        ${queue},
        ${msgId},
        ${tx.json(messageToStore)},
        ${error},
        NOW()
      )
    `;
    return true;
  });
}

/**
 * #292: Batch lookup shop currencies for INR-only filtering.
 * Returns a map of shop domain to currency string. Shops not in the map were not found.
 * NULL currency in DB is stored as empty string "" (sentinel) to distinguish from not found.
 */
async function loadShopCurrencies(
  sql: Sql,
  shopDomains: string[]
): Promise<Map<string, string>> {
  if (shopDomains.length === 0) {
    return new Map();
  }

  const uniqueDomains = [...new Set(shopDomains)];
  // Note: use IN ${sql(ids)} instead of ANY(${ids}) for fetch_types:false compatibility
  const rows = await sql<{ domain: string; currency: string | null }[]>`
    SELECT domain, currency FROM "Shop" WHERE domain IN ${sql(uniqueDomains)}
  `;

  const result = new Map<string, string>();
  for (const row of rows) {
    // Store NULL as empty string to distinguish from "shop not found"
    result.set(row.domain, row.currency ?? "");
  }
  return result;
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
    deadLetterAlreadyGoneCount: 0,
    skipped: 0,
    noHandler: 0,
    timedOut: false,
    elapsedMs: 0,
    errors: [],
  };

  const messages = await readSyncMessages(sql, config.batchSize, config.visibilityTimeoutSec);

  // #292: Batch lookup shop currencies for INR-only filtering
  const shopDomains = messages.map((m) => m.message.shop);
  const shopCurrencies = await loadShopCurrencies(sql, shopDomains);
  const skippedNonInrCounts = new Map<string, number>();

  for (const msg of messages) {
    // Check time budget
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.timeBudgetMs) {
      result.timedOut = true;
      break;
    }

    // #292: Skip non-INR shops (but let terminal topics through for existing rows)
    // Shop not in map → let handler fail with shop_not_found → sanitized DLQ path
    // Shop in map with unsupported currency (NULL/""/XXX/non-INR) → skip non-terminal, pass terminal
    const shopCurrency = shopCurrencies.get(msg.message.shop);
    const shopFound = shopCurrencies.has(msg.message.shop);
    // Fail closed: NULL/"" or unsupported currency treated as non-INR
    const isNonInr = shopFound && !isShopCurrencySupported(shopCurrency ?? "");

    // #239: Shop row missing (redacted or never existed) → re-check and delete message.
    // Uninstalled-but-present shops keep today's behaviour (handler returns shop_not_found).
    if (!shopFound) {
      try {
        const [shopRow] = await sql<[{ id: string }?]>`
          SELECT id FROM "Shop" WHERE domain = ${msg.message.shop}
        `;
        if (!shopRow) {
          await sql`SELECT pgmq.delete(${S6_QUEUES.SYNC}, ${msg.msg_id}::bigint)`;
          safeLog("info", "drain_shop_missing_deleted", {
            queue: "sync",
            topic: msg.message.topic,
            msgId: msg.msg_id,
            count: 1,
          });
          continue;
        }
      } catch (err) {
        const errorCode = toErrorCode(err);
        safeLog("error", "sync_message_exception", {
          topic: msg.message.topic,
          queue: S6_QUEUES.SYNC,
          errorCode,
          readCt: msg.read_ct,
        });
        result.failed++;
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          code: errorCode,
        });
        continue;
      }
    }

    if (isNonInr && !TERMINAL_TOPICS.has(msg.message.topic)) {
      // G8: Non-INR shop, non-terminal topic - skip (don't import new amounts)
      await archiveMessage(sql, S6_QUEUES.SYNC, msg.msg_id);
      result.skipped++;
      skippedNonInrCounts.set(
        msg.message.shop,
        (skippedNonInrCounts.get(msg.message.shop) ?? 0) + 1
      );
      continue;
    }
    // G8: Terminal topics (PAID, CANCELLED, DRAFT_DELETE) pass through to handlers
    // which will update existing rows without importing new amounts
    // Shop not found → handler returns shop_not_found → moveToDeadLetter with sanitization

    // Skip already-sanitized messages (re-enqueued by hand)
    if ((msg.message as Record<string, unknown>).sanitized === true) {
      safeLog("warn", "drain_skip_sanitized_message", {
        queue: S6_QUEUES.SYNC,
        originalMsgId: msg.msg_id,
        topic: msg.message.topic,
      });
      await archiveMessage(sql, S6_QUEUES.SYNC, msg.msg_id);
      result.skipped++;
      continue;
    }

    const handler = getSyncHandler(msg.message.topic);

    if (!handler) {
      if (msg.read_ct >= config.noHandlerMaxReads) {
        const dlqd = await moveToDeadLetter(
          sql,
          S6_QUEUES.SYNC,
          msg.msg_id,
          msg.message,
          `permanent:no_handler`,
          msg.read_ct
        );
        if (dlqd) {
          result.deadLettered++;
        } else {
          result.deadLetterAlreadyGoneCount++;
        }
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
        const errorCode = syncResult.errorCode ?? toErrorCode(syncResult.error);

        // S25: Log failed sync messages with safe fields
        const hash = await shopHash(msg.message.shop);
        safeLog("warn", "sync_message_failed", {
          topic: msg.message.topic,
          queue: S6_QUEUES.SYNC,
          errorCode,
          shopHash: hash,
          readCt: msg.read_ct,
        });

        if (shouldDlq) {
          const dlqReason = syncResult.retryable === false
            ? `non_retryable:${errorCode}`
            : errorCode;

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
                errorCode
              );
            }
          }

          const dlqd = await moveToDeadLetter(
            sql,
            S6_QUEUES.SYNC,
            msg.msg_id,
            msg.message,
            dlqReason,
            msg.read_ct
          );
          if (dlqd) {
            result.deadLettered++;
          } else {
            result.deadLetterAlreadyGoneCount++;
          }
        } else {
          // Leave for retry (visibility timeout will make it available again)
          result.failed++;
        }
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          code: syncResult.errorCode ?? toErrorCode(syncResult.error),
        });
      }
    } catch (err) {
      // Uncaught exceptions are treated as retryable (transient failures)
      // Only DLQ after max retries to avoid losing messages on transient issues
      const errorCode = toErrorCode(err);

      // S25: Log uncaught exceptions with safe fields
      const hash = await shopHash(msg.message.shop);
      safeLog("error", "sync_message_exception", {
        topic: msg.message.topic,
        queue: S6_QUEUES.SYNC,
        errorCode,
        shopHash: hash,
        readCt: msg.read_ct,
      });

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
              errorCode
            );
          }
        }

        const dlqd = await moveToDeadLetter(sql, S6_QUEUES.SYNC, msg.msg_id, msg.message, errorCode, msg.read_ct);
        if (dlqd) {
          result.deadLettered++;
        } else {
          result.deadLetterAlreadyGoneCount++;
        }
      } else {
        result.failed++;
      }
      result.errors.push({
        msgId: msg.msg_id,
        topic: msg.message.topic,
        code: errorCode,
      });
    }
  }

  // #292: Log aggregated non-INR skip counts
  for (const [domain, count] of skippedNonInrCounts) {
    safeLog("info", "drain_skip_non_inr_shop", {
      queue: S6_QUEUES.SYNC,
      shopHash: await shopHash(domain),
      count,
    });
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

  // #292: Batch lookup shop currencies for INR-only filtering
  const shopDomains = messages.map((m) => m.message.shop);
  const shopCurrencies = await loadShopCurrencies(sql, shopDomains);
  const skippedNonInrCounts = new Map<string, number>();

  for (const msg of messages) {
    // Check time budget
    const currentElapsed = Date.now() - startTime;
    if (currentElapsed >= config.timeBudgetMs) {
      result.timedOut = true;
      break;
    }

    // #292: Skip non-INR shops
    // Shop not in map → let handler fail with shop_not_found → sanitized DLQ path
    // Shop in map with unsupported currency → skip (bulk queue has no terminal topics)
    const shopCurrency = shopCurrencies.get(msg.message.shop);
    const shopFound = shopCurrencies.has(msg.message.shop);
    // Fail closed: NULL/"" or unsupported currency treated as non-INR
    const isNonInr = shopFound && !isShopCurrencySupported(shopCurrency ?? "");
    
    // #239: Shop row missing (redacted or never existed) → re-check and delete message.
    // Uninstalled-but-present shops keep today's behaviour (handler returns shop_not_found).
    if (!shopFound) {
      try {
        const [shopRow] = await sql<[{ id: string }?]>`
          SELECT id FROM "Shop" WHERE domain = ${msg.message.shop}
        `;
        if (!shopRow) {
          await sql`SELECT pgmq.delete(${S6_QUEUES.BULK}, ${msg.msg_id}::bigint)`;
          safeLog("info", "drain_shop_missing_deleted", {
            queue: "bulk",
            topic: msg.message.topic,
            msgId: msg.msg_id,
            count: 1,
          });
          continue;
        }
      } catch (err) {
        const errorCode = toErrorCode(err);
        safeLog("error", "bulk_message_exception", {
          topic: msg.message.topic,
          queue: S6_QUEUES.BULK,
          errorCode,
          readCt: msg.read_ct,
        });
        result.failed++;
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          code: errorCode,
        });
        continue;
      }
    }

    if (isNonInr) {
      // G8: Bulk queue has no terminal topics - all non-INR are skipped
      await archiveMessage(sql, S6_QUEUES.BULK, msg.msg_id);
      result.skipped++;
      skippedNonInrCounts.set(
        msg.message.shop,
        (skippedNonInrCounts.get(msg.message.shop) ?? 0) + 1
      );
      continue;
    }

    // Skip already-sanitized messages (re-enqueued by hand)
    if ((msg.message as Record<string, unknown>).sanitized === true) {
      safeLog("warn", "drain_skip_sanitized_message", {
        queue: S6_QUEUES.BULK,
        originalMsgId: msg.msg_id,
        topic: msg.message.topic,
      });
      await archiveMessage(sql, S6_QUEUES.BULK, msg.msg_id);
      result.skipped++;
      continue;
    }

    const handler = getBulkHandler(msg.message.topic);

    if (!handler) {
      if (msg.read_ct >= config.noHandlerMaxReads) {
        const dlqd = await moveToDeadLetter(
          sql,
          S6_QUEUES.BULK,
          msg.msg_id,
          msg.message,
          `permanent:no_handler`,
          msg.read_ct
        );
        if (dlqd) {
          result.deadLettered++;
        } else {
          result.deadLetterAlreadyGoneCount++;
        }
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
          // Guard: only send continuation if Shop still exists and is not uninstalled (#239).
          // FOR SHARE serializes with deleteShop's leading FOR UPDATE on the Shop row.
          await sql.begin(async (tx) => {
            const [shopRow] = await tx<[{ id: string }?]>`
              SELECT id FROM "Shop"
              WHERE domain = ${msg.message.shop}
                AND "uninstalledAt" IS NULL
              FOR SHARE
            `;
            if (shopRow) {
              await tx`SELECT pgmq.send(${S6_QUEUES.BULK}, ${tx.json(msg.message)})`;
            }
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
        const errorCode = bulkResult.errorCode ?? toErrorCode(bulkResult.error);

        // S25: Log failed message with safe fields
        const hash = await shopHash(msg.message.shop);
        safeLog("warn", "bulk_message_failed", {
          topic: msg.message.topic,
          queue: S6_QUEUES.BULK,
          errorCode,
          readCt: msg.read_ct,
          retryable: errorType === "retryable",
          shopHash: hash,
        });

        if (errorType === "permanent") {
          // Permanent error (4xx, bad data, exhausted retries) - go to DLQ
          const dlqd = await moveToDeadLetter(
            sql,
            S6_QUEUES.BULK,
            msg.msg_id,
            msg.message,
            `permanent:${errorCode}`,
            msg.read_ct
          );
          if (dlqd) {
            result.deadLettered++;
          } else {
            result.deadLetterAlreadyGoneCount++;
          }
        } else if (errorType === "retryable") {
          // S25: Cap lease contention retries at maxRetries - send to DLQ
          if (errorCode === "bulk_lease_contention" && msg.read_ct >= config.maxRetries) {
            const dlqd = await moveToDeadLetter(
              sql,
              S6_QUEUES.BULK,
              msg.msg_id,
              msg.message,
              errorCode,
              msg.read_ct
            );
            if (dlqd) {
              result.deadLettered++;
            } else {
              result.deadLetterAlreadyGoneCount++;
            }
          } else {
            // Retryable error - leave message in queue for retry via read_ct
            // The failure_count was already incremented by processBulkOperation
            // Message will be retried on next read (visibility timeout reset)
            result.failed++;
          }
        } else {
          // Unknown error type or legacy path - use read_ct for DLQ
          if (msg.read_ct >= config.maxRetries) {
            const dlqd = await moveToDeadLetter(
              sql,
              S6_QUEUES.BULK,
              msg.msg_id,
              msg.message,
              errorCode,
              msg.read_ct
            );
            if (dlqd) {
              result.deadLettered++;
            } else {
              result.deadLetterAlreadyGoneCount++;
            }
          } else {
            result.failed++;
          }
        }
        result.errors.push({
          msgId: msg.msg_id,
          topic: msg.message.topic,
          code: errorCode,
        });
      }
    } catch (err) {
      const errorCode = toErrorCode(err);

      // S25: Log uncaught exceptions with safe fields
      const hash = await shopHash(msg.message.shop);
      safeLog("error", "bulk_message_exception", {
        topic: msg.message.topic,
        queue: S6_QUEUES.BULK,
        errorCode,
        shopHash: hash,
        readCt: msg.read_ct,
      });

      if (msg.read_ct >= config.maxRetries) {
        const dlqd = await moveToDeadLetter(sql, S6_QUEUES.BULK, msg.msg_id, msg.message, errorCode, msg.read_ct);
        if (dlqd) {
          result.deadLettered++;
        } else {
          result.deadLetterAlreadyGoneCount++;
        }
      } else {
        result.failed++;
      }
      result.errors.push({
        msgId: msg.msg_id,
        topic: msg.message.topic,
        code: errorCode,
      });
    }
  }

  // #292: Log aggregated non-INR skip counts
  for (const [domain, count] of skippedNonInrCounts) {
    safeLog("info", "drain_skip_non_inr_shop", {
      queue: S6_QUEUES.BULK,
      shopHash: await shopHash(domain),
      count,
    });
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
