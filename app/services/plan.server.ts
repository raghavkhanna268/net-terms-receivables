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
 * - Fail-to-free: Any error, unknown name, or missing subscription = 'free'
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
 * Returns null if no cache or cache is expired.
 */
async function getCachedPlan(
  sql: Sql,
  shopId: string
): Promise<CachedPlanRow | null> {
  const [row] = await sql<
    {
      plan_key: PlanKey;
      subscription_id: string | null;
      subscription_name: string | null;
      is_test: boolean;
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

  if (!row || !row.plan_cached_at) {
    return null;
  }

  // Check if cache is still valid
  const cacheAge = Date.now() - row.plan_cached_at.getTime();
  if (cacheAge > CACHE_TTL_MS) {
    return null;
  }

  return {
    planKey: row.plan_key ?? "free",
    subscriptionId: row.subscription_id,
    subscriptionName: row.subscription_name,
    isTest: row.is_test ?? false,
    cachedAt: row.plan_cached_at,
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
 * Uses cached value if fresh, otherwise fetches from Shopify.
 * On any error, returns 'free' plan (fail-to-free).
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

  try {
    const shopId = await getShopId(sql, shopDomain);

    if (!shopId) {
      console.warn(`[plan.server] Shop not found: ${shopDomain}`);
      return defaultResult;
    }

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cached = await getCachedPlan(sql, shopId);
      if (cached) {
        return {
          plan: getPlanConfig(cached.planKey),
          subscriptionId: cached.subscriptionId,
          subscriptionName: cached.subscriptionName,
          isTest: cached.isTest,
          fromCache: true,
        };
      }
    }

    // Fetch from Shopify
    const fetched = await fetchPlanFromShopify(shopDomain);

    if (!fetched) {
      // Fetch failed - default to free, don't cache failure
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
 * Returns default plan if not found.
 */
export async function getPlanByShopId(
  sql: Sql,
  shopId: string
): Promise<PlanConfig> {
  const cached = await getCachedPlan(sql, shopId);
  if (cached) {
    return getPlanConfig(cached.planKey);
  }
  
  // No cache - return free plan
  // Don't fetch from Shopify here as we don't have the domain
  return getDefaultPlan();
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
