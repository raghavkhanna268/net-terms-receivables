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
import { safeLog, shopHash, toErrorCode } from "./log.server";
import type { Sql } from "./db-light.server";

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
 * IMPORTANT: Before the cache early-return, we always clear uninstalledAt
 * if set. This handles the case where:
 * 1. Shop was uninstalled (uninstalledAt set)
 * 2. Isolate A handled the uninstall and evicted from its cache
 * 3. Isolate B still has the shop in its cache
 * 4. Shop reinstalls and Isolate B handles the first /app load
 * 5. Without this check, Isolate B would skip upsertShopOnAuth
 *    and leave uninstalledAt set, breaking reconcile/reminders
 *
 * When clearUninstalledAtIfSet returns true (a row was cleared), we also
 * re-run the full setup because Shopify drops app-owned metafield definitions,
 * the validation function, and payment customization on uninstall.
 *
 * This adds one indexed conditional UPDATE on every /app load, but it's
 * a single-row WHERE domain=$1 AND uninstalledAt IS NOT NULL update
 * that is a no-op when already NULL (most requests).
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
  let sql: Sql | null = null;
  try {
    sql = getRequestSql();
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] clear_uninstalled_at_failed reason=no_request_context err=${errInfo}`);
  }

  if (sql) {
    const clearAndSetupPromise = clearAndMaybeSetup(sql, shop, admin, waitUntil);
    waitUntil(clearAndSetupPromise);
  } else {
    runSetupIfNeeded(shop, admin, waitUntil);
  }
}

/**
 * Clear uninstalledAt and run setup if the shop was reinstalled or not cached.
 */
async function clearAndMaybeSetup(
  sql: Sql,
  shop: string,
  admin: AdminGraphqlClient,
  waitUntil: WaitUntilFn,
): Promise<void> {
  const wasReinstalled = await clearUninstalledAtIfSet(sql, shop);

  if (wasReinstalled) {
    setupCompletedShops.delete(shop);
  }

  runSetupIfNeeded(shop, admin, waitUntil);
}

/**
 * Run setup if the shop is not in cache and not already in-flight.
 */
function runSetupIfNeeded(
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
 * Clear uninstalledAt and reset onboarding state if the shop was uninstalled.
 *
 * This is called on every /app load BEFORE the cache early-return to handle
 * cross-isolate reinstall scenarios. It's a single cheap, shop-scoped conditional
 * UPDATE using the indexed domain column - no extra SELECT or round-trip.
 *
 * S23-09: Also resets onboarding_dismissed_at on reinstall so the merchant sees
 * the Setup Guide again. This is in the same UPDATE to remain a single statement.
 *
 * IMPORTANT: Only sets uninstalledAt and onboarding_dismissed_at to NULL.
 * Never touches plan, gating, credit, timezone, or any other column.
 *
 * @param sql - postgres.js SQL client
 * @param shop - The shop domain
 * @returns true if a row was updated (shop was reinstalled), false otherwise
 */
async function clearUninstalledAtIfSet(sql: Sql, shop: string): Promise<boolean> {
  try {
    const result = await sql<{ id: string }[]>`
      UPDATE "Shop"
      SET "uninstalledAt" = NULL, onboarding_dismissed_at = NULL
      WHERE domain = ${shop} AND "uninstalledAt" IS NOT NULL
      RETURNING id
    `;
    if (result.length > 0) {
      safeLog("info", "cleared_uninstalled_at_and_onboarding", {
        shopHash: await shopHash(shop),
      });
      return true;
    }
    return false;
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] clear_uninstalled_at_failed reason=db_error err=${errInfo}`);
    return false;
  }
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
 * Fetch the shop's timezone from Admin API and upsert the Shop row.
 * Uses validateTimezone to ensure the value is a valid IANA timezone.
 *
 * This function ensures the Shop row exists on every install or re-auth.
 * It uses INSERT ... ON CONFLICT to be idempotent:
 * - Fresh install: Creates new Shop row with timezone (or default if query fails)
 * - Reinstall: Clears uninstalledAt and updates timezone (preserves existing if query fails)
 * - Re-auth: Updates timezone only (preserves existing if query fails)
 */
