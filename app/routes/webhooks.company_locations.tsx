import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendSyncMessage } from "~/lib/pgmq.server";

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
 * 1. HMAC verification via authenticate.webhook (returns 401 on failure)
 * 2. Extract minimal payload (just the location GID)
 * 3. Enqueue to s6_sync for async processing
 * 4. Return 200 immediately (within 10ms CPU budget)
 *
 * The actual mapping happens in the drain (S10).
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  const { shop, topic, payload, webhookId } =
    await shopify.authenticate.webhook(request);

  const typedPayload = payload as { admin_graphql_api_id?: string };
  const resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    console.warn(
      `[webhooks.company_locations] Missing admin_graphql_api_id in ${topic} for ${shop}`
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
    `[webhooks.company_locations] Enqueued ${topic} for ${shop}: ${resourceGid}`
  );

  return new Response(null, { status: 200 });
};
