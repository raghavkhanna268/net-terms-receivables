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
import { validateCurrencyCode, NO_CURRENCY_SENTINEL, SUPPORTED_SHOP_CURRENCY } from "./shop-currency.server";
import { refreshPlanCache } from "~/services/plan.server";
import { decideShopCurrencyUpdate, hasFinancialRows } from "./shop-currency-guard.server";
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
 * In-flight reinstall handler promises by shop.
 * 
 * This is the PRIMARY deduplication mechanism for concurrent reinstall loads.
 * Set SYNCHRONOUSLY before any DB call, so all concurrent callers await the
 * same promise. Deleted in finally after the handler completes.
 * 
 * Why this exists (race condition fix):
 * Without this, two concurrent calls race on clearUninstalledAtAndMetafieldErrors.
 * The loser's 0-row result can return BEFORE the winner sets up its in-flight maps,
 * causing the loser to fall through to runSetupIfNeeded and render stale state.
 * 
 * With this map set synchronously BEFORE the first await, every concurrent caller
 * waits on the same promise. The first caller does the work; others await it.
 * 
 * This deduplication is per-isolate. Across Workers isolates, a concurrent
 * duplicate is still possible but harmless, because every registration function
 * (ensureMetafieldDefinitions, ensureValidation, ensurePaymentCustomization)
 * is idempotent (query then create/update).
 */
const inFlightReinstallHandlers = new Map<string, Promise<void>>();

/**
 * Runs after-authentication hooks for a shop.
 *
 * Gap 1 (awaited reinstall clear): The critical reinstall path is now AWAITED,
 * not fire-and-forget via waitUntil. This ensures:
 * - uninstalledAt is cleared BEFORE the post-auth redirect/render
 * - Registration (metafields, validation, payment customization) is complete
 *   on reinstall before the first load, so onboarding shows true state
 * - Failures are logged and visible (not swallowed)
 *
 * Non-critical work (normal first-install setup when not a reinstall) still
 * runs via waitUntil to keep install latency low.
 *
 * This function is idempotent and safe to call on every request:
 * - Uses in-memory cache to skip already-processed shops
 * - Concurrent first loads share one ensureValidation call
 * - Runs setup via ctx.waitUntil to stay off critical path (except reinstall)
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
 * @returns Promise that resolves when critical reinstall work is done
 */
export async function runAfterAuth(
  shop: string,
  admin: AdminGraphqlClient,
  waitUntil: WaitUntilFn,
): Promise<void> {
  let sql: Sql | null = null;
  try {
    sql = getRequestSql();
  } catch (error) {
    safeLog("warn", "clear_uninstalled_at_failed", { reason: "no_request_context", err: toErrorCode(error) });
  }

  if (sql) {
    await clearAndMaybeSetup(sql, shop, admin, waitUntil);
  } else {
    runSetupIfNeeded(shop, admin, waitUntil);
  }
}

/**
 * Clear uninstalledAt and run setup if the shop was reinstalled or not cached.
 *
 * Deduplication (per-isolate):
 * BEFORE any DB call, we check/set inFlightReinstallHandlers synchronously.
 * All concurrent callers await the same promise, ensuring:
 * - Registration runs exactly once per shop per isolate
 * - All callers' runAfterAuth resolves only after critical registration completes
 * - The Setup Guide never renders stale "Missing" state
 *
 * Across Workers isolates, a concurrent duplicate is still possible but harmless,
 * because every registration function is idempotent (query then create/update).
 *
 * On reinstall (wasReinstalled=true):
 * 1. Await critical work in parallel (registration + plan refresh)
 * 2. Run non-critical work (syncShopInfo) via waitUntil
 *
 * Critical path (awaited, parallel):
 * - [metafield definitions → validation] chain (validation depends on definitions)
 * - [payment customization] (independent)
 * - [plan refresh with forceRefresh] (bypasses stale cache)
 *
 * Background (waitUntil): syncShopInfo (timezone/currency/DB upsert)
 *
 * This fixes two reinstall bugs:
 * - Plan cache showing old Starter plan after subscription was cancelled by uninstall
 * - Payment Customization showing "Missing" on first load due to racing setup
 */
