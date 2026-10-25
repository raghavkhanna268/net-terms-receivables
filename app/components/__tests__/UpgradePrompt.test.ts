import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import {
  UpgradePrompt,
  PlanBanner,
  PLAN_DISPLAY_NAMES,
  FEATURE_DISPLAY_NAMES,
  getRequiredPlanForFeature,
} from "../UpgradePrompt";
import { ALL_PLAN_KEYS, ALL_FEATURE_KEYS } from "~/lib/entitlements";

/**
 * Tests for UpgradePrompt component (S21).
 *
 * These tests render the actual components and verify:
 * 1. Gating flag OFF: prompts use "info" tone and "View Plans" button
 * 2. Gating flag ON: prompts use "warning" tone and "Upgrade" button
 * 3. Feature-to-plan mapping is derived from entitlements.ts
 * 4. Display names are exported and used correctly
 */

describe("getRequiredPlanForFeature", () => {
  it("derives required plan from entitlements.ts (all features on all plans)", () => {
    // All features are now available on every plan, so they return 'none'
    // HIDDEN (issue #286): pdf_statements, payer_memory, audit_export removed
    expect(getRequiredPlanForFeature("aging_dashboard")).toBe("none");
    expect(getRequiredPlanForFeature("matching")).toBe("none");
    expect(getRequiredPlanForFeature("reminders")).toBe("none");
    expect(getRequiredPlanForFeature("credit_holds")).toBe("none");
  });

  it("returns valid plan for all features", () => {
    for (const feature of ALL_FEATURE_KEYS) {
      const plan = getRequiredPlanForFeature(feature);
      expect(ALL_PLAN_KEYS).toContain(plan);
    }
  });

  it("credit_holds is available on none plan (all-plans feature)", () => {
    // credit_holds must never be shown as requiring an upgrade
    expect(getRequiredPlanForFeature("credit_holds")).toBe("none");
  });
});

describe("PLAN_DISPLAY_NAMES", () => {
  it("has display name for all plan keys", () => {
    for (const planKey of ALL_PLAN_KEYS) {
      expect(PLAN_DISPLAY_NAMES[planKey]).toBeDefined();
      expect(PLAN_DISPLAY_NAMES[planKey].length).toBeGreaterThan(0);
    }
  });
});

describe("FEATURE_DISPLAY_NAMES", () => {
  it("has display name for all feature keys", () => {
    for (const feature of ALL_FEATURE_KEYS) {
      expect(FEATURE_DISPLAY_NAMES[feature]).toBeDefined();
      expect(FEATURE_DISPLAY_NAMES[feature].length).toBeGreaterThan(0);
    }
  });
});

describe("UpgradePrompt component", () => {
  const baseProps = {
    currentPlan: "none" as const,
    upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
  };

  describe("feature-based prompts", () => {
    it("renders nothing for aging_dashboard (all features on all plans)", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          feature: "aging_dashboard",
          gatingEnforced: false,
        })
      );
      expect(html).toBe("");
    });

    it("renders nothing for matching (all features on all plans)", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          feature: "matching",
          gatingEnforced: false,
        })
      );
      expect(html).toBe("");
    });

    it("renders nothing for reminders (all features on all plans)", () => {
      // All features are now available on every plan, including none
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          feature: "reminders",
          gatingEnforced: false,
        })
      );
      expect(html).toBe("");
    });

    it("renders nothing for reminders even with gating ON (all features on all plans)", () => {
      // All features are now available on every plan
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          feature: "reminders",
          gatingEnforced: true,
        })
      );
      expect(html).toBe("");
    });
  });

  describe("limit-based prompts", () => {
    it("renders info banner when gating is OFF and at limit", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: false,
        })
      );
      expect(html).toContain('tone="info"');
      expect(html).toContain("Plan Limit Note");
      expect(html).toContain("View Plans");
    });

    it("renders warning banner when gating is ON and at limit", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: true,
        })
      );
      expect(html).toContain('tone="warning"');
      expect(html).toContain("Company Limit Reached");
      expect(html).toContain("Upgrade Plan");
    });
  });

  describe("compact mode", () => {
    it("renders inline with critical tone when gating is ON", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: true,
          compact: true,
        })
      );
      expect(html).toContain('direction="inline"');
      expect(html).toContain('tone="critical"');
      expect(html).toContain("Company limit reached");
    });

    it("renders inline with warning tone when gating is OFF", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: false,
          compact: true,
        })
      );
      expect(html).toContain('direction="inline"');
      expect(html).toContain('tone="warning"');
      expect(html).toContain("At company limit");
    });
  });

  describe("upgrade URL", () => {
    it("includes target _top for parent frame navigation (limit-based)", () => {
      // Use limit-based prompt since feature-based prompts render nothing
      // when all features are on all plans
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: true,
        })
      );
      expect(html).toContain('target="_top"');
      expect(html).toContain(baseProps.upgradeUrl);
    });
  });
});

describe("PlanBanner component", () => {
  const baseProps = {
    planKey: "starter" as const,
    planName: "Starter",
    isTest: false,
    companiesUsed: 10,
    companiesLimit: 25,
    gatingEnforced: false,
    upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
  };

  it("renders plan name from PLAN_DISPLAY_NAMES", () => {
    const html = renderToString(createElement(PlanBanner, baseProps));
    expect(html).toContain("Starter");
  });

  it("renders usage count", () => {
    const html = renderToString(createElement(PlanBanner, baseProps));
    expect(html).toContain("10 / 25 companies");
  });

  it("renders unlimited usage correctly", () => {
    const html = renderToString(
      createElement(PlanBanner, {
        ...baseProps,
        planKey: "unlimited",
        companiesLimit: -1,
        companiesUsed: 100,
      })
    );
    expect(html).toContain("100 companies");
  });

  it("shows test badge when isTest is true", () => {
    const html = renderToString(
      createElement(PlanBanner, { ...baseProps, isTest: true })
    );
    expect(html).toContain("(Test)");
  });

  it("shows critical badge when at limit and gating enforced", () => {
    const html = renderToString(
      createElement(PlanBanner, {
        ...baseProps,
        companiesUsed: 25,
        companiesLimit: 25,
        gatingEnforced: true,
      })
    );
    expect(html).toContain('tone="critical"');
    expect(html).toContain("Limit Reached");
  });

  it("shows no badge when at limit but gating not enforced (T1)", () => {
    const html = renderToString(
      createElement(PlanBanner, {
        ...baseProps,
        companiesUsed: 25,
        companiesLimit: 25,
        gatingEnforced: false,
      })
    );
    // No badge shown when gating is off
    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Limit Reached");
  });

  it("shows primary upgrade button when at limit", () => {
    const html = renderToString(
      createElement(PlanBanner, {
        ...baseProps,
        companiesUsed: 25,
        companiesLimit: 25,
      })
    );
    expect(html).toContain('variant="primary"');
    expect(html).toContain("Upgrade to Add More");
  });

  it("shows secondary view plans button when not at limit", () => {
    const html = renderToString(createElement(PlanBanner, baseProps));
    expect(html).toContain('variant="secondary"');
    expect(html).toContain("View Plans");
  });

  it("hides upgrade button for unlimited plan", () => {
    const html = renderToString(
      createElement(PlanBanner, {
        ...baseProps,
        planKey: "unlimited",
        companiesLimit: -1,
      })
    );
    expect(html).not.toContain("Upgrade");
    expect(html).not.toContain("View Plans");
  });

  it("includes target _top for parent frame navigation", () => {
    const html = renderToString(createElement(PlanBanner, baseProps));
    expect(html).toContain('target="_top"');
  });
});