async function syncShopTimezone(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  const sql = getRequestSql();
  let timezone: string | null = null;

  try {
    const response = await admin.graphql(SHOP_TIMEZONE_QUERY);
    const result = await response.json() as {
      data?: { shop?: { ianaTimezone?: string } };
      errors?: Array<{ message: string }>;
    };

    if (result.errors) {
      console.warn(
        `[afterAuth] timezone_query_failed reason=graphql_errors`
      );
    } else {
      const ianaTimezone = result.data?.shop?.ianaTimezone;
      if (ianaTimezone) {
        const validatedTimezone = validateTimezone(ianaTimezone);
        if (validatedTimezone !== ianaTimezone) {
          console.warn(
            `[afterAuth] timezone_invalid fallback=${validatedTimezone}`
          );
        }
        timezone = validatedTimezone;
      } else {
        console.warn(`[afterAuth] timezone_query_failed reason=no_timezone_returned`);
      }
    }
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.warn(`[afterAuth] timezone_query_failed reason=exception err=${errInfo}`);
  }

  try {
    await upsertShopOnAuth(sql, shop, timezone);
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] upsert_shop_failed reason=db_error err=${errInfo}`);
    throw error;
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
    console.error(`[afterAuth] metafield_definitions_failed reason=exception err=${toErrorCode(error)}`);
  }
  
  try {
    await ensureValidation(admin);
  } catch (error) {
    hasError = true;
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] validation_registration_failed reason=exception err=${errInfo}`);
  }
  
  // S13: Payment customization for hiding net-terms payment methods.
  // Failure is logged but doesn't break auth - can be retried on next request.
  try {
    const result = await ensurePaymentCustomization(admin);
    if (result.created) {
      console.log(`[afterAuth] payment_customization_created id=${result.id}`);
    }
  } catch (error) {
    hasError = true;
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] payment_customization_failed reason=exception err=${errInfo}`);
  }
  
  // Timezone sync runs even if earlier steps fail - it's independent.
  try {
    await syncShopTimezone(shop, admin);
  } catch (error) {
    hasError = true;
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] sync_timezone_failed reason=exception err=${errInfo}`);
  }
  
  // Only mark complete if all steps succeeded.
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

/**
 * Upsert Shop row on authentication.
 *
 * Called on every install or re-auth to ensure the Shop row exists.
 * This is idempotent: INSERT ... ON CONFLICT updates existing rows.
 *
 * On fresh install: Creates a new Shop row with the given timezone (or default if null).
 * On reinstall: Clears uninstalledAt and updates timezone (preserves existing if null).
 * On re-auth: Updates timezone only (preserves existing if null).
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain (e.g., "example.myshopify.com")
 * @param timezone - IANA timezone from Shopify, or null if query failed
 */
export async function upsertShopOnAuth(
  sql: Sql,
  shopDomain: string,
  timezone: string | null,
): Promise<void> {
  const result = await sql<{ id: string }[]>`
    INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
    VALUES (${shopDomain}, COALESCE(${timezone}, 'Asia/Kolkata'), 'INR', 'free', NOW(), NOW())
    ON CONFLICT (domain)
    DO UPDATE SET
      timezone = COALESCE(${timezone}, "Shop".timezone),
      "uninstalledAt" = NULL,
      onboarding_dismissed_at = CASE
        WHEN "Shop"."uninstalledAt" IS NOT NULL THEN NULL
        ELSE "Shop".onboarding_dismissed_at
      END,
      "updatedAt" = NOW()
    RETURNING id
  `;
  const shopId = result[0]?.id ?? 'unknown';
  console.log(`[afterAuth] shop_upserted shop_id=${shopId} timezone=${timezone ?? 'preserved'}`);
}

/**
 * Evict a shop from the setup completed cache.
 * Called after a successful uninstall to ensure a quick reinstall
 * on a warm isolate still runs the upsert.
 *
 * @param shop - The shop domain to evict
 */
export function evictShopFromSetupCache(shop: string): void {
  setupCompletedShops.delete(shop);
}

/**
 * Exported for testing: clear uninstalledAt if set.
 * @internal
 */
export { clearUninstalledAtIfSet as _clearUninstalledAtIfSetForTesting };
