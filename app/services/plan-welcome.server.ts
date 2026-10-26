/**
 * Plan Welcome Service - Shared logic for App Pricing welcome-link redirect handling.
 *
 * Handles the plan_handle verification flow from Shopify App Pricing redirects.
 * Used by both /app/welcome and /app (index) routes.
 *
 * Security:
 * - plan_handle validated against strict allowlist: starter, growth, unlimited
 * - Shop comes ONLY from authenticated session, never URL params
 * - Foreign-shop params silently ignored (no write)
 *
 * Verification:
 * - Queries currentAppInstallation.activeSubscriptions
 * - On verification: stores as confirmed plan
 * - On empty/error: stores handle as pending only
 *
 * Idempotency:
 * - Re-visits don't duplicate or downgrade confirmed plans
 * - Pending never gates, redirects, or blocks
 */

import type { Sql } from "~/lib/db-light.server";
import { adminGraphQL } from "~/services/drain/admin-client.server";
import { safeLog, toErrorCode } from "~/lib/log.server";

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

interface SubscriptionQueryResponse {
  currentAppInstallation: {
    activeSubscriptions: Array<{
      id: string;
      name: string;
      status: string;
      test: boolean;
    }>;
  } | null;
}

const CURRENT_APP_INSTALLATION_QUERY = `
  query CurrentAppInstallation {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
      }
    }
  }
`;

export interface PlanWelcomeResult {
  handled: boolean;
  verified: boolean;
  pending: boolean;
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
 * Check if a handle matches a subscription name (case-insensitive).
 */
function handleMatchesSubscription(
  handle: string,
  subscriptionName: string | null | undefined
): boolean {
  if (!subscriptionName) return false;
  return subscriptionName.toLowerCase().trim() === handle;
}

/**
 * Process a plan_handle from App Pricing welcome-link redirect.
 *
 * This is the shared verify-or-pending logic used by both routes.
 *
 * @param sql - Database client
 * @param sessionShop - Shop domain from authenticated session (trusted)
 * @param urlShopParam - Shop param from URL (untrusted, may differ)
 * @param rawPlanHandle - Raw plan_handle from URL
 * @returns Result indicating what action was taken
 */
export async function processPlanWelcome(
  sql: Sql,
  sessionShop: string,
  urlShopParam: string | null,
  rawPlanHandle: string | null
): Promise<PlanWelcomeResult> {
  if (urlShopParam && urlShopParam !== sessionShop) {
    safeLog("warn", "welcome_foreign_shop_ignored", {});
    return { handled: false, verified: false, pending: false, skipped: true, reason: "foreign_shop" };
  }

  const validatedHandle = normalizePlanHandle(rawPlanHandle);

  if (!validatedHandle) {
    if (rawPlanHandle) {
      safeLog("warn", "welcome_invalid_handle", {});
    }
    return { handled: false, verified: false, pending: false, skipped: true, reason: "invalid_handle" };
  }

  const [shop] = await sql<{ id: string; plan_key: string | null }[]>`
    SELECT id, plan_key FROM "Shop" WHERE domain = ${sessionShop}
  `;

  if (!shop) {
    safeLog("warn", "welcome_shop_not_found", {});
    return { handled: false, verified: false, pending: false, skipped: true, reason: "shop_not_found" };
  }

  const existingPlanKey = shop.plan_key?.toLowerCase().trim() ?? "none";
  if (existingPlanKey === validatedHandle && existingPlanKey !== "none") {
    return { handled: true, verified: true, pending: false, skipped: false, reason: "already_confirmed" };
  }

  let verified = false;
  let subscriptionId: string | null = null;
  let subscriptionName: string | null = null;
  let isTest = false;

  try {
    const result = await adminGraphQL<SubscriptionQueryResponse>(
      sessionShop,
      CURRENT_APP_INSTALLATION_QUERY
    );

    if (result.success && result.data?.currentAppInstallation?.activeSubscriptions) {
      const subscriptions = result.data.currentAppInstallation.activeSubscriptions;
      const matchingSub = subscriptions.find(
        (sub) =>
          sub.status === "ACTIVE" && handleMatchesSubscription(validatedHandle, sub.name)
      );

      if (matchingSub) {
        verified = true;
        subscriptionId = matchingSub.id;
        subscriptionName = matchingSub.name;
        isTest = matchingSub.test;
      }
    }
  } catch (err) {
    safeLog("warn", "welcome_verification_error", { err: toErrorCode(err) });
  }

  if (verified) {
    await sql`
      UPDATE "Shop"
      SET
        plan_key = ${validatedHandle},
        subscription_id = ${subscriptionId},
        subscription_name = ${subscriptionName},
        is_test = ${isTest},
        plan_cached_at = NOW(),
        plan_pending_handle = NULL,
        "updatedAt" = NOW()
      WHERE id = ${shop.id}
    `;
    safeLog("info", "welcome_plan_confirmed", {
      shopId: shop.id,
      isTest,
    });
    return { handled: true, verified: true, pending: false, skipped: false };
  }

  await sql`
    UPDATE "Shop"
    SET
      plan_pending_handle = ${validatedHandle},
      "updatedAt" = NOW()
    WHERE id = ${shop.id}
  `;
  safeLog("info", "welcome_plan_pending", {
    shopId: shop.id,
  });
  return { handled: true, verified: false, pending: true, skipped: false };
}
