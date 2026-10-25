/**
 * Upgrade prompt component (S21).
 *
 * Shows contextual upgrade prompts in relevant UI spots.
 * When PLAN_GATING_ENFORCED is off, prompts are informational only.
 * When PLAN_GATING_ENFORCED is on, prompts indicate actual limitations.
 */

import {
  type PlanKey,
  type FeatureKey,
  ALL_PLAN_KEYS,
  getPlanConfig,
  planHasFeature,
} from "~/lib/entitlements";

/**
 * Display names for plans. Single source of truth for UI.
 */
export const PLAN_DISPLAY_NAMES: Record<PlanKey, string> = {
  none: "No Plan",
  starter: "Starter",
  growth: "Growth",
  unlimited: "Unlimited",
};

/**
 * Display names for features. Single source of truth for UI.
 * HIDDEN (issue #286): pdf_statements, payer_memory, audit_export removed.
 */
export const FEATURE_DISPLAY_NAMES: Record<FeatureKey, string> = {
  aging_dashboard: "Aging Dashboard",
  unlimited_imports: "Unlimited Bank Imports",
  matching: "Payment Matching",
  reminders: "Payment Reminders",
  credit_holds: "Credit Holds",
};

/**
 * Get the minimum plan required for a feature.
 * Derived from entitlements.ts using ALL_PLAN_KEYS + getPlanConfig + planHasFeature.
 */
export function getRequiredPlanForFeature(feature: FeatureKey): PlanKey {
  for (const planKey of ALL_PLAN_KEYS) {
    const plan = getPlanConfig(planKey);
    if (planHasFeature(plan, feature)) {
      return planKey;
    }
  }
  return "unlimited";
}

interface UpgradePromptProps {
  currentPlan: PlanKey;
  feature?: FeatureKey;
  limitType?: "companies" | "imports";
  gatingEnforced: boolean;
  upgradeUrl: string;
  compact?: boolean;
}

export function UpgradePrompt({
  currentPlan,
  feature,
  limitType,
  gatingEnforced,
  upgradeUrl,
  compact = false,
}: UpgradePromptProps) {
  const requiredPlan = feature ? getRequiredPlanForFeature(feature) : null;
  const currentIndex = ALL_PLAN_KEYS.indexOf(currentPlan);
  const requiredIndex = requiredPlan ? ALL_PLAN_KEYS.indexOf(requiredPlan) : -1;

  const needsUpgrade = requiredPlan && requiredIndex > currentIndex;
  const suggestedPlan = needsUpgrade ? requiredPlan : null;

  if (compact) {
    // Don't show limit-based prompts when gating is off
    if (limitType) {
      if (!gatingEnforced) {
        return null;
      }
      return (
        <s-stack direction="inline">
          <s-text tone="critical">
            {limitType === "companies" ? "Company" : "Import"} limit reached
          </s-text>
          <s-link href={upgradeUrl} target="_top">
            Upgrade
          </s-link>
        </s-stack>
      );
    }

    if (suggestedPlan) {
      return (
        <s-stack direction="inline">
          <s-text>
            {gatingEnforced ? "Requires" : "Available on"} {PLAN_DISPLAY_NAMES[suggestedPlan]}+
          </s-text>
          <s-link href={upgradeUrl} target="_top">
            Upgrade
          </s-link>
        </s-stack>
      );
    }

    return null;
  }

  if (limitType) {
    // Don't show limit-based prompts when gating is off
    if (!gatingEnforced) {
      return null;
    }

    const limitLabel = limitType === "companies" ? "buyer accounts" : "bank imports";

    return (
      <s-banner tone="warning" heading={`${limitType === "companies" ? "Company" : "Import"} Limit Reached`}>
        <s-stack>
          <s-text>
            You&apos;ve reached your plan limit for {limitLabel}. Upgrade to add more.
          </s-text>
          <s-button href={upgradeUrl} target="_top">
            Upgrade Plan
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  if (suggestedPlan) {
    const featureLabel = feature ? FEATURE_DISPLAY_NAMES[feature] : "this feature";

    if (gatingEnforced) {
      return (
        <s-banner tone="warning" heading="Feature Unavailable">
          <s-stack>
            <s-text>
              {featureLabel} requires the {PLAN_DISPLAY_NAMES[suggestedPlan]} plan or higher.
            </s-text>
            <s-button href={upgradeUrl} target="_top">
              Upgrade to {PLAN_DISPLAY_NAMES[suggestedPlan]}
            </s-button>
          </s-stack>
        </s-banner>
      );
    }

    return (
      <s-banner tone="info" heading="Premium Feature">
        <s-stack>
          <s-text>
            {featureLabel} is included in the {PLAN_DISPLAY_NAMES[suggestedPlan]} plan.
            Currently available to all users while plan gating is not enforced.
          </s-text>
          <s-button href={upgradeUrl} target="_top" variant="secondary">
            View Plans
          </s-button>
        </s-stack>
      </s-banner>
    );
  }

  return null;
}

interface PlanBannerProps {
  planKey: PlanKey;
  planName: string;
  isTest: boolean;
  companiesUsed: number;
  companiesLimit: number;
  gatingEnforced: boolean;
  upgradeUrl: string | null;
}

export function PlanBanner({
  planKey,
  planName,
  isTest,
  companiesUsed,
  companiesLimit,
  gatingEnforced,
  upgradeUrl,
}: PlanBannerProps) {
  const displayPlanName = PLAN_DISPLAY_NAMES[planKey] || planName;
  // Plan-limit check only applies when gating is enforced
  // With none=0, every shop would show "at limit" if we didn't gate this
  const companiesAtLimit = gatingEnforced && companiesLimit !== -1 && companiesUsed >= companiesLimit;
  const canUpgrade = planKey !== "unlimited";

  // When gating is off, just show the count without limit comparison
  // This avoids showing confusing 'N / 0' for no-plan shops
  const companiesText = gatingEnforced
    ? companiesLimit === -1
      ? `${companiesUsed} buyer accounts`
      : `${companiesUsed} / ${companiesLimit} buyer accounts`
    : `${companiesUsed} buyer accounts`;

  // 'Upgrade to Add More' only shows when at limit (which already includes gatingEnforced check)
  const showUpgradeCta = companiesAtLimit;

  return (
    <s-stack>
      <s-paragraph>
        <s-text type="strong">Plan: </s-text>
        <s-text>
          {displayPlanName}
          {isTest && " (Test)"}
        </s-text>
      </s-paragraph>
      <s-paragraph>
        <s-text type="strong">Usage: </s-text>
        <s-text>{companiesText}</s-text>
        {companiesAtLimit && (
          <s-badge tone="critical">Limit Reached</s-badge>
        )}
      </s-paragraph>
      {canUpgrade && upgradeUrl && (
        <s-button href={upgradeUrl} target="_top" variant={showUpgradeCta ? "primary" : "secondary"}>
          {showUpgradeCta ? "Upgrade to Add More" : "View Plans"}
        </s-button>
      )}
    </s-stack>
  );
}
