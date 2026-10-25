/**
 * Plan resolution service for S21/S24.
 *
 * IMPORTANT: These limits are the PRICING HYPOTHESIS from the tracker
 * and are NOT final. Raghav decides final tier limits and pricing via
 * the Partner Dashboard (managed App Pricing).
 *
 * This service:
 * 1. Resolves the shop's current plan from Shopify Admin GraphQL
 * 2. Caches the result in Postgres with ~6h TTL
 * 3. Provides getPlan(), hasFeature(), and limit() helpers
 *
 * S24 Refactor: Plan resolution is now behind the PlanSource interface,
 * allowing future integration with Shopify App Pricing via Partner API
 * without changing callers.
 *
 * Design decisions:
 * - Staleness never lowers tier: Always use last known plan, trigger background refresh
 * - Fail-to-cached: On error, use cached plan if one exists; only Free when no cache
 * - Never calls Shopify when cache is fresh (respects 10ms CPU budget)
 * - Cache refresh happens via APP_SUBSCRIPTIONS_UPDATE webhook
 * - Background refresh uses ctx.waitUntil() to avoid blocking requests
 *
 * @see plan-source.server.ts for the PlanSource interface
 */

import type { Sql } from "~/lib/db-light.server";
import { getRequestWaitUntil } from "~/lib/request-context.server";
import { captureExceptionWithTags, captureMessage } from "~/lib/sentry";
import { safeLog, toErrorCode, shopHash } from "~/lib/log.server";
import {
  type PlanKey,
  type PlanConfig,
  type FeatureKey,
  type LimitKey,
  getPlanConfig,
  getDefaultPlan,
  mapSubscriptionToPlanKey,
  planHasFeature,
  planLimit,
} from "~/lib/entitlements";
import { adminGraphQL } from "./drain/admin-client.server";
import type {
  PlanSource,
  PlanResolutionContext,
  SourceResolvedPlan,
  PlanSourceTag,
  PlanStatus,
} from "./plan-source.server";

/**
 * Cache TTL in milliseconds (~6 hours).
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * In-flight background refresh promises by shop domain.
 * Prevents concurrent refresh calls from racing when multiple requests
 * arrive while the cache is stale. Entry is deleted on settle.
 */
const inFlightRefreshes = new Map<string, Promise<void>>();

/**
 * Reset in-flight refreshes map - only for testing purposes.
 * @internal
 */
export function _resetInFlightRefreshesForTesting(): void {
  inFlightRefreshes.clear();
}

/**
 * Check if a refresh is in-flight for a shop - only for testing purposes.
 * @internal
 */
export function _isRefreshInFlight(shopDomain: string): boolean {
  return inFlightRefreshes.has(shopDomain);
}

/**
 * GraphQL query for current app installation subscriptions.
 * Uses 2026-10 API version.
 */
const CURRENT_APP_INSTALLATION_QUERY = `
  query CurrentAppInstallation {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        lineItems {
          plan {
            pricingDetails {
              __typename
            }
          }
        }
      }
    }
  }
`;

/**
 * Shopify subscription status types.
 */
type SubscriptionStatus =
  | "ACTIVE"
  | "CANCELLED"
  | "DECLINED"
  | "EXPIRED"
  | "FROZEN"
  | "PENDING";

/**
 * Shape of the GraphQL response for subscription query.
 */
interface SubscriptionQueryResponse {
  currentAppInstallation: {
    activeSubscriptions: Array<{
      id: string;
      name: string;
      status: SubscriptionStatus;
      test: boolean;
      lineItems: Array<{
        plan: {
          pricingDetails: {
            __typename: string;
          };
        };
      }>;
    }>;
  } | null;
}

/**
 * Cached plan row from database.
 */
interface CachedPlanRow {
  planKey: PlanKey;
  subscriptionId: string | null;
  subscriptionName: string | null;
  isTest: boolean;
  cachedAt: Date;
  isStale: boolean;
}

/**
 * Result of plan resolution.
 */
export interface ResolvedPlan {
  plan: PlanConfig;
  subscriptionId: string | null;
  subscriptionName: string | null;
  isTest: boolean;
  fromCache: boolean;
}

