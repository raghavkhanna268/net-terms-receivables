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
    it("renders nothing when gating is OFF (T1: no limit prompts when gating off)", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: false,
        })
      );
      expect(html).toBe("");
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
      expect(html).toContain("Company");
      expect(html).toContain("limit reached");
    });

    it("renders nothing when gating is OFF (T1: no At company limit when gating off)", () => {
      const html = renderToString(
        createElement(UpgradePrompt, {
          ...baseProps,
          limitType: "companies",
          gatingEnforced: false,
          compact: true,
        })
      );
      expect(html).toBe("");
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

  describe("gating OFF (T1)", () => {
    it("shows count without limit when gating is OFF", () => {
      const html = renderToString(createElement(PlanBanner, baseProps));
      expect(html).toContain("10 buyer accounts");
      expect(html).not.toContain("/ 25");
    });

    it("shows View Plans button when at limit with gating OFF", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          ...baseProps,
          companiesUsed: 25,
          companiesLimit: 25,
          gatingEnforced: false,
        })
      );
      expect(html).toContain('variant="secondary"');
      expect(html).toContain("View Plans");
      expect(html).not.toContain("Upgrade to Add More");
    });

    it("shows no badge when at limit but gating not enforced", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          ...baseProps,
          companiesUsed: 25,
          companiesLimit: 25,
          gatingEnforced: false,
        })
      );
      expect(html).not.toContain("At Limit");
      expect(html).not.toContain("Limit Reached");
    });

    it("no-plan shop (limit 0) shows just count, no / 0", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          ...baseProps,
          planKey: "none",
          companiesUsed: 5,
          companiesLimit: 0,
          gatingEnforced: false,
        })
      );
      expect(html).toContain("5 buyer accounts");
      expect(html).not.toContain("/ 0");
      expect(html).not.toContain("Limit Reached");
    });
  });

  describe("gating ON", () => {
    it("shows count with limit when gating is ON", () => {
      const html = renderToString(
        createElement(PlanBanner, { ...baseProps, gatingEnforced: true })
      );
      expect(html).toContain("10 / 25 buyer accounts");
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

    it("shows primary Upgrade to Add More button when at limit with gating ON", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          ...baseProps,
          companiesUsed: 25,
          companiesLimit: 25,
          gatingEnforced: true,
        })
      );
      expect(html).toContain('variant="primary"');
      expect(html).toContain("Upgrade to Add More");
    });
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
    expect(html).toContain("100 buyer accounts");
  });

  it("shows test badge when isTest is true", () => {
    const html = renderToString(
      createElement(PlanBanner, { ...baseProps, isTest: true })
    );
    expect(html).toContain("(Test)");
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

  it("renders no CTA button when upgradeUrl is null", () => {
    const html = renderToString(
      createElement(PlanBanner, {
        ...baseProps,
        upgradeUrl: null,
      })
    );
    expect(html).not.toContain("<s-button");
    expect(html).not.toContain("View Plans");
    expect(html).not.toContain("Upgrade");
  });

  it("includes target _top for parent frame navigation", () => {
    const html = renderToString(createElement(PlanBanner, baseProps));
    expect(html).toContain('target="_top"');
  });

  describe("gating OFF: no plan-limit UI for EVERY plan over limit", () => {
    const planConfigs = [
      { planKey: "none" as const, companiesLimit: 0, companiesUsed: 3 },
      { planKey: "starter" as const, companiesLimit: 25, companiesUsed: 30 },
      { planKey: "growth" as const, companiesLimit: 100, companiesUsed: 150 },
      { planKey: "unlimited" as const, companiesLimit: -1, companiesUsed: 500 },
    ];

    for (const config of planConfigs) {
      it(`${config.planKey} plan over limit with gating OFF: no badge, no banner, no Upgrade CTA`, () => {
        const html = renderToString(
          createElement(PlanBanner, {
            ...baseProps,
            planKey: config.planKey,
            planName: config.planKey.charAt(0).toUpperCase() + config.planKey.slice(1),
            companiesLimit: config.companiesLimit,
            companiesUsed: config.companiesUsed,
            gatingEnforced: false,
          })
        );
        expect(html).not.toContain("Limit Reached");
        expect(html).not.toContain("At Limit");
        expect(html).not.toContain("Upgrade to Add More");
        // Should still show the plan name and usage count
        expect(html).toContain(`${config.companiesUsed} buyer accounts`);
      });
    }
  });

  describe("gating ON: none plan shows limit UI", () => {
    it("none plan with 1 account, gating ON shows Limit Reached badge", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          ...baseProps,
          planKey: "none",
          planName: "No Plan",
          companiesUsed: 1,
          companiesLimit: 0,
          gatingEnforced: true,
        })
      );
      expect(html).toContain("1 / 0 buyer accounts");
      expect(html).toContain('tone="critical"');
      expect(html).toContain("Limit Reached");
      expect(html).toContain("Upgrade to Add More");
    });
  });

  describe("T1: none plan with gating OFF displays correctly", () => {
    it("shows 'No Plan', no 'Free', no '/ 3', no badges or limit UI", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "none",
          planName: "No Plan",
          isTest: false,
          companiesUsed: 5,
          companiesLimit: 0,
          gatingEnforced: false,
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        })
      );
      // Shows No Plan as plan name
      expect(html).toContain("No Plan");
      // No 'Free' anywhere
      expect(html).not.toContain("Free");
      // No '/ 3' limit display (old limit)
      expect(html).not.toContain("/ 3");
      // No '/ 0' limit display (limit 0 not shown when gating off)
      expect(html).not.toContain("/ 0");
      // No over-limit badges
      expect(html).not.toContain("Limit Reached");
      expect(html).not.toContain("At Limit");
      // No upgrade CTA for limit
      expect(html).not.toContain("Upgrade to Add More");
      // Shows usage count
      expect(html).toContain("5 buyer accounts");
    });

    it("starter plan with gating OFF shows correct limit in text when gating is ON", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "starter",
          planName: "Starter",
          isTest: false,
          companiesUsed: 10,
          companiesLimit: 25,
          gatingEnforced: true,
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        })
      );
      // Shows / 25 limit
      expect(html).toContain("/ 25");
      // No '/ 3' (old free limit)
      expect(html).not.toContain("/ 3");
    });
  });
});
