/**
 * Plan Welcome Service - Force-refresh plan on every welcome visit.
 *
 * This service force-refreshes the plan cache on every visit to /app/welcome,
 * regardless of plan_handle or charge_id values. Uses resolvePlanWithStatus
 * (forceRefresh=true) which goes through fetchPlanFromShopify/activeSubscriptions
 * plus resolvePlanKey, writing via setCachedPlan - the only writer of plan_key.
 *
 * Security:
 * - Shop comes ONLY from authenticated session, never URL params
 * - Foreign-shop params silently ignored (no write)
 *
 * Failure handling:
 * - If refresh fails (error status or throws), returns refresh_failed
 * - Never throws, never gates
 */

import type { Sql } from "~/lib/db-light.server";
import { resolvePlanWithStatus } from "~/services/plan.server";

const MAX_HANDLE_LENGTH = 32;

/**
 * Allowlist of known plan handles for normalization.
 * Used by normalizePlanHandle to validate against known values.
 */
const VALID_PLAN_HANDLES: ReadonlySet<string> = new Set([
  "starter",
  "growth",
  "unlimited",
]);

/**
 * Reason codes for plan welcome processing results.
 */
export const PLAN_WELCOME_REASONS = [
  "foreign_shop",
  "no_trigger",
  "refresh_failed",
  "refreshed",
] as const;

export type PlanWelcomeReason = (typeof PLAN_WELCOME_REASONS)[number];

export interface PlanWelcomeResult {
  refreshed: boolean;
  skipped: boolean;
  reason: PlanWelcomeReason;
}

/**
 * Normalize and validate a plan_handle against known values.
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
 * Force-refresh plan cache on every welcome visit.
 *
 * Uses resolvePlanWithStatus with forceRefresh=true which goes through
 * fetchPlanFromShopify/activeSubscriptions and writes via setCachedPlan.
 *
 * @param sql - Database client
 * @param sessionShop - Shop domain from authenticated session (trusted)
 * @param urlShopParam - Shop param from URL (untrusted, may differ)
 * @param _planHandle - plan_handle from URL (unused, kept for signature compatibility)
 * @param _chargeId - charge_id from URL (unused, kept for signature compatibility)
 * @returns Result indicating what action was taken
 */
export async function processPlanWelcome(
  sql: Sql,
  sessionShop: string,
  urlShopParam: string | null,
  _planHandle: string | null,
  _chargeId: string | null
): Promise<PlanWelcomeResult> {
  if (urlShopParam && urlShopParam !== sessionShop) {
    return { refreshed: false, skipped: true, reason: "foreign_shop" };
  }

  try {
    const { status } = await resolvePlanWithStatus(sql, sessionShop, true);
    if (status === "error") {
      return { refreshed: false, skipped: false, reason: "refresh_failed" };
    }
    return { refreshed: true, skipped: false, reason: "refreshed" };
  } catch {
    return { refreshed: false, skipped: false, reason: "refresh_failed" };
  }
}
