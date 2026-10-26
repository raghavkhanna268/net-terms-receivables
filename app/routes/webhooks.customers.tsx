import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { parseTriggeredAt, recordAndEnqueueSync } from "~/lib/webhook-receipts.server";

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
 * 2. Edge idempotency: record receipt, skip if duplicate (S20)
 * 3. Topic guard: only process expected topics
 * 4. Extract minimal payload (customer GID only)
 * 5. Enqueue to s6_sync for async processing
 * 6. Return 200 immediately (within 10ms CPU budget)
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Saves ~5-10ms DB round-trip per webhook.
 *
 * Protected Customer Data (Level 2 + Name + Email, confirmed 2026-10-23):
 * - Webhook payloads contain PII, but we only extract the GID here
 * - The sync processor fetches: id, tags, email, displayName (when CUSTOMER_PII_FIELDS=1)
 * - Phone and addresses are NEVER fetched or stored
 * - PII nulling for inactive customers is tracked in #44
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
  const triggeredAt = parseTriggeredAt(request);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.customers] Unexpected topic ${normalizedTopic}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.customers] Missing admin_graphql_api_id in ${normalizedTopic}`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  // S20: Edge idempotency + enqueue in ONE transaction (via shared helper)
  const result = await recordAndEnqueueSync(sql, {
    shop,
    webhookId,
    topic: normalizedTopic,
    triggeredAt,
    resourceGid,
  });

  if (result.status === "duplicate") {
    console.log(`[webhooks.customers] Duplicate ${normalizedTopic}, skipping`);
    return new Response(null, { status: 200 });
  }

  if (result.status === "error") {
    console.error("[webhooks.customers] Enqueue failed");
    throw new Error(result.code);
  }

  console.log(
    `[webhooks.customers] Enqueued ${normalizedTopic}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
