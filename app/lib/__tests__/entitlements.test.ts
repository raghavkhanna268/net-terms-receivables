import { describe, it, expect } from "vitest";
import {
  ALL_PLAN_KEYS,
  ALL_FEATURE_KEYS,
  getPlanConfig,
  getDefaultPlan,
  planHasFeature,
  planLimit,
  isLimitExceeded,
  resolvePlanKey,
  mapSubscriptionToPlanKey,
  getSupportTier,
  type PlanKey,
  type FeatureKey,
} from "../entitlements";

/**
 * Tests for entitlements configuration (T1 pricing launch).
 *
 * Pricing approved 2026-10-25:
 * - Starter: 25 buyer accounts, standard support
 * - Growth: 100 buyer accounts, standard support
 * - Unlimited: no limit, priority support
 * - None: 0 buyer accounts (no subscription)
 *
 * All features are enabled on every plan.
 */

describe("resolvePlanKey", () => {
  describe("handles (confirmed in Partner Dashboard 2026-10-25)", () => {
    it("resolves 'starter' handle", () => {
      expect(resolvePlanKey("starter")).toBe("starter");
    });

    it("resolves 'growth' handle", () => {
      expect(resolvePlanKey("growth")).toBe("growth");
    });

    it("resolves 'unlimited' handle", () => {
      expect(resolvePlanKey("unlimited")).toBe("unlimited");
    });
  });

  describe("case-insensitive matching", () => {
    it("handles uppercase", () => {
      expect(resolvePlanKey("STARTER")).toBe("starter");
      expect(resolvePlanKey("GROWTH")).toBe("growth");
      expect(resolvePlanKey("UNLIMITED")).toBe("unlimited");
    });

    it("handles mixed case", () => {
      expect(resolvePlanKey("Starter")).toBe("starter");
      expect(resolvePlanKey("Growth")).toBe("growth");
      expect(resolvePlanKey("Unlimited")).toBe("unlimited");
    });

    it("handles unusual case", () => {
      expect(resolvePlanKey("sTaRtEr")).toBe("starter");
      expect(resolvePlanKey("gRoWtH")).toBe("growth");
      expect(resolvePlanKey("uNlImItEd")).toBe("unlimited");
    });
  });

  describe("whitespace handling", () => {
    it("trims leading whitespace", () => {
      expect(resolvePlanKey("  starter")).toBe("starter");
      expect(resolvePlanKey("\tstarter")).toBe("starter");
    });

    it("trims trailing whitespace", () => {
      expect(resolvePlanKey("starter  ")).toBe("starter");
      expect(resolvePlanKey("starter\t")).toBe("starter");
    });

    it("trims both sides", () => {
      expect(resolvePlanKey("  starter  ")).toBe("starter");
      expect(resolvePlanKey("\t growth \t")).toBe("growth");
    });

    it("handles whitespace-only as none", () => {
      expect(resolvePlanKey("   ")).toBe("none");
      expect(resolvePlanKey("\t")).toBe("none");
    });
  });

  describe("unknown values map to none", () => {
    it("maps unknown handle to none", () => {
      expect(resolvePlanKey("enterprise")).toBe("none");
      expect(resolvePlanKey("premium")).toBe("none");
      expect(resolvePlanKey("basic")).toBe("none");
    });

    it("maps shopify-test to none (private $0 plan)", () => {
      expect(resolvePlanKey("shopify-test")).toBe("none");
      expect(resolvePlanKey("Shopify-Test")).toBe("none");
      expect(resolvePlanKey("SHOPIFY-TEST")).toBe("none");
    });

    it("maps random strings to none", () => {
      expect(resolvePlanKey("xyz123")).toBe("none");
      expect(resolvePlanKey("not-a-plan")).toBe("none");
    });
  });

  describe("null and empty values", () => {
    it("maps null to none", () => {
      expect(resolvePlanKey(null)).toBe("none");
    });

    it("maps undefined to none", () => {
      expect(resolvePlanKey(undefined)).toBe("none");
    });

    it("maps empty string to none", () => {
      expect(resolvePlanKey("")).toBe("none");
    });
  });

  describe("legacy cached values", () => {
    it("maps 'free' to none", () => {
      expect(resolvePlanKey("free")).toBe("none");
      expect(resolvePlanKey("Free")).toBe("none");
      expect(resolvePlanKey("FREE")).toBe("none");
    });

    it("maps 'scale' to unlimited", () => {
      expect(resolvePlanKey("scale")).toBe("unlimited");
      expect(resolvePlanKey("Scale")).toBe("unlimited");
      expect(resolvePlanKey("SCALE")).toBe("unlimited");
    });
  });
});

