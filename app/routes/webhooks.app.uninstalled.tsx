import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import { markShopUninstalled } from "~/services/compliance";
import { deleteWebhookReceiptsForShop } from "~/lib/webhook-receipts.server";
import { evictShopFromSetupCache } from "~/lib/after-auth.server";

/**
 * App uninstalled webhook handler.
 *
 * When a merchant uninstalls the app:
 * 1. Delete all sessions immediately (required for logout)
 * 2. Mark the shop as uninstalled (sets uninstalledAt timestamp)
 * 3. Purge webhook receipts for the shop (S20 compliance)
 *
 * Full data deletion happens later on shop/redact webhook.
 * Per Shopify docs, shop/redact is sent 48 hours after uninstall:
 * https://shopify.dev/docs/apps/build/privacy-law-compliance
 *
 * This gives merchants a grace period if they reinstall, and ensures
 * we meet GDPR/CCPA requirements for data deletion timing.
 *
 * Idempotency: No edge deduplication - handlers are fully idempotent:
 * - deleteAllForShop: deleting 0 sessions is safe
 * - markShopUninstalled: re-marking is safe (timestamp already set)
 * - deleteWebhookReceiptsForShop: deleting 0 receipts is safe
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session loading. This webhook only needs to DELETE sessions,
 * not read them - deleteAllForShop runs a single DELETE query.
 *
 * CPU savings: ~5-10ms by avoiding session DB round-trip.
 *
 * Error handling: Returns 500 on session delete or uninstalledAt write failure
 * so Shopify retries. Webhook receipt purge failure is non-fatal.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[uninstalled] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  console.log(`[uninstalled] webhook_received topic=${normalizedTopic}`);

  if (normalizedTopic !== "APP_UNINSTALLED") {
    console.log(`[uninstalled] topic_ignored topic=${normalizedTopic}`);
    return new Response();
  }

  const sql = getRequestSql();

  try {
    const { sessionStorage } = context;
    const count = await sessionStorage.deleteAllForShop(shop);
    console.log(`[uninstalled] sessions_deleted count=${count}`);
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[uninstalled] sessions_delete_failed reason=db_error err=${errInfo}`);
    return new Response(null, { status: 500 });
  }

  try {
    const marked = await markShopUninstalled(sql, shop);
    if (marked) {
      console.log(`[uninstalled] shop_marked_uninstalled status=updated`);
    } else {
      console.log(`[uninstalled] shop_marked_uninstalled status=not_found`);
    }
    evictShopFromSetupCache(shop);
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[uninstalled] mark_uninstalled_failed reason=db_error err=${errInfo}`);
    return new Response(null, { status: 500 });
  }

  // Purge webhook receipts for the shop (S20 compliance) - non-fatal on failure.
  try {
    const receiptsDeleted = await deleteWebhookReceiptsForShop(sql, shop);
    console.log(`[uninstalled] receipts_deleted count=${receiptsDeleted}`);
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[uninstalled] receipts_delete_failed reason=db_error err=${errInfo}`);
  }

  return new Response();
};
