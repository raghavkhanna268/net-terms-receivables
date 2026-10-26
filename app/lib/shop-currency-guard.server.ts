/**
 * #292: Currency Flip Safety Guard
 *
 * Shared decision helper for blocking currency flips that would relabel
 * existing financial data. Used by:
 * - shop-currency-recovery.server.ts (on /app and /app/onboarding load)
 * - after-auth.server.ts (on install/reinstall/re-auth)
 * - Future: shop/update webhook (#349)
 *
 * The guard blocks ANY flip to INR when financial rows exist, including:
 * - Known non-INR currencies (USD, EUR, GBP, etc.)
 * - Unknown currencies (XXX sentinel, NULL)
 *
 * Only a shop with ZERO financial rows may flip to INR. This is fail-closed:
 * when in doubt, block the flip and keep the shop not-supported until the
 * financial data is addressed (e.g., via support intervention).
 */

import type { Sql } from "~/lib/db-light.server";
import { SUPPORTED_SHOP_CURRENCY } from "~/lib/shop-currency.server";

/**
 * Decision result from the currency guard.
 */
export interface CurrencyGuardDecision {
  /** Whether the currency update should proceed */
  allowUpdate: boolean;
  /** The currency value to use (stored currency if blocked, live currency if allowed) */
  effectiveCurrency: string;
  /** Whether the flip was blocked due to existing financial rows */
  blocked: boolean;
}

/**
 * Input parameters for the currency guard decision.
 */
export interface CurrencyGuardInput {
  /** The currently stored currency in Shop.currency */
  storedCurrency: string;
  /** The live currency from Shopify Admin API */
  liveCurrency: string;
  /** Whether the shop has any financial rows (Invoice, Payment, s8_draft_orders) */
  hasFinancialRows: boolean;
}

/**
 * Decide whether a currency update should proceed.
 *
 * Blocks the update when:
 * - Live currency is INR (the target of the flip)
 * - Stored currency is NOT already INR
 * - Shop has financial rows that would be relabeled
 *
 * When blocked:
 * - Returns the stored currency (preserves existing state)
 * - Sets blocked=true so callers can show appropriate UI
 *
 * When allowed (any of these conditions):
 * - Currencies match (no change needed)
 * - Live currency is not INR (switching away from INR is always allowed)
 * - Stored currency is already INR (no relabeling would occur)
 * - Shop has zero financial rows (safe to flip)
 *
 * @param input - The guard input parameters
 * @returns Decision with allowUpdate, effectiveCurrency, and blocked flags
 */
export function decideShopCurrencyUpdate(input: CurrencyGuardInput): CurrencyGuardDecision {
  const { storedCurrency, liveCurrency, hasFinancialRows } = input;

  // No change needed - allow
  if (storedCurrency === liveCurrency) {
    return { allowUpdate: true, effectiveCurrency: liveCurrency, blocked: false };
  }

  // Not flipping TO INR - allow (switching away from INR is always safe)
  if (liveCurrency !== SUPPORTED_SHOP_CURRENCY) {
    return { allowUpdate: true, effectiveCurrency: liveCurrency, blocked: false };
  }

  // Already INR - allow (no relabeling would occur)
  if (storedCurrency === SUPPORTED_SHOP_CURRENCY) {
    return { allowUpdate: true, effectiveCurrency: liveCurrency, blocked: false };
  }

  // Flipping TO INR from any other value (including XXX/NULL)
  // Block if shop has financial rows
  if (hasFinancialRows) {
    return { allowUpdate: false, effectiveCurrency: storedCurrency, blocked: true };
  }

  // No financial rows - safe to flip
  return { allowUpdate: true, effectiveCurrency: liveCurrency, blocked: false };
}

/**
 * Check if a shop has any financial rows (Invoice, Payment, or s8_draft_orders).
 * Used to determine if a currency flip should be blocked.
 *
 * Uses EXISTS queries for efficiency - stops scanning as soon as one row is found.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - The shop's internal ID
 * @returns true if any financial rows exist, false otherwise
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
