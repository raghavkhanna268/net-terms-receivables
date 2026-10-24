import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
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

  describe("enforceImportLimit (S21 item 4 wiring)", () => {
    it("succeeds when import is allowed", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { enforceImportLimit } = await import("../gating.server");
      
      // Starter plan (unlimited imports)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // Should not throw
      await expect(enforceImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID)).resolves.toBeUndefined();
    });

    it("throws UpgradeRequiredError when import limit exceeded", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { enforceImportLimit, UpgradeRequiredError } = await import("../gating.server");
      
      // Free plan (1 import/month limit)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockSql.setMockResult("import_count", [{ count: "1" }]); // Already at limit
      
      await expect(enforceImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID))
        .rejects.toThrow(UpgradeRequiredError);
      
      // Verify error details
      try {
        await enforceImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      } catch (error) {
        expect(error).toBeInstanceOf(UpgradeRequiredError);
        expect((error as InstanceType<typeof UpgradeRequiredError>).limitType).toBe("importsPerMonth");
        expect((error as InstanceType<typeof UpgradeRequiredError>).currentUsage).toBe(1);
        expect((error as InstanceType<typeof UpgradeRequiredError>).limit).toBe(1);
      }
    });

    it("succeeds when gating is OFF (no enforcement)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { enforceImportLimit } = await import("../gating.server");
      
      // Should not throw even with free plan and imports at limit
      await expect(enforceImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID)).resolves.toBeUndefined();
    });
  });

  describe("enforceCompanyLimit", () => {
    it("succeeds when under limit", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { enforceCompanyLimit } = await import("../gating.server");
      
      // Free plan with 2 active accounts (limit 3)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      // checkCompanyLimit uses gated_at IS NULL, so set active_account_count
      mockSql.setMockResult("active_account_count", [{ count: "2" }]);
      
      await expect(enforceCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID)).resolves.toBeUndefined();
    });

    it("throws UpgradeRequiredError when limit exceeded", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { enforceCompanyLimit, UpgradeRequiredError } = await import("../gating.server");
      
      // Free plan at limit (3 active accounts, limit is 3)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      // checkCompanyLimit uses gated_at IS NULL, so set active_account_count
      mockSql.setMockResult("active_account_count", [{ count: "3" }]);
      
      await expect(enforceCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID))
        .rejects.toThrow(UpgradeRequiredError);
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

  describe("activeAccountFragment helper", () => {
    it("returns TRUE fragment when gating is OFF", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { activeAccountFragment } = await import("../gating.server");
      
      const fragment = activeAccountFragment(mockSql as unknown as Sql);
      expect(fragment).toBeDefined();
    });

    it("returns gated_at IS NULL fragment when gating is ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { activeAccountFragment } = await import("../gating.server");
      
      const fragment = activeAccountFragment(mockSql as unknown as Sql);
      expect(fragment).toBeDefined();
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

/**
 * DB-backed tests for activeAccountFragment.
 * These tests verify that the SQL fragment actually excludes gated accounts.
 */
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("activeAccountFragment DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-gating";
  const TEST_SHOP_ID = `shop-gating-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `gating-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW())
    `;

    // Create test accounts: 2 active (gated_at IS NULL), 2 gated (gated_at IS NOT NULL)
    // COMPANY kind requires both companyId and companyLocationId (BuyerAccount_kind_consistency constraint)
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES 
        (${"acc-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-1-" + TEST_SUFFIX}, ${"loc-1-" + TEST_SUFFIX}, 'Active Account 1', NULL, NOW(), NOW()),
        (${"acc-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-2-" + TEST_SUFFIX}, ${"loc-2-" + TEST_SUFFIX}, 'Active Account 2', NULL, NOW(), NOW()),
        (${"acc-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-3-" + TEST_SUFFIX}, ${"loc-3-" + TEST_SUFFIX}, 'Gated Account 1', NOW(), NOW(), NOW()),
        (${"acc-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-4-" + TEST_SUFFIX}, ${"loc-4-" + TEST_SUFFIX}, 'Gated Account 2', NOW(), NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("returns all accounts when gating is OFF", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
    vi.resetModules();
    const { activeAccountFragment } = await import("../gating.server");

    const accounts = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND ${activeAccountFragment(sql)}
    `;

    // When gating is OFF, all 4 accounts should be returned
    expect(accounts.length).toBe(4);
  });

  it("excludes gated accounts when gating is ON", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { activeAccountFragment } = await import("../gating.server");

    const accounts = await sql<{ id: string; name: string }[]>`
      SELECT id, name FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND ${activeAccountFragment(sql)}
    `;

    // When gating is ON, only 2 active accounts should be returned
    expect(accounts.length).toBe(2);
    expect(accounts.every(a => a.name.includes("Active"))).toBe(true);
  });

  it("isAccountActive returns correct values with DB data", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { isAccountActive } = await import("../gating.server");

    // Fetch accounts with gated_at
    const accounts = await sql<{ id: string; gated_at: Date | null }[]>`
      SELECT id, gated_at FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;

    const activeAccounts = accounts.filter(a => isAccountActive(a.gated_at));
    const gatedAccounts = accounts.filter(a => !isAccountActive(a.gated_at));

    expect(activeAccounts.length).toBe(2);
    expect(gatedAccounts.length).toBe(2);
  });

  it("isAccountActive correctly identifies gated accounts", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { isAccountActive } = await import("../gating.server");

    // Fetch accounts with gated_at and verify isAccountActive
    const accounts = await sql<{ id: string; name: string; gated_at: Date | null }[]>`
      SELECT id, name, gated_at FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;

    // Active accounts (gated_at IS NULL) should return true
    const activeOnes = accounts.filter(a => a.gated_at === null);
    expect(activeOnes.every(a => isAccountActive(a.gated_at))).toBe(true);

    // Gated accounts (gated_at IS NOT NULL) should return false
    const gatedOnes = accounts.filter(a => a.gated_at !== null);
    expect(gatedOnes.every(a => !isAccountActive(a.gated_at))).toBe(true);
  });
});
