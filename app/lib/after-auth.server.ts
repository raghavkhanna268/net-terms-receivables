/**
 * After-authentication hooks that run once per shop.
 *
 * These operations are idempotent and wrapped to never break authentication.
 * Failures are logged but don't prevent the user from accessing the app.
 *
 * The setup runs fire-and-forget (not awaited) to stay off the loader's
 * critical path. This means the first request after install may complete
 * before validation is registered, but the registration is idempotent and
 * will complete on a subsequent request.
 *
 * Note: Running on Cloudflare Workers with CPU limits.
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
 * In-memory cache for shops that have started afterAuth setup.
 * This is per-isolate on Workers, so shops may be set up multiple times
 * across different isolates, but ensureValidation is idempotent.
 */
const setupStartedShops = new Set<string>();

/**
 * Runs after-authentication hooks for a shop (fire-and-forget).
 *
 * This function is idempotent and safe to call on every request:
 * - Uses in-memory cache to skip already-processed shops
 * - Runs setup in background (not awaited) to stay off critical path
 * - Wraps all operations in try-catch to never break auth
 * - Logs errors for observability without affecting user experience
 *
 * @param shop - The shop domain (e.g., "example.myshopify.com")
 * @param admin - The authenticated admin GraphQL client
 */
export function runAfterAuth(
  shop: string,
  admin: AdminGraphqlClient,
): void {
  if (setupStartedShops.has(shop)) {
    return;
  }

  setupStartedShops.add(shop);

  runSetup(shop, admin).catch((error) => {
    setupStartedShops.delete(shop);
    console.error(`[afterAuth] Failed to setup validation for ${shop}:`, error);
  });
}

async function runSetup(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  await ensureValidation(admin);
}

/**
 * Reset the setup cache - only for testing purposes.
 * @internal
 */
export function _resetSetupCacheForTesting(): void {
  setupStartedShops.clear();
}

/**
 * Check if a shop has started setup - only for testing purposes.
 * @internal
 */
export function _isShopSetupStarted(shop: string): boolean {
  return setupStartedShops.has(shop);
}
