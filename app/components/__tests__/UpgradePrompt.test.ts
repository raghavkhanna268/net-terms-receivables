import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { UpgradePrompt, PlanBanner, PLAN_DISPLAY_NAMES } from "../UpgradePrompt";
import { ALL_PLAN_KEYS } from "~/lib/entitlements";

/**
 * Tests for UpgradePrompt component (S21).
 *
 * These tests render the actual components and verify:
 * 1. Gating flag OFF: prompts return null (no limit prompts when gating off)
 * 2. Gating flag ON: prompts use "warning" tone and "Upgrade" button
 * 3. Display names are exported and used correctly
 */

describe("PLAN_DISPLAY_NAMES", () => {
  it("has display name for all plan keys", () => {
    for (const planKey of ALL_PLAN_KEYS) {
      expect(PLAN_DISPLAY_NAMES[planKey]).toBeDefined();
      expect(PLAN_DISPLAY_NAMES[planKey].length).toBeGreaterThan(0);
    }
  });
});

describe("UpgradePrompt component", () => {
  const baseProps = {
    upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
  };

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
    it("hides 'Plan: No Plan' label when gating is OFF", () => {
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
      // Does NOT show 'Plan: No Plan' when gating is off
      expect(html).not.toContain("Plan:");
      expect(html).not.toContain("No Plan");
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
      // View Plans link is still present
      expect(html).toContain("View Plans");
    });

    it("shows 'Plan: No Plan' label when gating is ON (true)", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "none",
          planName: "No Plan",
          isTest: false,
          companiesUsed: 5,
          companiesLimit: 0,
          gatingEnforced: true,
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        })
      );
      // Shows 'Plan: No Plan' when gating is ON
      expect(html).toContain("Plan:");
      expect(html).toContain("No Plan");
      // Upgrade CTA is present (shows "Upgrade to Add More" when at limit with gating ON)
      expect(html).toContain("Upgrade to Add More");
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

  describe("Plan label visibility based on gatingEnforced", () => {
    it("shows plan label for non-none plans even when gating is OFF", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "starter",
          planName: "Starter",
          isTest: false,
          companiesUsed: 10,
          companiesLimit: 25,
          gatingEnforced: false,
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        })
      );
      expect(html).toContain("Plan:");
      expect(html).toContain("Starter");
    });

    it("shows plan label for growth plan with gating OFF", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "growth",
          planName: "Growth",
          isTest: false,
          companiesUsed: 50,
          companiesLimit: 100,
          gatingEnforced: false,
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        })
      );
      expect(html).toContain("Plan:");
      expect(html).toContain("Growth");
    });

    it("shows plan label for unlimited plan with gating OFF", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "unlimited",
          planName: "Unlimited",
          isTest: false,
          companiesUsed: 500,
          companiesLimit: -1,
          gatingEnforced: false,
          upgradeUrl: null,
        })
      );
      expect(html).toContain("Plan:");
      expect(html).toContain("Unlimited");
    });

    it("View Plans link is present for none plan with gating OFF", () => {
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
      // Plan label is hidden but View Plans is still present
      expect(html).not.toContain("Plan:");
      expect(html).toContain("View Plans");
    });

    it("Upgrade CTA is present for none plan with gating ON (at limit shows Upgrade to Add More)", () => {
      const html = renderToString(
        createElement(PlanBanner, {
          planKey: "none",
          planName: "No Plan",
          isTest: false,
          companiesUsed: 5,
          companiesLimit: 0,
          gatingEnforced: true,
          upgradeUrl: "https://admin.shopify.com/store/test/charges/app/pricing_plans",
        })
      );
      // Plan label is shown and Upgrade CTA is present
      expect(html).toContain("Plan:");
      expect(html).toContain("No Plan");
      // When gating is ON and at/over limit, shows "Upgrade to Add More"
      expect(html).toContain("Upgrade to Add More");
    });

    it("View Plans link is present for starter plan with gating ON (not at limit)", () => {
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
      // Plan label is shown
      expect(html).toContain("Plan:");
      expect(html).toContain("Starter");
      // When gating is ON but NOT at limit, shows "View Plans"
      expect(html).toContain("View Plans");
      // Should not show "Upgrade to Add More" when not at limit
      expect(html).not.toContain("Upgrade to Add More");
    });
  });
});
