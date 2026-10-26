import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  markShopUninstalled,
  deleteProcessedWebhooksViaReceipts,
} from "~/services/compliance";
import { evictShopFromSetupCache } from "~/lib/after-auth.server";
import { safeLog, toErrorCode } from "~/lib/log.server";

/**
 * App uninstalled webhook handler.
 *
 * When a merchant uninstalls the app:
 * 1. Delete all sessions immediately (required for logout)
 * 2. Mark the shop as uninstalled (sets uninstalledAt timestamp)
 * 3. Purge receipt-linked processed webhooks and webhook receipts (S20/S22 compliance)
 *
 * Full data deletion happens later on shop/redact webhook.
 * Per Shopify docs, shop/redact is sent 48 hours after uninstall:
 * https://shopify.dev/docs/apps/build/privacy-law-compliance
 *
 * This gives merchants a grace period if they reinstall, and ensures
 * we meet GDPR/CCPA requirements for data deletion timing.
 *
 * Note: Reconcile-prefix processed webhooks are NOT deleted on uninstall
 * (only on shop/redact) in case the shop reinstalls within the 48h window.
 *
 * Idempotency: No edge deduplication - handlers are fully idempotent:
 * - deleteAllForShop: deleting 0 sessions is safe
 * - markShopUninstalled: re-marking is safe (timestamp already set)
 * - deleteProcessedWebhooksViaReceipts + receipts delete: deleting 0 rows is safe
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session loading. This webhook only needs to DELETE sessions,
 * not read them - deleteAllForShop runs a single DELETE query.
 *
 * CPU savings: ~5-10ms by avoiding session DB round-trip.
 *
 * Error handling: Returns 500 on session delete or uninstalledAt write failure
 * so Shopify retries. Processed webhooks and receipt purge failure is non-fatal.
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
    safeLog("info", "uninstalled_sessions_deleted", { count });
  } catch (error) {
    safeLog("error", "uninstalled_sessions_delete_failed", {
      reason: "db_error",
      err: toErrorCode(error),
    });
    return new Response(null, { status: 500 });
  }

  try {
    const marked = await markShopUninstalled(sql, shop);
    safeLog("info", "uninstalled_shop_marked", {
      status: marked ? "updated" : "not_found",
    });
    evictShopFromSetupCache(shop);
  } catch (error) {
    safeLog("error", "uninstalled_mark_failed", {
      reason: "db_error",
      err: toErrorCode(error),
    });
    return new Response(null, { status: 500 });
  }

  // Purge receipt-linked processed webhooks and webhook receipts together (S20/S22 compliance).
  // Must be in ONE transaction: helper deletes processed webhooks via receipts join,
  // then receipts are deleted. Non-fatal on failure.
  try {
    const { processedWebhooksDeleted, receiptsDeleted } = await sql.begin(
      async (tx) => {
        const pwCount = await deleteProcessedWebhooksViaReceipts(tx, shop);
        const rcptResult = await tx`
          DELETE FROM webhook_receipts WHERE shop = ${shop}
        `;
        return {
          processedWebhooksDeleted: pwCount,
          receiptsDeleted: rcptResult.count,
        };
      }
    );
    safeLog("info", "uninstalled_webhooks_purged", {
      processedWebhooksDeletedCount: processedWebhooksDeleted,
      receiptsDeletedCount: receiptsDeleted,
    });
  } catch (error) {
    safeLog("error", "uninstalled_receipts_purge_failed", {
      reason: "db_error",
      err: toErrorCode(error),
    });
  }

  return new Response();
};
