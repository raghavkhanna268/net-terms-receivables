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
  PlanStatus,
  ResolutionState,
} from "./plan-source.server";
import {
  readPartnerConfig,
  fetchActiveSubscription,
  mapPlanHandleToKey,
  PartnerApiError,
  _resetConfigLoggingForTesting,
  type PartnerConfig,
} from "./partner-api.server";

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
 * - Routes through getPlanSource() so Partner API source is used when configured
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
      const source = getPlanSource();
      const result = await source.resolveActivePlan({
        sql,
        shopDomain,
        forceRefresh: true,
      });
      safeLog("info", "plan_background_refresh_completed", { shopId });

      if (!result.fromCache) {
        await setCachedPlan(
          sql,
          shopId,
          result.planKey,
          result.subscriptionId,
          result.subscriptionName,
          result.isTest
        );
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
 * S24: Routes through PlanSource interface via getPlanSource().
 * Note: getPlanByShopId() reads the DB-cached plan directly for performance;
 * it does not route through the interface since it never calls Shopify.
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
  const source = getPlanSource();
  const result = await source.resolveActivePlan({
    sql,
    shopDomain,
    forceRefresh,
  });

  return {
    plan: result.plan,
    subscriptionId: result.subscriptionId,
    subscriptionName: result.subscriptionName,
    isTest: result.isTest,
    fromCache: result.fromCache,
  };
}

/**
 * Internal plan resolution logic for AdminInstallationPlanSource.
 * This contains the actual implementation that was previously in resolvePlan().
 *
 * @internal - Use resolvePlan() or getPlanSource().resolveActivePlan() instead
 */
async function _resolveFromAdminInstallation(
  sql: Sql,
  shopDomain: string,
  forceRefresh: boolean
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
 * .activeSubscriptions from the Admin API. Contains the actual plan
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
   * This is the main entry point for plan resolution. Callers using
   * resolvePlan, getPlan, hasFeature, etc. route through this method.
   * Note: getPlanByShopId() reads the DB-cached plan directly for performance.
   */
  async resolveActivePlan(ctx: PlanResolutionContext): Promise<SourceResolvedPlan> {
    const shopId = await getShopId(ctx.sql, ctx.shopDomain);

    if (!shopId) {
      safeLog("warn", "plan_shop_not_found", {});
      return {
        plan: getDefaultPlan(),
        planKey: "free",
        subscriptionId: null,
        subscriptionName: null,
        isTest: false,
        fromCache: false,
        sourceTag: "admin_installation",
        status: "unknown",
        resolutionState: "unknown",
      };
    }

    const resolved = await _resolveFromAdminInstallation(
      ctx.sql,
      ctx.shopDomain,
      ctx.forceRefresh ?? false
    );

    const { status, resolutionState } = this.mapResolutionState(resolved);

    return {
      plan: resolved.plan,
      planKey: resolved.plan.key as PlanKey,
      subscriptionId: resolved.subscriptionId,
      subscriptionName: resolved.subscriptionName,
      isTest: resolved.isTest,
      fromCache: resolved.fromCache,
      sourceTag: "admin_installation",
      status,
      resolutionState,
    };
  }

  /**
   * Map resolved plan to status and resolution state.
   *
   * Returns:
   * - active/active: Has a subscription ID (confirmed active subscription)
   * - unknown/none: No subscription ID, fresh data (confirmed no subscription)
   * - unknown/unknown: No subscription ID, from cache or error (uncertain state)
   */
  private mapResolutionState(resolved: ResolvedPlan): { status: PlanStatus; resolutionState: ResolutionState } {
    if (resolved.subscriptionId) {
      return { status: "active", resolutionState: "active" };
    }
    if (!resolved.fromCache) {
      return { status: "unknown", resolutionState: "none" };
    }
    return { status: "unknown", resolutionState: "unknown" };
  }
}

/**
 * Isolate cache for confirmed Partner API subscriptions.
 * Only confirmed (non-null) subscriptions are cached.
 * Entries expire after 5 minutes.
 */
interface PartnerCacheEntry {
  planKey: PlanKey;
  subscriptionId: string | null;
  handle: string;
  isTest: boolean;
  expiresAt: number;
}

const PARTNER_CACHE_TTL_MS = 5 * 60 * 1000;
const PARTNER_CACHE_MAX_ENTRIES = 1000;

const partnerPlanCache = new Map<string, PartnerCacheEntry>();
const shopGidMemo = new Map<string, string>();
const inFlightPartner = new Map<string, Promise<SourceResolvedPlan>>();

