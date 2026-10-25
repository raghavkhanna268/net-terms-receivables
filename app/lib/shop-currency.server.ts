/**
 * Shop Currency Support Module (#292)
 *
 * v1 is INR-only. This module provides constants and helpers for checking
 * whether a shop's currency is supported by the app.
 *
 * @module
 */

/**
 * The only supported shop currency in v1.
 * Used for guards in drain, reconcile, initial sync, and reminders.
 */
export const SUPPORTED_SHOP_CURRENCY = "INR";

/**
 * ISO 4217 code for "no currency" - used as sentinel when currency query fails.
 * A shop with XXX currency is treated as unsupported (fail-closed).
 */
export const NO_CURRENCY_SENTINEL = "XXX";

/**
 * Check if a shop's currency is supported.
 *
 * In v1, only INR shops are supported. A shop with XXX (query failure)
 * or any other currency is considered unsupported.
 *
 * @param currency - The shop's currency code from Shop.currency
 * @returns true if the currency is supported, false otherwise
 */
export function isShopCurrencySupported(currency: string | null | undefined): boolean {
  return currency === SUPPORTED_SHOP_CURRENCY;
}

/**
 * Validate a currency code from the Shopify API.
 * Returns the code if valid (3 uppercase letters), otherwise null.
 *
 * @param code - The currency code from the API
 * @returns The validated code or null if invalid
 */
export function validateCurrencyCode(code: unknown): string | null {
  if (typeof code !== "string") {
    return null;
  }
  if (!/^[A-Z]{3}$/.test(code)) {
    return null;
  }
  return code;
}

/**
 * #292: Banner copy for currency not supported state.
 * Used by app._index.tsx and app.onboarding.tsx.
 *
 * Admin path source: https://help.shopify.com/en/manual/intro-to-shopify/initial-setup/setup-business-settings
 * Section: "Select a store currency" → Settings > General > Store defaults > Change store currency
 */
export const CURRENCY_NOT_SUPPORTED_BANNER_COPY =
  "Termwise is built for Indian merchants and currently supports INR only. " +
  "To use it, the store owner must change the store currency to Indian Rupee (INR) in " +
  "Shopify admin → Settings → General → Store defaults → Currency display → ⋯ → Change store currency, " +
  "then reload this page. If your store already has orders, Shopify asks you to confirm the change.";
