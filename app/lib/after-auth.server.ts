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
import { validateCurrencyCode, NO_CURRENCY_SENTINEL } from "./shop-currency.server";
import { writeShopConfigMetafield } from "~/services/shop-config.server";
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
 * When clearUninstalledAtAndMetafieldErrors returns wasReinstalled=true, we also
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
  const reinstallResult = await clearUninstalledAtAndMetafieldErrors(sql, shop);

  if (reinstallResult.wasReinstalled) {
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
 * Result of clearUninstalledAtAndMetafieldErrors containing reinstall status and shop ID.
 */
interface ClearUninstalledResult {
  wasReinstalled: boolean;
  shopId?: string;
}

/**
 * Atomically clear uninstalledAt, onboarding state, and metafield sync errors on reinstall.
 *
 * This is called on every /app load BEFORE the cache early-return to handle
 * cross-isolate reinstall scenarios. Uses a CTE to perform both updates in a
 * single statement, ensuring atomicity: if clearing the metafield errors fails,
 * the uninstalledAt clear is also rolled back, preserving the reinstall signal.
 *
 * S23-09: Also resets onboarding_dismissed_at on reinstall so the merchant sees
 * the Setup Guide again.
 *
 * #208 follow-up: Also clears metafieldSyncErrorCode and metafieldSyncErrorAt on
 * all BuyerAccount rows for the shop, allowing the resync sweep to retry accounts
 * that had permanent sync failures before uninstall.
 *
 * IMPORTANT: Only touches uninstalledAt, onboarding_dismissed_at on Shop, and
 * metafieldSyncErrorCode/metafieldSyncErrorAt on BuyerAccount.
 * Never touches plan, gating, credit, timezone, or any other column.
 *
 * @param sql - postgres.js SQL client
 * @param shop - The shop domain
 * @returns Object with wasReinstalled flag and shopId if reinstalled
 */
async function clearUninstalledAtAndMetafieldErrors(sql: Sql, shop: string): Promise<ClearUninstalledResult> {
  try {
    const result = await sql<{ id: string }[]>`
      WITH reinstalled_shop AS (
        UPDATE "Shop"
        SET "uninstalledAt" = NULL, onboarding_dismissed_at = NULL
        WHERE domain = ${shop} AND "uninstalledAt" IS NOT NULL
        RETURNING id
      ),
      cleared_accounts AS (
        UPDATE "BuyerAccount"
        SET "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
        WHERE "shopId" IN (SELECT id FROM reinstalled_shop)
          AND ("metafieldSyncErrorCode" IS NOT NULL OR "metafieldSyncErrorAt" IS NOT NULL)
      )
      SELECT id FROM reinstalled_shop
    `;
    if (result.length > 0) {
      safeLog("info", "cleared_uninstalled_at_and_metafield_errors", {
        shopHash: await shopHash(shop),
      });
      return { wasReinstalled: true, shopId: result[0].id };
    }
    return { wasReinstalled: false };
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] clear_uninstalled_at_failed reason=db_error err=${errInfo}`);
    return { wasReinstalled: false };
  }
}

/**
 * GraphQL query to fetch shop timezone and currency.
 * #292: Also fetches currencyCode for INR-only validation.
 */
const SHOP_AUTH_INFO_QUERY = `
  query ShopAuthInfo {
    shop {
      id
      ianaTimezone
      currencyCode
    }
  }
`;

/**
 * #292: Result from fetching shop auth info.
 */
interface ShopAuthInfo {
  shopId: string | null;
  timezone: string | null;
  currencyCode: string;
}

/**
 * #292: Fetch shop auth info (timezone and currency) from Admin API.
 */
async function fetchShopAuthInfo(admin: AdminGraphqlClient): Promise<ShopAuthInfo> {
  const result: ShopAuthInfo = {
    shopId: null,
    timezone: null,
    currencyCode: NO_CURRENCY_SENTINEL,
  };

  try {
    const response = await admin.graphql(SHOP_AUTH_INFO_QUERY);
    const data = await response.json() as {
      data?: { shop?: { id?: string; ianaTimezone?: string; currencyCode?: string } };
      errors?: Array<{ message: string }>;
    };

    if (data.errors) {
      console.warn(`[afterAuth] shop_auth_info_query_failed reason=graphql_errors`);
      return result;
    }

    const shop = data.data?.shop;
    if (!shop) {
      console.warn(`[afterAuth] shop_auth_info_query_failed reason=no_shop_returned`);
      return result;
    }

    result.shopId = shop.id ?? null;

    if (shop.ianaTimezone) {
      const validatedTimezone = validateTimezone(shop.ianaTimezone);
      if (validatedTimezone !== shop.ianaTimezone) {
        console.warn(`[afterAuth] timezone_invalid fallback=${validatedTimezone}`);
      }
      result.timezone = validatedTimezone;
    } else {
      console.warn(`[afterAuth] shop_auth_info_query_failed reason=no_timezone_returned`);
    }

    const validatedCurrency = validateCurrencyCode(shop.currencyCode);
    if (validatedCurrency) {
      result.currencyCode = validatedCurrency;
    } else {
      console.warn(`[afterAuth] shop_auth_info_query_failed reason=invalid_currency`);
    }
  } catch (error) {
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.warn(`[afterAuth] shop_auth_info_query_failed reason=exception err=${errInfo}`);
  }

  return result;
}

/**
 * Fetch shop auth info and sync to database and metafields.
 * #292: Also writes shop_config metafield with currency for Rust functions.
 *
 * This function ensures the Shop row exists on every install or re-auth.
 * It uses INSERT ... ON CONFLICT to be idempotent:
 * - Fresh install: Creates new Shop row with timezone and currency (or defaults if query fails)
 * - Reinstall: Clears uninstalledAt and updates timezone/currency (preserves existing if query fails)
 * - Re-auth: Updates timezone/currency only (preserves existing if query fails)
 *
 * #292: Write order - shop_config FIRST, then DB. A failed shop_config write is logged
 * but does not block the DB upsert (install must succeed). /app will detect and retry
 * any shop_config mismatch on next load.
 */
async function syncShopInfo(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  const sql = getRequestSql();

  const authInfo = await fetchShopAuthInfo(admin);

  // #292: Write shop_config metafield FIRST, log warning on failure but continue
  if (authInfo.shopId) {
    const writeResult = await writeShopConfigMetafield(admin, authInfo.shopId, authInfo.currencyCode);
    if (!writeResult.success) {
      safeLog("warn", "shop_config_write_failed", { err: writeResult.error ?? "unknown" });
    }
  }

  try {
    await upsertShopOnAuth(sql, shop, authInfo.timezone, authInfo.currencyCode);
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
  
  // Shop info sync runs even if earlier steps fail - it's independent.
  // #292: Also syncs currency and writes shop_config metafield.
  try {
    await syncShopInfo(shop, admin);
  } catch (error) {
    hasError = true;
    const errInfo = (error as { code?: string; name?: string }).code ?? (error as Error).name;
    console.error(`[afterAuth] sync_shop_info_failed reason=exception err=${errInfo}`);
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
 * On fresh install: Creates a new Shop row with the given timezone and currency (or defaults if null).
 * On reinstall: Clears uninstalledAt, resets onboarding, clears metafield sync errors,
 *   and updates timezone/currency (preserves existing if null). All done atomically via CTE.
 * On re-auth: Updates timezone/currency only (preserves existing if null). Metafield errors untouched.
 *
 * #208 follow-up: Also clears metafieldSyncErrorCode and metafieldSyncErrorAt on all
 * BuyerAccount rows for the shop when uninstalledAt was set (reinstall only).
 * This is atomic with the Shop update to ensure the reinstall signal isn't lost.
 *
 * #292: Now stores actual shop currency (not hardcoded INR) for INR-only guards.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain (e.g., "example.myshopify.com")
 * @param timezone - IANA timezone from Shopify, or null if query failed
 * @param currency - ISO 4217 currency code from Shopify (e.g., INR, USD)
 */
export async function upsertShopOnAuth(
  sql: Sql,
  shopDomain: string,
  timezone: string | null,
  currency: string,
): Promise<void> {
  const result = await sql<{ id: string }[]>`
    WITH old_state AS (
      SELECT id, "uninstalledAt" IS NOT NULL AS was_uninstalled
      FROM "Shop"
      WHERE domain = ${shopDomain}
    ),
    upserted AS (
      INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
      VALUES (${shopDomain}, COALESCE(${timezone}, 'Asia/Kolkata'), ${currency}, 'free', NOW(), NOW())
      ON CONFLICT (domain)
      DO UPDATE SET
        timezone = COALESCE(${timezone}, "Shop".timezone),
        currency = CASE
          WHEN ${currency} = 'XXX' THEN "Shop".currency
          ELSE ${currency}
        END,
        "uninstalledAt" = NULL,
        onboarding_dismissed_at = CASE
          WHEN "Shop"."uninstalledAt" IS NOT NULL THEN NULL
          ELSE "Shop".onboarding_dismissed_at
        END,
        "updatedAt" = NOW()
      RETURNING id
    ),
    cleared_accounts AS (
      UPDATE "BuyerAccount"
      SET "metafieldSyncErrorCode" = NULL, "metafieldSyncErrorAt" = NULL
      WHERE "shopId" IN (SELECT id FROM old_state WHERE was_uninstalled)
        AND ("metafieldSyncErrorCode" IS NOT NULL OR "metafieldSyncErrorAt" IS NOT NULL)
    )
    SELECT id FROM upserted
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
 * Exported for testing: atomically clear uninstalledAt and metafield errors.
 * @internal
 */
export { clearUninstalledAtAndMetafieldErrors as _clearUninstalledAtAndMetafieldErrorsForTesting };
