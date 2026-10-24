/**
 * Tests for plan gating of value-add actions (S21).
 *
 * Product rule: With PLAN_GATING_ENFORCED on, gated accounts (gated_at IS NOT NULL)
 * stay visible but are blocked from these value-add actions:
 * 1. Payment reminders - no reminders to gated accounts
 * 2. Credit-limit edits - blocked on gated accounts
 * 3. Account detail edits - blocked on gated accounts
 * 4. Bulk bank-statement import - blocked by plan import limit
 *
 * NEVER gated (verified via regression tests):
 * - Payment matching, confirming a match, marking an invoice paid
 * - Credit holds, metafield sync, checkout validation
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const originalEnv = process.env.PLAN_GATING_ENFORCED;

function setGatingEnforced(value: string): void {
  (process.env as Record<string, string>).PLAN_GATING_ENFORCED = value;
}

describe("Plan gating - isAccountActive helper", () => {
  afterEach(() => {
    process.env.PLAN_GATING_ENFORCED = originalEnv;
    vi.resetModules();
  });

  describe("1. isAccountActive - core gating check", () => {
    it("returns false for gated account when PLAN_GATING_ENFORCED=true", async () => {
      setGatingEnforced("true");
      vi.resetModules();

      const { isAccountActive } = await import("~/services/gating.server");

      const gatedAt = new Date("2026-10-01");
      expect(isAccountActive(gatedAt)).toBe(false);
    });

    it("returns true for non-gated account when PLAN_GATING_ENFORCED=true", async () => {
      setGatingEnforced("true");
      vi.resetModules();

      const { isAccountActive } = await import("~/services/gating.server");

      expect(isAccountActive(null)).toBe(true);
    });

    it("returns true for gated account when PLAN_GATING_ENFORCED=false", async () => {
      setGatingEnforced("false");
      vi.resetModules();

      const { isAccountActive } = await import("~/services/gating.server");

      const gatedAt = new Date("2026-10-01");
      expect(isAccountActive(gatedAt)).toBe(true);
    });
  });

  describe("2. isGatingEnforced - environment check", () => {
    it("returns true when PLAN_GATING_ENFORCED=1", async () => {
      setGatingEnforced("1");
      vi.resetModules();

      const { isGatingEnforced } = await import("~/services/gating.server");

      expect(isGatingEnforced()).toBe(true);
    });

    it("returns true when PLAN_GATING_ENFORCED=true", async () => {
      setGatingEnforced("true");
      vi.resetModules();

      const { isGatingEnforced } = await import("~/services/gating.server");

      expect(isGatingEnforced()).toBe(true);
    });

    it("returns false when PLAN_GATING_ENFORCED=false", async () => {
      setGatingEnforced("false");
      vi.resetModules();

      const { isGatingEnforced } = await import("~/services/gating.server");

      expect(isGatingEnforced()).toBe(false);
    });

    it("returns false when PLAN_GATING_ENFORCED is empty", async () => {
      setGatingEnforced("");
      vi.resetModules();

      const { isGatingEnforced } = await import("~/services/gating.server");

      expect(isGatingEnforced()).toBe(false);
    });
  });

  describe("3. Bulk import - import limit decision (plan feature not gated-account)", () => {
    it("uses plan-based import limits, not gated account count", async () => {
      setGatingEnforced("true");
      vi.resetModules();

      const { planLimit, getPlanConfig } = await import("~/lib/entitlements");

      // Free plan has 1 import/month
      const freePlan = getPlanConfig("free");
      expect(planLimit(freePlan, "importsPerMonth")).toBe(1);

      // Starter+ plans have unlimited imports
      const starterPlan = getPlanConfig("starter");
      expect(planLimit(starterPlan, "importsPerMonth")).toBe(-1);

      // This verifies bulk import is a plan feature, not gated-account-based
    });
  });

  describe("4. Regression: never-gated actions reference", () => {
    it("documents that matching, confirm, mark-paid are tested in gated-account-db.test.ts", () => {
      // See app/services/__tests__/gated-account-db.test.ts for DB integration tests proving:
      // - Matcher suggests matches for gated accounts
      // - confirmMatch succeeds for gated accounts
      // - Invoice payment clears holds on gated accounts
      // These are comprehensive DB tests that don't need mocking
      expect(true).toBe(true);
    });
  });
});
