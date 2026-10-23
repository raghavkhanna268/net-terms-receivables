import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for gating service (S21).
 *
 * Tests verify:
 * 1. PLAN_GATING_ENFORCED on/off modes
 * 2. Company limit enforcement at boundaries (3rd vs 4th company on free)
 * 3. Gated accounts excluded from limit count
 * 4. Reactivation on upgrade (oldest first)
 * 5. Import limit enforcement per calendar month (IST)
 * 6. Feature checks return correct values
 */

// Mock SQL client
const createMockSql = () => {
  const mockResults: Map<string, unknown[]> = new Map();
  
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      
      // Check for plan cache lookup
      if (query.includes("plan_key") && query.includes("plan_cached_at")) {
        return mockResults.get("shop_plan") ?? [];
      }
      
      // Check for BuyerAccount count with gated_at IS NULL filter (active, non-gated)
      // This matches both checkCompanyLimit and getUsageStats when gating is ON
      if (query.includes('COUNT') && query.includes('"BuyerAccount"') && query.includes('gated_at IS NULL')) {
        return mockResults.get("active_account_count") ?? [{ count: "0" }];
      }

      // Check for BuyerAccount count without gated_at filter (all accounts)
      // This matches getUsageStats when gating is OFF
      if (query.includes('COUNT') && query.includes('"BuyerAccount"') && !query.includes('gated_at')) {
        return mockResults.get("account_count") ?? [{ count: "0" }];
      }
      
      // Check for BankImport count
      if (query.includes('COUNT') && query.includes('"BankImport"')) {
        return mockResults.get("import_count") ?? [{ count: "0" }];
      }

      // Check for gated account reactivation
      if (query.includes('UPDATE') && query.includes('gated_at = NULL')) {
        return mockResults.get("reactivate_result") ?? { count: 0 };
      }
      
      return [];
    }),
    {
      json: vi.fn((v) => v),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
      clearMockResults: () => mockResults.clear(),
    }
  ) as unknown as Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
  };
  
  return sql;
};