/**
 * Get the cached plan for a shop.
 * Returns the cached plan with staleness flag. Returns null only if no cache exists.
 * Staleness never lowers the tier - we always return the last known plan.
 */
async function getCachedPlan(
  sql: Sql,
  shopId: string
): Promise<CachedPlanRow | null> {
  const [row] = await sql<
    {
      plan_key: PlanKey | null;
      subscription_id: string | null;
      subscription_name: string | null;
      is_test: boolean | null;
      plan_cached_at: Date | null;
    }[]
  >`
    SELECT 
      plan_key,
      subscription_id,
      subscription_name,
      is_test,
      plan_cached_at
    FROM "Shop"
    WHERE id = ${shopId}
  `;

  // No row or no plan_key means no cache exists
  if (!row || !row.plan_key) {
    return null;
  }

  // Check if cache is stale (but still return it)
  const cacheAge = row.plan_cached_at 
    ? Date.now() - row.plan_cached_at.getTime()
    : Infinity;
  const isStale = cacheAge > CACHE_TTL_MS;

  return {
    planKey: row.plan_key,
    subscriptionId: row.subscription_id,
    subscriptionName: row.subscription_name,
    isTest: row.is_test ?? false,
    cachedAt: row.plan_cached_at ?? new Date(0),
    isStale,
  };
}

/**
 * Update the cached plan for a shop.
 */
async function setCachedPlan(
  sql: Sql,
  shopId: string,
  planKey: PlanKey,
  subscriptionId: string | null,
  subscriptionName: string | null,
  isTest: boolean
): Promise<void> {
  await sql`
    UPDATE "Shop"
    SET 
      plan_key = ${planKey},
      subscription_id = ${subscriptionId},
      subscription_name = ${subscriptionName},
      is_test = ${isTest},
      plan_cached_at = NOW(),
      "updatedAt" = NOW()
    WHERE id = ${shopId}
  `;
}

/**
 * Fetch the current plan from Shopify Admin API.
 * Returns the first ACTIVE subscription, or null if none.
 */
async function fetchPlanFromShopify(
  shop: string
): Promise<{
  planKey: PlanKey;
  subscriptionId: string | null;
  subscriptionName: string | null;
  isTest: boolean;
} | null> {
  const result = await adminGraphQL<SubscriptionQueryResponse>(
    shop,
    CURRENT_APP_INSTALLATION_QUERY
  );

  if (!result.success) {
    const code = toErrorCode(result.error);
    safeLog("error", "plan_fetch_failed", { shopHash: await shopHash(shop), err: code });
    captureMessage("plan_fetch_failed", "error");
    return null;
  }

  const subscriptions =
    result.data?.currentAppInstallation?.activeSubscriptions ?? [];

  // Find the first ACTIVE subscription
  const activeSubscription = subscriptions.find(
    (sub) => sub.status === "ACTIVE"
  );

  if (!activeSubscription) {
    // No active subscription = free plan
    return {
      planKey: "free",
      subscriptionId: null,
      subscriptionName: null,
      isTest: false,
    };
  }

  // Map the subscription name to a plan key
  const planKey = mapSubscriptionToPlanKey(activeSubscription.name);

  if (!planKey) {
    safeLog("warn", "unknown_subscription_name", {
      shopHash: await shopHash(shop),
      subscriptionId: activeSubscription.id,
      isTest: activeSubscription.test,
    });
    captureMessage("unknown_subscription_name", "warning");
    return {
      planKey: "free",
      subscriptionId: activeSubscription.id,
      subscriptionName: activeSubscription.name,
      isTest: activeSubscription.test,
    };
  }

  return {
    planKey,
    subscriptionId: activeSubscription.id,
    subscriptionName: activeSubscription.name,
    isTest: activeSubscription.test,
  };
}

/**
 * Get the shop ID from domain.
 */
async function getShopId(sql: Sql, shopDomain: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;
  return row?.id ?? null;
}

/**
 * Trigger a background refresh for a stale plan cache.
 *
 * Features:
 * - Deduplication: concurrent calls for the same shop share one in-flight promise
 * - Uses ctx.waitUntil via ALS to run without blocking the response
 * - Catches and reports errors to Sentry (never throws unhandled)
 * - Safe no-op when waitUntil is not available (tests, dev)
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID in database
 * @param shopDomain - Shop domain for Shopify API call
 */
