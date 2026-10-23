/**
 * Gating service for S21 plan enforcement.
 *
 * Provides server-side limit checking and feature gating.
 * Called before creating resources that have plan-based limits.
 *
 * Design decisions:
 * - Downgrades NEVER delete data: over-limit shops keep read access
 * - Over-limit accounts are gated (gated_at set) not blocked/skipped
 * - Gated accounts are excluded from limit count and enforcement
 * - On upgrade, gated accounts are reactivated up to new limit (oldest first)
 * - Feature checks are exported for later steps to call hasFeature()
 *
 * Environment:
 * - PLAN_GATING_ENFORCED: Set to '1' or 'true' to enable enforcement
 *   Default is off (plan resolution, banner, usage work but no blocking)
 *
 * TODO (S13): hasFeature('credit_holds') is exported but the Validation Function
 * fail-open/fail-closed behavior on downgrade needs to be decided in S13.
 * This PR does NOT disable the Validation Function when credit_holds is unavailable.
 * See docs/plans-and-gating.md for details.
 */

import type { Sql } from "~/lib/db-light.server";
import { DateTime } from "luxon";
import { getPlanByShopId } from "./plan.server";
import {
  type FeatureKey,
  type PlanKey,
  getPlanConfig,
  planHasFeature,
  planLimit,
  isLimitExceeded,
} from "~/lib/entitlements";

/**
 * Check if plan gating enforcement is enabled.
 * Default is OFF (plan resolution, banner, usage work but no blocking).
 */
export function isGatingEnforced(): boolean {
  const env = process.env.PLAN_GATING_ENFORCED as string | undefined;
  return env === "1" || env === "true";
}

/**
 * SQL predicate for filtering active (non-gated) buyer accounts.
 * Use this in WHERE clauses to consistently exclude gated accounts.
 *
 * When PLAN_GATING_ENFORCED is OFF, returns a tautology (1=1) so all accounts are included.
 * When PLAN_GATING_ENFORCED is ON, returns "gated_at IS NULL" to exclude gated accounts.
 *
 * Usage:
 * ```typescript
 * const accounts = await sql`
 *   SELECT * FROM "BuyerAccount"
 *   WHERE "shopId" = ${shopId}
 *   AND ${activeAccountPredicate()}
 * `;
 * ```
 *
 * Note: This returns a raw SQL fragment. For complex queries you may need to
 * use it with proper escaping or construct the query differently.
 */
export function activeAccountPredicate(): string {
  if (!isGatingEnforced()) {
    return "1=1";
  }
  return "gated_at IS NULL";
}

/**
 * Check if a buyer account is active (not gated).
 * Respects PLAN_GATING_ENFORCED flag.
 *
 * @param gatedAt - The gated_at timestamp from the account (null means active)
 * @returns true if the account is active, false if gated
 */
export function isAccountActive(gatedAt: Date | null): boolean {
  if (!isGatingEnforced()) {
    return true;
  }
  return gatedAt === null;
}

/**
 * Error thrown when a plan limit is exceeded.
 */
export class UpgradeRequiredError extends Error {
  public readonly limitType: string;
  public readonly currentUsage: number;
  public readonly limit: number;

  constructor(limitType: string, currentUsage: number, limit: number) {
    super(
      `Upgrade required: ${limitType} limit reached (${currentUsage}/${limit})`
    );
    this.name = "UpgradeRequiredError";
    this.limitType = limitType;
    this.currentUsage = currentUsage;
    this.limit = limit;
  }
}

/**
 * Result of a gating check.
 */
export interface GatingCheckResult {
  allowed: boolean;
  currentUsage: number;
  limit: number;
  reason?: string;
}

/**
 * Check if a shop can create another BuyerAccount (company).
 * Excludes gated accounts from the count.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @returns GatingCheckResult with allowed status and usage info
 */