describe("mapSubscriptionToPlanKey (backwards compatibility)", () => {
  it("returns null for null/undefined/empty (not none)", () => {
    expect(mapSubscriptionToPlanKey(null)).toBeNull();
    expect(mapSubscriptionToPlanKey(undefined)).toBeNull();
    expect(mapSubscriptionToPlanKey("")).toBeNull();
  });

  it("maps known handles to plan keys", () => {
    expect(mapSubscriptionToPlanKey("starter")).toBe("starter");
    expect(mapSubscriptionToPlanKey("growth")).toBe("growth");
    expect(mapSubscriptionToPlanKey("unlimited")).toBe("unlimited");
  });

  it("maps legacy values", () => {
    expect(mapSubscriptionToPlanKey("free")).toBe("none");
    expect(mapSubscriptionToPlanKey("scale")).toBe("unlimited");
  });

  it("returns null for unknown names (backwards compatible)", () => {
    expect(mapSubscriptionToPlanKey("enterprise")).toBeNull();
    expect(mapSubscriptionToPlanKey("shopify-test")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(mapSubscriptionToPlanKey("Starter")).toBe("starter");
    expect(mapSubscriptionToPlanKey("GROWTH")).toBe("growth");
    expect(mapSubscriptionToPlanKey("Unlimited")).toBe("unlimited");
  });
});

describe("plan limits", () => {
  describe("companies limit per plan", () => {
    it("none plan has 0 companies limit", () => {
      const plan = getPlanConfig("none");
      expect(planLimit(plan, "companies")).toBe(0);
    });

    it("starter plan has 25 companies limit", () => {
      const plan = getPlanConfig("starter");
      expect(planLimit(plan, "companies")).toBe(25);
    });

    it("growth plan has 100 companies limit", () => {
      const plan = getPlanConfig("growth");
      expect(planLimit(plan, "companies")).toBe(100);
    });

    it("unlimited plan has -1 (unlimited) companies", () => {
      const plan = getPlanConfig("unlimited");
      expect(planLimit(plan, "companies")).toBe(-1);
    });
  });

  describe("importsPerMonth is unlimited (-1) on all plans", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' has unlimited imports",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        expect(planLimit(plan, "importsPerMonth")).toBe(-1);
      }
    );
  });
});

describe("isLimitExceeded", () => {
  describe("starter plan edges (limit 25)", () => {
    const plan = getPlanConfig("starter");

    it("24 is not exceeded (under limit)", () => {
      expect(isLimitExceeded(plan, "companies", 24)).toBe(false);
    });

    it("25 is exceeded (at limit, >= semantics)", () => {
      expect(isLimitExceeded(plan, "companies", 25)).toBe(true);
    });

    it("26 is exceeded (over limit)", () => {
      expect(isLimitExceeded(plan, "companies", 26)).toBe(true);
    });

    it("0 is not exceeded", () => {
      expect(isLimitExceeded(plan, "companies", 0)).toBe(false);
    });
  });

  describe("growth plan edges (limit 100)", () => {
    const plan = getPlanConfig("growth");

    it("99 is not exceeded (under limit)", () => {
      expect(isLimitExceeded(plan, "companies", 99)).toBe(false);
    });

    it("100 is exceeded (at limit, >= semantics)", () => {
      expect(isLimitExceeded(plan, "companies", 100)).toBe(true);
    });

    it("101 is exceeded (over limit)", () => {
      expect(isLimitExceeded(plan, "companies", 101)).toBe(true);
    });
  });

  describe("unlimited plan never exceeds", () => {
    const plan = getPlanConfig("unlimited");

    it("0 is not exceeded", () => {
      expect(isLimitExceeded(plan, "companies", 0)).toBe(false);
    });

    it("100 is not exceeded", () => {
      expect(isLimitExceeded(plan, "companies", 100)).toBe(false);
    });

    it("10000 is not exceeded", () => {
      expect(isLimitExceeded(plan, "companies", 10000)).toBe(false);
    });

    it("Number.MAX_SAFE_INTEGER is not exceeded", () => {
      expect(isLimitExceeded(plan, "companies", Number.MAX_SAFE_INTEGER)).toBe(false);
    });
  });

  describe("none plan (limit 0)", () => {
    const plan = getPlanConfig("none");

    it("0 is exceeded (at limit, >= semantics)", () => {
      expect(isLimitExceeded(plan, "companies", 0)).toBe(true);
    });

    it("1 is exceeded", () => {
      expect(isLimitExceeded(plan, "companies", 1)).toBe(true);
    });
  });

  describe("importsPerMonth never exceeds (unlimited on all plans)", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' never exceeds import limit",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        expect(isLimitExceeded(plan, "importsPerMonth", 0)).toBe(false);
        expect(isLimitExceeded(plan, "importsPerMonth", 1000)).toBe(false);
        expect(isLimitExceeded(plan, "importsPerMonth", 10000)).toBe(false);
      }
    );
  });
});

