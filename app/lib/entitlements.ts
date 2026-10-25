/**
 * Entitlements configuration for plan tiers (S21).
 *
 * Pricing approved 2026-10-25:
 * - Starter: $9/mo, 25 buyer accounts, standard support
 * - Growth: $19/mo, 100 buyer accounts, standard support
 * - Unlimited: $29/mo, no limit, priority support
 *
 * There is no free plan. Every feature is on every plan.
 *
 * Plans are configured in the Shopify Partner Dashboard.
 * This module maps subscription handles/names to feature limits.
 *
 * Key design decisions:
 * - fail-to-none: Any error or unknown plan defaults to 'none'
 * - case-insensitive: Plan handles/names matched case-insensitively
 * - limits.companies: How many BuyerAccounts a shop can create
 * - limits.importsPerMonth: Bank statement imports (-1 = unlimited on all plans)
 * - features: Boolean feature flags - all true on every plan (T5 removes these later)
 */

/**
 * Plan keys.
 * - none: No active subscription (limit 0 for new accounts)
 * - starter: 25 buyer accounts
 * - growth: 100 buyer accounts
 * - unlimited: No limit
 */
export type PlanKey = "none" | "starter" | "growth" | "unlimited";

/**
 * Support tier for each plan.
 */
export type SupportTier = "standard" | "priority";

/**
 * Feature keys for capability gating.
 * NOTE: All features are true on every plan. These fields are kept for
 * compatibility and will be removed by T5.
 *
 * credit_holds is an all-plans feature: holds, recompute, sweep, and the
 * Validation Function run on every plan. It must never be gated.
 *
 * HIDDEN (issue #286, App Store rule 1.1.4): pdf_statements, payer_memory,
 * audit_export are not built and must not be listed. T5 removes them fully.
 */
export type FeatureKey =
  | "aging_dashboard"
  | "unlimited_imports"
  | "matching"
  | "reminders"
  | "credit_holds";

/**
 * Limit keys for numeric constraints.
 */
export type LimitKey = "companies" | "importsPerMonth";

/**
 * Plan configuration structure.
 */
export interface PlanConfig {
  key: PlanKey;
  limits: {
    companies: number; // -1 means unlimited
    importsPerMonth: number; // -1 means unlimited
  };
  features: Set<FeatureKey>;
  supportTier: SupportTier;
}

/**
 * All features - every feature is enabled on every plan.
 * HIDDEN (issue #286): pdf_statements, payer_memory, audit_export removed.
 */
const ALL_FEATURES = new Set<FeatureKey>([
  "aging_dashboard",
  "unlimited_imports",
  "matching",
  "reminders",
  "credit_holds",
]);

/**
 * Plan configurations.
 * Account limits: none=0, starter=25, growth=100, unlimited=-1.
 * All features are enabled on every plan (including none).
 * Imports are unlimited (-1) on every plan.
 */
const PLAN_CONFIGS: Record<PlanKey, PlanConfig> = {
  none: {
    key: "none",
    limits: {
      companies: 0,
      importsPerMonth: -1,
    },
    features: new Set(ALL_FEATURES),
    supportTier: "standard",
  },
  starter: {
    key: "starter",
    limits: {
      companies: 25,
      importsPerMonth: -1,
    },
    features: new Set(ALL_FEATURES),
    supportTier: "standard",
  },
  growth: {
    key: "growth",
    limits: {
      companies: 100,
      importsPerMonth: -1,
    },
    features: new Set(ALL_FEATURES),
    supportTier: "standard",
  },
  unlimited: {
    key: "unlimited",
    limits: {
      companies: -1,
      importsPerMonth: -1,
    },
    features: new Set(ALL_FEATURES),
    supportTier: "priority",
  },
};

/**
 * Resolve a plan key from Partner API handle or subscription display name.
 *
 * Resolution order:
 * 1. Match Partner plan_handle (case-insensitive, trimmed)
 * 2. Fall back to subscription/plan display name (case-insensitive)
 * 3. Legacy cached values: 'free' → none, 'scale' → unlimited
 * 4. Unknown/empty/null → none
 *
 * Expected handles: 'starter', 'growth', 'unlimited'
 * (confirmed in Partner Dashboard 2026-10-25)
 *
 * @param handleOrName - The plan_handle from Partner API or subscription display name
 * @returns The resolved plan key
 */