/**
 * Query to get shop GID from Admin API.
 */
const SHOP_GID_QUERY = `query ShopGid { shop { id } }`;

/**
 * Evict oldest entries if cache exceeds max size.
 */
function evictPartnerCacheIfNeeded(): void {
  if (partnerPlanCache.size > PARTNER_CACHE_MAX_ENTRIES) {
    const keysToDelete = Array.from(partnerPlanCache.keys()).slice(
      0,
      partnerPlanCache.size - PARTNER_CACHE_MAX_ENTRIES
    );
    for (const key of keysToDelete) {
      partnerPlanCache.delete(key);
    }
  }
}

/**
 * PartnerApiPlanSource - Resolves plans from Shopify Partner API.
 *
 * This source queries the Partner API's activeSubscription endpoint to
 * determine the shop's current plan under Shopify App Pricing.
 *
 * Design:
 * - 5-minute isolate cache for confirmed subscriptions only
 * - In-flight deduplication per shop domain
 * - Shop GID memoized per isolate (never changes)
 * - Error fallback to last confirmed Postgres plan, or rethrow if none
 * - Never returns free on error (protects paying merchants)
 *
 * @see https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
 */
export class PartnerApiPlanSource implements PlanSource {
  private config: PartnerConfig | null = null;

  constructor() {
    this.config = readPartnerConfig();
  }