function triggerBackgroundRefresh(
  sql: Sql,
  shopId: string,
  shopDomain: string
): void {
  const waitUntil = getRequestWaitUntil();
  if (!waitUntil) {
    return;
  }

  if (inFlightRefreshes.has(shopDomain)) {
    return;
  }

  const refreshPromise = (async () => {
    try {
      const fetched = await fetchPlanFromShopify(shopDomain);
      if (fetched) {
        await setCachedPlan(
          sql,
          shopId,
          fetched.planKey,
          fetched.subscriptionId,
          fetched.subscriptionName,
          fetched.isTest
        );
        safeLog("info", "plan_background_refresh_completed", { shopId });
      }
    } catch (err) {
      safeLog("error", "plan_background_refresh_failed", { shopId, err: toErrorCode(err) });
      captureExceptionWithTags(err, { shopId });
    } finally {
      inFlightRefreshes.delete(shopDomain);
    }
  })();

  inFlightRefreshes.set(shopDomain, refreshPromise);
  waitUntil(refreshPromise);
}

/**
 * Resolve the current plan for a shop.
 *
 * Design:
 * - Fresh cache: Return cached plan immediately
 * - Stale cache: Return cached plan, trigger background refresh (staleness never lowers tier)
 * - No cache: Fetch from Shopify, cache result
 * - Fetch failure with cache: Return cached plan (fail-to-cached)
 * - Fetch failure without cache: Return free plan (only case we default to free)
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain (e.g., "example.myshopify.com")
 * @param forceRefresh - Skip cache and fetch fresh from Shopify
 * @returns Resolved plan with metadata
 */
export async function resolvePlan(
  sql: Sql,
  shopDomain: string,
  forceRefresh = false
): Promise<ResolvedPlan> {
  const defaultResult: ResolvedPlan = {
    plan: getDefaultPlan(),
    subscriptionId: null,
    subscriptionName: null,
    isTest: false,
    fromCache: false,
  };

  let shopId: string | null = null;
  let cachedPlan: CachedPlanRow | null = null;

  try {
    shopId = await getShopId(sql, shopDomain);

    if (!shopId) {
      safeLog("warn", "plan_shop_not_found", {});
      return defaultResult;
    }

    // Always get cached plan first (for fail-to-cached behavior)
    cachedPlan = await getCachedPlan(sql, shopId);

    // If we have a fresh cache and not forcing refresh, return it
    if (cachedPlan && !cachedPlan.isStale && !forceRefresh) {
      return {
        plan: getPlanConfig(cachedPlan.planKey),
        subscriptionId: cachedPlan.subscriptionId,
        subscriptionName: cachedPlan.subscriptionName,
        isTest: cachedPlan.isTest,
        fromCache: true,
      };
    }

    // If cache is stale (but exists) and not forcing refresh,
    // return cached value and trigger background refresh
    if (cachedPlan && cachedPlan.isStale && !forceRefresh) {
      triggerBackgroundRefresh(sql, shopId, shopDomain);

      // Return stale cache immediately (staleness never lowers tier)
      return {
        plan: getPlanConfig(cachedPlan.planKey),
        subscriptionId: cachedPlan.subscriptionId,
        subscriptionName: cachedPlan.subscriptionName,
        isTest: cachedPlan.isTest,
        fromCache: true,
      };
    }

    // Fetch from Shopify (no cache or force refresh)
    const fetched = await fetchPlanFromShopify(shopDomain);

    if (!fetched) {
      if (cachedPlan) {
        safeLog("warn", "plan_fetch_failed_using_cache", { shopId });
        return {
          plan: getPlanConfig(cachedPlan.planKey),
          subscriptionId: cachedPlan.subscriptionId,
          subscriptionName: cachedPlan.subscriptionName,
          isTest: cachedPlan.isTest,
          fromCache: true,
        };
      }
      return defaultResult;
    }

    // Update cache
    await setCachedPlan(
      sql,
      shopId,
      fetched.planKey,
      fetched.subscriptionId,
      fetched.subscriptionName,
      fetched.isTest
    );

    return {
      plan: getPlanConfig(fetched.planKey),
      subscriptionId: fetched.subscriptionId,
      subscriptionName: fetched.subscriptionName,
      isTest: fetched.isTest,
      fromCache: false,
    };
  } catch (error) {
    safeLog("error", "plan_resolve_error", { shopId, err: toErrorCode(error) });
    captureExceptionWithTags(error, { shopId: shopId ?? undefined });
    
    if (cachedPlan) {
      safeLog("warn", "plan_exception_using_cache", { shopId });
      return {
        plan: getPlanConfig(cachedPlan.planKey),
        subscriptionId: cachedPlan.subscriptionId,
        subscriptionName: cachedPlan.subscriptionName,
        isTest: cachedPlan.isTest,
        fromCache: true,
      };
    }
    
    return defaultResult;
  }
}

