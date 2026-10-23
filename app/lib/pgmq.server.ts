/**
 * pgmq queue operations for S6 webhook processing.
 *
 * Uses postgres.js to call pgmq functions directly. Messages are enqueued
 * by webhook handlers and processed by the drain (S10).
 *
 * Queue names:
 * - s6_sync: Company, CompanyLocation, Order webhook events
 * - s6_bulk: Bulk operation completion events
 *
 * Message format uses sql.json() for proper JSONB serialization.
 */

import type { Sql } from "./db-light.server";

/**
 * Queue names for S6 operations.
 */
export const S6_QUEUES = {
  SYNC: "s6_sync",
  BULK: "s6_bulk",
} as const;

/**
 * Base message payload with common fields.
 */
export interface BaseMessage {
  /** Shopify webhook topic (e.g., "COMPANIES_CREATE") */
  topic: string;
  /** Shop domain (e.g., "example.myshopify.com") */
  shop: string;
  /** Webhook ID for idempotency/dedupe */
  webhookId: string;
  /** Timestamp when the message was enqueued */
  enqueuedAt: string;
  /** Allow additional string keys for JSON serialization */
  [key: string]: string;
}

/**
 * Sync message for company/location/order webhooks.
 */
export interface SyncMessage extends BaseMessage {
  /** Shopify resource GID (e.g., "gid://shopify/Company/123") */
  resourceGid: string;
}

/**
 * Bulk operation completion message.
 */
export interface BulkMessage extends Omit<BaseMessage, keyof BaseMessage> {
  /** Shopify webhook topic */
  topic: string;
  /** Shop domain */
  shop: string;
  /** Webhook ID for idempotency/dedupe */
  webhookId: string;
  /** Timestamp when the message was enqueued */
  enqueuedAt: string;
  /** Bulk operation GID */
  bulkOperationId: string;
  /** Type of bulk operation (companies, orders, customers) */
  bulkType: "companies" | "orders" | "customers";
  /** Allow additional string keys for JSON serialization */
  [key: string]: string;
}

/**
 * Result of a pgmq.send operation.
 */
export interface SendResult {
  /** Message ID assigned by pgmq */
  msgId: string;
}

/**
 * Send a message to the s6_sync queue.
 *
 * @param sql - postgres.js SQL client (request-scoped)
 * @param message - Sync message payload
 * @returns Message ID from pgmq
 *
 * @example
 * ```ts
 * await sendSyncMessage(sql, {
 *   topic: "COMPANIES_CREATE",
 *   shop: "example.myshopify.com",
 *   webhookId: "abc123",
 *   resourceGid: "gid://shopify/Company/123",
 *   enqueuedAt: new Date().toISOString(),
 * });
 * ```
 */
export async function sendSyncMessage(
  sql: Sql,
  message: SyncMessage
): Promise<SendResult> {
  const [result] = await sql<{ send: string }[]>`
    SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json(message)}) as send
  `;
  return { msgId: result.send };
}

/**
 * Send a message to the s6_bulk queue.
 *
 * @param sql - postgres.js SQL client (request-scoped)
 * @param message - Bulk operation completion message
 * @returns Message ID from pgmq
 */
export async function sendBulkMessage(
  sql: Sql,
  message: BulkMessage
): Promise<SendResult> {
  const [result] = await sql<{ send: string }[]>`
    SELECT pgmq.send(${S6_QUEUES.BULK}, ${sql.json(message)}) as send
  `;
  return { msgId: result.send };
}

