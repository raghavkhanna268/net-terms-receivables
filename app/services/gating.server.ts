/**
 * Gating service for S21 plan enforcement (T4: account-count gating).
 *
 * Provides server-side limit checking for company limits.
 * Called before creating resources that have plan-based limits.
 *
 * What is enforced (when PLAN_GATING_ENFORCED=true):
 * - Company limit: new BuyerAccounts over limit are created with gated_at set
 *
 * What is NOT enforced:
 * - Bank statement imports: unlimited on all plans
 * - credit_holds: runs on all plans (holds, recompute, sweep, Validation Function)
 *
 * Design decisions:
 * - Downgrades NEVER delete data: over-limit shops keep read access
 * - Over-limit accounts are gated (gated_at set) not blocked/skipped
 * - Gated accounts are excluded from limit count and enforcement
 * - On upgrade, gated accounts are reactivated up to new limit (oldest first)
 * - Existing rows and updates NEVER change gated_at
 *
 * Concurrency (T4):
 * - decideNewAccountGate() uses pg_advisory_xact_lock inside the insert tx
 * - Lock key: hashtextextended('ba_limit:' || shopId, 0)
 * - Lock is taken ONLY when PLAN_GATING_ENFORCED is on AND limit != -1
 * - reactivateGatedAccounts() uses the same lock
 *
 * Environment:
 * - PLAN_GATING_ENFORCED: Set to '1' or 'true' to enable enforcement
 *   Default is off (plan resolution, banner, usage work but no blocking)
 */

