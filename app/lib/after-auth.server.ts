/**
 * After-authentication hooks that run once per shop.
 *
 * These operations are idempotent and wrapped to never break authentication.
 * Failures are logged but don't prevent the user from accessing the app.
 *
 * Uses ctx.waitUntil to run setup in the background, keeping it off the
 * loader's critical path while ensuring the Worker doesn't terminate before
 * the async work completes.
 *
 * Note: Running on Cloudflare Workers with CPU limits.
 */

import { ensureMetafieldDefinitions } from "./metafield-definitions.server";
import { ensureValidation } from "./validation-registration.server";
import { ensurePaymentCustomization } from "./payment-customization-registration.server";
import { getRequestSql } from "./request-context.server";
import { validateTimezone } from "./aging-dates.server";

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
 * Type for ctx.waitUntil function from Cloudflare Workers.
 */
type WaitUntilFn = (promise: Promise<unknown>) => void;

/**
 * In-memory cache for shops that have completed afterAuth setup.
 * This is per-isolate on Workers, so shops may be set up multiple times
 * across different isolates, but ensureValidation is idempotent.
 */
const setupCompletedShops = new Set<string>();

/**
 * In-flight setup promises by shop. Concurrent first loads share one
 * ensureValidation call. Entry is deleted on settle (success or failure).
 */
const inFlightSetups = new Map<string, Promise<void>>();

/**
 * Runs after-authentication hooks for a shop using ctx.waitUntil.
 *
 * This function is idempotent and safe to call on every request:
 * - Uses in-memory cache to skip already-processed shops
 * - Concurrent first loads share one ensureValidation call
 * - Runs setup via ctx.waitUntil to stay off critical path
 * - Marks shop complete only after success
 * - Allows retry on failure (shop not marked as complete)
 * - Logs errors for observability without affecting user experience
 *
 * @param shop - The shop domain (e.g., "example.myshopify.com")
 * @param admin - The authenticated admin GraphQL client
 * @param waitUntil - The ctx.waitUntil function from Cloudflare Workers context
 */
export function runAfterAuth(
  shop: string,
  admin: AdminGraphqlClient,
  waitUntil: WaitUntilFn,
): void {
  if (setupCompletedShops.has(shop)) {
    return;
  }

  const existingPromise = inFlightSetups.get(shop);
  if (existingPromise) {
    waitUntil(existingPromise);
    return;
  }

  const setupPromise = runSetup(shop, admin);
  inFlightSetups.set(shop, setupPromise);
  waitUntil(setupPromise);
}

/**
 * GraphQL query to fetch shop timezone.
 * Only fetches the ianaTimezone field to minimize data transfer.
 */
const SHOP_TIMEZONE_QUERY = `
  query ShopTimezone {
    shop {
      ianaTimezone
    }
  }
`;

/**
 * Fetch the shop's timezone from Admin API and update the database.
 * Uses validateTimezone to ensure the value is a valid IANA timezone.
 */
async function syncShopTimezone(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  try {
    const response = await admin.graphql(SHOP_TIMEZONE_QUERY);
    const result = await response.json() as {
      data?: { shop?: { ianaTimezone?: string } };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      console.warn(
        `[afterAuth] GraphQL errors fetching timezone for ${shop}:`,
        result.errors.map((e) => e.message).join(", ")
      );
      return;
    }

    const ianaTimezone = result.data?.shop?.ianaTimezone;
    if (!ianaTimezone) {
      console.warn(`[afterAuth] No timezone returned for ${shop}`);
      return;
    }

    // Validate the timezone before storing - this ensures the DB only has valid zones
    const validatedTimezone = validateTimezone(ianaTimezone);
    if (validatedTimezone !== ianaTimezone) {
      console.warn(
        `[afterAuth] Invalid timezone from Shopify for ${shop}: "${ianaTimezone}", ` +
        `using fallback: "${validatedTimezone}"`
      );
    }

    // Get SQL client from request context
    const sql = getRequestSql();

    // Update the shop's timezone in the database
    // Note: Shop row may not exist yet if this is the first auth - that's OK, row count will be 0
    const updateResult = await sql`
      UPDATE "Shop"
      SET timezone = ${validatedTimezone}
      WHERE domain = ${shop}
    `;

    const rowCount = updateResult.count ?? 0;
    if (rowCount === 0) {
      console.log(`[afterAuth] No Shop row found for ${shop}, skipping timezone update`);
    } else {
      console.log(`[afterAuth] Updated timezone for ${shop}: ${validatedTimezone} (${rowCount} row)`);
    }
  } catch (error) {
    // Non-fatal: timezone sync failure shouldn't break app access
    console.error(`[afterAuth] Failed to sync timezone for ${shop}:`, error);
  }
}

async function runSetup(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  let hasError = false;
  
  try {
    // Definitions run before validation so the Function input query can resolve them.
    await ensureMetafieldDefinitions(admin);
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] Failed to ensure metafield definitions for ${shop}:`, error);
  }
  
  try {
    await ensureValidation(admin);
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] Failed to ensure validation for ${shop}:`, error);
  }
  
  // S13: Payment customization for hiding net-terms payment methods
  // Failure is logged but doesn't break auth - can be retried on next request
  try {
    const result = await ensurePaymentCustomization(admin);
    if (result.created) {
      console.log(`[afterAuth] Created payment customization for ${shop}: ${result.id}`);
    }
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] Failed to ensure payment customization for ${shop}:`, error);
  }
  
  // Timezone sync runs even if earlier steps fail - it's independent
  try {
    await syncShopTimezone(shop, admin);
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] Failed to sync timezone for ${shop}:`, error);
  }
  
  // Only mark complete if all steps succeeded
  if (!hasError) {
    setupCompletedShops.add(shop);
  }
  
  inFlightSetups.delete(shop);
}

/**
 * Reset the setup cache and in-flight map - only for testing purposes.
 * @internal
 */
export function _resetSetupCacheForTesting(): void {
  setupCompletedShops.clear();
  inFlightSetups.clear();
}

/**
 * Check if a shop has completed setup - only for testing purposes.
 * @internal
 */
export function _isShopSetupComplete(shop: string): boolean {
  return setupCompletedShops.has(shop);
}

/**
 * Check if a shop has an in-flight setup - only for testing purposes.
 * @internal
 */
export function _isShopSetupInFlight(shop: string): boolean {
  return inFlightSetups.has(shop);
}
