/**
 * Plan URL utilities for building Shopify pricing plan URLs.
 *
 * Server-only module that reads APP_HANDLE from process.env (same mechanism
 * as the route loaders). Returns null when unset to fail closed rather than
 * building a broken URL.
 *
 * @module
 */

/**
 * Reads APP_HANDLE from the env the same way the routes do today.
 * Returns null when it's unset or empty (fail closed, never a hardcoded guess).
 */
export function getAppHandle(): string | null {
  const handle = process.env.APP_HANDLE;
  if (!handle || handle.trim() === "" || handle === "undefined") {
    return null;
  }
  return handle;
}

/**
 * Build the Shopify pricing plans URL for a store.
 *
 * @param shopDomain - Shop domain like 'test-shop.myshopify.com'
 *                     (the .myshopify.com suffix is stripped; a bare handle is accepted)
 * @param appHandle - App handle (defaults to getAppHandle())
 * @returns https://admin.shopify.com/store/{store_handle}/charges/{app_handle}/pricing_plans,
 *          or null if the app handle is null or the shop domain is invalid.
 */
export function buildPlanSelectionUrl(
  shopDomain: string,
  appHandle: string | null = getAppHandle()
): string | null {
  if (appHandle === null) {
    return null;
  }

  if (!shopDomain || shopDomain.trim() === "") {
    return null;
  }

  const storeHandle = shopDomain.replace(".myshopify.com", "");

  if (storeHandle.trim() === "") {
    return null;
  }

  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}
