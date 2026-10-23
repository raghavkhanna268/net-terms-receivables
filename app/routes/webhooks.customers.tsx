import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";

/**
 * Webhook handler for customer lifecycle events (S8).
 *
 * Topics handled:
 * - customers/create: New customer created
 * - customers/update: Customer details changed (including tags)
 * - customers/delete: Customer removed
 *
 * Processing:
 * 1. HMAC verification via authenticate.webhook (returns 401 on failure)
 * 2. Extract minimal payload (customer GID only - DPDP compliant)
 * 3. Enqueue to s6_sync for async processing
 * 4. Return 200 immediately (within 10ms CPU budget)
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
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  const { shop, topic, payload, webhookId } =
    await shopify.authenticate.webhook(request);

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.customers] Missing admin_graphql_api_id in ${topic} for ${shop}`
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
    `[webhooks.customers] Enqueued ${topic} for ${shop}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
