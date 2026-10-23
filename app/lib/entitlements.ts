/**
 * Entitlements configuration for plan tiers (S21).
 *
 * IMPORTANT: These limits are the PRICING HYPOTHESIS from the tracker
 * and are NOT final. Raghav decides final tier limits and pricing via
 * the Partner Dashboard (managed App Pricing).
 *
 * Plans are configured in the Shopify Partner Dashboard, not in code.
 * This module maps subscription names to feature limits.
 *
 * Key design decisions:
 * - fail-to-free: Any error or unknown plan defaults to 'free'
 * - case-insensitive: Plan names matched case-insensitively
 * - limits.companies: How many BuyerAccounts a shop can create
 * - limits.importsPerMonth: Bank statement imports per calendar month (IST)
 * - features: Boolean feature flags for capability gating
 */

/**
 * Plan keys. Case-insensitive match against subscription name.
 */
export type PlanKey = "free" | "starter" | "growth" | "scale";

/**
 * Feature keys for capability gating.
 * Some features are not yet implemented (marked with TODO comments).
 */
export type FeatureKey =
  | "aging_dashboard"
  | "unlimited_imports"
  | "matching"
  | "reminders" // TODO: Not implemented yet (S-future)
  | "credit_holds"
  | "pdf_statements" // TODO: Not implemented yet (S-future)
  | "payer_memory" // TODO: Not implemented yet (S-future)
  | "audit_export"; // TODO: Not implemented yet (S-future)

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
}

/**
 * HYPOTHESIS LIMITS - subject to Raghav's pricing decision.
 * See tracker step S21 for context.
 */
const PLAN_CONFIGS: Record<PlanKey, PlanConfig> = {
  free: {
    key: "free",
    limits: {
      companies: 3,
      importsPerMonth: 1,
    },
    features: new Set<FeatureKey>(["aging_dashboard"]),
  },
  starter: {
    key: "starter",
    limits: {
      companies: 25,
      importsPerMonth: -1, // unlimited
    },
    features: new Set<FeatureKey>([
      "aging_dashboard",
      "unlimited_imports",
      "matching",
      "reminders",
    ]),
  },
  growth: {
    key: "growth",
    limits: {
      companies: 100,
      importsPerMonth: -1,
    },
    features: new Set<FeatureKey>([
      "aging_dashboard",
      "unlimited_imports",
      "matching",
      "reminders",
      "credit_holds",
      "pdf_statements",
      "payer_memory",
    ]),
  },
  scale: {
    key: "scale",
    limits: {
      companies: -1, // unlimited
      importsPerMonth: -1,
    },
    features: new Set<FeatureKey>([
      "aging_dashboard",
      "unlimited_imports",
      "matching",
      "reminders",
      "credit_holds",
      "pdf_statements",
      "payer_memory",
      "audit_export",
    ]),
  },
};

/**
 * Map subscription name (from Shopify) to plan key.
 * Case-insensitive matching.
 *
 * @param subscriptionName - The subscription name from Shopify
 * @returns The plan key, or null if no match
 */
export function mapSubscriptionToPlanKey(
  subscriptionName: string | null | undefined
): PlanKey | null {
  if (!subscriptionName) return null;

  const normalized = subscriptionName.toLowerCase().trim();

  // Match against known plan keys
  if (normalized === "free") return "free";
  if (normalized === "starter") return "starter";
  if (normalized === "growth") return "growth";
  if (normalized === "scale") return "scale";

  return null;
}

/**
 * Get the configuration for a plan key.
 *
 * @param key - The plan key
 * @returns The plan configuration
 */
export function getPlanConfig(key: PlanKey): PlanConfig {
  return PLAN_CONFIGS[key];
}

/**
 * Get the default (free) plan configuration.
 */
export function getDefaultPlan(): PlanConfig {
  return PLAN_CONFIGS.free;
}

/**
 * Check if a plan has a specific feature.
 *
 * @param plan - The plan configuration
 * @param feature - The feature key to check
 * @returns true if the plan has the feature
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
 * All available feature keys (exported for later steps to call hasFeature).
 */
export const ALL_FEATURE_KEYS: readonly FeatureKey[] = [
  "aging_dashboard",
  "unlimited_imports",
  "matching",
  "reminders",
  "credit_holds",
  "pdf_statements",
  "payer_memory",
  "audit_export",
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
  "free",
  "starter",
  "growth",
  "scale",
] as const;
