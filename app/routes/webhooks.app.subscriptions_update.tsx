import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { refreshPlanCache } from "~/services/plan.server";

/**
 * Webhook handler for APP_SUBSCRIPTIONS_UPDATE.
 *
 * Fired when a shop's app subscription changes (upgrade, downgrade, cancel).
 * This webhook refreshes the cached plan so changes take effect immediately.
 *
 * Idempotency: Uses HMAC verification + safe-to-replay design.
 * Refreshing the cache multiple times is safe and has no side effects.
 *
 * Background refresh: Uses cloudflare.ctx.waitUntil() to avoid blocking
 * the webhook response. Shopify expects a quick 200 response.
 *
 * NOTE: This webhook does NOT use the pgmq queue because:
 * 1. Plan refresh is fast (~1 DB write)
 * 2. It's safe to replay (idempotent)
 * 3. We want immediate cache invalidation
 */

const ALLOWED_TOPICS = new Set(["APP_SUBSCRIPTIONS_UPDATE"]);

export const loader = async (_args: LoaderFunctionArgs) => {
  return new Response(null, { status: 405, statusText: "Method Not Allowed" });
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error(
      "[webhooks.app.subscriptions_update] SHOPIFY_API_SECRET not configured"
    );
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.app.subscriptions_update] Unexpected topic ${normalizedTopic} for ${shop}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  // Use waitUntil for background refresh to avoid blocking the response.
  // This respects the Workers 10ms CPU budget by returning quickly.
  const cloudflare = context.cloudflare as {
    ctx: { waitUntil: (promise: Promise<unknown>) => void };
  };

  const refreshPromise = (async () => {
    try {
      await refreshPlanCache(sql, shop);
      console.log(
        `[webhooks.app.subscriptions_update] Refreshed plan for ${shop} (webhookId=${webhookId})`
      );
    } catch (error) {
      console.error(
        `[webhooks.app.subscriptions_update] Error refreshing plan for ${shop}:`,
        error
      );
    }
  })();

  cloudflare.ctx.waitUntil(refreshPromise);

  return new Response(null, { status: 200 });
};
