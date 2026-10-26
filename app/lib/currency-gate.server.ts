/**
 * Shared currency gate helper for route loaders/actions (#292).
 *
 * Checks the STORED Shop.currency to determine if money views should render.
 * Uses fail-closed semantics: unknown, NULL, or 'XXX' are treated as not supported.
 *
 * Live re-read via checkAndRecoverCurrency is done only on /app and /app/onboarding.
 * Other routes use the stored value, which stays fresh via the shop/update webhook (#342).
 *
 * @module
 */

import { isShopCurrencySupported, NO_CURRENCY_SENTINEL } from "./shop-currency.server";

/**
 * Check if a shop's stored currency is supported for money views.
 * Fail-closed: NULL, undefined, or XXX are treated as not supported.
 *
 * @param storedCurrency - The shop's currency from Shop.currency column
 * @returns true if INR, false otherwise (fail-closed)
 */
export function isCurrencyGateOpen(storedCurrency: string | null | undefined): boolean {
  if (storedCurrency === null || storedCurrency === undefined) {
    return false;
  }
  return isShopCurrencySupported(storedCurrency);
}

/**
 * Get the effective currency code for display, with fail-closed sentinel.
 *
 * @param storedCurrency - The shop's currency from Shop.currency column
 * @returns The currency code or XXX sentinel if unknown
 */
export function getEffectiveCurrency(storedCurrency: string | null | undefined): string {
  return storedCurrency ?? NO_CURRENCY_SENTINEL;
}
