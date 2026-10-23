import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { parseTriggeredAt, recordAndEnqueueSync } from "~/lib/webhook-receipts.server";

/**
 * Webhook handler for order lifecycle events.
 *
 * Topics handled:
 * - orders/create: New order placed (may have payment terms)
 * - orders/updated: Order modified (payment terms, amounts, etc.)
 * - orders/cancelled: Order cancelled (close invoice)
 * - orders/paid: Order fully paid (mark invoice as paid)
 *
 * Only orders with payment terms are relevant for net-terms tracking.
 * The sync processor (S10 drain) will filter orders without payment terms.
 *
 * Processing:
 * 1. HMAC verification via verifyWebhook (returns 401 on failure)
 * 2. Topic guard: only process expected topics
 * 3. Extract minimal payload (just the order GID)
 * 4. Edge idempotency + enqueue in ONE transaction (S20)
 *    - If duplicate: return 200 (skip)
 *    - If enqueue fails: receipt rolls back, Shopify retry succeeds
 * 5. Return 200 immediately (within 10ms CPU budget)
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Saves ~5-10ms DB round-trip per webhook.
 *
 * Note on scopes:
 * - read_orders: Access orders from the last 60 days (default)
 * - read_all_orders: Access all historical orders (requires approval)
 *
 * With read_orders, the backfill is limited to 60 days. Once read_all_orders
 * is approved, historical orders can be backfilled via bulk operations.
 */

const ALLOWED_TOPICS = new Set([
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "ORDERS_PAID",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[webhooks.orders] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const triggeredAt = parseTriggeredAt(request);
  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.orders] Unexpected topic ${normalizedTopic} for ${shop}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.orders] Missing admin_graphql_api_id in ${normalizedTopic} for ${shop}`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  // S20: Edge idempotency + enqueue in ONE transaction (via shared helper)
  // If duplicate: return 200 (skip)
  // If enqueue fails: receipt rolls back, Shopify retry succeeds
  const result = await recordAndEnqueueSync(sql, {
    shop,
    webhookId,
    topic: normalizedTopic,
    triggeredAt,
    resourceGid,
  });

  if (result.status === "duplicate") {
    console.log(`[webhooks.orders] Duplicate ${normalizedTopic} for ${shop}, skipping`);
    return new Response(null, { status: 200 });
  }

  if (result.status === "error") {
    console.error(`[webhooks.orders] Enqueue failed for ${shop}:`, result.error);
    throw result.error;
  }

  console.log(`[webhooks.orders] Enqueued ${normalizedTopic} for ${shop}: ${resourceGid}`);

  return new Response(null, { status: 200 });
};
