import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import { markShopUninstalled } from "~/services/compliance";
import { deleteWebhookReceiptsForShop } from "~/lib/webhook-receipts.server";

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
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[uninstalled] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic } = await verifyWebhook(request, apiSecret);
  const normalizedTopic = normalizeWebhookTopic(topic);

  console.log(`Received ${normalizedTopic} webhook for ${shop}`);

  if (normalizedTopic !== "APP_UNINSTALLED") {
    console.log(
      `[uninstalled] Ignoring unexpected topic ${normalizedTopic} for ${shop}`
    );
    return new Response();
  }

  const sql = getRequestSql();

  try {
    const { sessionStorage } = context;
    const count = await sessionStorage.deleteAllForShop(shop);
    console.log(`Deleted ${count} session(s) for ${shop}`);
  } catch (error) {
    console.error(`Error deleting sessions for ${shop}:`, error);
  }

  try {
    const marked = await markShopUninstalled(sql, shop);
    if (marked) {
      console.log(`[uninstalled] Marked shop ${shop} as uninstalled`);
    } else {
      console.log(
        `[uninstalled] Shop ${shop} not found in database (may not have completed install)`
      );
    }
  } catch (error) {
    console.error(`Error marking shop ${shop} as uninstalled:`, error);
  }

  // Purge webhook receipts for the shop (S20 compliance)
  try {
    const receiptsDeleted = await deleteWebhookReceiptsForShop(sql, shop);
    console.log(`[uninstalled] Deleted ${receiptsDeleted} webhook receipts for ${shop}`);
  } catch (error) {
    console.error(`Error deleting webhook receipts for ${shop}:`, error);
  }

  return new Response();
};
