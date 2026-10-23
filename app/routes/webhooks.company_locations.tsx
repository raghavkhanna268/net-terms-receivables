import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { recordWebhookReceipt, parseTriggeredAt } from "~/lib/webhook-receipts.server";

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
 * 2. Edge idempotency: record receipt, skip if duplicate (S20)
 * 3. Topic guard: only process expected topics
 * 4. Extract minimal payload (just the location GID)
 * 5. Enqueue to s6_sync for async processing
 * 6. Return 200 immediately (within 10ms CPU budget)
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

  const triggeredAt = parseTriggeredAt(request);
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

  // S20: Edge idempotency + enqueue in ONE transaction
  const result = await sql.begin(async (tx) => {
    const isNew = await recordWebhookReceipt(tx, shop, webhookId, normalizedTopic, triggeredAt);
    if (!isNew) {
      return { duplicate: true };
    }

    await sendSyncMessage(tx, {
      topic: normalizedTopic,
      shop,
      webhookId,
      resourceGid,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: triggeredAt?.toISOString(),
    });

    return { duplicate: false };
  });

  if (result.duplicate) {
    console.log(`[webhooks.company_locations] Duplicate ${normalizedTopic} for ${shop}, skipping`);
    return new Response(null, { status: 200 });
  }

  console.log(
    `[webhooks.company_locations] Enqueued ${normalizedTopic} for ${shop}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
