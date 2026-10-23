/**
 * Gating service for S21 plan enforcement.
 *
 * Provides server-side limit checking and feature gating.
 * Called before creating resources that have plan-based limits.
 *
 * Design decisions:
 * - Downgrades NEVER delete data: over-limit shops keep read access
 * - Over-limit shops are blocked only from creating NEW resources
 * - Feature checks are exported for later steps to call hasFeature()
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
  planHasFeature,
  planLimit,
  isLimitExceeded,
} from "~/lib/entitlements";

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
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @returns GatingCheckResult with allowed status and usage info
 */
export async function checkCompanyLimit(
  sql: Sql,
  shopId: string
): Promise<GatingCheckResult> {
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

  // Count existing BuyerAccounts for this shop
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
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
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @returns GatingCheckResult with allowed status and usage info
 */
export async function checkImportLimit(
  sql: Sql,
  shopId: string
): Promise<GatingCheckResult> {
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

  // Count companies
  const [companyResult] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
  `;
  const companyCount = parseInt(companyResult?.count ?? "0", 10);

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
