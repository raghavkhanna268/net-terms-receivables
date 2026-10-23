import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for plan resolution service (S21).
 *
 * Tests verify:
 * 1. No subscription returns 'free' plan
 * 2. Active subscription maps to correct plan
 * 3. Unknown subscription name defaults to 'free'
 * 4. API error defaults to 'free' (fail-to-free)
 * 5. Cache is used when fresh
 * 6. Cache is bypassed when expired
 */

// Mock SQL client
const createMockSql = () => {
  const mockResults: Map<string, unknown[]> = new Map();
  
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      
      // Check for SELECT from Shop with plan columns
      if (query.includes("plan_key") && query.includes("plan_cached_at")) {
        return mockResults.get("shop_plan") ?? [];
      }
      
      // Check for UPDATE Shop plan cache
      if (query.includes("UPDATE") && query.includes("plan_key")) {
        return [];
      }
      
      // Check for SELECT id from Shop
      if (query.includes('SELECT') && query.includes('"Shop"') && query.includes('id')) {
        return mockResults.get("shop_id") ?? [];
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

// Mock adminGraphQL
vi.mock("../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
}));

describe("Plan Resolution Service", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";
  
  let mockSql: ReturnType<typeof createMockSql>;
  let adminGraphQL: ReturnType<typeof vi.fn>;
  
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSql = createMockSql();
    
    const adminClient = await import("../drain/admin-client.server");
    adminGraphQL = adminClient.adminGraphQL as ReturnType<typeof vi.fn>;
  });
  
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("mapSubscriptionToPlanKey", () => {
    it("maps known plan names case-insensitively", async () => {
      const { mapSubscriptionToPlanKey } = await import("~/lib/entitlements");
      
      expect(mapSubscriptionToPlanKey("free")).toBe("free");
      expect(mapSubscriptionToPlanKey("Free")).toBe("free");
      expect(mapSubscriptionToPlanKey("FREE")).toBe("free");
      expect(mapSubscriptionToPlanKey("starter")).toBe("starter");
      expect(mapSubscriptionToPlanKey("Starter")).toBe("starter");
      expect(mapSubscriptionToPlanKey("growth")).toBe("growth");
      expect(mapSubscriptionToPlanKey("Growth")).toBe("growth");
      expect(mapSubscriptionToPlanKey("scale")).toBe("scale");
      expect(mapSubscriptionToPlanKey("Scale")).toBe("scale");
    });

    it("returns null for unknown names", async () => {
      const { mapSubscriptionToPlanKey } = await import("~/lib/entitlements");
      
      expect(mapSubscriptionToPlanKey("premium")).toBeNull();
      expect(mapSubscriptionToPlanKey("enterprise")).toBeNull();
      expect(mapSubscriptionToPlanKey("")).toBeNull();
      expect(mapSubscriptionToPlanKey(null)).toBeNull();
      expect(mapSubscriptionToPlanKey(undefined)).toBeNull();
    });
  });

  describe("getPlanConfig", () => {
    it("returns correct limits for free plan", async () => {
      const { getPlanConfig } = await import("~/lib/entitlements");
      
      const plan = getPlanConfig("free");
      expect(plan.key).toBe("free");
      expect(plan.limits.companies).toBe(3);
      expect(plan.limits.importsPerMonth).toBe(1);
      expect(plan.features.has("aging_dashboard")).toBe(true);
      expect(plan.features.has("matching")).toBe(false);
    });

    it("returns correct limits for starter plan", async () => {
      const { getPlanConfig } = await import("~/lib/entitlements");
      
      const plan = getPlanConfig("starter");
      expect(plan.limits.companies).toBe(25);
      expect(plan.limits.importsPerMonth).toBe(-1); // unlimited
      expect(plan.features.has("matching")).toBe(true);
      expect(plan.features.has("reminders")).toBe(true);
    });

    it("returns correct limits for growth plan", async () => {
      const { getPlanConfig } = await import("~/lib/entitlements");
      
      const plan = getPlanConfig("growth");
      expect(plan.limits.companies).toBe(100);
      expect(plan.features.has("credit_holds")).toBe(true);
      expect(plan.features.has("pdf_statements")).toBe(true);
    });

    it("returns unlimited for scale plan", async () => {
      const { getPlanConfig } = await import("~/lib/entitlements");
      
      const plan = getPlanConfig("scale");
      expect(plan.limits.companies).toBe(-1); // unlimited
      expect(plan.features.has("audit_export")).toBe(true);
    });
  });

  describe("isLimitExceeded", () => {
    it("returns false for unlimited limits", async () => {
      const { getPlanConfig, isLimitExceeded } = await import("~/lib/entitlements");
      
      const scalePlan = getPlanConfig("scale");
      expect(isLimitExceeded(scalePlan, "companies", 0)).toBe(false);
      expect(isLimitExceeded(scalePlan, "companies", 100)).toBe(false);
      expect(isLimitExceeded(scalePlan, "companies", 10000)).toBe(false);
    });

    it("returns true when at or over limit", async () => {
      const { getPlanConfig, isLimitExceeded } = await import("~/lib/entitlements");
      
      const freePlan = getPlanConfig("free");
      expect(isLimitExceeded(freePlan, "companies", 2)).toBe(false);
      expect(isLimitExceeded(freePlan, "companies", 3)).toBe(true);
      expect(isLimitExceeded(freePlan, "companies", 4)).toBe(true);
    });
  });

  describe("resolvePlan", () => {
    it("returns free plan when shop not found", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop not found
      mockSql.setMockResult("shop_id", []);
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      
      expect(result.plan.key).toBe("free");
      expect(result.fromCache).toBe(false);
    });

    it("returns cached plan when cache is fresh", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop exists
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      // Fresh cache (cached 1 hour ago)
      const freshCacheTime = new Date(Date.now() - 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: freshCacheTime,
      }]);
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      
      expect(result.plan.key).toBe("growth");
      expect(result.fromCache).toBe(true);
      expect(adminGraphQL).not.toHaveBeenCalled();
    });

    it("fetches from Shopify when cache is expired", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop exists
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      // Expired cache (cached 7 hours ago)
      const expiredCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "free",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: expiredCacheTime,
      }]);
      
      // Mock Shopify response with active subscription
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/123",
              name: "Starter",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      
      expect(result.plan.key).toBe("starter");
      expect(result.fromCache).toBe(false);
      expect(adminGraphQL).toHaveBeenCalled();
    });

    it("returns free plan when no active subscription", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
      
      // No subscriptions
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      expect(result.plan.key).toBe("free");
      expect(result.subscriptionId).toBeNull();
    });

    it("returns free plan for unknown subscription name", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
      
      // Unknown subscription name
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/123",
              name: "Unknown Plan",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      expect(result.plan.key).toBe("free");
      expect(result.subscriptionName).toBe("Unknown Plan");
    });

    it("returns free plan on API error (fail-to-free)", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
      
      // API error
      adminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Network error",
        retryable: true,
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      expect(result.plan.key).toBe("free");
      expect(result.fromCache).toBe(false);
    });

    it("correctly identifies test subscriptions", async () => {
      const { resolvePlan } = await import("../plan.server");
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
      
      // Test subscription
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/123",
              name: "Growth",
              status: "ACTIVE",
              test: true,
              lineItems: [],
            }],
          },
        },
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      expect(result.plan.key).toBe("growth");
      expect(result.isTest).toBe(true);
    });
  });
});
