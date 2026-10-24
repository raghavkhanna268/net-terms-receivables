import { describe, it, expect } from "vitest";
import {
  ALL_PLAN_KEYS,
  getPlanConfig,
  planHasFeature,
  type PlanKey,
} from "../entitlements";

/**
 * Tests for entitlements configuration (S21).
 *
 * These tests verify the plan configuration is correct, especially
 * that credit_holds is available on ALL plans (never gated).
 */

describe("entitlements configuration", () => {
  describe("credit_holds is available on ALL plans", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' includes credit_holds feature",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        const hasCreditHolds = planHasFeature(plan, "credit_holds");

        expect(hasCreditHolds).toBe(true);
      }
    );

    it("all four plans include credit_holds (guard against re-gating)", () => {
      const plansWithCreditHolds = ALL_PLAN_KEYS.filter((planKey) => {
        const plan = getPlanConfig(planKey);
        return planHasFeature(plan, "credit_holds");
      });

      expect(plansWithCreditHolds).toEqual(["free", "starter", "growth", "scale"]);
      expect(plansWithCreditHolds).toHaveLength(4);
    });
  });

  describe("aging_dashboard is available on ALL plans", () => {
    it.each(ALL_PLAN_KEYS)(
      "plan '%s' includes aging_dashboard feature",
      (planKey: PlanKey) => {
        const plan = getPlanConfig(planKey);
        const hasAgingDashboard = planHasFeature(plan, "aging_dashboard");

        expect(hasAgingDashboard).toBe(true);
      }
    );
  });

  describe("tier-gated features", () => {
    it("matching requires starter or higher", () => {
      expect(planHasFeature(getPlanConfig("free"), "matching")).toBe(false);
      expect(planHasFeature(getPlanConfig("starter"), "matching")).toBe(true);
      expect(planHasFeature(getPlanConfig("growth"), "matching")).toBe(true);
      expect(planHasFeature(getPlanConfig("scale"), "matching")).toBe(true);
    });

    it("pdf_statements requires growth or higher", () => {
      expect(planHasFeature(getPlanConfig("free"), "pdf_statements")).toBe(false);
      expect(planHasFeature(getPlanConfig("starter"), "pdf_statements")).toBe(false);
      expect(planHasFeature(getPlanConfig("growth"), "pdf_statements")).toBe(true);
      expect(planHasFeature(getPlanConfig("scale"), "pdf_statements")).toBe(true);
    });

    it("audit_export requires scale", () => {
      expect(planHasFeature(getPlanConfig("free"), "audit_export")).toBe(false);
      expect(planHasFeature(getPlanConfig("starter"), "audit_export")).toBe(false);
      expect(planHasFeature(getPlanConfig("growth"), "audit_export")).toBe(false);
      expect(planHasFeature(getPlanConfig("scale"), "audit_export")).toBe(true);
    });
  });
});
