/**
 * Webhook receipts for S20 idempotency.
 *
 * Two-level deduplication:
 * 1. Edge (webhook route): recordWebhookReceipt() returns false if duplicate
 * 2. Processor (drain): isWebhookReceived() checks before processing
 *
 * Ordering guards:
 * - triggered_at from X-Shopify-Triggered-At is stored with receipts
 * - Processors compare against existing data's updated_at
 * - Older events never overwrite newer data
 *
 * Retention:
 * - 30-day purge via pg_cron
 * - Immediate purge on app/uninstalled and shop/redact
 */

import type { Sql } from "./db-light.server";

/**
 * Record a webhook receipt at the edge.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING to atomically dedupe.
 * Returns true if this is a new webhook (should be processed).
 * Returns false if this is a duplicate (should be skipped).
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param webhookId - X-Shopify-Webhook-Id header value
 * @param topic - Normalized webhook topic (e.g., "ORDERS_CREATE")
 * @param triggeredAt - X-Shopify-Triggered-At header value (optional)
 * @returns true if new webhook, false if duplicate
 */
export async function recordWebhookReceipt(
  sql: Sql,
  shop: string,
  webhookId: string,
  topic: string,
  triggeredAt?: Date | null
): Promise<boolean> {
  const result = await sql`
    INSERT INTO webhook_receipts (shop, webhook_id, topic, triggered_at, received_at)
    VALUES (${shop}, ${webhookId}, ${topic}, ${triggeredAt ?? null}, NOW())
    ON CONFLICT (shop, webhook_id) DO NOTHING
    RETURNING webhook_id
  `;

  // If RETURNING returned a row, the insert succeeded (new webhook)
  // If no rows returned, ON CONFLICT triggered (duplicate)
  return result.length > 0;
}

/**
 * Check if a webhook has been received (for processor-level idempotency).
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param webhookId - X-Shopify-Webhook-Id header value
 * @returns true if already received
 */
export async function isWebhookReceived(
  sql: Sql,
  shop: string,
  webhookId: string
): Promise<boolean> {
  const [result] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM webhook_receipts
      WHERE shop = ${shop} AND webhook_id = ${webhookId}
    ) as exists
  `;
  return result?.exists ?? false;
}

/**
 * Get the triggered_at timestamp for a webhook receipt.
 * Used by processors for ordering guard comparisons.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param webhookId - X-Shopify-Webhook-Id header value
 * @returns triggered_at timestamp or null if not found
 */
export async function getWebhookTriggeredAt(
  sql: Sql,
  shop: string,
  webhookId: string
): Promise<Date | null> {
  const [result] = await sql<{ triggered_at: Date | null }[]>`
    SELECT triggered_at FROM webhook_receipts
    WHERE shop = ${shop} AND webhook_id = ${webhookId}
  `;
  return result?.triggered_at ?? null;
}

/**
 * Delete all webhook receipts for a shop.
 * Called on app/uninstalled and shop/redact for compliance.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @returns Number of receipts deleted
 */
export async function deleteWebhookReceiptsForShop(
  sql: Sql,
  shop: string
): Promise<number> {
  const result = await sql`
    DELETE FROM webhook_receipts WHERE shop = ${shop}
  `;
  return result.count;
}

/**
 * Mark a webhook as processed (for processor-level tracking).
 * This is called after successful processing to ensure the webhook
 * is recorded even if edge recording was missed.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param webhookId - X-Shopify-Webhook-Id header value
 * @param topic - Normalized webhook topic
 * @param triggeredAt - X-Shopify-Triggered-At header value (optional)
 */
export async function markWebhookReceived(
  sql: Sql,
  shop: string,
  webhookId: string,
  topic: string,
  triggeredAt?: Date | null
): Promise<void> {
  await sql`
    INSERT INTO webhook_receipts (shop, webhook_id, topic, triggered_at, received_at)
    VALUES (${shop}, ${webhookId}, ${topic}, ${triggeredAt ?? null}, NOW())
    ON CONFLICT (shop, webhook_id) DO NOTHING
  `;
}

/**
 * Parse X-Shopify-Triggered-At header to Date.
 * Returns null if header is missing or invalid.
 *
 * @param request - The incoming request
 * @returns Parsed Date or null
 */
export function parseTriggeredAt(request: Request): Date | null {
  const header = request.headers.get("X-Shopify-Triggered-At");
  if (!header) return null;

  const parsed = new Date(header);
  if (isNaN(parsed.getTime())) return null;

  return parsed;
}