  /**
   * Resolve the active plan for a shop from Partner API.
   */
  async resolveActivePlan(ctx: PlanResolutionContext): Promise<SourceResolvedPlan> {
    if (!this.config) {
      throw new Error("PartnerApiPlanSource called without valid config");
    }

    const shopId = await getShopId(ctx.sql, ctx.shopDomain);
    if (!shopId) {
      throw new Error("plan_shop_not_found");
    }

    const lastConfirmed = await getCachedPlan(ctx.sql, shopId);

    if (!ctx.forceRefresh) {
      const cached = partnerPlanCache.get(ctx.shopDomain);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          plan: getPlanConfig(cached.planKey),
          planKey: cached.planKey,
          subscriptionId: cached.subscriptionId,
          subscriptionName: cached.handle,
          isTest: cached.isTest,
          fromCache: true,
          sourceTag: "partner_api",
          status: "active",
          resolutionState: "active",
        };
      }
    }

    const existing = inFlightPartner.get(ctx.shopDomain);
    if (existing) {
      return existing;
    }

    const promise = this.fetchAndCache(ctx, shopId, lastConfirmed);
    inFlightPartner.set(ctx.shopDomain, promise);

    try {
      return await promise;
    } finally {
      inFlightPartner.delete(ctx.shopDomain);
    }
  }

  private async fetchAndCache(
    ctx: PlanResolutionContext,
    shopId: string,
    lastConfirmed: CachedPlanRow | null
  ): Promise<SourceResolvedPlan> {
    try {
      const shopGid = await this.getShopGid(ctx.shopDomain);
      const sub = await fetchActiveSubscription(this.config!, shopGid);

      if (sub) {
        const handle = sub.items.find((i) => i.handle)?.handle;
        const mappedKey = mapPlanHandleToKey(handle);

        if (!mappedKey || mappedKey === "none") {
          if (mappedKey === "none") {
            await setCachedPlan(ctx.sql, shopId, "free", null, handle ?? null, false);
            return {
              plan: getDefaultPlan(),
              planKey: "free",
              subscriptionId: sub.legacySubscriptionId,
              subscriptionName: handle ?? null,
              isTest: false,
              fromCache: false,
              sourceTag: "partner_api",
              status: "unknown",
              resolutionState: "none",
            };
          }
          safeLog("error", "partner_plan_handle_unknown", {
            shopHash: await shopHash(ctx.shopDomain),
          });
          captureMessage("partner_plan_handle_unknown", "error");
          throw new Error("partner_plan_handle_unknown");
        }

        partnerPlanCache.set(ctx.shopDomain, {
          planKey: mappedKey,
          subscriptionId: sub.legacySubscriptionId,
          handle: handle!,
          isTest: false,
          expiresAt: Date.now() + PARTNER_CACHE_TTL_MS,
        });
        evictPartnerCacheIfNeeded();

        await setCachedPlan(
          ctx.sql,
          shopId,
          mappedKey,
          sub.legacySubscriptionId,
          handle!,
          false
        );

        return {
          plan: getPlanConfig(mappedKey),
          planKey: mappedKey,
          subscriptionId: sub.legacySubscriptionId,
          subscriptionName: handle!,
          isTest: false,
          fromCache: false,
          sourceTag: "partner_api",
          status: "active",
          resolutionState: "active",
        };
      }

      await setCachedPlan(ctx.sql, shopId, "free", null, null, false);

      return {
        plan: getDefaultPlan(),
        planKey: "free",
        subscriptionId: null,
        subscriptionName: null,
        isTest: false,
        fromCache: false,
        sourceTag: "partner_api",
        status: "unknown",
        resolutionState: "none",
      };
    } catch (err) {
      const code = err instanceof PartnerApiError ? err.code : toErrorCode(err);
      const httpStatus = err instanceof PartnerApiError ? err.httpStatus : undefined;

      if (code !== "partner_throttled") {
        captureExceptionWithTags(err, { shopId });
      }
      safeLog("warn", "partner_plan_fetch_failed", {
        shopHash: await shopHash(ctx.shopDomain),
        err: code,
        httpStatus,
      });

      if (lastConfirmed) {
        return {
          plan: getPlanConfig(lastConfirmed.planKey),
          planKey: lastConfirmed.planKey,
          subscriptionId: lastConfirmed.subscriptionId,
          subscriptionName: lastConfirmed.subscriptionName,
          isTest: lastConfirmed.isTest,
          fromCache: true,
          sourceTag: "partner_api",
          status: "unknown",
          resolutionState: "unknown",
        };
      }

      throw err;
    }
  }

  private async getShopGid(shopDomain: string): Promise<string> {
    const cached = shopGidMemo.get(shopDomain);
    if (cached) {
      return cached;
    }

    const result = await adminGraphQL<{ shop: { id: string } }>(
      shopDomain,
      SHOP_GID_QUERY
    );

    if (!result.success || !result.data?.shop?.id) {
      throw new Error("partner_shop_gid_failed");
    }

    const gid = result.data.shop.id;
    if (!/^gid:\/\/shopify\/Shop\/\d+$/.test(gid)) {
      throw new Error("partner_shop_gid_invalid");
    }

    shopGidMemo.set(shopDomain, gid);
    if (shopGidMemo.size > PARTNER_CACHE_MAX_ENTRIES) {
      const firstKey = shopGidMemo.keys().next().value;
      if (firstKey) shopGidMemo.delete(firstKey);
    }

    return gid;
  }

  /**
   * Map plan_handle from post-checkout redirect to internal plan key.
   * Used by T6 for informational logging (mismatch detection).
   */
  onPlanRedirect(planHandle: string): PlanKey | null {
    const mapped = mapPlanHandleToKey(planHandle);
    if (!mapped || mapped === "none") {
      return null;
    }
    return mapped;
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
let partnerSource: PartnerApiPlanSource | null = null;

let partnerNotConfiguredLogged = false;

/**
 * Get the active PlanSource for plan resolution.
 *
 * Selection logic:
 * - If PLAN_SOURCE === "partner_api" and all Partner API env vars are valid,
 *   returns PartnerApiPlanSource
 * - Otherwise returns AdminInstallationPlanSource (today's behavior)
 *
 * With PLAN_SOURCE unset or set to "admin_installation", behavior is identical
 * to before this change: zero extra fetches, zero extra logs.
 *
 * @returns The active PlanSource instance
 */
export function getPlanSource(): PlanSource {
  const planSource = process.env.PLAN_SOURCE as string | undefined;
  if (planSource === "partner_api") {
    const config = readPartnerConfig();
    if (config) {
      if (!partnerSource) {
        partnerSource = new PartnerApiPlanSource();
      }
      return partnerSource;
    }
    if (!partnerNotConfiguredLogged) {
      partnerNotConfiguredLogged = true;
      safeLog("warn", "partner_api_not_configured", {});
    }
  }
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
 * Get a PartnerApiPlanSource instance.
 * Exported for testing purposes only.
 * @internal
 */
export function _getPartnerSourceForTesting(): PartnerApiPlanSource {
  if (!partnerSource) {
    partnerSource = new PartnerApiPlanSource();
  }
  return partnerSource;
}

/**
 * Reset Partner API caches for testing.
 * @internal
 */
export function _resetPartnerCachesForTesting(): void {
  partnerPlanCache.clear();
  shopGidMemo.clear();
  inFlightPartner.clear();
  partnerNotConfiguredLogged = false;
  partnerSource = null;
  _resetConfigLoggingForTesting();
}

// Re-export types from plan-source.server.ts for convenience
export type {
  PlanSource,
  PlanResolutionContext,
  SourceResolvedPlan,
  PlanSourceTag,
  PlanStatus,
  ResolutionState,
} from "./plan-source.server";
