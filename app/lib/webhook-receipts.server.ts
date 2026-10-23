/**
 * Webhook receipts for S20 edge-level idempotency.
 *
 * EDGE-level deduplication ONLY:
 * - recordWebhookReceipt(): Called in transactional block with enqueue
 * - Returns false if duplicate (skip processing)
 * - If enqueue fails, transaction rolls back (no orphan receipts)
 *
 * This is separate from DRAIN-level idempotency (s6_processed_webhooks).
 * - Edge (webhook_receipts): Prevents duplicate enqueues from Shopify retries
 * - Drain (s6_processed_webhooks): Prevents duplicate processing in queue
 *
 * Retention:
 * - 30-day purge via pg_cron
 * - Immediate purge on app/uninstalled and shop/redact
 */

import type { Sql } from "./db-light.server";

/**
 * Record a webhook receipt at the edge (INSIDE a transaction).
 *
 * IMPORTANT: Must be called within sql.begin() along with the enqueue.
 * This ensures if enqueue fails, the receipt is rolled back and
 * Shopify's retry will succeed.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING to atomically dedupe.
 * Returns true if this is a new webhook (should be processed).
 * Returns false if this is a duplicate (should be skipped).
 *
 * @param sql - postgres.js SQL client (use transaction sql from sql.begin)
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
