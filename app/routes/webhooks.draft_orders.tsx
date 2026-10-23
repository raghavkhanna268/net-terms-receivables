import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";

/**
 * Webhook handler for draft order lifecycle events (S8).
 *
 * Topics handled:
 * - draft_orders/create: New draft order created
 * - draft_orders/update: Draft order modified (payment terms, amounts, etc.)
 * - draft_orders/delete: Draft order removed
 *
 * Processing:
 * 1. HMAC verification via authenticate.webhook (returns 401 on failure)
 * 2. Extract minimal payload (draft order GID only)
 * 3. Enqueue to s6_sync for async processing
 * 4. Return 200 immediately (within 10ms CPU budget)
 *
 * DPDP compliance:
 * - Only the draft order GID is extracted from the webhook payload
 * - The sync processor fetches only id, name, total, paymentTerms, purchasingEntity
 * - No customer PII is stored
 *
 * Draft orders are tracked when they have payment terms assigned to a buyer
 * account. This enables pending credit exposure calculation before the draft
 * order is completed.
 *
 * Note: When a draft order is completed (becomes an Order), Shopify sends
 * an orders/create webhook. The order sync processor creates the Invoice,
 * and the draft order record is removed (or marked completed).
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  const { shop, topic, payload, webhookId } =
    await shopify.authenticate.webhook(request);

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.draft_orders] Missing admin_graphql_api_id in ${topic} for ${shop}`
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

  console.log(
    `[webhooks.draft_orders] Enqueued ${topic} for ${shop}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
