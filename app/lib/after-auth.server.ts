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
  const clearUninstalledPromise = clearUninstalledAtIfSet(shop);
  waitUntil(clearUninstalledPromise);

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
 * Clear uninstalledAt if set for the given shop.
 *
 * This is called on every /app load BEFORE the cache early-return to handle
 * cross-isolate reinstall scenarios. It's a single cheap, shop-scoped conditional
 * UPDATE using the indexed domain column - no extra SELECT or round-trip.
 *
 * IMPORTANT: Only sets uninstalledAt to NULL. Never touches plan, gating,
 * credit, timezone, or any other column.
 *
 * @param shop - The shop domain
 */
async function clearUninstalledAtIfSet(shop: string): Promise<void> {
  try {
    const sql = getRequestSql();
    const result = await sql<{ id: string }[]>`
      UPDATE "Shop"
      SET "uninstalledAt" = NULL
      WHERE domain = ${shop} AND "uninstalledAt" IS NOT NULL
      RETURNING id
    `;
    if (result.length > 0) {
      console.log(`[afterAuth] cleared_uninstalled_at shop_id=${result[0].id}`);
    }
  } catch (error) {
    console.error(`[afterAuth] clear_uninstalled_at_failed reason=db_error`, error);
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
            `[afterAuth] timezone_invalid input=${ianaTimezone} fallback=${validatedTimezone}`
          );
        }
        timezone = validatedTimezone;
      } else {
        console.warn(`[afterAuth] timezone_query_failed reason=no_timezone_returned`);
      }
    }
  } catch (error) {
    console.warn(`[afterAuth] timezone_query_failed reason=exception`, error);
  }

  try {
    await upsertShopOnAuth(sql, shop, timezone);
  } catch (error) {
    console.error(`[afterAuth] upsert_shop_failed reason=db_error`, error);
    throw error;
  }
}

async function runSetup(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  let hasError = false;
  
  try {
    await ensureMetafieldDefinitions(admin);
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] metafield_definitions_failed reason=exception`, error);
  }
  
  try {
    await ensureValidation(admin);
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] validation_registration_failed reason=exception`, error);
  }
  
  try {
    const result = await ensurePaymentCustomization(admin);
    if (result.created) {
      console.log(`[afterAuth] payment_customization_created id=${result.id}`);
    }
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] payment_customization_failed reason=exception`, error);
  }
  
  try {
    await syncShopTimezone(shop, admin);
  } catch (error) {
    hasError = true;
    console.error(`[afterAuth] sync_timezone_failed reason=exception`, error);
  }
  
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