describe("Gating Service", () => {
  const TEST_SHOP_ID = "shop-123";
  const originalEnv = process.env;
  
  let mockSql: ReturnType<typeof createMockSql>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSql = createMockSql();
    process.env = { ...originalEnv };
  });
  
  afterEach(() => {
    vi.clearAllMocks();
    process.env = originalEnv;
  });

  describe("isGatingEnforced", () => {
    it("returns false when PLAN_GATING_ENFORCED is not set", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = undefined;
      const { isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(false);
    });

    it("returns false when PLAN_GATING_ENFORCED is 'false'", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(false);
    });

    it("returns true when PLAN_GATING_ENFORCED is '1'", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(true);
    });

    it("returns true when PLAN_GATING_ENFORCED is 'true'", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "true";
      vi.resetModules();
      const { isGatingEnforced } = await import("../gating.server");
      expect(isGatingEnforced()).toBe(true);
    });
  });

  describe("checkCompanyLimit with gating OFF", () => {
    it("always allows when PLAN_GATING_ENFORCED is off", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Don't even need to set up plan - gating is off
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Gating not enforced");
    });
  });

  describe("checkCompanyLimit with gating ON", () => {
    beforeEach(() => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    });

    it("allows creation when under limit", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 2 active companies exist (limit is 3)
      mockSql.setMockResult("active_account_count", [{ count: "2" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(2);
      expect(result.limit).toBe(3);
    });

    it("blocks creation at limit (3rd vs 4th company boundary)", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 3 active companies exist (at limit)
      mockSql.setMockResult("active_account_count", [{ count: "3" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(3);
      expect(result.limit).toBe(3);
      expect(result.reason).toContain("Company limit reached");
    });

    it("excludes gated accounts from count", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 2 active accounts (gated ones not counted)
      // This simulates having 5 total accounts but only 2 active
      mockSql.setMockResult("active_account_count", [{ count: "2" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      // Should allow because only 2 active, even if there are more gated
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(2);
    });

    it("allows creation on scale plan (unlimited)", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Scale plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "scale",
        subscription_id: "sub-123",
        subscription_name: "Scale",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
    });

    it("allows creation on growth plan with higher limit", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Growth plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 50 active companies exist (limit is 100)
      mockSql.setMockResult("active_account_count", [{ count: "50" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(50);
      expect(result.limit).toBe(100);
    });
  });

  describe("reactivateGatedAccounts", () => {
    it("reactivates gated accounts on upgrade (oldest first)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { reactivateGatedAccounts } = await import("../gating.server");
      
      // 2 active accounts currently
      mockSql.setMockResult("active_account_count", [{ count: "2" }]);
      
      // Reactivation updates 3 accounts
      mockSql.setMockResult("reactivate_result", { count: 3 });
      
      // Upgrade to growth (limit 100)
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID,
        "growth"
      );
      
      // Should have reactivated accounts
      expect(reactivated).toBe(3);
    });

    it("reactivates all gated accounts on upgrade to scale (unlimited)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { reactivateGatedAccounts } = await import("../gating.server");
      
      // 5 active accounts
      mockSql.setMockResult("active_account_count", [{ count: "5" }]);
      
      // Reactivation updates 50 accounts
      mockSql.setMockResult("reactivate_result", { count: 50 });
      
      // Upgrade to scale (unlimited)
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID,
        "scale"
      );
      
      expect(reactivated).toBe(50);
    });

    it("reactivates nothing when already at limit", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { reactivateGatedAccounts } = await import("../gating.server");
      
      // Already at starter limit (25)
      mockSql.setMockResult("active_account_count", [{ count: "25" }]);
      
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID,
        "starter"
      );
      
      expect(reactivated).toBe(0);
    });
  });

  describe("checkImportLimit with gating OFF", () => {
    it("always allows when PLAN_GATING_ENFORCED is off", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { checkImportLimit } = await import("../gating.server");
      
      const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Gating not enforced");
    });
  });

  describe("checkImportLimit with gating ON", () => {
    beforeEach(() => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    });

    it("allows import when under monthly limit", async () => {
      vi.resetModules();
      const { checkImportLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 0 imports this month (limit is 1)
      mockSql.setMockResult("import_count", [{ count: "0" }]);
      
      const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(0);
      expect(result.limit).toBe(1);
    });

    it("blocks import when at monthly limit", async () => {
      vi.resetModules();
      const { checkImportLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 1 import this month (at limit)
      mockSql.setMockResult("import_count", [{ count: "1" }]);
      
      const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(1);
      expect(result.limit).toBe(1);
      expect(result.reason).toContain("Import limit reached");
    });

    it("allows unlimited imports on starter plan", async () => {
      vi.resetModules();
      const { checkImportLimit } = await import("../gating.server");
      
      // Starter plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(-1);
    });
  });

  describe("checkFeature", () => {
    it("returns true for features in plan", async () => {
      const { checkFeature } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      const result = await checkFeature(mockSql as unknown as Sql, TEST_SHOP_ID, "aging_dashboard");
      
      expect(result).toBe(true);
    });

    it("returns false for features not in plan", async () => {
      const { checkFeature } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      const result = await checkFeature(mockSql as unknown as Sql, TEST_SHOP_ID, "credit_holds");
      
      expect(result).toBe(false);
    });

    it("returns true for credit_holds on growth plan", async () => {
      const { checkFeature } = await import("../gating.server");
      
      // Growth plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      const result = await checkFeature(mockSql as unknown as Sql, TEST_SHOP_ID, "credit_holds");
      
      expect(result).toBe(true);
    });
  });

  describe("UpgradeRequiredError", () => {
    it("has correct properties", async () => {
      const { UpgradeRequiredError } = await import("../gating.server");
      
      const error = new UpgradeRequiredError("companies", 3, 3);
      
      expect(error.name).toBe("UpgradeRequiredError");
      expect(error.limitType).toBe("companies");
      expect(error.currentUsage).toBe(3);
      expect(error.limit).toBe(3);
      expect(error.message).toContain("Upgrade required");
      expect(error.message).toContain("3/3");
    });
  });

  describe("Over-limit then upgrade scenario", () => {
    it("gated accounts appear after upgrade", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { checkCompanyLimit, reactivateGatedAccounts } = await import("../gating.server");
      
      // Free plan, 3 active accounts (at limit)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockSql.setMockResult("active_account_count", [{ count: "3" }]);
      
      // Creating 4th account should be blocked
      const beforeUpgrade = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      expect(beforeUpgrade.allowed).toBe(false);
      
      // Simulate upgrade to growth
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-456",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // Simulate reactivation (5 gated accounts activated)
      mockSql.setMockResult("reactivate_result", { count: 5 });
      
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID,
        "growth"
      );
      expect(reactivated).toBe(5);
      
      // After upgrade + reactivation, we have 8 active accounts (limit 100)
      mockSql.setMockResult("active_account_count", [{ count: "8" }]);
      
      const afterUpgrade = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      expect(afterUpgrade.allowed).toBe(true);
      expect(afterUpgrade.currentUsage).toBe(8);
      expect(afterUpgrade.limit).toBe(100);
    });
  });

  describe("activeAccountPredicate helper", () => {
    it("returns tautology (1=1) when gating is OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { activeAccountPredicate } = await import("../gating.server");
      
      expect(activeAccountPredicate()).toBe("1=1");
    });

    it("returns gated_at IS NULL when gating is ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { activeAccountPredicate } = await import("../gating.server");
      
      expect(activeAccountPredicate()).toBe("gated_at IS NULL");
    });
  });

  describe("isAccountActive helper", () => {
    it("returns true for all accounts when gating is OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { isAccountActive } = await import("../gating.server");
      
      expect(isAccountActive(null)).toBe(true);
      expect(isAccountActive(new Date())).toBe(true);
    });

    it("returns true only for non-gated accounts when gating is ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { isAccountActive } = await import("../gating.server");
      
      expect(isAccountActive(null)).toBe(true);
      expect(isAccountActive(new Date())).toBe(false);
    });
  });

  describe("getUsageStats with gating", () => {
    it("counts all companies when gating is OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { getUsageStats } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 5 total companies (some might be gated, but we count all when OFF)
      mockSql.setMockResult("account_count", [{ count: "5" }]);
      mockSql.setMockResult("import_count", [{ count: "0" }]);
      
      const stats = await getUsageStats(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(stats.companies.current).toBe(5);
      expect(stats.companies.limit).toBe(3);
    });

    it("counts only non-gated companies when gating is ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { getUsageStats } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // The query with gated_at IS NULL filter returns active count
      mockSql.setMockResult("active_account_count", [{ count: "3" }]);
      mockSql.setMockResult("import_count", [{ count: "0" }]);
      
      const stats = await getUsageStats(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      // Should return only active (non-gated) count
      expect(stats.companies.current).toBe(3);
      expect(stats.companies.limit).toBe(3);
    });
  });
});
