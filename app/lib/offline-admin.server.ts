/**
 * Offline Admin Context helper for webhook, queue, and cron paths.
 *
 * This module provides a wrapper around `unauthenticated.admin` that ensures:
 * 1. Token refresh happens under the per-shop advisory lock (via refreshOfflineTokenIfNeeded)
 * 2. The admin client is only returned after the token is confirmed fresh
 * 3. Non-retryable failures (invalid_grant, no_refresh_token, no_session) are typed
 *
 * Without this wrapper, concurrent calls to `unauthenticated.admin` for a shop
 * with an expiring token could race to refresh, potentially using stale tokens
 * or refreshing twice.
 *
 * Usage:
 * ```ts
 * const result = await getOfflineAdminContext(sql, shop, clientId, clientSecret);
 * if (!result.success) {
 *   // Handle typed failure (needsReauth, noSession, etc.)
 *   return;
 * }
 * const { admin } = result;
 * // Use admin for GraphQL calls
 * ```
 */

import type { Sql } from "./db-light.server";
import {
  refreshOfflineTokenIfNeeded,
  type RefreshErrorCode,
} from "./offline-token.server";
import { getShopifyApp } from "~/shopify.server";
import { InvalidSession } from "@shopify/shopify-api";
import { safeLog, shopHash } from "./log.server";

/**
 * Error codes for offline admin context failures.
 * Maps to RefreshErrorCode plus admin client errors.
 */
export type OfflineAdminErrorCode =
  | RefreshErrorCode
  | "admin_invalid_session"
  | "admin_no_session";

/**
 * Result of getting an offline admin context.
 */
export interface OfflineAdminResult {
  success: boolean;
  admin?: Awaited<
    ReturnType<ReturnType<typeof getShopifyApp>["unauthenticated"]["admin"]>
  >["admin"];
  errorCode?: OfflineAdminErrorCode;
  error?: string;
  /** Whether this is a retryable error */
  retryable: boolean;
  /** Whether the shop needs re-authentication */
  needsReauth?: boolean;
}

/**
 * Non-retryable error codes that indicate the shop needs re-authentication.
 * When these occur, the session's needsReauth flag should already be set
 * by refreshOfflineTokenIfNeeded.
 */
const NEEDS_REAUTH_CODES: Set<OfflineAdminErrorCode> = new Set([
  "invalid_grant",
  "no_refresh_token",
  "no_session",
  "admin_no_session",
]);

/**
 * Get an offline admin context for a shop with proper token refresh locking.
 *
 * This is the safe way to get an admin client for webhook, queue, and cron paths.
 * It ensures:
 * 1. Token refresh is serialized per-shop via advisory lock
 * 2. The admin client is only returned after token is confirmed fresh
 * 3. Non-retryable failures are typed for proper DLQ handling
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain (e.g., "example.myshopify.com")
 * @param clientId - Shopify app's API key (from env)
 * @param clientSecret - Shopify app's API secret (from env)
 * @returns OfflineAdminResult with admin client or typed failure
 */
export async function getOfflineAdminContext(
  sql: Sql,
  shop: string,
  clientId: string,
  clientSecret: string
): Promise<OfflineAdminResult> {
  const refreshResult = await refreshOfflineTokenIfNeeded(
    sql,
    shop,
    clientId,
    clientSecret
  );

  if (!refreshResult.success) {
    const needsReauth = NEEDS_REAUTH_CODES.has(
      refreshResult.errorCode as OfflineAdminErrorCode
    );

    if (needsReauth) {
      safeLog("error", "offline_admin_needs_reauth", {
        shopHash: await shopHash(shop),
        code: refreshResult.errorCode,
      });
    } else {
      safeLog("error", "offline_admin_refresh_failed", {
        shopHash: await shopHash(shop),
        code: refreshResult.errorCode,
      });
    }

    return {
      success: false,
      errorCode: refreshResult.errorCode,
      error: refreshResult.error,
      retryable: !needsReauth,
      needsReauth,
    };
  }

  try {
    const shopify = getShopifyApp();
    const { admin } = await shopify.unauthenticated.admin(shop);

    return {
      success: true,
      admin,
      retryable: false,
    };
  } catch (err) {
    if (err instanceof InvalidSession) {
      safeLog("error", "offline_admin_refresh_failed", {
        shopHash: await shopHash(shop),
        code: "admin_invalid_session",
      });

      return {
        success: false,
        errorCode: "admin_invalid_session",
        error: "Invalid session after token refresh",
        retryable: true,
        needsReauth: false,
      };
    }

    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("No session found") || message.includes("no session")) {
      safeLog("error", "offline_admin_needs_reauth", {
        shopHash: await shopHash(shop),
        code: "admin_no_session",
      });

      return {
        success: false,
        errorCode: "admin_no_session",
        error: "No session found",
        retryable: false,
        needsReauth: true,
      };
    }

    throw err;
  }
}
