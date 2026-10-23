import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";

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
 * 1. HMAC verification via authenticate.webhook (returns 401 on failure)
 * 2. Extract minimal payload (just the order GID)
 * 3. Enqueue to s6_sync for async processing
 * 4. Return 200 immediately (within 10ms CPU budget)
 *
 * Note on scopes:
 * - read_orders: Access orders from the last 60 days (default)
 * - read_all_orders: Access all historical orders (requires approval)
 *
 * With read_orders, the backfill is limited to 60 days. Once read_all_orders
 * is approved, historical orders can be backfilled via bulk operations.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  const { shop, topic, payload, webhookId } =
    await shopify.authenticate.webhook(request);

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.orders] Missing admin_graphql_api_id in ${topic} for ${shop}`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  await sendSyncMessage(sql, {
    topic,
    shop,
    webhookId,
    resourceGid,
    enqueuedAt: new Date().toISOString(),
  });

  console.log(`[webhooks.orders] Enqueued ${topic} for ${shop}: ${resourceGid}`);

  return new Response(null, { status: 200 });
};
