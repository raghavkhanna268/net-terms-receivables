/**
 * #292 G1: Shared currency recovery logic for both /app and /app/onboarding.
 *
 * This module provides the checkAndRecoverCurrency function that is called on
 * every /app (Dashboard) and /app/onboarding (Setup Guide) load to catch:
 * - Shops with hardcoded 'INR' rows (from bugs or manual data fixes)
 * - Shops that switched away from INR
 * - Shops that switched to INR (recovery)
 * - Stale shop_config metafield (e.g., after-auth write failed)
 *
 * #292 Currency Flip Safety:
 * When a shop with non-INR stored currency (real code, not NULL/XXX) switches
 * to INR in Shopify, AND the shop already has financial rows (Invoice, Payment,
 * or s8_draft_orders), the flip is BLOCKED to prevent relabeling existing
 * USD-era data as rupees. The function returns flipBlocked: true in this case.
 *
 * Behavior for NULL/XXX stored currency with live INR:
 * - NULL: Treated as unknown currency, flip allowed (same as today's fresh install)
 * - XXX: Treated as failed query sentinel, flip allowed (recovery path)
 * These are considered "unknown" rather than "known non-INR", so existing rows
 * (if any) are assumed to be from INR-era or non-existent.
 */

import type { Sql } from "~/lib/db-light.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { NO_CURRENCY_SENTINEL, SUPPORTED_SHOP_CURRENCY, validateCurrencyCode } from "~/lib/shop-currency.server";
import { writeShopConfigMetafield } from "./shop-config.server";

/**
 * Admin GraphQL client interface for type safety.
 */
