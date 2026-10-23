/**
 * Plan resolution service for S21.
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
 * Design decisions:
 * - Staleness never lowers tier: Always use last known plan, trigger background refresh
 * - Fail-to-cached: On error, use cached plan if one exists; only Free when no cache
 * - Never calls Shopify when cache is fresh (respects 10ms CPU budget)
 * - Cache refresh happens via APP_SUBSCRIPTIONS_UPDATE webhook
 * - Background refresh uses ctx.waitUntil() to avoid blocking requests
 */

import type { Sql } from "~/lib/db-light.server";
import { captureException, captureMessage } from "~/lib/sentry";
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

/**
 * Cache TTL in milliseconds (~6 hours).
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Background refresh callback type for ctx.waitUntil binding.
 * Set via setBackgroundRefreshCallback() from worker context.
 */
type BackgroundRefreshCallback = (promise: Promise<unknown>) => void;
let backgroundRefreshCallback: BackgroundRefreshCallback | null = null;

/**
 * Set the background refresh callback (bound waitUntil).
 * Call this from worker context: setBackgroundRefreshCallback((p) => ctx.waitUntil(p))
 */
export function setBackgroundRefreshCallback(cb: BackgroundRefreshCallback | null): void {
  backgroundRefreshCallback = cb;
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
    console.error(
      `[plan.server] Failed to fetch subscription for ${shop}: ${result.error}`
    );
    captureMessage(
      `Plan fetch failed: ${result.error}`,
      "warning"
    );
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
    // Unknown subscription name - log and default to free
    console.warn(
      `[plan.server] Unknown subscription name for ${shop}: "${activeSubscription.name}"`
    );
    captureMessage(
      `Unknown subscription name: "${activeSubscription.name}"`,
      "warning"
    );
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
      console.warn(`[plan.server] Shop not found: ${shopDomain}`);
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
      // Trigger background refresh via waitUntil if available
      if (backgroundRefreshCallback) {
        const refreshPromise = (async () => {
          try {
            const fetched = await fetchPlanFromShopify(shopDomain);
            if (fetched && shopId) {
              await setCachedPlan(
                sql,
                shopId,
                fetched.planKey,
                fetched.subscriptionId,
                fetched.subscriptionName,
                fetched.isTest
              );
              console.log(`[plan.server] Background refresh completed for ${shopDomain}`);
            }
          } catch (err) {
            console.error(`[plan.server] Background refresh failed for ${shopDomain}:`, err);
          }
        })();
        backgroundRefreshCallback(refreshPromise);
      }

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
      // Fetch failed - use cached plan if available (fail-to-cached)
      if (cachedPlan) {
        console.warn(`[plan.server] Fetch failed for ${shopDomain}, using cached plan`);
        return {
          plan: getPlanConfig(cachedPlan.planKey),
          subscriptionId: cachedPlan.subscriptionId,
          subscriptionName: cachedPlan.subscriptionName,
          isTest: cachedPlan.isTest,
          fromCache: true,
        };
      }
      // No cache exists - only now default to free
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
    console.error("[plan.server] Error resolving plan:", error);
    captureException(error);
    
    // Fail-to-cached: use cached plan if available
    if (cachedPlan) {
      console.warn(`[plan.server] Exception for ${shopDomain}, using cached plan`);
      return {
        plan: getPlanConfig(cachedPlan.planKey),
        subscriptionId: cachedPlan.subscriptionId,
        subscriptionName: cachedPlan.subscriptionName,
        isTest: cachedPlan.isTest,
        fromCache: true,
      };
    }
    
    // No cache - only now default to free
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
  // Force refresh bypasses cache
  await resolvePlan(sql, shopDomain, true);
  console.log(`[plan.server] Refreshed plan cache for ${shopDomain}`);
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
    // No cache ever existed - return free plan
    return getDefaultPlan();
  }
  
  // If stale, try to trigger background refresh
  if (cached.isStale && backgroundRefreshCallback) {
    // Get shop domain for background refresh
    const [shopRow] = await sql<{ domain: string }[]>`
      SELECT domain FROM "Shop" WHERE id = ${shopId}
    `;
    
    if (shopRow) {
      const refreshPromise = (async () => {
        try {
          const fetched = await fetchPlanFromShopify(shopRow.domain);
          if (fetched) {
            await setCachedPlan(
              sql,
              shopId,
              fetched.planKey,
              fetched.subscriptionId,
              fetched.subscriptionName,
              fetched.isTest
            );
            console.log(`[plan.server] Background refresh (by shopId) completed for ${shopRow.domain}`);
          }
        } catch (err) {
          console.error(`[plan.server] Background refresh (by shopId) failed:`, err);
        }
      })();
      backgroundRefreshCallback(refreshPromise);
    }
  }
  
  // Always return the cached plan (staleness never lowers tier)
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
