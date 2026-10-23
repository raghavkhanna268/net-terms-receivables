/**
 * After-authentication hooks that run once per shop.
 *
 * These operations are idempotent and wrapped to never break authentication.
 * Failures are logged but don't prevent the user from accessing the app.
 *
 * Note: Running on Cloudflare Workers with CPU limits. These operations should
 * be fast and are cached per-shop to avoid running on every request.
 */

import { ensureValidation } from "./validation-registration.server";

/**
 * Minimal type for the admin GraphQL client.
 */
interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

/**
 * In-memory cache for shops that have completed afterAuth setup.
 * This is per-isolate on Workers, so shops may be set up multiple times
 * across different isolates, but ensureValidation is idempotent.
 */
const setupCompletedShops = new Set<string>();

/**
 * Runs after-authentication hooks for a shop.
 *
 * This function is idempotent and safe to call on every request:
 * - Uses in-memory cache to skip already-processed shops
 * - Wraps all operations in try-catch to never break auth
 * - Logs errors for observability without affecting user experience
 *
 * @param shop - The shop domain (e.g., "example.myshopify.com")
 * @param admin - The authenticated admin GraphQL client
 */
export async function runAfterAuth(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  if (setupCompletedShops.has(shop)) {
    return;
  }

  try {
    await ensureValidation(admin);
    setupCompletedShops.add(shop);
  } catch (error) {
    console.error(`[afterAuth] Failed to setup validation for ${shop}:`, error);
  }
}

/**
 * Reset the setup cache - only for testing purposes.
 * @internal
 */
export function _resetSetupCacheForTesting(): void {
  setupCompletedShops.clear();
}

/**
 * Check if a shop has completed setup - only for testing purposes.
 * @internal
 */
export function _isShopSetupComplete(shop: string): boolean {
  return setupCompletedShops.has(shop);
}