import type { Sql } from "~/lib/db-light.server";
import { getPlanByShopId } from "./plan.server";
import {
  type PlanKey,
  getPlanConfig,
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
 * SQL fragment type for composable WHERE clauses.
 * This is a tagged template result from postgres.js.
 */
export type SqlFragment = ReturnType<Sql>;

/**
 * Get a SQL fragment for filtering active (non-gated) buyer accounts.
 *
 * IMPORTANT: This helper must NOT be used for sync, hold, recompute, metafield,
 * sweep, matching, aging, or totals queries. Gated accounts participate fully
 * in those paths - gating applies only to value-add actions (reminders,
 * credit-limit edits, account editing).
 *
 * When PLAN_GATING_ENFORCED is OFF, returns a tautology (TRUE) so all accounts are included.
 * When PLAN_GATING_ENFORCED is ON, returns "gated_at IS NULL" to exclude gated accounts.
 *
 * @param sql - The postgres.js SQL client (needed to create the fragment)
 * @returns A SQL fragment that can be composed into queries
 */
export function activeAccountFragment(sql: Sql): SqlFragment {
  if (!isGatingEnforced()) {
    return sql`TRUE`;
  }
  return sql`gated_at IS NULL`;
}

/**
 * Check if a buyer account is active (not gated).
 * Respects PLAN_GATING_ENFORCED flag.
 *
 * Use this for in-memory checks on already-fetched accounts.
 * For database queries, use activeAccountFragment() instead.
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
 * Count active (non-gated) buyer accounts for a shop.
 *
 * This is the single source of truth for account counts used by:
 * - checkCompanyLimit() for enforcement decisions
 * - getUsageStats() for UI display
 * - decideNewAccountGate() inside transactions
 *
 * Note: Currently counts all rows with gated_at IS NULL. The Team Lead ruling
 * says to exclude rows with deleted-location or removed-tag markers, but there's
 * no such marker on BuyerAccount for deleted company locations. Implementing this
 * would require a migration to add a deleted_at column or similar. Per the ruling,
 * we count all rows and this is noted for a backlog issue.
 *
 * @param sql - postgres.js SQL client (or transaction)
 * @param shopId - Internal shop ID
 * @returns Count of active (non-gated) accounts
 */
export async function countActiveAccounts(
  sql: Sql,
  shopId: string
): Promise<number> {
  const [result] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND gated_at IS NULL
  `;
  return parseInt(result?.count ?? "0", 10);
}

/**
 * Result of the gating decision for a new account.
 */
export interface GateDecision {
  gate: boolean;
  used: number;
  limit: number;
}

/**
 * Decide whether a new account should be gated.
 *
 * MUST be called inside a sql.begin() transaction. When gating is enforced
 * and limit != -1, takes pg_advisory_xact_lock to prevent concurrent creates
 * from overshooting the limit.
 *
 * Lock key: hashtextextended('ba_limit:' || shopId, 0)
 *
 * The lock is per-shop and held only for the transaction duration. It's only
 * taken when PLAN_GATING_ENFORCED is on AND limit != -1, so there's no cost
 * while the flag is false or for unlimited plans.
 *
 * @param tx - postgres.js transaction (from sql.begin)
 * @param shopId - Internal shop ID
 * @returns GateDecision with gate flag and usage info
 */
export async function decideNewAccountGate(
  tx: Sql,
  shopId: string
): Promise<GateDecision> {
  if (!isGatingEnforced()) {
    return { gate: false, used: 0, limit: -1 };
  }

  const plan = await getPlanByShopId(tx, shopId);
  const limit = planLimit(plan, "companies");

  if (limit === -1) {
    return { gate: false, used: 0, limit: -1 };
  }

  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ba_limit:' + shopId}, 0))`;

  const used = await countActiveAccounts(tx, shopId);

  const gate = used >= limit;

  return { gate, used, limit };
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
 * NOTE: This does NOT take the lock. For actual inserts, use decideNewAccountGate()
 * inside a transaction. This function is for pre-checks and UI display.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @returns GatingCheckResult with allowed status and usage info
 */
export async function checkCompanyLimit(
  sql: Sql,
  shopId: string
): Promise<GatingCheckResult> {
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

  if (limit === -1) {
    return {
      allowed: true,
      currentUsage: 0,
      limit: -1,
    };
  }

  const currentCount = await countActiveAccounts(sql, shopId);

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
 * Get usage statistics for a shop's plan.
 * Useful for UI display of current usage.
 *
 * When PLAN_GATING_ENFORCED is ON, excludes gated accounts from the company count.
 * This reflects the "active" usage that counts toward the plan limit.
 *
 * Note: importsThisMonth is always unlimited (-1) because imports are not gated.
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

  const companyCount = isGatingEnforced()
    ? await countActiveAccounts(sql, shopId)
    : parseInt(
        (
          await sql<{ count: string }[]>`
          SELECT COUNT(*)::text as count
          FROM "BuyerAccount"
          WHERE "shopId" = ${shopId}
        `
        )[0]?.count ?? "0",
        10
      );

  return {
    companies: {
      current: companyCount,
      limit: planLimit(plan, "companies"),
    },
    importsThisMonth: {
      current: 0,
      limit: -1,
    },
  };
}

/**
 * Reactivate gated accounts up to the new plan limit.
 * Reactivates oldest accounts first (by createdAt).
 *
 * Uses the same pg_advisory_xact_lock as decideNewAccountGate() to prevent
 * race conditions between reactivation and concurrent creates.
 *
 * Called on plan upgrade via APP_SUBSCRIPTIONS_UPDATE webhook.
 * The caller (T2) is responsible for determining when to call this.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @returns Number of accounts reactivated
 */
export async function reactivateGatedAccounts(
  sql: Sql,
  shopId: string
): Promise<number> {
  const plan = await getPlanByShopId(sql, shopId);
  const newLimit = planLimit(plan, "companies");

  if (newLimit === -1) {
    const result = await sql`
      UPDATE "BuyerAccount"
      SET gated_at = NULL, "updatedAt" = NOW()
      WHERE "shopId" = ${shopId}
        AND gated_at IS NOT NULL
    `;
    return result.count;
  }

  return await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ba_limit:' + shopId}, 0))`;

    const activeCount = await countActiveAccounts(tx, shopId);

    const canActivate = Math.max(0, newLimit - activeCount);

    if (canActivate === 0) {
      return 0;
    }

    const result = await tx`
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
  });
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
