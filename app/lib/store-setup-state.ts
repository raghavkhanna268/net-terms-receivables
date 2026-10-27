/**
 * Store setup state helper (#292 extension).
 *
 * Determines whether a shop is still being set up, not supported, or ready.
 * Used to show appropriate UI states on routes that gate on currency.
 *
 * Setup state: Shop row missing OR currency is placeholder 'XXX'.
 * Not supported: Shop exists with a non-INR currency (USD, EUR, etc.).
 * Supported: Shop exists with INR currency.
 */

import { NO_CURRENCY_SENTINEL } from "./shop-currency.server";
import { isCurrencyGateOpen } from "./currency-gate.server";

export type StoreSetupStatus = "setting_up" | "not_supported" | "supported";

/**
 * Determine the store setup status from Shop row presence and currency.
 *
 * Decision table:
 * - No shop row → setting_up (async creation in progress)
 * - Shop with currency XXX → setting_up (currency not yet fetched)
 * - Shop with non-INR currency → not_supported (fail-closed)
 * - Shop with INR currency → supported
 *
 * @param shop - The shop row from DB, or null/undefined if not found
 * @returns The store setup status
 */
export function getStoreSetupStatus(
  shop: { currency: string | null } | null | undefined
): StoreSetupStatus {
  if (!shop) {
    return "setting_up";
  }

  const currency = shop.currency;

  if (currency === null || currency === NO_CURRENCY_SENTINEL) {
    return "setting_up";
  }

  if (isCurrencyGateOpen(currency)) {
    return "supported";
  }

  return "not_supported";
}

/**
 * Check if the store is in a blocked state (not ready for money actions).
 * Both setting_up and not_supported block money actions (fail-closed).
 */
export function isStoreBlocked(status: StoreSetupStatus): boolean {
  return status !== "supported";
}
