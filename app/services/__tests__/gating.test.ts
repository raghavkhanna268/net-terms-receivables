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
  
  const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
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

    // Check for gated account reactivation
    if (query.includes('UPDATE') && query.includes('gated_at = NULL')) {
      return mockResults.get("reactivate_result") ?? { count: 0 };
    }

    // Check for pg_advisory_xact_lock (used in transactions)
    if (query.includes('pg_advisory_xact_lock')) {
      return [];
    }
    
    return [];
  };
  
  const sql = Object.assign(
    vi.fn(queryHandler),
    {
      json: vi.fn((v) => v),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
      clearMockResults: () => mockResults.clear(),
      begin: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        // Create a mock transaction that delegates to the same query handler
        const mockTx = Object.assign(vi.fn(queryHandler), { json: vi.fn((v) => v) });
        return callback(mockTx);
      }),
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

  describe("Ruling (b): Unconfirmed shops are not gated", () => {
    describe("checkCompanyLimit", () => {
      it("allows unconfirmed shop over none limit with gating ON", async () => {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "true";
        vi.resetModules();
        const { checkCompanyLimit } = await import("../gating.server");

        // No plan_cached_at means unconfirmed
        mockSql.setMockResult("shop_plan", [{
          plan_key: "none",
          subscription_id: null,
          subscription_name: null,
          is_test: false,
          plan_cached_at: null, // Unconfirmed
        }]);

        // 100 companies would be way over none limit (0)
        mockSql.setMockResult("active_account_count", [{ count: "100" }]);

        const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain("Plan not confirmed");
      });

      it("blocks confirmed none shop over limit with gating ON", async () => {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "true";
        vi.resetModules();
        const { checkCompanyLimit } = await import("../gating.server");

        // plan_cached_at set means confirmed
        mockSql.setMockResult("shop_plan", [{
          plan_key: "none",
          subscription_id: null,
          subscription_name: null,
          is_test: false,
          plan_cached_at: new Date(), // Confirmed
        }]);

        // 3 companies at none limit (0)
        mockSql.setMockResult("active_account_count", [{ count: "3" }]);

        const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

        expect(result.allowed).toBe(false);
        expect(result.reason).toContain("Company limit reached");
      });

      it("allows everything when gating flag is false", async () => {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
        vi.resetModules();
        const { checkCompanyLimit } = await import("../gating.server");

        // Even with a confirmed shop over limit
        mockSql.setMockResult("shop_plan", [{
          plan_key: "none",
          subscription_id: null,
          subscription_name: null,
          is_test: false,
          plan_cached_at: new Date(), // Confirmed
        }]);
        mockSql.setMockResult("active_account_count", [{ count: "100" }]);

        const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain("Gating not enforced");
      });
    });

    describe("checkImportLimit", () => {
      it("allows unconfirmed shop over none limit with gating ON", async () => {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "true";
        vi.resetModules();
        const { checkImportLimit } = await import("../gating.server");

        // No plan_cached_at means unconfirmed
        mockSql.setMockResult("shop_plan", [{
          plan_key: "none",
          subscription_id: null,
          subscription_name: null,
          is_test: false,
          plan_cached_at: null, // Unconfirmed
        }]);

        // 100 imports would be way over none limit
        mockSql.setMockResult("import_count", [{ count: "100" }]);

        const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain("Plan not confirmed");
      });

      it("allows confirmed none shop imports (imports are unlimited on all plans)", async () => {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "true";
        vi.resetModules();
        const { checkImportLimit } = await import("../gating.server");

        // plan_cached_at set means confirmed
        mockSql.setMockResult("shop_plan", [{
          plan_key: "none",
          subscription_id: null,
          subscription_name: null,
          is_test: false,
          plan_cached_at: new Date(), // Confirmed
        }]);

        // Even with many imports, should be allowed (unlimited on all plans)
        mockSql.setMockResult("import_count", [{ count: "100" }]);

        const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

        // Imports are unlimited (-1) on all plans including 'none'
        expect(result.allowed).toBe(true);
        expect(result.limit).toBe(-1);
      });

      it("allows everything when gating flag is false", async () => {
        (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
        vi.resetModules();
        const { checkImportLimit } = await import("../gating.server");

        // Even with a confirmed shop over limit
        mockSql.setMockResult("shop_plan", [{
          plan_key: "none",
          subscription_id: null,
          subscription_name: null,
          is_test: false,
          plan_cached_at: new Date(), // Confirmed
        }]);
        mockSql.setMockResult("import_count", [{ count: "100" }]);

        const result = await checkImportLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

        expect(result.allowed).toBe(true);
        expect(result.reason).toContain("Gating not enforced");
      });
    });
  });

  describe("checkCompanyLimit with gating ON", () => {
    beforeEach(() => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    });

    it("allows creation when under limit", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Starter plan cached (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 10 active companies exist (limit is 25)
      mockSql.setMockResult("active_account_count", [{ count: "10" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(10);
      expect(result.limit).toBe(25);
    });

    it("blocks creation at limit (25th company boundary on starter)", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Starter plan cached (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 25 active companies exist (at limit)
      mockSql.setMockResult("active_account_count", [{ count: "25" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(result.allowed).toBe(false);
      expect(result.currentUsage).toBe(25);
      expect(result.limit).toBe(25);
      expect(result.reason).toContain("Company limit reached");
    });

    it("excludes gated accounts from count", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Starter plan cached (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 10 active accounts (gated ones not counted)
      // This simulates having 30 total accounts but only 10 active
      mockSql.setMockResult("active_account_count", [{ count: "10" }]);
      
      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      // Should allow because only 10 active, even if there are more gated
      expect(result.allowed).toBe(true);
      expect(result.currentUsage).toBe(10);
    });

    it("allows creation on unlimited plan", async () => {
      vi.resetModules();
      const { checkCompanyLimit } = await import("../gating.server");
      
      // Unlimited plan cached
      mockSql.setMockResult("shop_plan", [{
        plan_key: "unlimited",
        subscription_id: "sub-123",
        subscription_name: "Unlimited",
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
      
      // Set plan to growth (limit 100)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 2 active accounts currently
      mockSql.setMockResult("active_account_count", [{ count: "2" }]);
      
      // Reactivation updates 3 accounts
      mockSql.setMockResult("reactivate_result", { count: 3 });
      
      // Reads plan from DB
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID
      );
      
      // Should have reactivated accounts
      expect(reactivated).toBe(3);
    });

    it("reactivates all gated accounts on upgrade to unlimited", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { reactivateGatedAccounts } = await import("../gating.server");
      
      // Set plan to unlimited (-1)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "unlimited",
        subscription_id: "sub-123",
        subscription_name: "Unlimited",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // Reactivation updates 50 accounts
      mockSql.setMockResult("reactivate_result", { count: 50 });
      
      // Reads plan from DB
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID
      );
      
      expect(reactivated).toBe(50);
    });

    it("reactivates nothing when already at limit", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { reactivateGatedAccounts } = await import("../gating.server");
      
      // Set plan to starter (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // Already at starter limit (25)
      mockSql.setMockResult("active_account_count", [{ count: "25" }]);
      
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID
      );
      
      expect(reactivated).toBe(0);
    });

    it("reactivates gated accounts even when flag is off", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { reactivateGatedAccounts } = await import("../gating.server");
      
      // Set plan to starter (limit 25) - plan lookup still happens
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // Currently 10 active accounts
      mockSql.setMockResult("active_account_count", [{ count: "10" }]);
      
      // Reactivation updates 5 accounts (15 slots available, 5 gated)
      mockSql.setMockResult("reactivate_result", { count: 5 });
      
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID
      );
      
      // Rows MUST be reactivated even when flag is off
      expect(reactivated).toBe(5);
    });
  });

  describe("enforceCompanyLimit", () => {
    it("succeeds when under limit", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { enforceCompanyLimit } = await import("../gating.server");
      
      // Starter plan with 10 active accounts (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      // checkCompanyLimit uses gated_at IS NULL, so set active_account_count
      mockSql.setMockResult("active_account_count", [{ count: "10" }]);
      
      await expect(enforceCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID)).resolves.toBeUndefined();
    });

    it("throws UpgradeRequiredError when limit exceeded", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { enforceCompanyLimit, UpgradeRequiredError } = await import("../gating.server");
      
      // Starter plan at limit (25 active accounts, limit is 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      // checkCompanyLimit uses gated_at IS NULL, so set active_account_count
      mockSql.setMockResult("active_account_count", [{ count: "25" }]);
      
      await expect(enforceCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID))
        .rejects.toThrow(UpgradeRequiredError);
    });
  });

  describe("UpgradeRequiredError", () => {
    it("has correct properties", async () => {
      const { UpgradeRequiredError } = await import("../gating.server");
      
      const error = new UpgradeRequiredError("companies", 25, 25);
      
      expect(error.name).toBe("UpgradeRequiredError");
      expect(error.limitType).toBe("companies");
      expect(error.currentUsage).toBe(25);
      expect(error.limit).toBe(25);
      expect(error.message).toContain("Upgrade required");
      expect(error.message).toContain("25/25");
    });
  });

  describe("decideNewAccountGate", () => {
    it("does not query plans table (limit passed as parameter)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { decideNewAccountGate } = await import("../gating.server");
      
      // Track all SQL calls made during decideNewAccountGate
      const sqlCalls: string[] = [];
      const trackingTx = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          sqlCalls.push(query);
          // Mock pg_advisory_xact_lock
          if (query.includes('pg_advisory_xact_lock')) {
            return [];
          }
          // Mock active account count
          if (query.includes('COUNT')) {
            return [{ count: "5" }];
          }
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      // Call decideNewAccountGate with limit already resolved (10)
      const decision = await decideNewAccountGate(
        trackingTx as unknown as Sql,
        TEST_SHOP_ID,
        10
      );
      
      // Verify no plan lookup occurred - decideNewAccountGate should NOT query plans
      const planQueries = sqlCalls.filter(
        q => q.includes('plan_key') || q.includes('plan_cached_at') || q.includes('"Shop"')
      );
      expect(planQueries).toHaveLength(0);
      
      // Verify basic gating decision worked
      expect(decision.gate).toBe(false); // 5 active, limit 10, not at limit
      expect(decision.limit).toBe(10);
      expect(decision.used).toBe(5);
    });

    it("returns gate: false without querying when flag is off", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
      vi.resetModules();
      const { decideNewAccountGate } = await import("../gating.server");
      
      // Track SQL calls
      const sqlCalls: string[] = [];
      const trackingTx = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          sqlCalls.push(strings.join("?"));
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      const decision = await decideNewAccountGate(
        trackingTx as unknown as Sql,
        TEST_SHOP_ID,
        10
      );
      
      // When flag is off, should return early with no SQL calls
      expect(sqlCalls).toHaveLength(0);
      expect(decision.gate).toBe(false);
      expect(decision.limit).toBe(-1);
    });

    it("returns gate: false without querying when limit is -1 (unlimited)", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { decideNewAccountGate } = await import("../gating.server");
      
      // Track SQL calls
      const sqlCalls: string[] = [];
      const trackingTx = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          sqlCalls.push(strings.join("?"));
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      const decision = await decideNewAccountGate(
        trackingTx as unknown as Sql,
        TEST_SHOP_ID,
        -1  // unlimited
      );
      
      // When limit is -1, should return early with no SQL calls
      expect(sqlCalls).toHaveLength(0);
      expect(decision.gate).toBe(false);
      expect(decision.limit).toBe(-1);
    });
  });

  describe("Over-limit then upgrade scenario", () => {
    it("gated accounts appear after upgrade", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { checkCompanyLimit, reactivateGatedAccounts } = await import("../gating.server");
      
      // Starter plan, 25 active accounts (at limit)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockSql.setMockResult("active_account_count", [{ count: "25" }]);
      
      // Creating 26th account should be blocked
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
      
      // Reads plan from DB
      const reactivated = await reactivateGatedAccounts(
        mockSql as unknown as Sql,
        TEST_SHOP_ID
      );
      expect(reactivated).toBe(5);
      
      // After upgrade + reactivation, we have 30 active accounts (limit 100)
      mockSql.setMockResult("active_account_count", [{ count: "30" }]);
      
      const afterUpgrade = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);
      expect(afterUpgrade.allowed).toBe(true);
      expect(afterUpgrade.currentUsage).toBe(30);
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
      
      // Starter plan cached (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // 15 total companies (some might be gated, but we count all when OFF)
      mockSql.setMockResult("account_count", [{ count: "15" }]);
      
      const stats = await getUsageStats(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(stats.companies.current).toBe(15);
      expect(stats.companies.limit).toBe(25);
      // importsThisMonth is always unlimited
      expect(stats.importsThisMonth.limit).toBe(-1);
    });

    it("counts only non-gated companies when gating is ON", async () => {
      (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
      vi.resetModules();
      const { getUsageStats } = await import("../gating.server");
      
      // Starter plan cached (limit 25)
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-123",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      
      // The query with gated_at IS NULL filter returns active count
      mockSql.setMockResult("active_account_count", [{ count: "15" }]);
      
      const stats = await getUsageStats(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      // Should return only active (non-gated) count
      expect(stats.companies.current).toBe(15);
      expect(stats.companies.limit).toBe(25);
      // importsThisMonth is always unlimited
      expect(stats.importsThisMonth.limit).toBe(-1);
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

  it("isAccountActive correctly identifies gated accounts with gating ON", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { isAccountActive } = await import("../gating.server");

    // Fetch accounts with gated_at and verify isAccountActive
    const accounts = await sql<{ id: string; name: string; gated_at: Date | null }[]>`
      SELECT id, name, gated_at FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;

    // Explicit length assertions: exactly 2 active and 2 gated
    const activeOnes = accounts.filter(a => a.gated_at === null);
    const gatedOnes = accounts.filter(a => a.gated_at !== null);

    expect(activeOnes.length).toBe(2);
    expect(gatedOnes.length).toBe(2);

    // Active accounts (gated_at IS NULL) should return true
    for (const account of activeOnes) {
      expect(isAccountActive(account.gated_at)).toBe(true);
    }

    // Gated accounts (gated_at IS NOT NULL) should return false
    for (const account of gatedOnes) {
      expect(isAccountActive(account.gated_at)).toBe(false);
    }
  });

  it("isAccountActive treats all accounts as active when gating is OFF", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "false";
    vi.resetModules();
    const { isAccountActive } = await import("../gating.server");

    // Fetch all accounts
    const accounts = await sql<{ id: string; gated_at: Date | null }[]>`
      SELECT id, gated_at FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;

    // Explicit length assertions: 4 total (2 with gated_at NULL, 2 with gated_at set)
    const withNullGatedAt = accounts.filter(a => a.gated_at === null);
    const withSetGatedAt = accounts.filter(a => a.gated_at !== null);

    expect(withNullGatedAt.length).toBe(2);
    expect(withSetGatedAt.length).toBe(2);

    // When gating is OFF, all accounts should be treated as active
    for (const account of accounts) {
      expect(isAccountActive(account.gated_at)).toBe(true);
    }
  });
});

/**
 * DB-backed tests for inactive-tag exclusion (Item 3).
 * TAGGED_CUSTOMER accounts with s8_tagged_customers.tag_active=false don't count.
 */
describeWithDb("countActiveAccounts inactive-tag exclusion DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-inactivetag";
  const TEST_SHOP_ID = `shop-inactivetag-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `inactivetag-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_CUSTOMER_ID_INACTIVE = `cust-inactive-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID_ACTIVE = `cust-active-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with a starter plan (limit 25)
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt", plan_key, plan_cached_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW(), 'starter', NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("inactive-tag TAGGED_CUSTOMER account doesn't count toward limit", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { countActiveAccounts } = await import("../gating.server");

    // Create a TAGGED_CUSTOMER account
    const accountId = `acc-tagged-inactive-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, gated_at, "createdAt", "updatedAt")
      VALUES (${accountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${TEST_CUSTOMER_ID_INACTIVE}, 'Tagged Customer Inactive', NULL, NOW(), NOW())
    `;

    // Mark tag as inactive in s8_tagged_customers (schema has 'tags' JSONB array, not 'tag')
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID_INACTIVE}, '["wholesale"]'::jsonb, false, NOW())
    `;

    // Count should exclude the inactive-tag account
    const count = await countActiveAccounts(sql, TEST_SHOP_ID);
    expect(count).toBe(0);
  });

  it("active-tag TAGGED_CUSTOMER account counts toward limit", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { countActiveAccounts } = await import("../gating.server");

    // Create another TAGGED_CUSTOMER account with active tag
    const accountId = `acc-tagged-active-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "customerId", name, gated_at, "createdAt", "updatedAt")
      VALUES (${accountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER', ${TEST_CUSTOMER_ID_ACTIVE}, 'Tagged Customer Active', NULL, NOW(), NOW())
    `;

    // Mark tag as active in s8_tagged_customers (schema has 'tags' JSONB array, not 'tag')
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID_ACTIVE}, '["wholesale"]'::jsonb, true, NOW())
    `;

    // Count should include the active-tag account but not the inactive one
    // We have 1 inactive-tag account from previous test, 1 active-tag account
    const count = await countActiveAccounts(sql, TEST_SHOP_ID);
    expect(count).toBe(1);
  });

  it("COMPANY accounts always count (no tag_active check)", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { countActiveAccounts } = await import("../gating.server");

    // Create a COMPANY account
    const accountId = `acc-company-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES (${accountId}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-" + TEST_SUFFIX}, ${"loc-" + TEST_SUFFIX}, 'Company Account', NULL, NOW(), NOW())
    `;

    // Count should be 2: 1 active-tag TAGGED_CUSTOMER + 1 COMPANY
    // (inactive-tag TAGGED_CUSTOMER still doesn't count)
    const count = await countActiveAccounts(sql, TEST_SHOP_ID);
    expect(count).toBe(2);
  });

  it("re-activating tag doesn't change gated_at", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();

    // The inactive-tag account already exists with gated_at = NULL
    // Re-activate the tag
    await sql`
      UPDATE s8_tagged_customers
      SET tag_active = true
      WHERE shop_id = ${TEST_SHOP_ID}
        AND customer_id = ${TEST_CUSTOMER_ID_INACTIVE}
    `;

    // Verify gated_at is still NULL (re-activation doesn't change it)
    const [account] = await sql<{ gated_at: Date | null }[]>`
      SELECT gated_at FROM "BuyerAccount"
      WHERE "shopId" = ${TEST_SHOP_ID}
        AND "customerId" = ${TEST_CUSTOMER_ID_INACTIVE}
    `;

    expect(account.gated_at).toBeNull();

    // Now count should include this account (tag is active again)
    const { countActiveAccounts } = await import("../gating.server");
    const count = await countActiveAccounts(sql, TEST_SHOP_ID);
    expect(count).toBe(3); // 2 TAGGED_CUSTOMER (both active now) + 1 COMPANY
  });
});