async function clearAndMaybeSetup(
  sql: Sql,
  shop: string,
  admin: AdminGraphqlClient,
  waitUntil: WaitUntilFn,
): Promise<void> {
  // Check for existing in-flight handler BEFORE any await.
  // This prevents the race where the loser's SQL returns before the winner sets up dedupe.
  const existingHandler = inFlightReinstallHandlers.get(shop);
  if (existingHandler) {
    // Another call is already handling this shop - await it and return.
    // The existing handler will do the work; we just wait for it.
    await existingHandler;
    return;
  }

  // We're the first caller - set up the handler promise synchronously.
  // Create a deferred so we can resolve it from within the handler.
  let resolveHandler!: () => void;
  let rejectHandler!: (error: unknown) => void;
  const handlerPromise = new Promise<void>((resolve, reject) => {
    resolveHandler = resolve;
    rejectHandler = reject;
  });

  // Set the handler BEFORE any await so concurrent callers find it immediately.
  inFlightReinstallHandlers.set(shop, handlerPromise);

  try {
    // Now do the actual work - concurrent callers will await handlerPromise above.
    const reinstallResult = await clearUninstalledAtAndMetafieldErrors(sql, shop);

    if (reinstallResult.wasReinstalled) {
      setupCompletedShops.delete(shop);

      // Use a deferred to pass critical result to the background promise.
      // This ensures the closure gets the actual result, not a captured initial value.
      let resolveCritical!: (success: boolean) => void;
      const criticalResultPromise = new Promise<boolean>((resolve) => {
        resolveCritical = resolve;
      });

      // Create the full setup promise (critical + background) for waitUntil.
      const fullSetupPromise = (async () => {
        const criticalSuccess = await criticalResultPromise;
        await runBackgroundSetup(shop, admin, criticalSuccess);
      })();

      inFlightSetups.set(shop, fullSetupPromise);

      try {
        // Run critical registration - this is what the Setup Guide depends on
        const criticalSuccess = await runCriticalRegistration(sql, shop, admin);
        resolveCritical(criticalSuccess);

        // Background setup runs via waitUntil (not blocking the response)
        waitUntil(fullSetupPromise);
      } catch (error) {
        // Signal failure so background can proceed
        resolveCritical(false);
        throw error;
      } finally {
        // Clean up inFlightSetups after full setup completes
        fullSetupPromise.finally(() => {
          inFlightSetups.delete(shop);
        });
      }
    } else {
      // Not a reinstall - run normal setup if needed
      runSetupIfNeeded(shop, admin, waitUntil);
    }

    resolveHandler();
  } catch (error) {
    rejectHandler(error);
    throw error;
  } finally {
    // Always clean up the handler map
    inFlightReinstallHandlers.delete(shop);
  }
}

/**
 * Run critical registration steps that the Setup Guide depends on (awaited on reinstall).
 *
 * Runs two chains in parallel:
 * 1. [definitions → validation] - validation depends on metafield definitions
 * 2. [payment customization] - independent
 * 3. [plan refresh] - force-bypasses cache to get fresh subscription status
 *
 * Returns true if ALL critical steps succeeded, false if any failed.
 * A failed step leaves the shop retryable (not marked complete).
 */
async function runCriticalRegistration(
  sql: Sql,
  shop: string,
  admin: AdminGraphqlClient,
): Promise<boolean> {
  let hasError = false;

  // Chain 1: definitions → validation (validation depends on definitions)
  const definitionsValidationChain = async (): Promise<void> => {
    await ensureMetafieldDefinitions(admin);
    const validationResult = await ensureValidation(admin);
    if (validationResult.created) {
      safeLog("info", "validation_created", { validationId: validationResult.id });
    }
  };

  // Chain 2: payment customization (independent)
  const paymentChain = async (): Promise<{ id: string; created: boolean }> => {
    return await ensurePaymentCustomization(admin);
  };

  // Chain 3: plan refresh with force (bypasses stale cache)
  // Note: refreshPlanCache internally catches errors and returns gracefully.
  // A failed plan refresh is logged but doesn't cause the Promise to reject.
  // This is by design - the plan will be refreshed on the next request.
  const planChain = async (): Promise<void> => {
    await refreshPlanCache(sql, shop);
  };

  const [defValResult, paymentResult, planResult] = await Promise.allSettled([
    definitionsValidationChain(),
    paymentChain(),
    planChain(),
  ]);

  if (defValResult.status === "rejected") {
    safeLog("error", "validation_registration_failed", { err: toErrorCode(defValResult.reason) });
    hasError = true;
  }

  if (paymentResult.status === "rejected") {
    safeLog("error", "payment_customization_failed", { err: toErrorCode(paymentResult.reason) });
    hasError = true;
  } else if (paymentResult.value.created) {
    safeLog("info", "payment_customization_created", { paymentCustomizationId: paymentResult.value.id });
  }

  if (planResult.status === "rejected") {
    safeLog("warn", "plan_background_refresh_failed", { err: toErrorCode(planResult.reason) });
    hasError = true;
  }

  return !hasError;
}

