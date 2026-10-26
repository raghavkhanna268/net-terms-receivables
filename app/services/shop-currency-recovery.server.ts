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
 * When a shop has ANY non-INR stored currency (including XXX or NULL) and
 * switches to INR in Shopify, AND the shop already has financial rows (Invoice,
 * Payment, or s8_draft_orders), the flip is BLOCKED to prevent relabeling
 * existing data as rupees. The function returns flipBlocked: true in this case.
 *
 * Fail-closed behavior: Only a shop with ZERO financial rows may flip to INR.
 * When in doubt, block the flip and keep the shop not-supported until the
 * financial data is addressed (e.g., via support intervention).
 */

import type { Sql } from "~/lib/db-light.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { NO_CURRENCY_SENTINEL, validateCurrencyCode } from "~/lib/shop-currency.server";
import { writeShopConfigMetafield } from "./shop-config.server";
import { decideShopCurrencyUpdate, hasFinancialRows } from "~/lib/shop-currency-guard.server";

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
 * When stored currency is NOT INR (any value including XXX, NULL, USD, EUR, etc.)
 * and live currency IS INR, AND the shop has any financial rows, the flip is BLOCKED:
 * - Do NOT update Shop.currency
 * - Do NOT push the INR shop_config metafield
 * - Do NOT clear the not-supported state
 * - Return flipBlocked: true so callers can show the appropriate banner
 *
 * This is fail-closed: only a shop with ZERO financial rows may flip to INR.
 * When in doubt, block the flip and keep the shop not-supported until the
 * financial data is addressed (e.g., via support intervention).
 *
 * Never writes 'XXX' over a known value.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain (e.g., "example.myshopify.com")
 * @param currentCurrency - The currently stored currency in Shop.currency
 * @param admin - The authenticated admin GraphQL client
 * @param shopId - Optional: shop's internal ID, pass to avoid re-querying when caller has it
 */
export async function checkAndRecoverCurrency(
  sql: Sql,
  shopDomain: string,
  currentCurrency: string,
  admin: AdminGraphqlClient,
  shopId?: string,
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

    // #292 Currency Flip Safety: Use shared guard to decide if flip should be blocked
    // Reuse shopId from caller if provided, otherwise query DB
    let effectiveShopId = shopId;
    if (!effectiveShopId) {
      const [shopRow] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${shopDomain}
      `;
      effectiveShopId = shopRow?.id;
    }

    const hasRows = effectiveShopId ? await hasFinancialRows(sql, effectiveShopId) : false;
    const guardDecision = decideShopCurrencyUpdate({
      storedCurrency: currentCurrency,
      liveCurrency: fetchedCurrency,
      hasFinancialRows: hasRows,
    });

    if (guardDecision.blocked) {
      safeLog("info", "currency_flip_blocked", { shopHash: hash });
      return { currency: guardDecision.effectiveCurrency, flipBlocked: true };
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
