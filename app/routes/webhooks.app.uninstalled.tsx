import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import { parseTriggeredAt } from "~/lib/webhook-receipts.server";
import { getOfflineAdminContext } from "~/lib/offline-admin.server";
import type { Sql } from "~/lib/db-light.server";
import {
  markShopUninstalled,
  deleteProcessedWebhooksViaReceipts,
} from "~/services/compliance";
import { evictShopFromSetupCache } from "~/lib/after-auth.server";

/**
 * Stale uninstall detection result.
 * Used by isStaleUninstall to determine if webhook should be ignored.
 */
type StaleCheckResult =
  | { status: "stale"; reason: "triggered_before_install" | "probe_ok" }
  | { status: "genuine" }
  | { status: "probe_error"; reason: string };

/**
 * Error codes from getOfflineAdminContext that indicate genuine uninstall.
 * These mean the token is invalid/revoked, so the shop actually uninstalled.
 */
const GENUINE_UNINSTALL_ERROR_CODES = new Set([
  "invalid_grant",
  "no_refresh_token",
  "no_session",
  "admin_no_session",
]);

/**
 * Check if an app/uninstalled webhook is stale (arrived after a quick reinstall).
 *
 * Cases (#261):
 * (a) Header present and older than lastInstalledAt: stale.
 * (b) Header present and newer, or lastInstalledAt NULL: genuine uninstall.
 * (c) Header missing and lastInstalledAt NULL: genuine uninstall.
 * (d) Header missing and lastInstalledAt set: probe Admin API to determine.
 *     - 200 with shop.id means stale (shop still has a valid token)
 *     - Token/auth failure (invalid_grant, no_session, 401, 403) means genuine uninstall
 *     - Any other error or unexpected response returns 5xx for Shopify retry
 *
 * Rule (d) is STRICT:
 * - Only specific auth error codes or HTTP 401/403 mean genuine uninstall
 * - A 200 without shop.id is unexpected → 5xx
 * - Any non-auth probe failure → 5xx
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param triggeredAt - Parsed X-Shopify-Triggered-At header (null if missing/invalid)
 * @returns StaleCheckResult indicating stale, genuine, or probe error
 */
async function isStaleUninstall(
  sql: Sql,
  shop: string,
  triggeredAt: Date | null
): Promise<StaleCheckResult> {
  const [shopRow] = await sql<{ lastInstalledAt: Date | null }[]>`
    SELECT "lastInstalledAt" FROM "Shop" WHERE domain = ${shop}
  `;

  const lastInstalledAt = shopRow?.lastInstalledAt ?? null;

  if (triggeredAt !== null) {
    if (lastInstalledAt !== null && triggeredAt < lastInstalledAt) {
      return { status: "stale", reason: "triggered_before_install" };
    }
    return { status: "genuine" };
  }

  if (lastInstalledAt === null) {
    return { status: "genuine" };
  }

  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    return { status: "probe_error", reason: "_env_missing" };
  }

  const adminResult = await getOfflineAdminContext(sql, shop, clientId, clientSecret);

  if (!adminResult.success) {
    if (GENUINE_UNINSTALL_ERROR_CODES.has(adminResult.errorCode ?? "")) {
      return { status: "genuine" };
    }
    return { status: "probe_error", reason: adminResult.errorCode ?? "unknown" };
  }

  try {
    const response = await adminResult.admin!.graphql(`{ shop { id } }`);
    const data = (await response.json()) as {
      data?: { shop?: { id?: string } };
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    };

    if (data.data?.shop?.id) {
      return { status: "stale", reason: "probe_ok" };
    }

    if (data.errors && data.errors.length > 0) {
      const hasAuthError = data.errors.some((e) =>
        e.extensions?.code === "ACCESS_DENIED" ||
        e.message.toLowerCase().includes("access denied")
      );
      if (hasAuthError) {
        return { status: "genuine" };
      }
      return { status: "probe_error", reason: "graphql_error" };
    }

    return { status: "probe_error", reason: "unexpected_response" };
  } catch (error) {
    const err = error as { response?: { status?: number }; code?: string; name?: string };

    if (err.response?.status === 401 || err.response?.status === 403) {
      return { status: "genuine" };
    }

    const errMsg = error instanceof Error ? error.message : "";
    if (
      errMsg.includes("401") ||
      errMsg.includes("403") ||
      errMsg.toLowerCase().includes("unauthorized") ||
      errMsg.toLowerCase().includes("forbidden")
    ) {
      return { status: "genuine" };
    }

    return { status: "probe_error", reason: "graphql_error" };
  }
}

/**
 * App uninstalled webhook handler.
 *
 * When a merchant uninstalls the app:
 * 0. Check if webhook is stale (arrived after a quick reinstall) - ignore if so (#261)
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
 * #261: Stale uninstall detection. If the shop uninstalled and quickly reinstalled,
 * the original uninstall webhook (or a retry) may arrive AFTER the reinstall
 * completed. We detect this by comparing X-Shopify-Triggered-At to Shop.lastInstalledAt.
 * Stale webhooks are acknowledged with 200 but do NOT delete sessions or mark uninstalled.
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
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiSecret || !apiKey) {
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

  const triggeredAt = parseTriggeredAt(request);
  const staleResult = await isStaleUninstall(sql, shop, triggeredAt);

  if (staleResult.status === "stale") {
    console.log(`[uninstalled] stale_ignored reason=${staleResult.reason}`);
    return new Response();
  }

  if (staleResult.status === "probe_error") {
    if (staleResult.reason !== "_env_missing") {
      console.error(`[uninstalled] stale_probe_failed reason=${staleResult.reason}`);
    }
    return new Response(null, { status: 500 });
  }

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
    console.log(
      `[uninstalled] processed_webhooks_deleted count=${processedWebhooksDeleted}`
    );
    console.log(`[uninstalled] receipts_deleted count=${receiptsDeleted}`);
  } catch (error) {
    const errInfo =
      (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(
      `[uninstalled] receipts_purge_failed reason=db_error err=${errInfo}`
    );
  }

  return new Response();
};
