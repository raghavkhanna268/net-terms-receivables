/**
 * #292 G1: Shared currency recovery logic for both /app and /app/onboarding.
 *
 * This module provides the checkAndRecoverCurrency function that is called on
 * every /app (Dashboard) and /app/onboarding (Setup Guide) load to catch:
 * - Shops with hardcoded 'INR' rows (from bugs or manual data fixes)
 * - Shops that switched away from INR
 * - Shops that switched to INR (recovery)
 * - Stale shop_config metafield (e.g., after-auth write failed)
 */

import type { Sql } from "~/lib/db-light.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { NO_CURRENCY_SENTINEL, validateCurrencyCode } from "~/lib/shop-currency.server";
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
 * Never writes 'XXX' over a known value.
 */
export async function checkAndRecoverCurrency(
  sql: Sql,
  shopDomain: string,
  currentCurrency: string,
  admin: AdminGraphqlClient,
): Promise<string> {
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

    const shopId = data.data?.shop?.id;
    const fetchedCurrency = validateCurrencyCode(data.data?.shop?.currencyCode);

    if (!fetchedCurrency || !shopId) {
      return currentCurrency;
    }

    if (fetchedCurrency === NO_CURRENCY_SENTINEL) {
      return currentCurrency;
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

    const shopConfigMissing = shopConfigCurrency === null;
    const shopConfigStale =
      shopConfigCurrency !== null && shopConfigCurrency !== fetchedCurrency;
    const dbNeedsUpdate = currentCurrency !== fetchedCurrency;

    const needsShopConfigPush =
      shopConfigMissing || shopConfigStale || dbNeedsUpdate;

    if (needsShopConfigPush) {
      const writeResult = await writeShopConfigMetafield(
        admin,
        shopId,
        fetchedCurrency,
      );

      if (!writeResult.success) {
        safeLog("warn", "currency_recovery_metafield_failed", {
          shopHash: hash,
          err: writeResult.error ?? "shop_config_write_error",
        });
        return currentCurrency;
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

    return fetchedCurrency;
  } catch {
    const hash = await shopHash(shopDomain);
    safeLog("warn", "currency_check_failed", { shopHash: hash });
    return currentCurrency;
  }
}
