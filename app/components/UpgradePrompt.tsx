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
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
};

/**
 * Display names for features. Single source of truth for UI.
 */
export const FEATURE_DISPLAY_NAMES: Record<FeatureKey, string> = {
  aging_dashboard: "Aging Dashboard",
  unlimited_imports: "Unlimited Bank Imports",
  matching: "Payment Matching",
  reminders: "Payment Reminders",
  credit_holds: "Credit Holds",
  pdf_statements: "PDF Statements",
  payer_memory: "Payer Memory",
  audit_export: "Audit Export",
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
  return "scale";
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
    if (limitType) {
      return (
        <s-stack direction="inline">
          <s-text tone={gatingEnforced ? "critical" : "warning"}>
            {gatingEnforced
              ? `${limitType === "companies" ? "Company" : "Import"} limit reached`
              : `At ${limitType === "companies" ? "company" : "import"} limit`}
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
    const limitLabel = limitType === "companies" ? "buyer accounts" : "bank imports";

    if (gatingEnforced) {
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

    return (
      <s-banner tone="info" heading="Plan Limit Note">
        <s-stack>
          <s-text>
            You&apos;ve reached the {limitLabel} limit for your plan tier, but limits
            are not currently enforced.
          </s-text>
          <s-button href={upgradeUrl} target="_top" variant="secondary">
            View Plans
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
  upgradeUrl: string;
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
  const companiesAtLimit = companiesLimit !== -1 && companiesUsed >= companiesLimit;
  const canUpgrade = planKey !== "scale";

  const companiesText =
    companiesLimit === -1
      ? `${companiesUsed} companies`
      : `${companiesUsed} / ${companiesLimit} companies`;

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
        {companiesAtLimit && gatingEnforced && (
          <s-badge tone="critical">Limit Reached</s-badge>
        )}
        {companiesAtLimit && !gatingEnforced && (
          <s-badge tone="warning">At Limit</s-badge>
        )}
      </s-paragraph>
      {canUpgrade && (
        <s-button href={upgradeUrl} target="_top" variant={companiesAtLimit ? "primary" : "secondary"}>
          {companiesAtLimit ? "Upgrade to Add More" : "View Plans"}
        </s-button>
      )}
    </s-stack>
  );
}