/**
 * DB-backed tests for flag-off inertness (Item 4).
 * When PLAN_GATING_ENFORCED=false, creates stay ungated and no lock is taken.
 */
describeWithDb("decideNewAccountGate flag-off inertness DB integration", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-flagoff";
  const TEST_SHOP_ID = `shop-flagoff-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `flagoff-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with "none" plan (limit 0)
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt", plan_key, plan_cached_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW(), 'none', NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("flag-on with limit=0: new accounts ARE gated", async () => {
    (process.env as Record<string, string>).PLAN_GATING_ENFORCED = "1";
    vi.resetModules();
    const { decideNewAccountGate } = await import("../gating.server");

    // Shop has plan_key='none' which has limit=0
    // When flag is ON, this SHOULD gate the account
    // Caller looks up limit BEFORE sql.begin and passes it as parameter
    const limit = 0;

    const decision = await sql.begin(async (tx) => {
      return decideNewAccountGate(tx, TEST_SHOP_ID, limit);
    });

    // With flag on and limit=0, gate should be true
    expect(decision.gate).toBe(true);
    expect(decision.limit).toBe(0);

    // Create an account based on the decision
    const accountId = `acc-flagon-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES (
        ${accountId},
        ${TEST_SHOP_ID},
        'COMPANY',
        ${"co-flagon-" + TEST_SUFFIX},
        ${"loc-flagon-" + TEST_SUFFIX},
        'Flag On Test Account',
        ${decision.gate ? sql`NOW()` : sql`NULL`},
        NOW(),
        NOW()
      )
    `;

    // Verify account was created WITH gated_at
    const [account] = await sql<{ gated_at: Date | null }[]>`
      SELECT gated_at FROM "BuyerAccount" WHERE id = ${accountId}
    `;
    expect(account.gated_at).not.toBeNull();
  });
});