/**
 * Run non-critical setup in the background (via waitUntil).
 *
 * Includes: syncShopInfo (timezone/currency/DB upsert).
 * Plan refresh is now in the critical path, not here.
 *
 * Only marks shop complete if BOTH critical registration AND syncShopInfo succeeded.
 * A failed syncShopInfo on reinstall means timezone/currency/upsert didn't complete,
 * so the next load should retry.
 */
async function runBackgroundSetup(
  shop: string,
  admin: AdminGraphqlClient,
  criticalSuccess: boolean,
): Promise<void> {
  let syncSuccess = true;
  try {
    await syncShopInfo(shop, admin);
  } catch (error) {
    syncSuccess = false;
    safeLog("warn", "sync_shop_info_failed", { err: toErrorCode(error) });
  }

  // Only mark complete if all steps succeeded (critical + syncShopInfo)
  if (criticalSuccess && syncSuccess) {
    setupCompletedShops.add(shop);
  }
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
 * LIKE pattern for redacted customer IDs (e.g. 'gid://shopify/Customer/123_redacted_1698765432').
 * String.raw preserves backslashes so Postgres receives '%\_redacted\_%' exactly.
 * Must match enqueue_credit_status_recomputes() Part 3 in migration 20261111000000.
 */
const REDACTED_CUSTOMER_PATTERN = String.raw`%\_redacted\_%`;

/**
 * Atomically clear uninstalledAt, onboarding state, metafield sync errors, and
 * close open bulk operations on reinstall.
 *
 * This is called on every /app load BEFORE the cache early-return to handle
 * cross-isolate reinstall scenarios. Uses a CTE to perform all updates in a
 * single statement, ensuring atomicity: if any update fails, the entire
 * statement is rolled back, preserving the reinstall signal.
 *
 * S23-09: Also resets onboarding_dismissed_at on reinstall so the merchant sees
 * the Setup Guide again.
 *
 * #208 follow-up: Also clears metafieldSyncErrorCode and metafieldSyncErrorAt on
 * eligible BuyerAccount rows for the shop, allowing the resync sweep to retry
 * accounts that had permanent sync failures before uninstall.
 *
 * #294: Also sets metafieldSyncedAt = NULL and syncPending = true for eligible
 * BuyerAccount rows in the reinstalled shop. This makes the accounts eligible
 * for the daily resync sweep (Part 3), which re-pushes the credit_status
 * metafield. Part 3 is capped at 100 accounts per run across all shops.
 * Shopify wipes app-owned metafield values on uninstall.
 * Exclusions (must stay in sync with enqueue_credit_status_recomputes Part 3):
 * - No-owner rows (COMPANY without companyLocationId, TAGGED_CUSTOMER without customerId)
 * - Redacted accounts (customerId contains '_redacted_')
 *
 * #293: Also closes all open s6_bulk_operations rows (all origins: reconcile,
 * manual, webhook) so getInitialSyncState returns not_started and the merchant
 * can start a fresh sync. Closed rows carry closed_reason='reinstall_reset'.
 *
 * IMPORTANT: Only touches uninstalledAt, onboarding_dismissed_at on Shop;
 * metafieldSyncErrorCode, metafieldSyncErrorAt, metafieldSyncedAt, syncPending
 * on BuyerAccount; and closed_at/closed_reason on s6_bulk_operations.
 * Never touches plan, gating, credit, timezone, syncVersion, or any other column.
 *
 * @param sql - postgres.js SQL client
 * @param shop - The shop domain
 * @returns Object with wasReinstalled flag and shopId if reinstalled
 */
async function clearUninstalledAtAndMetafieldErrors(sql: Sql, shop: string): Promise<ClearUninstalledResult> {
  try {
    const result = await sql<{ id: string; closed_count: number; deleted_claims_count: number }[]>`
      WITH reinstalled_shop AS (
        UPDATE "Shop"
        SET "uninstalledAt" = NULL, onboarding_dismissed_at = NULL
        WHERE domain = ${shop} AND "uninstalledAt" IS NOT NULL
        RETURNING id
      ),
      cleared_accounts AS (
        -- #294: Reset eligible accounts for resync. Exclusions must match
        -- enqueue_credit_status_recomputes() Part 3 in migration 20261111000000.
        UPDATE "BuyerAccount"
        SET "metafieldSyncErrorCode" = NULL,
            "metafieldSyncErrorAt" = NULL,
            "metafieldSyncedAt" = NULL,
            "syncPending" = true
        WHERE "shopId" IN (SELECT id FROM reinstalled_shop)
          AND ("metafieldSyncErrorCode" IS NOT NULL
               OR "metafieldSyncErrorAt" IS NOT NULL
               OR "metafieldSyncedAt" IS NOT NULL
               OR "syncPending" = false)
          -- Exclude no-owner rows: COMPANY must have companyLocationId, TAGGED_CUSTOMER must have customerId
          AND NOT (kind = 'COMPANY'::"AccountKind" AND "companyLocationId" IS NULL)
          AND NOT (kind = 'TAGGED_CUSTOMER'::"AccountKind" AND "customerId" IS NULL)
          -- Exclude redacted accounts (customerId like 'gid://...._redacted_<timestamp>')
          AND ("customerId" IS NULL OR "customerId" NOT LIKE ${REDACTED_CUSTOMER_PATTERN} ESCAPE '\\')
      ),
      closed_ops AS (
        UPDATE s6_bulk_operations
        SET closed_at = NOW(), closed_reason = 'reinstall_reset'
        WHERE shop = ${shop}
          AND EXISTS (SELECT 1 FROM reinstalled_shop)
          AND closed_at IS NULL
        RETURNING 1
      ),
      deleted_claims AS (
        DELETE FROM s6_reconcile_stage_claims
        WHERE shop = ${shop}
          AND EXISTS (SELECT 1 FROM reinstalled_shop)
        RETURNING 1
      )
      SELECT id, (SELECT count(*) FROM closed_ops)::int AS closed_count,
             (SELECT count(*) FROM deleted_claims)::int AS deleted_claims_count
      FROM reinstalled_shop
    `;
    if (result.length > 0) {
      const closedCount = result[0].closed_count;
      const deletedClaimsCount = result[0].deleted_claims_count;
      safeLog("info", "cleared_uninstalled_at_and_metafield_errors", {
        shopHash: await shopHash(shop),
      });
      if (closedCount > 0 || deletedClaimsCount > 0) {
        safeLog("info", "reinstall_initial_sync_reset", {
          shopHash: await shopHash(shop),
          closedCount,
          claimsDeletedCount: deletedClaimsCount,
        });
      }
      return { wasReinstalled: true, shopId: result[0].id };
    }
    return { wasReinstalled: false };
  } catch (error) {
    safeLog("error", "clear_uninstalled_at_failed", { reason: "db_error", shopHash: await shopHash(shop), err: toErrorCode(error) });
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
 * Fetch shop auth info and sync to database.
 *
 * This function ensures the Shop row exists on every install or re-auth.
 * It uses INSERT ... ON CONFLICT to be idempotent:
 * - Fresh install: Creates new Shop row with timezone and currency (or defaults if query fails)
 * - Reinstall: Clears uninstalledAt and updates timezone/currency (preserves existing if query fails)
 * - Re-auth: Updates timezone/currency only (preserves existing if query fails)
 *
 * Note: shop_config metafield write was REMOVED here to eliminate duplication.
 * checkAndRecoverCurrency in the /app loader handles all shop_config writes with
 * proper staleness detection and flip-blocked logic. See shop-currency-recovery.server.ts.
 *
 * #292 Currency Flip Safety: When live currency is INR, stored currency is NOT INR,
 * AND the shop has financial rows (Invoice, Payment, s8_draft_orders), the currency
 * flip is BLOCKED. In this case:
 * - Do NOT update Shop.currency (preserves existing state)
 * - Timezone update still proceeds (independent of currency)
 * This is fail-closed: only zero financial rows allows flip to INR.
 */
async function syncShopInfo(
  shop: string,
  admin: AdminGraphqlClient,
): Promise<void> {
  const sql = getRequestSql();

  const authInfo = await fetchShopAuthInfo(admin);

  // #292 Currency Flip Safety: Check if currency flip should be blocked
  let effectiveCurrency = authInfo.currencyCode;
  let flipBlocked = false;

  if (authInfo.currencyCode === SUPPORTED_SHOP_CURRENCY) {
    const [shopRow] = await sql<{ id: string; currency: string | null }[]>`
      SELECT id, currency FROM "Shop" WHERE domain = ${shop}
    `;

    if (shopRow && shopRow.currency !== SUPPORTED_SHOP_CURRENCY) {
      const hasRows = await hasFinancialRows(sql, shopRow.id);
      const decision = decideShopCurrencyUpdate({
        storedCurrency: shopRow.currency ?? NO_CURRENCY_SENTINEL,
        liveCurrency: authInfo.currencyCode,
        hasFinancialRows: hasRows,
      });

      if (decision.blocked) {
        effectiveCurrency = decision.effectiveCurrency;
        flipBlocked = true;
        safeLog("info", "currency_flip_blocked_on_auth", {
          shopHash: await shopHash(shop),
        });
      }
    }
  }

  // #292: Write shop_config metafield with currency (unless flip was blocked)
  // On first install, there's no Shop row yet, so checkAndRecoverCurrency never runs.
  // This ensures the shop_config metafield is written on first install.
  if (!flipBlocked && authInfo.shopId) {
    const writeResult = await writeShopConfigMetafield(admin, authInfo.shopId, effectiveCurrency);
    if (!writeResult.success) {
      safeLog("warn", "shop_config_write_failed", {
        shopHash: await shopHash(shop),
        err: writeResult.error || "unknown",
      });
    }
  }

  try {
    await upsertShopOnAuth(sql, shop, authInfo.timezone, effectiveCurrency);
  } catch (error) {
    safeLog("error", "upsert_shop_failed", { shopHash: await shopHash(shop), err: toErrorCode(error) });
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
    safeLog("error", "metafield_definitions_failed", { err: toErrorCode(error) });
  }
  
  try {
    const validationResult = await ensureValidation(admin);
    if (validationResult.created) {
      safeLog("info", "validation_created", { validationId: validationResult.id });
    }
  } catch (error) {
    hasError = true;
    safeLog("error", "validation_registration_failed", { err: toErrorCode(error) });
  }
  
  // S13: Payment customization for hiding net-terms payment methods.
  // Failure is logged but doesn't break auth - can be retried on next request.
  try {
    const result = await ensurePaymentCustomization(admin);
    if (result.created) {
      safeLog("info", "payment_customization_created", { paymentCustomizationId: result.id });
    }
  } catch (error) {
    hasError = true;
    safeLog("error", "payment_customization_failed", { err: toErrorCode(error) });
  }
  
  // Shop info sync runs even if earlier steps fail - it's independent.
  // #292: Also syncs currency and writes shop_config metafield.
  try {
    await syncShopInfo(shop, admin);
  } catch (error) {
    hasError = true;
    safeLog("warn", "sync_shop_info_failed", { err: toErrorCode(error) });
  }
  
  // Only mark complete if all steps succeeded.
  if (!hasError) {
    setupCompletedShops.add(shop);
  }
  
  inFlightSetups.delete(shop);
}

/**
 * Reset the setup cache and in-flight maps - only for testing purposes.
 * @internal
 */
export function _resetSetupCacheForTesting(): void {
  setupCompletedShops.clear();
  inFlightSetups.clear();
  inFlightReinstallHandlers.clear();
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
 *   closes open bulk operations, and updates timezone/currency (preserves existing if null).
 *   All done atomically via CTE.
 * On re-auth: Updates timezone/currency only (preserves existing if null). Metafield errors untouched.
 *
 * #208 follow-up: Also clears metafieldSyncErrorCode and metafieldSyncErrorAt on
 * eligible BuyerAccount rows for the shop when uninstalledAt was set (reinstall only).
 * This is atomic with the Shop update to ensure the reinstall signal isn't lost.
 *
 * #294: Also sets metafieldSyncedAt = NULL and syncPending = true for eligible
 * BuyerAccount rows when uninstalledAt was set (reinstall only). This makes them
 * eligible for the daily resync sweep (Part 3), which is capped at 100 accounts
 * per run across all shops. Shopify wipes app-owned metafield values on uninstall.
 * Exclusions (must stay in sync with enqueue_credit_status_recomputes Part 3):
 * - No-owner rows (COMPANY without companyLocationId, TAGGED_CUSTOMER without customerId)
 * - Redacted accounts (customerId contains '_redacted_')
 *
 * #293: Also closes all open s6_bulk_operations rows when uninstalledAt was set
 * (reinstall only), so getInitialSyncState returns not_started for a fresh sync.
 *
 * #292: Now stores actual shop currency (not hardcoded INR) for INR-only guards.
 *
 * #292 G4: A failed currency read (XXX) now overwrites the existing currency
 * instead of preserving it. This ensures a shop that was INR but now has a failed
 * re-auth read fails closed (currency=XXX → not supported) rather than keeping
 * stale INR. Recovery can re-read and restore INR if the API becomes available.
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
  const result = await sql<{ id: string; closed_count: number; deleted_claims_count: number }[]>`
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
        -- G4: Do NOT preserve existing currency on failed read (XXX).
        -- A failed re-auth read must fail-closed, not keep stale INR.
        currency = ${currency},
        "uninstalledAt" = NULL,
        onboarding_dismissed_at = CASE
          WHEN "Shop"."uninstalledAt" IS NOT NULL THEN NULL
          ELSE "Shop".onboarding_dismissed_at
        END,
        "updatedAt" = NOW()
      RETURNING id
    ),
    cleared_accounts AS (
      -- #294: Reset eligible accounts for resync. Exclusions must match
      -- enqueue_credit_status_recomputes() Part 3 in migration 20261111000000.
      UPDATE "BuyerAccount"
      SET "metafieldSyncErrorCode" = NULL,
          "metafieldSyncErrorAt" = NULL,
          "metafieldSyncedAt" = NULL,
          "syncPending" = true
      WHERE "shopId" IN (SELECT id FROM old_state WHERE was_uninstalled)
        AND ("metafieldSyncErrorCode" IS NOT NULL
             OR "metafieldSyncErrorAt" IS NOT NULL
             OR "metafieldSyncedAt" IS NOT NULL
             OR "syncPending" = false)
        -- Exclude no-owner rows: COMPANY must have companyLocationId, TAGGED_CUSTOMER must have customerId
        AND NOT (kind = 'COMPANY'::"AccountKind" AND "companyLocationId" IS NULL)
        AND NOT (kind = 'TAGGED_CUSTOMER'::"AccountKind" AND "customerId" IS NULL)
        -- Exclude redacted accounts (customerId like 'gid://...._redacted_<timestamp>')
        AND ("customerId" IS NULL OR "customerId" NOT LIKE ${REDACTED_CUSTOMER_PATTERN} ESCAPE '\\')
    ),
    closed_ops AS (
      UPDATE s6_bulk_operations
      SET closed_at = NOW(), closed_reason = 'reinstall_reset'
      WHERE shop = ${shopDomain}
        AND EXISTS (SELECT 1 FROM old_state WHERE was_uninstalled)
        AND closed_at IS NULL
      RETURNING 1
    ),
    deleted_claims AS (
      DELETE FROM s6_reconcile_stage_claims
      WHERE shop = ${shopDomain}
        AND EXISTS (SELECT 1 FROM old_state WHERE was_uninstalled)
      RETURNING 1
    )
    SELECT id, (SELECT count(*) FROM closed_ops)::int AS closed_count,
           (SELECT count(*) FROM deleted_claims)::int AS deleted_claims_count
    FROM upserted
  `;
  const shopId = result[0]?.id ?? 'unknown';
  const closedCount = result[0]?.closed_count ?? 0;
  const deletedClaimsCount = result[0]?.deleted_claims_count ?? 0;
  safeLog("info", "shop_upserted", { shopId });
  if (closedCount > 0 || deletedClaimsCount > 0) {
    safeLog("info", "reinstall_initial_sync_reset", {
      shopHash: await shopHash(shopDomain),
      closedCount,
      claimsDeletedCount: deletedClaimsCount,
    });
  }
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

/**
 * Exported for testing: sync shop info (timezone, currency) with currency flip guard.
 * @internal
 */
export { syncShopInfo as _syncShopInfoForTesting };
