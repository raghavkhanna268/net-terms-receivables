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