/**
 * Refresh the cached plan for a shop.
 * Called by APP_SUBSCRIPTIONS_UPDATE webhook handler.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 */
export async function refreshPlanCache(
  sql: Sql,
  shopDomain: string
): Promise<void> {
  await resolvePlan(sql, shopDomain, true);
  safeLog("info", "plan_cache_refreshed", { shopHash: await shopHash(shopDomain) });
}

/**
 * Helper: Get the current plan for a shop.
 * Convenience wrapper around resolvePlan().
 */
export async function getPlan(
  sql: Sql,
  shopDomain: string
): Promise<PlanConfig> {
  const resolved = await resolvePlan(sql, shopDomain);
  return resolved.plan;
}

/**
 * Helper: Check if a shop has a specific feature.
 */
export async function hasFeature(
  sql: Sql,
  shopDomain: string,
  feature: FeatureKey
): Promise<boolean> {
  const plan = await getPlan(sql, shopDomain);
  return planHasFeature(plan, feature);
}

/**
 * Helper: Get a limit value for a shop.
 * Returns -1 for unlimited.
 */
export async function limit(
  sql: Sql,
  shopDomain: string,
  limitKey: LimitKey
): Promise<number> {
  const plan = await getPlan(sql, shopDomain);
  return planLimit(plan, limitKey);
}

/**
 * Get the shop's plan by shopId (used internally).
 * Always returns the last known plan regardless of staleness.
 * Triggers background refresh if stale and domain is available.
 * Returns default plan only if no plan was ever cached.
 */
export async function getPlanByShopId(
  sql: Sql,
  shopId: string
): Promise<PlanConfig> {
  const cached = await getCachedPlan(sql, shopId);
  
  if (!cached) {
    return getDefaultPlan();
  }
  
  if (cached.isStale && getRequestWaitUntil()) {
    const [shopRow] = await sql<{ domain: string }[]>`
      SELECT domain FROM "Shop" WHERE id = ${shopId}
    `;
    
    if (shopRow) {
      triggerBackgroundRefresh(sql, shopId, shopRow.domain);
    }
  }
  
  return getPlanConfig(cached.planKey);
}

/**
 * Check if a shop is on a test subscription.
 * Useful for development/testing flows.
 */
export async function isTestSubscription(
  sql: Sql,
  shopDomain: string
): Promise<boolean> {
  const resolved = await resolvePlan(sql, shopDomain);
  return resolved.isTest;
}

// =============================================================================
// PlanSource Interface Implementations (S24)
// =============================================================================

/**
 * AdminInstallationPlanSource - Resolves plans from Shopify Admin GraphQL.
 *
 * This is the production implementation that reads currentAppInstallation
 * .activeSubscriptions from the Admin API. It wraps the existing plan
 * resolution logic with the same queries, cache, TTL, fallbacks, and logs.
 *
 * Design:
 * - Uses 6h cache TTL in Postgres
 * - Staleness never lowers tier (returns cached plan, triggers background refresh)
 * - Fail-to-cached: On error, use cached plan; only Free when no cache exists
 * - Background refresh via ctx.waitUntil() to avoid blocking requests
 */
