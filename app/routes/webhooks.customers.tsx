import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";

/**
 * Webhook handler for customer lifecycle events (S8).
 *
 * Topics handled:
 * - customers/create: New customer created
 * - customers/update: Customer details changed (including tags)
 * - customers/delete: Customer removed
 *
 * Processing:
 * 1. HMAC verification via verifyWebhook (returns 401 on failure)
 * 2. Topic guard: only process expected topics
 * 3. Extract minimal payload (customer GID only - DPDP compliant)
 * 4. Enqueue to s6_sync for async processing
 * 5. Return 200 immediately (within 10ms CPU budget)
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Saves ~5-10ms DB round-trip per webhook.
 *
 * DPDP compliance:
 * - Webhook payloads contain PII, but we only extract the GID here
 * - The sync processor fetches only id and tags via GraphQL
 * - No names, emails, phones, or addresses are stored
 *
 * The actual customer->BuyerAccount mapping happens in the drain (S10).
 * Tag rules are checked against AccountSource to determine if a customer
 * should have a BuyerAccount (kind=TAGGED_CUSTOMER).
 */

const ALLOWED_TOPICS = new Set([
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "CUSTOMERS_DELETE",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[webhooks.customers] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.customers] Unexpected topic ${normalizedTopic} for ${shop}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.customers] Missing admin_graphql_api_id in ${normalizedTopic} for ${shop}`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  await sendSyncMessage(sql, {
    topic: normalizedTopic,
    shop,
    webhookId,
    resourceGid,
    enqueuedAt: new Date().toISOString(),
  });

  console.log(
    `[webhooks.customers] Enqueued ${normalizedTopic} for ${shop}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