describe("supportTier", () => {
  it("none plan has standard support", () => {
    const plan = getPlanConfig("none");
    expect(getSupportTier(plan)).toBe("standard");
    expect(plan.supportTier).toBe("standard");
  });

  it("starter plan has standard support", () => {
    const plan = getPlanConfig("starter");
    expect(getSupportTier(plan)).toBe("standard");
    expect(plan.supportTier).toBe("standard");
  });

  it("growth plan has standard support", () => {
    const plan = getPlanConfig("growth");
    expect(getSupportTier(plan)).toBe("standard");
    expect(plan.supportTier).toBe("standard");
  });

  it("unlimited plan has priority support", () => {
    const plan = getPlanConfig("unlimited");
    expect(getSupportTier(plan)).toBe("priority");
    expect(plan.supportTier).toBe("priority");
  });
});

describe("all features enabled on every plan", () => {
  describe("every feature is true on every plan", () => {
    const testCases = ALL_PLAN_KEYS.flatMap((planKey) =>
      ALL_FEATURE_KEYS.map((featureKey) => ({
        planKey,
        featureKey,
      }))
    );

    it.each(testCases)(
      "plan '$planKey' has feature '$featureKey'",
      ({ planKey, featureKey }: { planKey: PlanKey; featureKey: FeatureKey }) => {
        const plan = getPlanConfig(planKey);
        expect(planHasFeature(plan, featureKey)).toBe(true);
      }
    );
  });

  describe("credit_holds is available on ALL plans (guard against re-gating)", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' includes credit_holds feature",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        expect(planHasFeature(plan, "credit_holds")).toBe(true);
      }
    );

    it("all four plans include credit_holds", () => {
      const plansWithCreditHolds = ALL_PLAN_KEYS.filter((planKey) => {
        const plan = getPlanConfig(planKey);
        return planHasFeature(plan, "credit_holds");
      });

      expect(plansWithCreditHolds).toEqual(["none", "starter", "growth", "unlimited"]);
      expect(plansWithCreditHolds).toHaveLength(4);
    });
  });

  describe("aging_dashboard is available on ALL plans", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' includes aging_dashboard feature",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        expect(planHasFeature(plan, "aging_dashboard")).toBe(true);
      }
    );
  });

  describe("matching is available on ALL plans", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' includes matching feature",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        expect(planHasFeature(plan, "matching")).toBe(true);
      }
    );

    it("all four plans include matching", () => {
      const plansWithMatching = ALL_PLAN_KEYS.filter((planKey) => {
        const plan = getPlanConfig(planKey);
        return planHasFeature(plan, "matching");
      });

      expect(plansWithMatching).toEqual(["none", "starter", "growth", "unlimited"]);
      expect(plansWithMatching).toHaveLength(4);
    });
  });
});

describe("getDefaultPlan", () => {
  it("returns none plan", () => {
    const defaultPlan = getDefaultPlan();
    expect(defaultPlan.key).toBe("none");
  });

  it("default plan has 0 companies limit", () => {
    const defaultPlan = getDefaultPlan();
    expect(planLimit(defaultPlan, "companies")).toBe(0);
  });

  it("default plan has unlimited imports", () => {
    const defaultPlan = getDefaultPlan();
    expect(planLimit(defaultPlan, "importsPerMonth")).toBe(-1);
  });

  it("default plan has all features", () => {
    const defaultPlan = getDefaultPlan();
    ALL_FEATURE_KEYS.forEach((feature) => {
      expect(planHasFeature(defaultPlan, feature)).toBe(true);
    });
  });

  it("default plan has standard support", () => {
    const defaultPlan = getDefaultPlan();
    expect(defaultPlan.supportTier).toBe("standard");
  });
});

describe("ALL_PLAN_KEYS", () => {
  it("contains exactly four plans", () => {
    expect(ALL_PLAN_KEYS).toHaveLength(4);
  });

  it("contains none, starter, growth, unlimited", () => {
    expect(ALL_PLAN_KEYS).toEqual(["none", "starter", "growth", "unlimited"]);
  });
});

describe("getPlanConfig", () => {
  it.each(ALL_PLAN_KEYS)(
    "returns valid config for '%s'",
    (planKey: PlanKey) => {
      const plan = getPlanConfig(planKey);
      expect(plan.key).toBe(planKey);
      expect(typeof plan.limits.companies).toBe("number");
      expect(typeof plan.limits.importsPerMonth).toBe("number");
      expect(plan.features).toBeInstanceOf(Set);
      expect(["standard", "priority"]).toContain(plan.supportTier);
    }
  );
});
