/**
 * Upgrade prompt component (S21).
 *
 * Shows contextual upgrade prompts in relevant UI spots.
 * When PLAN_GATING_ENFORCED is off, prompts are informational only.
 * When PLAN_GATING_ENFORCED is on, prompts indicate actual limitations.
 */

import type { PlanKey } from "~/lib/entitlements";

/**
 * Display names for plans. Single source of truth for UI.
 */
export const PLAN_DISPLAY_NAMES: Record<PlanKey, string> = {
  none: "No Plan",
  starter: "Starter",
  growth: "Growth",
  unlimited: "Unlimited",
};

interface UpgradePromptProps {
  currentPlan: PlanKey;
  limitType?: "companies" | "imports";
  gatingEnforced: boolean;
  upgradeUrl: string;
  compact?: boolean;
}

export function UpgradePrompt({
  limitType,
  gatingEnforced,
  upgradeUrl,
  compact = false,
}: UpgradePromptProps) {
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
  const canUpgrade = planKey !== "unlimited";

  // When gating is off, just show the count without limit comparison
  // This avoids showing confusing 'N / 0' for no-plan shops
  const companiesText = gatingEnforced
    ? companiesLimit === -1
      ? `${companiesUsed} companies`
      : `${companiesUsed} / ${companiesLimit} companies`
    : `${companiesUsed} companies`;

  // When gating is off, always show secondary 'View Plans' button
  // Never show 'Upgrade to Add More' when gating is off
  const showUpgradeCta = gatingEnforced && companiesAtLimit;

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
      </s-paragraph>
      {canUpgrade && (
        <s-button href={upgradeUrl} target="_top" variant={showUpgradeCta ? "primary" : "secondary"}>
          {showUpgradeCta ? "Upgrade to Add More" : "View Plans"}
        </s-button>
      )}
    </s-stack>
  );
}