export class AdminInstallationPlanSource implements PlanSource {
  /**
   * Resolve the active plan for a shop from Admin GraphQL.
   *
   * This method wraps the existing resolvePlan() function, converting its
   * result to the SourceResolvedPlan format with source metadata.
   */
  async resolveActivePlan(ctx: PlanResolutionContext): Promise<SourceResolvedPlan> {
    const resolved = await resolvePlan(ctx.sql, ctx.shopDomain, ctx.forceRefresh);

    const status = this.mapSubscriptionStatus(resolved);

    return {
      plan: resolved.plan,
      planKey: resolved.plan.key as PlanKey,
      subscriptionId: resolved.subscriptionId,
      subscriptionName: resolved.subscriptionName,
      isTest: resolved.isTest,
      fromCache: resolved.fromCache,
      sourceTag: "admin_installation" as PlanSourceTag,
      status,
    };
  }

  private mapSubscriptionStatus(resolved: ResolvedPlan): PlanStatus {
    if (resolved.subscriptionId) {
      return "active";
    }
    return "unknown";
  }
}

/**
 * PartnerApiPlanSource - STUB for future Shopify App Pricing integration.
 *
 * This source is NEVER SELECTED today. It exists to define the interface
 * for future Partner API integration without touching callers.
 *
 * Design notes for future implementation:
 * - Query Partner API's activeSubscription when cache is stale
 * - Map plan_handle (from post-checkout redirect) to internal plan keys
 * - Keep last known plan and safeLog a fixed code if Partner API unavailable
 * - Eventual retirement of APP_SUBSCRIPTIONS_UPDATE webhook requires:
 *   - QA's slot for testing
 *   - TOML change to remove webhook subscription
 *   - Blocked on Raghav's pricing decision and Partner API credentials
 *
 * @see https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
 * @see https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/migrating-to-shopify-app-pricing
 */
export class PartnerApiPlanSource implements PlanSource {
  /**
   * STUB: Always returns not_configured status.
   *
   * This method makes NO network calls. It exists only to satisfy the
   * PlanSource interface for future implementation.
   *
   * @throws Error if called (source should never be selected)
   */
  async resolveActivePlan(_ctx: PlanResolutionContext): Promise<SourceResolvedPlan> {
    safeLog("error", "partner_api_source_not_configured", {});
    throw new Error(
      "PartnerApiPlanSource is not configured. " +
      "This source should never be selected in the current implementation."
    );
  }

  /**
   * STUB: Map plan_handle from post-checkout redirect to internal plan key.
   *
   * Future implementation will:
   * - Receive plan_handle query param from Shopify's post-checkout redirect
   * - Map it to internal plan keys (free, starter, growth, scale)
   * - Update the cached plan state
   *
   * @param _planHandle - The plan_handle from redirect (unused in stub)
   * @returns null (stub always returns null)
   */
  onPlanRedirect(_planHandle: string): PlanKey | null {
    safeLog("warn", "partner_api_redirect_not_configured", {});
    return null;
  }
}

// =============================================================================
// PlanSource Selector (S24)
// =============================================================================

/**
 * Singleton instances of plan sources.
 * Created once and reused for all requests.
 */
const adminSource = new AdminInstallationPlanSource();
const partnerSource = new PartnerApiPlanSource();

/**
 * Get the active PlanSource for plan resolution.
 *
 * Today, this ALWAYS returns AdminInstallationPlanSource.
 * No env var, credential, wrangler secret, or config flag controls selection.
 *
 * Future Partner API integration will add selection logic here without
 * changing callers of resolvePlan(), getPlan(), etc.
 *
 * @returns The active PlanSource instance
 */
export function getPlanSource(): PlanSource {
  return adminSource;
}

/**
 * Get the AdminInstallationPlanSource instance.
 * Exported for testing purposes only.
 * @internal
 */
export function _getAdminSourceForTesting(): AdminInstallationPlanSource {
  return adminSource;
}

/**
 * Get the PartnerApiPlanSource instance.
 * Exported for testing purposes only.
 * @internal
 */
export function _getPartnerSourceForTesting(): PartnerApiPlanSource {
  return partnerSource;
}

// Re-export types from plan-source.server.ts for convenience
export type {
  PlanSource,
  PlanResolutionContext,
  SourceResolvedPlan,
  PlanSourceTag,
  PlanStatus,
} from "./plan-source.server";
