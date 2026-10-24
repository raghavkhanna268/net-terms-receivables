import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";

/**
 * Scopes update webhook handler.
 *
 * Idempotency: No edge deduplication - handler is fully idempotent
 * (updating to the same scope value is safe).
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session loading. This webhook only needs to UPDATE scopes,
 * not read sessions - updateScopeForShop runs a single UPDATE query.
 *
 * CPU savings: ~5-10ms by avoiding session DB round-trip.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[scopes_update] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  console.log(`[scopes_update] Received ${normalizedTopic} wh=${webhookId}`);

  if (normalizedTopic !== "APP_SCOPES_UPDATE") {
    console.log(
      `[scopes_update] Ignoring unexpected topic ${normalizedTopic} wh=${webhookId}`
    );
    return new Response();
  }

  // Update session scopes when the merchant changes app permissions.
  // The payload contains the current scopes granted to the app.
  // Uses updateScopeForShop which calls updateMany in a single query.
  try {
    const currentScopes = (payload as { current?: string[] })?.current?.join(",");

    if (currentScopes) {
      const { sessionStorage } = context;
      const count = await sessionStorage.updateScopeForShop(shop, currentScopes);
      console.log(`[scopes_update] Updated scopes for ${count} session(s) to: ${currentScopes}`);
    }
  } catch {
    console.error(`[scopes_update] Error updating scopes wh=${webhookId}`);
  }

  return new Response();
};