type AdminGraphqlClient = {
  graphql: (
    query: string,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
};

interface ShopCurrencyAndIdResponse {
  data?: {
    shop?: {
      id?: string;
      currencyCode?: string;
      metafield?: { value?: string } | null;
    };
  };
}

/**
 * Result of checkAndRecoverCurrency.
 *
 * @property currency - The effective currency after recovery (or stored currency if blocked/failed)
 * @property flipBlocked - True when a non-INR→INR flip was blocked due to existing financial rows
 */
export interface CurrencyRecoveryResult {
  currency: string;
  flipBlocked: boolean;
}

/**
 * Check if a shop has any financial rows (Invoice, Payment, or s8_draft_orders).
 * Used to determine if a currency flip should be blocked.
 *
 * Uses EXISTS queries for efficiency - stops scanning as soon as one row is found.
 * Exported for testing.
 */
export async function hasFinancialRows(sql: Sql, shopId: string): Promise<boolean> {
  const [result] = await sql<{ has_rows: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "Invoice" WHERE "shopId" = ${shopId}
      UNION ALL
      SELECT 1 FROM "Payment" WHERE "shopId" = ${shopId}
      UNION ALL
      SELECT 1 FROM s8_draft_orders WHERE shop_id = ${shopId}
    ) AS has_rows
  `;
  return result?.has_rows ?? false;
}

/**
 * Check if a stored currency is a known non-INR currency (real code, not NULL/XXX).
 * Returns true for USD, EUR, etc. Returns false for INR, XXX, null, empty string.
 * Exported for testing.
 */
export function isKnownNonInrCurrency(currency: string | null | undefined): boolean {
  if (!currency) return false;
  if (currency === NO_CURRENCY_SENTINEL) return false;
  if (currency === SUPPORTED_SHOP_CURRENCY) return false;
  return /^[A-Z]{3}$/.test(currency);
}

/**
 * #292: Re-read currency to catch shop currency changes.
 *
 * Called on every /app and /app/onboarding load to catch:
 * - Shops with hardcoded 'INR' rows (from bugs or manual data fixes)
 * - Shops that switched away from INR
 * - Shops that switched to INR (recovery)
 * - Stale shop_config metafield (e.g., after-auth write failed)
 *
 * Behavior (fail-closed throughout):
 * - Always re-read from Shopify Admin API (includes shop_config metafield)
 * - If fetched currency is XXX: return early without writing anything
 * - Re-push shop_config when:
 *   - shop_config is missing
 *   - shop_config.currencyCode differs from fetched currency (stale)
 *   - DB currency differs from fetched currency
 * - Write shop_config metafield FIRST, only save DB on success
 * - If read fails: keep current value
 *
 * #292 Currency Flip Safety:
 * When stored currency is non-INR (real code like USD/EUR, not NULL/XXX), live
 * currency is INR, AND the shop has any financial rows, the flip is BLOCKED:
 * - Do NOT update Shop.currency
 * - Do NOT push the INR shop_config metafield
 * - Do NOT clear the not-supported state
 * - Return flipBlocked: true so callers can show the appropriate banner
 *
 * A shop with ZERO financial rows flips exactly as today.
 *
 * Never writes 'XXX' over a known value.
 */
export async function checkAndRecoverCurrency(
  sql: Sql,
  shopDomain: string,
  currentCurrency: string,
  admin: AdminGraphqlClient,
): Promise<CurrencyRecoveryResult> {
  try {
    const response = await admin.graphql(`
      query ShopCurrencyAndId {
        shop {
          id
          currencyCode
          metafield(namespace: "$app", key: "shop_config") {
            value
          }
        }
      }
    `);
    const data = (await response.json()) as ShopCurrencyAndIdResponse;

    const shopGid = data.data?.shop?.id;
    const fetchedCurrency = validateCurrencyCode(data.data?.shop?.currencyCode);

    if (!fetchedCurrency || !shopGid) {
      return { currency: currentCurrency, flipBlocked: false };
    }

    if (fetchedCurrency === NO_CURRENCY_SENTINEL) {
      return { currency: currentCurrency, flipBlocked: false };
    }

    let shopConfigCurrency: string | null = null;
    const metafieldValue = data.data?.shop?.metafield?.value;
    if (metafieldValue) {
      try {
        const parsed = JSON.parse(metafieldValue) as { currencyCode?: string };
        shopConfigCurrency = parsed.currencyCode ?? null;
      } catch {
        // Invalid JSON - treat as missing
      }
    }

    const hash = await shopHash(shopDomain);

    // #292 Currency Flip Safety: Block non-INR→INR flip when financial rows exist
    // Conditions: stored is known non-INR (USD, EUR, etc.), live is INR, has financial rows
    if (
      isKnownNonInrCurrency(currentCurrency) &&
      fetchedCurrency === SUPPORTED_SHOP_CURRENCY
    ) {
      // Need shopId from DB to check financial rows
      const [shopRow] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${shopDomain}
      `;
      if (shopRow && await hasFinancialRows(sql, shopRow.id)) {
        safeLog("info", "currency_flip_blocked", { shopHash: hash });
        return { currency: currentCurrency, flipBlocked: true };
      }
    }

    const shopConfigMissing = shopConfigCurrency === null;
    const shopConfigStale =
      shopConfigCurrency !== null && shopConfigCurrency !== fetchedCurrency;
    const dbNeedsUpdate = currentCurrency !== fetchedCurrency;

    const needsShopConfigPush =
      shopConfigMissing || shopConfigStale || dbNeedsUpdate;

    if (needsShopConfigPush) {
      const writeResult = await writeShopConfigMetafield(
        admin,
        shopGid,
        fetchedCurrency,
      );

      if (!writeResult.success) {
        const errCode = writeResult.error || "shop_config_write_error";
        safeLog("warn", "currency_recovery_metafield_failed", {
          shopHash: hash,
          err: errCode,
        });
        return { currency: currentCurrency, flipBlocked: false };
      }

      if (shopConfigStale && !dbNeedsUpdate) {
        safeLog("info", "shop_config_stale_repushed", { shopHash: hash });
      }
    }

    if (dbNeedsUpdate) {
      await sql`
        UPDATE "Shop" SET currency = ${fetchedCurrency}, "updatedAt" = NOW()
        WHERE domain = ${shopDomain}
      `;

      if (fetchedCurrency === "INR" && currentCurrency !== "INR") {
        safeLog("info", "currency_recovery_success", { shopHash: hash });
      } else if (fetchedCurrency !== "INR" && currentCurrency === "INR") {
        safeLog("info", "currency_switched_away", { shopHash: hash });
      } else if (currentCurrency === NO_CURRENCY_SENTINEL) {
        safeLog("info", "currency_xxx_resolved", { shopHash: hash });
      }
    }

    return { currency: fetchedCurrency, flipBlocked: false };
  } catch {
    const hash = await shopHash(shopDomain);
    safeLog("warn", "currency_check_failed", { shopHash: hash });
    return { currency: currentCurrency, flipBlocked: false };
  }
}
