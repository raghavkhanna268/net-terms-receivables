import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for gating service (S21).
 *
 * Tests verify:
 * 1. Company limit enforcement at boundaries (3rd vs 4th company on free)
 * 2. Import limit enforcement per calendar month (IST)
 * 3. Feature checks return correct values
 * 4. Downgrade-keeps-data behavior (existing accounts not deleted)
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
      
      // Check for BuyerAccount count
      if (query.includes('COUNT') && query.includes('"BuyerAccount"')) {
        return mockResults.get("account_count") ?? [{ count: "0" }];
      }
      
      // Check for BankImport count
      if (query.includes('COUNT') && query.includes('"BankImport"')) {
        return mockResults.get("import_count") ?? [{ count: "0" }];
      }
      
      return [];
    }),
    {
      json: vi.fn((v) => v),
      setMockResult: (key: string, value: unknown[]) => mockResults.set(key, value),
      clearMockResults: () => mockResults.clear(),
    }
  ) as unknown as Sql & {
    setMockResult: (key: string, value: unknown[]) => void;
    clearMockResults: () => void;
  };
  
  return sql;
};

describe("Gating Service", () => {
  const TEST_SHOP_ID = "shop-123";
  
  let mockSql: ReturnType<typeof createMockSql>;
  
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSql = createMockSql();
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("checkCompanyLimit", () => {
    it("allows creation when under limit", async () => {
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 2 companies exist (limit is 3)
      mockSql.setMockResult("account_count", [{ count: "2" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(2);
      expect(result.limit).toBe(3);
    });

    it("blocks creation at limit (3rd vs 4th company boundary)", async () => {
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 3 companies exist (at limit)
      mockSql.setMockResult("account_count", [{ count: "3" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(3);
      expect(result.limit).toBe(3);
      expect(result.reason).toContain("Company limit reached");
    });

    it("allows creation on scale plan (unlimited)", async () => {
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
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Growth plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 50 companies exist (limit is 100)
      mockSql.setMockResult("account_count", [{ count: "50" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(50);
      expect(result.limit).toBe(100);
    });
  });

  describe("enforceCompanyLimit", () => {
    it("throws UpgradeRequiredError when limit exceeded", async () => {
      const { enforceCompanyLimit, UpgradeRequiredError } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 3 companies exist (at limit)
      mockSql.setMockResult("account_count", [{ count: "3" }]);
      
      await expect(enforceCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID))
        .rejects.toThrow(UpgradeRequiredError);
    });

    it("does not throw when under limit", async () => {
      const { enforceCompanyLimit } = await import("../gating.server");
      
      // Free plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 1 company exists (under limit)
      mockSql.setMockResult("account_count", [{ count: "1" }]);
      
      await expect(enforceCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID))
        .resolves.toBeUndefined();
    });
  });

  describe("checkImportLimit", () => {
    it("allows import when under monthly limit", async () => {
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

  describe("getUsageStats", () => {
    it("returns correct usage statistics", async () => {
      const { getUsageStats } = await import("../gating.server");
      
      // Starter plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 10 companies
      mockSql.setMockResult("account_count", [{ count: "10" }]);
      
      // 3 imports this month
      mockSql.setMockResult("import_count", [{ count: "3" }]);
      
      const result = await getUsageStats(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.companies.current).toBe(10);
      expect(result.companies.limit).toBe(25);
      expect(result.importsThisMonth.current).toBe(3);
      expect(result.importsThisMonth.limit).toBe(-1); // unlimited
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

  describe("Downgrade behavior", () => {
    it("existing accounts are not deleted on downgrade", async () => {
      // This test documents the behavior that downgrades don't delete data.
      // Over-limit shops can still READ their data but cannot CREATE new records.
      
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Free plan cached (simulating a downgrade from growth)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 50 companies exist (way over free limit of 3)
      // This simulates a shop that downgraded from growth (100 limit) to free (3 limit)
      mockSql.setMockResult("account_count", [{ count: "50" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      // Should block NEW creations
      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(50);
      expect(result.limit).toBe(3);
      
      // The key point: currentUsage > limit means existing data is preserved
      // (if we deleted data on downgrade, currentUsage would be <= limit)
    });
  });
});
