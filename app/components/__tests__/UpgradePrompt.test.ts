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
    currentPlan: "none" as const,
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
      expect(html).toContain("10 companies");
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
      expect(html).toContain("5 companies");
      expect(html).not.toContain("/ 0");
      expect(html).not.toContain("Limit Reached");
    });
  });

  describe("gating ON", () => {
    it("shows count with limit when gating is ON", () => {
      const html = renderToString(
        createElement(PlanBanner, { ...baseProps, gatingEnforced: true })
      );
      expect(html).toContain("10 / 25 companies");
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
    expect(html).toContain("100 companies");
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

  it("includes target _top for parent frame navigation", () => {
    const html = renderToString(createElement(PlanBanner, baseProps));
    expect(html).toContain('target="_top"');
  });
});