export function resolvePlanKey(
  handleOrName: string | null | undefined
): PlanKey {
  if (!handleOrName) return "none";

  const normalized = handleOrName.toLowerCase().trim();
  if (!normalized) return "none";

  // Match plan handles (confirmed in Partner Dashboard 2026-10-25)
  if (normalized === "starter") return "starter";
  if (normalized === "growth") return "growth";
  if (normalized === "unlimited") return "unlimited";

  // Legacy cached values from old plan_key column
  if (normalized === "free") return "none";
  if (normalized === "scale") return "unlimited";

  // Match by display name fallback (case-insensitive)
  // Display names are expected to be "Starter", "Growth", "Unlimited"
  // Already handled above since they match handles

  // Unknown handle/name defaults to none
  return "none";
}

/**
 * Map subscription name (from Shopify) to plan key.
 * Case-insensitive matching.
 *
 * @deprecated Use resolvePlanKey() instead. This function is kept for
 * compatibility with existing callers and delegates to resolvePlanKey().
 *
 * @param subscriptionName - The subscription name from Shopify
 * @returns The plan key, or null if no match (for backwards compatibility)
 */
export function mapSubscriptionToPlanKey(
  subscriptionName: string | null | undefined
): PlanKey | null {
  if (!subscriptionName) return null;

  const normalized = subscriptionName.toLowerCase().trim();
  if (!normalized) return null;

  // Match against known plan keys and handles
  if (normalized === "starter") return "starter";
  if (normalized === "growth") return "growth";
  if (normalized === "unlimited") return "unlimited";

  // Legacy values
  if (normalized === "free") return "none";
  if (normalized === "scale") return "unlimited";

  // For backwards compatibility, return null for unknown names
  // Callers expecting null should migrate to resolvePlanKey()
  return null;
}

/**
 * Get the configuration for a plan key.
 *
 * Defensive: returns none config for unknown/invalid keys.
 * This handles cases where a raw string from DB is cast to PlanKey.
 * Uses Object.hasOwn to avoid prototype pollution (toString, constructor, __proto__).
 *
 * @param key - The plan key (may be unknown string cast to PlanKey)
 * @returns The plan configuration (none if key is unknown)
 */
export function getPlanConfig(key: PlanKey): PlanConfig {
  // Defensive: use Object.hasOwn to avoid prototype pollution attacks
  // This handles arbitrary strings that were cast to PlanKey
  if (Object.hasOwn(PLAN_CONFIGS, key)) {
    return PLAN_CONFIGS[key];
  }
  return PLAN_CONFIGS.none;
}

/**
 * Get the default (none) plan configuration.
 * Used when no subscription exists or plan resolution fails.
 */
export function getDefaultPlan(): PlanConfig {
  return PLAN_CONFIGS.none;
}

/**
 * Check if a plan has a specific feature.
 * NOTE: All features are true on every plan. This is kept for compatibility.
 *
 * @param plan - The plan configuration
 * @param feature - The feature key to check
 * @returns true if the plan has the feature (always true currently)
 */
export function planHasFeature(plan: PlanConfig, feature: FeatureKey): boolean {
  return plan.features.has(feature);
}

/**
 * Get a numeric limit for a plan.
 * Returns -1 for unlimited.
 *
 * @param plan - The plan configuration
 * @param limitKey - The limit key
 * @returns The limit value (-1 for unlimited)
 */
export function planLimit(plan: PlanConfig, limitKey: LimitKey): number {
  return plan.limits[limitKey];
}

/**
 * Check if a limit is exceeded.
 * Handles unlimited (-1) correctly.
 * Uses >= semantics: at the limit means exceeded (can't add more).
 *
 * @param plan - The plan configuration
 * @param limitKey - The limit key
 * @param currentValue - The current usage count
 * @returns true if the limit is exceeded
 */
export function isLimitExceeded(
  plan: PlanConfig,
  limitKey: LimitKey,
  currentValue: number
): boolean {
  const limit = plan.limits[limitKey];
  if (limit === -1) return false; // unlimited
  return currentValue >= limit;
}

/**
 * Get the support tier for a plan.
 *
 * @param plan - The plan configuration
 * @returns The support tier ('standard' or 'priority')
 */
export function getSupportTier(plan: PlanConfig): SupportTier {
  return plan.supportTier;
}

/**
 * All available feature keys (exported for later steps to call hasFeature).
 * HIDDEN (issue #286): pdf_statements, payer_memory, audit_export removed.
 */
export const ALL_FEATURE_KEYS: readonly FeatureKey[] = [
  "aging_dashboard",
  "unlimited_imports",
  "matching",
  "reminders",
  "credit_holds",
] as const;

/**
 * All available limit keys.
 */
export const ALL_LIMIT_KEYS: readonly LimitKey[] = [
  "companies",
  "importsPerMonth",
] as const;

/**
 * All available plan keys.
 */
export const ALL_PLAN_KEYS: readonly PlanKey[] = [
  "none",
  "starter",
  "growth",
  "unlimited",
] as const;
