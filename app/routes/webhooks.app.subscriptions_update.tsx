import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { refreshPlanCache } from "~/services/plan.server";
import { reactivateGatedAccounts } from "~/services/gating.server";

/**
 * Webhook handler for APP_SUBSCRIPTIONS_UPDATE.
 *
 * Fired when a shop's app subscription changes (upgrade, downgrade, cancel).
 * This webhook:
 * 1. Refreshes the cached plan so changes take effect immediately
 * 2. On upgrade, reactivates gated accounts up to the new limit (oldest first)
 *
 * Idempotency: HMAC verification + safe-to-replay design. No edge deduplication
 * because handlers are fully idempotent (cache refresh + account reactivation).
 * Shopify retries are safe and may even be beneficial for resilience.
 *
 * Background refresh: Uses cloudflare.ctx.waitUntil() to avoid blocking
 * the webhook response. Shopify expects a quick 200 response.
 *
 * NOTE: This webhook does NOT use the pgmq queue because:
 * 1. Plan refresh is fast (~1 DB write)
 * 2. It's safe to replay (idempotent)
 * 3. We want immediate cache invalidation and account reactivation
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
      `[webhooks.app.subscriptions_update] Unexpected topic ${normalizedTopic} wh=${webhookId}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  // Use waitUntil for background processing to avoid blocking the response.
  // This respects the Workers 10ms CPU budget by returning quickly.
  const cloudflare = context.cloudflare as {
    ctx: { waitUntil: (promise: Promise<unknown>) => void };
  };

  const processPromise = (async () => {
    try {
      // Refresh the plan cache
      await refreshPlanCache(sql, shop);
      console.log(
        `[webhooks.app.subscriptions_update] Refreshed plan wh=${webhookId}`
      );

      // Reactivate gated accounts if upgraded (reads plan from DB)
      const [shopRow] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${shop}
      `;

      if (shopRow) {
        const reactivated = await reactivateGatedAccounts(sql, shopRow.id);
        if (reactivated > 0) {
          console.log(
            `[webhooks.app.subscriptions_update] Reactivated ${reactivated} gated accounts shop_id=${shopRow.id} wh=${webhookId}`
          );
        }
      }
    } catch (error) {
      const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name ?? "unknown";
      console.error(
        `[webhooks.app.subscriptions_update] Error processing wh=${webhookId} err=${errInfo}`
      );
    }
  })();

  cloudflare.ctx.waitUntil(processPromise);

  return new Response(null, { status: 200 });
};