export async function checkCompanyLimit(
  sql: Sql,
  shopId: string
): Promise<GatingCheckResult> {
  // If gating is not enforced, always allow
  if (!isGatingEnforced()) {
    return {
      allowed: true,
      currentUsage: 0,
      limit: -1,
      reason: "Gating not enforced (PLAN_GATING_ENFORCED is off)",
    };
  }

  const plan = await getPlanByShopId(sql, shopId);
  const limit = planLimit(plan, "companies");

  // Unlimited
  if (limit === -1) {
    return {
      allowed: true,
      currentUsage: 0,
      limit: -1,
    };
  }

  // Count existing active (non-gated) BuyerAccounts for this shop
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND gated_at IS NULL
  `;

  const currentCount = parseInt(result?.count ?? "0", 10);

  if (isLimitExceeded(plan, "companies", currentCount)) {
    return {
      allowed: false,
      currentUsage: currentCount,
      limit,
      reason: `Company limit reached (${currentCount}/${limit}). Upgrade to add more buyer accounts.`,
    };
  }

  return {
    allowed: true,
    currentUsage: currentCount,
    limit,
  };
}

/**
 * Enforce the company limit - throws UpgradeRequiredError if exceeded.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @throws UpgradeRequiredError if limit exceeded
 */
export async function enforceCompanyLimit(
  sql: Sql,
  shopId: string
): Promise<void> {
  const check = await checkCompanyLimit(sql, shopId);
  if (!check.allowed) {
    throw new UpgradeRequiredError("companies", check.currentUsage, check.limit);
  }
}

/**
 * Check if a shop can perform another bank statement import this month.
 * Calendar month is calculated in IST (Asia/Kolkata) timezone.
 *
 * NOTE: Import limit enforcement is wired here but actual BankImport creation
 * is not yet implemented. See docs/plans-and-gating.md TODO for S15.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @returns GatingCheckResult with allowed status and usage info
 */
export async function checkImportLimit(
  sql: Sql,
  shopId: string
): Promise<GatingCheckResult> {
  // If gating is not enforced, always allow
  if (!isGatingEnforced()) {
    return {
      allowed: true,
      currentUsage: 0,
      limit: -1,
      reason: "Gating not enforced (PLAN_GATING_ENFORCED is off)",
    };
  }

  const plan = await getPlanByShopId(sql, shopId);
  const limit = planLimit(plan, "importsPerMonth");

  // Unlimited
  if (limit === -1) {
    return {
      allowed: true,
      currentUsage: 0,
      limit: -1,
    };
  }

  // Get start of current calendar month in IST
  const now = DateTime.now().setZone("Asia/Kolkata");
  const monthStart = now.startOf("month");
  const monthEnd = now.endOf("month");

  // Count imports in current month
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BankImport"
    WHERE "shopId" = ${shopId}
      AND "createdAt" >= ${monthStart.toJSDate()}
      AND "createdAt" <= ${monthEnd.toJSDate()}
  `;

  const currentCount = parseInt(result?.count ?? "0", 10);

  if (isLimitExceeded(plan, "importsPerMonth", currentCount)) {
    return {
      allowed: false,
      currentUsage: currentCount,
      limit,
      reason: `Import limit reached (${currentCount}/${limit} this month). Upgrade for unlimited imports.`,
    };
  }

  return {
    allowed: true,
    currentUsage: currentCount,
    limit,
  };
}

/**
 * Enforce the import limit - throws UpgradeRequiredError if exceeded.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @throws UpgradeRequiredError if limit exceeded
 */
export async function enforceImportLimit(
  sql: Sql,
  shopId: string
): Promise<void> {
  const check = await checkImportLimit(sql, shopId);
  if (!check.allowed) {
    throw new UpgradeRequiredError(
      "importsPerMonth",
      check.currentUsage,
      check.limit
    );
  }
}

/**
 * Check if a shop has a specific feature enabled.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @param feature - Feature key to check
 * @returns true if the feature is available
 */
export async function checkFeature(
  sql: Sql,
  shopId: string,
  feature: FeatureKey
): Promise<boolean> {
  const plan = await getPlanByShopId(sql, shopId);
  return planHasFeature(plan, feature);
}

/**
 * Get usage statistics for a shop's plan.
 * Useful for UI display of current usage.
 *
 * When PLAN_GATING_ENFORCED is ON, excludes gated accounts from the company count.
 * This reflects the "active" usage that counts toward the plan limit.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 */
