/**
 * Dead letter message sanitization for shop_not_found errors (#239).
 *
 * When a webhook fails with shop_not_found, the shop no longer exists in our
 * database, so the full message (containing shop domain, payload, etc.) becomes
 * orphaned PII. For topics that are re-fetched after reinstall (companies,
 * company locations, orders), we sanitize the DLQ row to an allowlisted object.
 *
 * Topics WITHOUT reconcile coverage (customers, draft_orders) keep their full
 * message because nothing would re-fetch that data after reinstall. A follow-up
 * (S8 customers/draft-orders reconcile) will enable sanitization for those.
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
 * Sanitized dead letter message structure.
 * Contains only allowlisted fields for audit/debugging without PII.
 * Index signature allows JSON serialization without type errors.
 */
export interface SanitizedDeadLetterMessage {
  sanitized: true;
  reason: "shop_not_found";
  topic: string;
  originalMsgId: string;
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
 * Sanitize a sync message for shop_not_found dead-lettering.
 *
 * Returns a sanitized object with only allowlisted fields, or null if the
 * topic is not covered by reconcile (customers, draft_orders).
 *
 * @param message - Original sync message
 * @param msgId - Original message ID from the queue
 * @param readCt - Read count (attempt count)
 * @returns Sanitized message or null if topic is not covered
 */
export function sanitizeSyncMessage(
  message: SyncMessage,
  msgId: string,
  readCt: number
): SanitizedDeadLetterMessage | null {
  if (!isCoveredSyncTopic(message.topic)) {
    return null;
  }

  return {
    sanitized: true,
    reason: "shop_not_found",
    topic: message.topic,
    originalMsgId: msgId,
    webhookId: message.webhookId,
    resourceGid: message.resourceGid,
    attemptCount: readCt,
    enqueuedAt: message.enqueuedAt,
    failedAt: new Date().toISOString(),
  };
}

/**
 * Sanitize a bulk message for shop_not_found dead-lettering.
 *
 * Returns a sanitized object with only allowlisted fields, or null if the
 * bulk type is not covered by reconcile (customers).
 *
 * @param message - Original bulk message
 * @param msgId - Original message ID from the queue
 * @param readCt - Read count (attempt count)
 * @returns Sanitized message or null if bulk type is not covered
 */
export function sanitizeBulkMessage(
  message: BulkMessage,
  msgId: string,
  readCt: number
): SanitizedDeadLetterMessage | null {
  if (!isCoveredBulkType(message.bulkType)) {
    return null;
  }

  return {
    sanitized: true,
    reason: "shop_not_found",
    topic: message.topic,
    originalMsgId: msgId,
    webhookId: message.webhookId,
    bulkOperationId: message.bulkOperationId,
    bulkType: message.bulkType,
    attemptCount: readCt,
    enqueuedAt: message.enqueuedAt,
    failedAt: new Date().toISOString(),
  };
}
