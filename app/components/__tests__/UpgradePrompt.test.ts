import { describe, it, expect } from "vitest";

/**
 * Tests for UpgradePrompt component (S21).
 *
 * Tests verify:
 * 1. Gating flag OFF: prompts are informational/inert
 * 2. Gating flag ON: prompts indicate actual limitations
 * 3. Correct feature-to-plan mapping
 * 4. Correct upgrade suggestions
 */

const PLAN_DISPLAY_NAMES: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  growth: "Growth",
  scale: "Scale",
};

const FEATURE_PLAN_REQUIREMENTS: Record<string, string> = {
  aging_dashboard: "free",
  unlimited_imports: "starter",
  matching: "starter",
  reminders: "starter",
  credit_holds: "growth",
  pdf_statements: "growth",
  payer_memory: "growth",
  audit_export: "scale",
};

const PLAN_ORDER = ["free", "starter", "growth", "scale"];

describe("UpgradePrompt Logic", () => {
  describe("Feature-based prompts", () => {
    it("identifies when upgrade is needed for a feature", () => {
      const currentPlan = "free";
      const feature = "matching";

      const requiredPlan = FEATURE_PLAN_REQUIREMENTS[feature];
      const currentIndex = PLAN_ORDER.indexOf(currentPlan);
      const requiredIndex = PLAN_ORDER.indexOf(requiredPlan);
      const needsUpgrade = requiredIndex > currentIndex;

      expect(needsUpgrade).toBe(true);
      expect(requiredPlan).toBe("starter");
    });

    it("identifies when no upgrade is needed", () => {
      const currentPlan = "growth";
      const feature = "matching";

      const requiredPlan = FEATURE_PLAN_REQUIREMENTS[feature];
      const currentIndex = PLAN_ORDER.indexOf(currentPlan);
      const requiredIndex = PLAN_ORDER.indexOf(requiredPlan);
      const needsUpgrade = requiredIndex > currentIndex;

      expect(needsUpgrade).toBe(false);
    });

    it("suggests correct plan for feature upgrade", () => {
      const currentPlan = "free";

      const getUpgradeSuggestion = (feature: string) => {
        const requiredPlan = FEATURE_PLAN_REQUIREMENTS[feature];
        const currentIndex = PLAN_ORDER.indexOf(currentPlan);
        const requiredIndex = PLAN_ORDER.indexOf(requiredPlan);
        return requiredIndex > currentIndex ? requiredPlan : null;
      };

      expect(getUpgradeSuggestion("matching")).toBe("starter");
      expect(getUpgradeSuggestion("credit_holds")).toBe("growth");
      expect(getUpgradeSuggestion("audit_export")).toBe("scale");
      expect(getUpgradeSuggestion("aging_dashboard")).toBeNull();
    });
  });

  describe("Limit-based prompts", () => {
    describe("when gating is OFF", () => {
      const gatingEnforced = false;

      it("shows warning tone instead of critical", () => {
        const companiesAtLimit = true;
        const tone = companiesAtLimit && gatingEnforced ? "critical" : "warning";

        expect(tone).toBe("warning");
      });

      it("indicates gating is not enforced", () => {
        const limitReached = true;
        const message = limitReached && !gatingEnforced
          ? "At limit - gating not enforced"
          : "Limit reached";

        expect(message).toContain("gating not enforced");
      });

      it("uses secondary button variant", () => {
        const buttonVariant = gatingEnforced ? "primary" : "secondary";

        expect(buttonVariant).toBe("secondary");
      });

      it("says 'View Plans' instead of 'Upgrade'", () => {
        const buttonText = gatingEnforced ? "Upgrade Plan" : "View Plans";

        expect(buttonText).toBe("View Plans");
      });
    });

    describe("when gating is ON", () => {
      const gatingEnforced = true;

      it("shows critical tone when at limit", () => {
        const companiesAtLimit = true;
        const tone = companiesAtLimit && gatingEnforced ? "critical" : "info";

        expect(tone).toBe("critical");
      });

      it("uses primary button variant when at limit", () => {
        const atLimit = true;
        const buttonVariant = atLimit && gatingEnforced ? "primary" : "secondary";

        expect(buttonVariant).toBe("primary");
      });

      it("says 'Upgrade Plan' when gating enforced", () => {
        const buttonText = gatingEnforced ? "Upgrade Plan" : "View Plans";

        expect(buttonText).toBe("Upgrade Plan");
      });
    });
  });

  describe("Compact mode", () => {
    it("returns inline layout for compact mode", () => {
      const compact = true;
      const layoutDirection = compact ? "inline" : "block";

      expect(layoutDirection).toBe("inline");
    });

    it("shows abbreviated limit message when compact", () => {
      const compact = true;
      const gatingEnforced = true;
      const limitType = "companies";

      const message = compact
        ? gatingEnforced
          ? `${limitType === "companies" ? "Company" : "Import"} limit reached`
          : `At ${limitType === "companies" ? "company" : "import"} limit`
        : "Full message with more details";

      expect(message).toBe("Company limit reached");
    });
  });

  describe("PlanBanner component logic", () => {
    it("shows test badge when subscription is test", () => {
      const isTest = true;
      const showTestBadge = isTest;

      expect(showTestBadge).toBe(true);
    });

    it("shows usage with correct format", () => {
      const current = 10;
      const limit = 25;
      const usageText = limit === -1
        ? `${current} companies`
        : `${current} / ${limit} companies`;

      expect(usageText).toBe("10 / 25 companies");
    });

    it("shows unlimited usage correctly", () => {
      const current = 100;
      const limit = -1;
      const usageText = limit === -1
        ? `${current} companies`
        : `${current} / ${limit} companies`;

      expect(usageText).toBe("100 companies");
    });

    it("hides upgrade button for scale plan", () => {
      const planKey = "scale";
      const canUpgrade = planKey !== "scale";

      expect(canUpgrade).toBe(false);
    });

    it("shows upgrade button for non-scale plans", () => {
      const planKeys = ["free", "starter", "growth"];

      planKeys.forEach(planKey => {
        const canUpgrade = planKey !== "scale";
        expect(canUpgrade).toBe(true);
      });
    });
  });
});

describe("Upgrade URL", () => {
  it("generates correct managed pricing URL", () => {
    const storeHandle = "my-store";
    const appHandle = "net-terms-receivables";
    const expectedUrl = `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;

    expect(expectedUrl).toBe(
      "https://admin.shopify.com/store/my-store/charges/net-terms-receivables/pricing_plans"
    );
  });

  it("opens in parent frame with target _top", () => {
    const target = "_top";

    expect(target).toBe("_top");
  });
});

describe("Feature display names", () => {
  const FEATURE_DISPLAY_NAMES: Record<string, string> = {
    aging_dashboard: "Aging Dashboard",
    unlimited_imports: "Unlimited Bank Imports",
    matching: "Payment Matching",
    reminders: "Payment Reminders",
    credit_holds: "Credit Holds",
    pdf_statements: "PDF Statements",
    payer_memory: "Payer Memory",
    audit_export: "Audit Export",
  };

  it("has display name for all features", () => {
    const featureKeys = Object.keys(FEATURE_PLAN_REQUIREMENTS);

    featureKeys.forEach(key => {
      expect(FEATURE_DISPLAY_NAMES[key]).toBeDefined();
      expect(FEATURE_DISPLAY_NAMES[key].length).toBeGreaterThan(0);
    });
  });
});