export async function getUsageStats(
  sql: Sql,
  shopId: string
): Promise<{
  companies: { current: number; limit: number };
  importsThisMonth: { current: number; limit: number };
}> {
  const plan = await getPlanByShopId(sql, shopId);

  // Count companies (exclude gated when PLAN_GATING_ENFORCED is ON)
  // Using raw SQL with the gating predicate
  const companyResult = isGatingEnforced()
    ? await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM "BuyerAccount"
        WHERE "shopId" = ${shopId}
          AND gated_at IS NULL
      `
    : await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM "BuyerAccount"
        WHERE "shopId" = ${shopId}
      `;
  const companyCount = parseInt(companyResult[0]?.count ?? "0", 10);

  // Count imports this month (IST)
  const now = DateTime.now().setZone("Asia/Kolkata");
  const monthStart = now.startOf("month");
  const monthEnd = now.endOf("month");

  const [importResult] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BankImport"
    WHERE "shopId" = ${shopId}
      AND "createdAt" >= ${monthStart.toJSDate()}
      AND "createdAt" <= ${monthEnd.toJSDate()}
  `;
  const importCount = parseInt(importResult?.count ?? "0", 10);

  return {
    companies: {
      current: companyCount,
      limit: planLimit(plan, "companies"),
    },
    importsThisMonth: {
      current: importCount,
      limit: planLimit(plan, "importsPerMonth"),
    },
  };
}

/**
 * Gate a BuyerAccount due to plan limits.
 * Sets gated_at to current timestamp.
 *
 * @param sql - postgres.js SQL client
 * @param accountId - BuyerAccount ID to gate
 */
export async function gateAccount(
  sql: Sql,
  accountId: string
): Promise<void> {
  await sql`
    UPDATE "BuyerAccount"
    SET gated_at = NOW(), "updatedAt" = NOW()
    WHERE id = ${accountId}
  `;
}

/**
 * Create a new BuyerAccount in gated state.
 * Used when limit is exceeded but we still want to persist the data.
 *
 * @param sql - postgres.js SQL client
 * @param data - Account data to insert
 * @returns The created account ID
 */
export async function createGatedAccount(
  sql: Sql,
  data: {
    shopId: string;
    kind: "COMPANY" | "TAGGED_CUSTOMER";
    companyId?: string | null;
    companyLocationId?: string | null;
    customerId?: string | null;
    name: string;
    defaultTermsDays?: number | null;
    defaultTermsSource?: "explicit" | "tag" | null;
  }
): Promise<string> {
  const [result] = await sql<{ id: string }[]>`
    INSERT INTO "BuyerAccount" (
      "shopId",
      kind,
      "companyId",
      "companyLocationId",
      "customerId",
      name,
      "defaultTermsDays",
      "defaultTermsSource",
      gated_at,
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${data.shopId},
      ${data.kind},
      ${data.companyId ?? null},
      ${data.companyLocationId ?? null},
      ${data.customerId ?? null},
      ${data.name},
      ${data.defaultTermsDays ?? null},
      ${data.defaultTermsSource ?? null},
      NOW(),
      NOW(),
      NOW()
    )
    ON CONFLICT ("shopId", "companyLocationId") WHERE "companyLocationId" IS NOT NULL
    DO UPDATE SET
      "companyId" = EXCLUDED."companyId",
      name = EXCLUDED.name,
      "defaultTermsDays" = COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays"),
      gated_at = COALESCE("BuyerAccount".gated_at, NOW()),
      "updatedAt" = NOW()
    RETURNING id
  `;
  return result.id;
}

/**
 * Reactivate gated accounts up to the new plan limit.
 * Reactivates oldest accounts first (by createdAt).
 *
 * Called on plan upgrade via APP_SUBSCRIPTIONS_UPDATE webhook.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param newPlanKey - The new plan key after upgrade
 * @returns Number of accounts reactivated
 */
export async function reactivateGatedAccounts(
  sql: Sql,
  shopId: string,
  newPlanKey: PlanKey
): Promise<number> {
  const newPlan = getPlanConfig(newPlanKey);
  const newLimit = planLimit(newPlan, "companies");

  // Count current active (non-gated) accounts
  const [activeResult] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND gated_at IS NULL
  `;
  const activeCount = parseInt(activeResult?.count ?? "0", 10);

  // Calculate how many more we can activate
  let canActivate: number;
  if (newLimit === -1) {
    // Unlimited - activate all gated accounts
    canActivate = Number.MAX_SAFE_INTEGER;
  } else {
    canActivate = Math.max(0, newLimit - activeCount);
  }

  if (canActivate === 0) {
    return 0;
  }

  // Reactivate oldest gated accounts up to the limit
  const result = await sql`
    UPDATE "BuyerAccount"
    SET gated_at = NULL, "updatedAt" = NOW()
    WHERE id IN (
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND gated_at IS NOT NULL
      ORDER BY "createdAt" ASC
      LIMIT ${canActivate}
    )
  `;

  return result.count;
}

/**
 * Get the count of gated accounts for a shop.
 * Useful for UI display.
 */
export async function getGatedAccountCount(
  sql: Sql,
  shopId: string
): Promise<number> {
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND gated_at IS NOT NULL
  `;
  return parseInt(result?.count ?? "0", 10);
}
