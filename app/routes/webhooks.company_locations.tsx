import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";

/**
 * Webhook handler for company location lifecycle events.
 *
 * Topics handled:
 * - company_locations/create: New location added to a company
 * - company_locations/update: Location details changed
 * - company_locations/delete: Location removed
 *
 * CompanyLocation is the primary entity for BuyerAccount (kind=COMPANY).
 * Each CompanyLocation maps to one BuyerAccount in our system.
 *
 * Processing:
 * 1. HMAC verification via verifyWebhook (returns 401 on failure)
 * 2. Topic guard: only process expected topics
 * 3. Extract minimal payload (just the location GID)
 * 4. Enqueue to s6_sync for async processing
 * 5. Return 200 immediately (within 10ms CPU budget)
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Saves ~5-10ms DB round-trip per webhook.
 *
 * The actual mapping happens in the drain (S10).
 */

const ALLOWED_TOPICS = new Set([
  "COMPANY_LOCATIONS_CREATE",
  "COMPANY_LOCATIONS_UPDATE",
  "COMPANY_LOCATIONS_DELETE",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[webhooks.company_locations] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.company_locations] Unexpected topic ${normalizedTopic} for ${shop}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.company_locations] Missing admin_graphql_api_id in ${normalizedTopic} for ${shop}`
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
    `[webhooks.company_locations] Enqueued ${normalizedTopic} for ${shop}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
