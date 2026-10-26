/**
 * Plan Welcome Service - Force-refresh plan on App Pricing redirect.
 *
 * When a merchant completes the App Pricing flow, Shopify redirects with
 * plan_handle (or charge_id). This service force-refreshes the plan cache
 * using the EXISTING resolvePlan path (forceRefresh=true) which goes through
 * fetchPlanFromShopify/activeSubscriptions plus resolvePlanKey, writing via
 * setCachedPlan - the only writer of plan_key.
 *
 * Security:
 * - plan_handle validated against strict allowlist: starter, growth, unlimited
 * - Shop comes ONLY from authenticated session, never URL params
 * - Foreign-shop params silently ignored (no write)
 *
 * Failure handling:
 * - If refresh fails or throws, falls back silently to existing resolvePlan semantics
 * - Never throws, never gates
 */

import type { Sql } from "~/lib/db-light.server";
import { resolvePlan } from "~/services/plan.server";

const MAX_HANDLE_LENGTH = 32;

/**
 * Strict allowlist of valid plan handles.
 * Exactly: starter, growth, unlimited (lowercase).
 * Ignores Shopify's private $0 test plan and any other handle.
 */
const VALID_PLAN_HANDLES: ReadonlySet<string> = new Set([
  "starter",
  "growth",
  "unlimited",
]);

export interface PlanWelcomeResult {
  refreshed: boolean;
  skipped: boolean;
  reason?: string;
}

/**
 * Normalize and validate a plan_handle.
 * Returns null for invalid/unknown handles.
 */
export function normalizePlanHandle(handle: string | null): string | null {
  if (!handle || typeof handle !== "string") return null;
  const trimmed = handle.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_HANDLE_LENGTH) return null;
  if (!VALID_PLAN_HANDLES.has(trimmed)) return null;
  return trimmed;
}

/**
 * Check if plan_handle or charge_id is present and valid for refresh.
 * charge_id presence triggers refresh even without plan_handle.
 */
export function shouldRefreshPlan(
  planHandle: string | null,
  chargeId: string | null
): boolean {
  if (chargeId && chargeId.trim().length > 0) {
    return true;
  }
  return normalizePlanHandle(planHandle) !== null;
}

/**
 * Force-refresh plan cache after App Pricing redirect.
 *
 * Uses existing resolvePlan with forceRefresh=true which goes through
 * fetchPlanFromShopify/activeSubscriptions and writes via setCachedPlan.
 *
 * @param sql - Database client
 * @param sessionShop - Shop domain from authenticated session (trusted)
 * @param urlShopParam - Shop param from URL (untrusted, may differ)
 * @param planHandle - plan_handle from URL
 * @param chargeId - charge_id from URL (triggers refresh if present)
 * @returns Result indicating what action was taken
 */
export async function processPlanWelcome(
  sql: Sql,
  sessionShop: string,
  urlShopParam: string | null,
  planHandle: string | null,
  chargeId: string | null
): Promise<PlanWelcomeResult> {
  if (urlShopParam && urlShopParam !== sessionShop) {
    return { refreshed: false, skipped: true, reason: "foreign_shop" };
  }

  if (!shouldRefreshPlan(planHandle, chargeId)) {
    return { refreshed: false, skipped: true, reason: "no_trigger" };
  }

  try {
    await resolvePlan(sql, sessionShop, true);
    return { refreshed: true, skipped: false };
  } catch {
    return { refreshed: false, skipped: false, reason: "refresh_failed" };
  }
}
