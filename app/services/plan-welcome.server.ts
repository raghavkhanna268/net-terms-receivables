/**
 * Plan Welcome Service - App Pricing welcome-link redirect handling.
 *
 * Handles the plan_handle verification flow from Shopify App Pricing redirects.
 * Used by both /app/welcome and /app (index) routes.
 *
 * Security:
 * - plan_handle validated against strict allowlist: starter, growth, unlimited
 * - Shop comes ONLY from authenticated session, never URL params
 * - Foreign-shop params silently ignored (no write)
 *
 * Verification (P2 fix - uses existing plan.server path):
 * - Calls resolvePlan(forceRefresh=true) to refresh via Admin API
 * - Uses resolvePlanKey to map subscription name to plan key
 * - On match: clears plan_pending_handle
 * - On mismatch: stores handle as pending (banner shows only when differs from resolved)
 *
 * P3 optimization:
 * - Skips Admin API call when same handle is already pending
 *
 * Idempotency:
 * - Re-visits don't duplicate or downgrade confirmed plans
 *
 * Gating:
 * - Pending plans NEVER gate, redirect, or block anything
 */

import type { Sql } from "~/lib/db-light.server";
import { resolvePlan } from "~/services/plan.server";
import { resolvePlanKey, type PlanKey } from "~/lib/entitlements";

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
  handled: boolean;
  verified: boolean;
  pending: boolean;
  skipped: boolean;
  reason?: string;
  resolvedPlanKey?: PlanKey;
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
 * Check if a plan_handle or charge_id should trigger a refresh.
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
 * Process a plan_handle from App Pricing welcome-link redirect.
 *
 * This is the shared verify-or-pending logic used by both routes.
 *
 * Flow:
 * 1. Validate handle against allowlist
 * 2. Check if same handle is already pending (P3 skip)
 * 3. Call resolvePlan(forceRefresh=true) to refresh from Admin API
 * 4. If resolved plan matches handle → clear pending (verified)
 * 5. If mismatch → set pending handle
 *
 * @param sql - Database client
 * @param sessionShop - Shop domain from authenticated session (trusted)
 * @param urlShopParam - Shop param from URL (untrusted, may differ)
 * @param rawPlanHandle - Raw plan_handle from URL
 * @param rawChargeId - Raw charge_id from URL (triggers refresh if present)
 * @returns Result indicating what action was taken
 */
export async function processPlanWelcome(
  sql: Sql,
  sessionShop: string,
  urlShopParam: string | null,
  rawPlanHandle: string | null,
  rawChargeId: string | null = null
): Promise<PlanWelcomeResult> {
  if (urlShopParam && urlShopParam !== sessionShop) {
    return { handled: false, verified: false, pending: false, skipped: true, reason: "foreign_shop" };
  }

  const validatedHandle = normalizePlanHandle(rawPlanHandle);

  if (!shouldRefreshPlan(rawPlanHandle, rawChargeId)) {
    return { handled: false, verified: false, pending: false, skipped: true, reason: "no_trigger" };
  }

  const [shop] = await sql<{ id: string; plan_key: string | null; plan_pending_handle: string | null }[]>`
    SELECT id, plan_key, plan_pending_handle FROM "Shop" WHERE domain = ${sessionShop}
  `;

  if (!shop) {
    return { handled: false, verified: false, pending: false, skipped: true, reason: "shop_not_found" };
  }

  const existingPlanKey = resolvePlanKey(shop.plan_key);
  const existingPending = shop.plan_pending_handle?.toLowerCase().trim() ?? null;

  if (validatedHandle) {
    if (existingPlanKey === validatedHandle && existingPlanKey !== "none") {
      await sql`
        UPDATE "Shop"
        SET plan_pending_handle = NULL, "updatedAt" = NOW()
        WHERE id = ${shop.id}
      `;
      return { 
        handled: true, 
        verified: true, 
        pending: false, 
        skipped: false, 
        reason: "already_confirmed",
        resolvedPlanKey: existingPlanKey
      };
    }

    if (existingPending === validatedHandle) {
      return { 
        handled: true, 
        verified: false, 
        pending: true, 
        skipped: true, 
        reason: "already_pending",
        resolvedPlanKey: existingPlanKey
      };
    }
  }

  let resolvedPlanKey: PlanKey = existingPlanKey;
  try {
    const resolved = await resolvePlan(sql, sessionShop, true);
    resolvedPlanKey = resolved.plan.key;
  } catch {
    return { 
      handled: true, 
      verified: false, 
      pending: false, 
      skipped: false, 
      reason: "refresh_failed",
      resolvedPlanKey: existingPlanKey
    };
  }

  if (validatedHandle && resolvedPlanKey === validatedHandle) {
    await sql`
      UPDATE "Shop"
      SET plan_pending_handle = NULL, "updatedAt" = NOW()
      WHERE id = ${shop.id}
    `;
    return { 
      handled: true, 
      verified: true, 
      pending: false, 
      skipped: false,
      resolvedPlanKey 
    };
  }

  if (validatedHandle) {
    await sql`
      UPDATE "Shop"
      SET plan_pending_handle = ${validatedHandle}, "updatedAt" = NOW()
      WHERE id = ${shop.id}
    `;
    return { 
      handled: true, 
      verified: false, 
      pending: true, 
      skipped: false,
      resolvedPlanKey 
    };
  }

  return { 
    handled: true, 
    verified: resolvedPlanKey !== "none", 
    pending: false, 
    skipped: false,
    resolvedPlanKey 
  };
}

/**
 * Clear plan_pending_handle for a shop.
 * Called when plan is confirmed via any path (webhook, setCachedPlan, etc.).
 *
 * @param sql - Database client  
 * @param shopId - Shop ID
 */
export async function clearPendingHandle(sql: Sql, shopId: string): Promise<void> {
  await sql`
    UPDATE "Shop"
    SET plan_pending_handle = NULL, "updatedAt" = NOW()
    WHERE id = ${shopId} AND plan_pending_handle IS NOT NULL
  `;
}

/**
 * Get pending handle for a shop.
 *
 * @param sql - Database client
 * @param shopId - Shop ID
 * @returns The pending handle or null
 */
export async function getPendingHandle(sql: Sql, shopId: string): Promise<string | null> {
  const [row] = await sql<{ plan_pending_handle: string | null }[]>`
    SELECT plan_pending_handle FROM "Shop" WHERE id = ${shopId}
  `;
  return row?.plan_pending_handle ?? null;
}
