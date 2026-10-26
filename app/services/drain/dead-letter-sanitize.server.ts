/**
 * Dead letter message sanitization for shop_not_found and shop_gone scenarios (#239, #262).
 *
 * Sanitization occurs when:
 * - shop_not_found: The handler returned shop_not_found error (shop already gone)
 * - shop_gone: The Shop row is missing or uninstalledAt is set (48h pre-redact window)
 *
 * For topics that are re-fetched after reinstall (companies, company locations, orders),
 * we sanitize the DLQ row to an allowlisted object containing only:
 * - topic, errorCode (from s6_dead_letter.error column), attemptCount, timestamps
 * - shopId (internal UUID, never the domain) when available
 * - resourceGid, webhookId, bulkOperationId, bulkType for debugging
 *
 * The shop domain (PII) is dropped. Payload is not stored.
 *
 * Topics WITHOUT reconcile coverage (customers, draft_orders) keep their full
 * message because nothing would re-fetch that data after reinstall. A follow-up
 * (S8 customers/draft-orders reconcile) will enable sanitization for those.
 *
 * Recovery path: After reinstall, the nightly reconcile (reconcile-handlers.server.ts:61)
 * re-fetches all companies/orders via RECONCILE_COMPANIES and RECONCILE_ORDERS bulk ops.
 *
 * NO shopHash: The shopHash function (log.server.ts:426-432) uses unkeyed
 * SHA-256, not HMAC, so including it would allow rainbow-table reversal.
 *
 * @module
 */

import type { SyncMessage, BulkMessage } from "~/lib/pgmq.server";

/**
 * Topics that have reconcile coverage and can be safely sanitized.
 * Companies and company locations are re-fetched via RECONCILE_COMPANIES.
 * Orders are re-fetched via RECONCILE_ORDERS.
 */
const COVERED_SYNC_TOPICS = new Set([
  "COMPANIES_CREATE",
  "COMPANIES_UPDATE",
  "COMPANIES_DELETE",
  "COMPANY_LOCATIONS_CREATE",
  "COMPANY_LOCATIONS_UPDATE",
  "COMPANY_LOCATIONS_DELETE",
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_PAID",
]);

/**
 * Bulk types that have reconcile coverage and can be safely sanitized.
 */
const COVERED_BULK_TYPES = new Set(["companies", "orders"]);

/**
 * Reason for DLQ sanitization (closed enum).
 * - shop_not_found: Handler returned shop_not_found error (shop already gone)
 * - shop_row_missing: No Shop row exists in the database
 * - shop_uninstalled: Shop row exists but uninstalledAt is set (48h pre-redact window)
 */
export type SanitizationReason = "shop_not_found" | "shop_row_missing" | "shop_uninstalled";

/**
 * Sanitized dead letter message structure.
 * Contains only allowlisted fields for audit/debugging without PII.
 *
 * Kept fields:
 * - topic, reason, attemptCount, timestamps (enqueuedAt, failedAt)
 * - shopId (internal UUID, never the domain) when available
 * - webhookId, resourceGid, bulkOperationId, bulkType for debugging
 *
 * Dropped fields:
 * - shop (domain - PII), payload, and any other message content
 *
 * Index signature allows JSON serialization without type errors.
 */
export interface SanitizedDeadLetterMessage {
  sanitized: true;
  reason: SanitizationReason;
  topic: string;
  originalMsgId: string;
  shopId?: string;
  webhookId?: string;
  resourceGid?: string;
  bulkOperationId?: string;
  bulkType?: string;
  attemptCount: number;
  enqueuedAt?: string;
  failedAt: string;
  [key: string]: string | number | boolean | undefined;
}

/**
 * Check if a topic is covered by reconcile and can be sanitized.
 */
export function isCoveredSyncTopic(topic: string): boolean {
  return COVERED_SYNC_TOPICS.has(topic);
}

/**
 * Check if a bulk type is covered by reconcile and can be sanitized.
 */
export function isCoveredBulkType(bulkType: string): boolean {
  return COVERED_BULK_TYPES.has(bulkType);
}

/**
 * Check if an error reason indicates shop_not_found.
 * Matches both 'shop_not_found' and 'permanent:shop_not_found'.
 */
export function isShopNotFoundReason(reason: string): boolean {
  return reason === "shop_not_found" || reason === "permanent:shop_not_found";
}

/**
 * Sanitize a sync message for dead-lettering.
 *
 * Returns a sanitized object with only allowlisted fields, or null if the
 * topic is not covered by reconcile (customers, draft_orders).
 *
 * @param message - Original sync message
 * @param msgId - Original message ID from the queue
 * @param readCt - Read count (attempt count)
 * @param reason - Why the message was sanitized (shop_not_found or shop_gone)
 * @param shopId - Internal Shop UUID (never the domain), if available
 * @returns Sanitized message or null if topic is not covered
 */
export function sanitizeSyncMessage(
  message: SyncMessage,
  msgId: string,
  readCt: number,
  reason: SanitizationReason = "shop_not_found",
  shopId?: string
): SanitizedDeadLetterMessage | null {
  if (!isCoveredSyncTopic(message.topic)) {
    return null;
  }

  return {
    sanitized: true,
    reason,
    topic: message.topic,
    originalMsgId: msgId,
    ...(shopId !== undefined && { shopId }),
    webhookId: message.webhookId,
    resourceGid: message.resourceGid,
    attemptCount: readCt,
    enqueuedAt: message.enqueuedAt,
    failedAt: new Date().toISOString(),
  };
}

/**
 * Sanitize a bulk message for dead-lettering.
 *
 * Returns a sanitized object with only allowlisted fields, or null if the
 * bulk type is not covered by reconcile (customers).
 *
 * @param message - Original bulk message
 * @param msgId - Original message ID from the queue
 * @param readCt - Read count (attempt count)
 * @param reason - Why the message was sanitized (shop_not_found or shop_gone)
 * @param shopId - Internal Shop UUID (never the domain), if available
 * @returns Sanitized message or null if bulk type is not covered
 */
export function sanitizeBulkMessage(
  message: BulkMessage,
  msgId: string,
  readCt: number,
  reason: SanitizationReason = "shop_not_found",
  shopId?: string
): SanitizedDeadLetterMessage | null {
  if (!isCoveredBulkType(message.bulkType)) {
    return null;
  }

  return {
    sanitized: true,
    reason,
    topic: message.topic,
    originalMsgId: msgId,
    ...(shopId !== undefined && { shopId }),
    webhookId: message.webhookId,
    bulkOperationId: message.bulkOperationId,
    bulkType: message.bulkType,
    attemptCount: readCt,
    enqueuedAt: message.enqueuedAt,
    failedAt: new Date().toISOString(),
  };
}
