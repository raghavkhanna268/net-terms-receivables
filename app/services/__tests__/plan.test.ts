import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";
import { requestContext, type RequestStore } from "~/lib/request-context.server";

/**
 * Tests for plan resolution service (S21).
 *
 * Tests verify:
 * 1. No subscription returns 'free' plan
 * 2. Active subscription maps to correct plan
 * 3. Unknown subscription name defaults to 'free'
 * 4. API error uses cached plan (fail-to-cached), only free when no cache
 * 5. Cache is used when fresh
 * 6. Stale cache returns cached plan and triggers background refresh (via ALS waitUntil)
 * 7. Background refresh is deduplicated (multiple stale requests share one refresh)
 * 8. Background refresh errors are captured to Sentry
 * 9. Background refresh is a no-op when waitUntil is not available
 */

// Mock adminGraphQL before importing plan.server
vi.mock("../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
}));

// Mock Sentry before importing plan.server
vi.mock("~/lib/sentry", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

// Import after mocks are set up
import { adminGraphQL as _adminGraphQL } from "../drain/admin-client.server";
import { captureException as _captureException } from "~/lib/sentry";
import {
  resolvePlan,
  getPlanByShopId,
  _resetInFlightRefreshesForTesting,
  _isRefreshInFlight,
} from "../plan.server";

const adminGraphQL = _adminGraphQL as ReturnType<typeof vi.fn>;
const captureException = _captureException as ReturnType<typeof vi.fn>;

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

      // Check for SELECT domain from Shop
      if (query.includes('SELECT') && query.includes('domain')) {
        return mockResults.get("shop_domain") ?? [];
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

describe("Plan Resolution Service", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";
  
  let mockSql: ReturnType<typeof createMockSql>;
  
  beforeEach(() => {
    // Use resetAllMocks to clear both calls and pending mockResolvedValueOnce
    vi.resetAllMocks();
    mockSql = createMockSql();
    // Clear in-flight refresh map between tests
    _resetInFlightRefreshesForTesting();
  });
  
  afterEach(() => {
    vi.resetAllMocks();
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
      // resolvePlan imported at module scope
      
      // Shop not found
      mockSql.setMockResult("shop_id", []);
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      
      expect(result.plan.key).toBe("free");
      expect(result.fromCache).toBe(false);
    });

    it("returns cached plan when cache is fresh", async () => {
      // resolvePlan imported at module scope
      
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

    it("returns cached plan when stale and triggers background refresh via ALS", async () => {
      // resolvePlan imported at module scope
      
      // Set up mock waitUntil via ALS
      const mockWaitUntil = vi.fn();
      const store: RequestStore = {
        getSql: () => mockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      // Shop exists
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      // Stale cache (cached 7 hours ago)
      const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: staleCacheTime,
      }]);
      
      // Mock Shopify response for background refresh
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{
              id: "gid://shopify/AppSubscription/456",
              name: "Scale",
              status: "ACTIVE",
              test: false,
              lineItems: [],
            }],
          },
        },
      });
      
      // Run within request context so waitUntil is available
      const result = await requestContext.run(store, async () => {
        return resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      });
      
      // Should return stale cached plan immediately
      expect(result.plan.key).toBe("growth");
      expect(result.fromCache).toBe(true);
      
      // Should have triggered background refresh via ALS waitUntil
      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    });

    it("returns free plan when no active subscription and no cache", async () => {
      // resolvePlan imported at module scope
      
      // Shop exists, no plan_key
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: null,
        subscription_id: null,
        subscription_name: null,
        is_test: null,
        plan_cached_at: null,
      }]);
      
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
      // resolvePlan imported at module scope
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: null,
        subscription_id: null,
        subscription_name: null,
        is_test: null,
        plan_cached_at: null,
      }]);
      
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

    it("returns cached plan on API error when cache exists (fail-to-cached)", async () => {
      // resolvePlan imported at module scope
      
      // Shop exists
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      // Cached growth plan
      const cachedTime = new Date(Date.now() - 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: cachedTime,
      }]);
      
      // API error
      adminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Network error",
        retryable: true,
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      // Should return cached plan, not free
      expect(result.plan.key).toBe("growth");
      expect(result.fromCache).toBe(true);
    });

    it("returns free plan on API error when NO cache exists", async () => {
      // resolvePlan imported at module scope
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: null,
        subscription_id: null,
        subscription_name: null,
        is_test: null,
        plan_cached_at: null,
      }]);
      
      // API error
      adminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Network error",
        retryable: true,
      });
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      // No cache exists, so free is correct
      expect(result.plan.key).toBe("free");
      expect(result.fromCache).toBe(false);
    });

    it("returns cached plan on exception when cache exists", async () => {
      // resolvePlan imported at module scope
      
      // Shop exists
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      // Cached starter plan
      const cachedTime = new Date(Date.now() - 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-456",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: cachedTime,
      }]);
      
      // Throw exception
      adminGraphQL.mockRejectedValueOnce(new Error("Connection failed"));
      
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP, true);
      
      // Should return cached plan
      expect(result.plan.key).toBe("starter");
      expect(result.fromCache).toBe(true);
    });

    it("correctly identifies test subscriptions", async () => {
      // resolvePlan imported at module scope
      
      // Shop exists, no cache
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: null,
        subscription_id: null,
        subscription_name: null,
        is_test: null,
        plan_cached_at: null,
      }]);
      
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

  describe("getPlanByShopId", () => {
    it("returns cached plan regardless of staleness", async () => {
      // getPlanByShopId imported at module scope
      
      // Stale cache (7 hours old)
      const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: staleCacheTime,
      }]);
      
      const plan = await getPlanByShopId(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      // Should return growth even though cache is stale
      expect(plan.key).toBe("growth");
    });

    it("returns free plan only when no cache ever existed", async () => {
      // getPlanByShopId imported at module scope
      
      // No cache
      mockSql.setMockResult("shop_plan", [{
        plan_key: null,
        subscription_id: null,
        subscription_name: null,
        is_test: null,
        plan_cached_at: null,
      }]);
      
      const plan = await getPlanByShopId(mockSql as unknown as Sql, TEST_SHOP_ID);
      
      expect(plan.key).toBe("free");
    });

    it("triggers background refresh when stale via ALS", async () => {
      // getPlanByShopId imported at module scope
      
      // Set up mock waitUntil via ALS
      const mockWaitUntil = vi.fn();
      
      // Create a new mock that handles both queries
      const specialMockSql = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          
          // First call: getCachedPlan - returns stale cache
          if (query.includes("plan_key") && query.includes("plan_cached_at")) {
            const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
            return [{
              plan_key: "starter",
              subscription_id: "sub-123",
              subscription_name: "Starter",
              is_test: false,
              plan_cached_at: staleCacheTime,
            }];
          }
          
          // Second call: get domain for background refresh
          if (query.includes("domain") && query.includes('"Shop"')) {
            return [{ domain: TEST_SHOP }];
          }
          
          // Third call: UPDATE for cache refresh
          if (query.includes("UPDATE")) {
            return [];
          }
          
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      // Mock Shopify response
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });
      
      const store: RequestStore = {
        getSql: () => specialMockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      // Run within request context so waitUntil is available
      const plan = await requestContext.run(store, async () => {
        return getPlanByShopId(specialMockSql as unknown as Sql, TEST_SHOP_ID);
      });
      
      // Should return cached plan
      expect(plan.key).toBe("starter");
      
      // Should trigger background refresh via ALS waitUntil
      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    });
  });

  describe("background refresh deduplication", () => {
    it("deduplicates concurrent refreshes for the same shop", async () => {
      const mockWaitUntil = vi.fn();
      
      // Create a mock that simulates the full flow
      let shopifyCallCount = 0;
      const specialMockSql = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          
          if (query.includes("plan_key") && query.includes("plan_cached_at")) {
            // Stale cache
            const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
            return [{
              plan_key: "growth",
              subscription_id: "sub-123",
              subscription_name: "Growth",
              is_test: false,
              plan_cached_at: staleCacheTime,
            }];
          }
          
          if (query.includes('SELECT') && query.includes('"Shop"') && query.includes('id')) {
            return [{ id: TEST_SHOP_ID }];
          }
          
          if (query.includes("UPDATE")) {
            return [];
          }
          
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      // Track Shopify API calls
      adminGraphQL.mockImplementation(async () => {
        shopifyCallCount++;
        // Add small delay to ensure concurrency
        await new Promise(resolve => setTimeout(resolve, 10));
        return {
          success: true,
          data: {
            currentAppInstallation: {
              activeSubscriptions: [{
                id: "gid://shopify/AppSubscription/456",
                name: "Scale",
                status: "ACTIVE",
                test: false,
                lineItems: [],
              }],
            },
          },
        };
      });
      
      const store: RequestStore = {
        getSql: () => specialMockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      // Fire two concurrent resolvePlan calls for the same shop
      const [result1, result2] = await requestContext.run(store, async () => {
        return Promise.all([
          resolvePlan(specialMockSql as unknown as Sql, TEST_SHOP),
          resolvePlan(specialMockSql as unknown as Sql, TEST_SHOP),
        ]);
      });
      
      // Both should return stale cached plan immediately
      expect(result1.plan.key).toBe("growth");
      expect(result2.plan.key).toBe("growth");
      
      // waitUntil should be called twice (both requests register the same promise)
      expect(mockWaitUntil).toHaveBeenCalledTimes(2);
      
      // Wait for background refresh to complete
      const promises = mockWaitUntil.mock.calls.map(call => call[0]);
      await Promise.all(promises);
      
      // Shopify API should only be called once due to deduplication
      expect(shopifyCallCount).toBe(1);
    });

    it("removes shop from in-flight map after refresh completes", async () => {
      const mockWaitUntil = vi.fn();
      
      const specialMockSql = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          
          if (query.includes("plan_key") && query.includes("plan_cached_at")) {
            const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
            return [{
              plan_key: "growth",
              subscription_id: "sub-123",
              subscription_name: "Growth",
              is_test: false,
              plan_cached_at: staleCacheTime,
            }];
          }
          
          if (query.includes('SELECT') && query.includes('"Shop"') && query.includes('id')) {
            return [{ id: TEST_SHOP_ID }];
          }
          
          if (query.includes("UPDATE")) {
            return [];
          }
          
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });
      
      const store: RequestStore = {
        getSql: () => specialMockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      await requestContext.run(store, async () => {
        await resolvePlan(specialMockSql as unknown as Sql, TEST_SHOP);
        
        // Should be in-flight immediately after triggering
        expect(_isRefreshInFlight(TEST_SHOP)).toBe(true);
      });
      
      // Wait for background refresh to complete
      const promise = mockWaitUntil.mock.calls[0][0];
      await promise;
      
      // Should no longer be in-flight after completion
      expect(_isRefreshInFlight(TEST_SHOP)).toBe(false);
    });
  });

  describe("background refresh error handling", () => {
    it("captures errors to Sentry when background refresh fails", async () => {
      const mockWaitUntil = vi.fn();
      const testError = new Error("Shopify API timeout");
      
      const specialMockSql = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          
          if (query.includes("plan_key") && query.includes("plan_cached_at")) {
            const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
            return [{
              plan_key: "starter",
              subscription_id: "sub-123",
              subscription_name: "Starter",
              is_test: false,
              plan_cached_at: staleCacheTime,
            }];
          }
          
          if (query.includes('SELECT') && query.includes('"Shop"') && query.includes('id')) {
            return [{ id: TEST_SHOP_ID }];
          }
          
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      // Throw an error from Shopify API
      adminGraphQL.mockRejectedValueOnce(testError);
      
      const store: RequestStore = {
        getSql: () => specialMockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      const result = await requestContext.run(store, async () => {
        return resolvePlan(specialMockSql as unknown as Sql, TEST_SHOP);
      });
      
      // Should still return stale cached plan
      expect(result.plan.key).toBe("starter");
      expect(result.fromCache).toBe(true);
      
      // Wait for background refresh to complete (and fail)
      const promise = mockWaitUntil.mock.calls[0][0];
      await promise;
      
      // Should have captured the error to Sentry
      expect(captureException).toHaveBeenCalledWith(testError);
    });

    it("removes shop from in-flight map even when refresh fails", async () => {
      const mockWaitUntil = vi.fn();
      
      const specialMockSql = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          
          if (query.includes("plan_key") && query.includes("plan_cached_at")) {
            const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
            return [{
              plan_key: "growth",
              subscription_id: "sub-123",
              subscription_name: "Growth",
              is_test: false,
              plan_cached_at: staleCacheTime,
            }];
          }
          
          if (query.includes('SELECT') && query.includes('"Shop"') && query.includes('id')) {
            return [{ id: TEST_SHOP_ID }];
          }
          
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      adminGraphQL.mockRejectedValueOnce(new Error("Network error"));
      
      const store: RequestStore = {
        getSql: () => specialMockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      await requestContext.run(store, async () => {
        await resolvePlan(specialMockSql as unknown as Sql, TEST_SHOP);
        expect(_isRefreshInFlight(TEST_SHOP)).toBe(true);
      });
      
      // Wait for background refresh to fail
      const promise = mockWaitUntil.mock.calls[0][0];
      await promise;
      
      // Should be removed from in-flight map after failure
      expect(_isRefreshInFlight(TEST_SHOP)).toBe(false);
    });
  });

  describe("background refresh no-op behavior", () => {
    it("is a no-op when waitUntil is not available (outside request context)", async () => {
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: staleCacheTime,
      }]);
      
      // Call without request context - no waitUntil available
      const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      
      // Should return stale cached plan
      expect(result.plan.key).toBe("growth");
      expect(result.fromCache).toBe(true);
      
      // Shopify API should NOT be called (no background refresh)
      expect(adminGraphQL).not.toHaveBeenCalled();
      
      // Should not be in-flight (refresh was not triggered)
      expect(_isRefreshInFlight(TEST_SHOP)).toBe(false);
    });

    it("does not trigger background refresh when cache is fresh", async () => {
      const mockWaitUntil = vi.fn();
      
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      
      // Fresh cache (cached 1 hour ago, TTL is 6 hours)
      const freshCacheTime = new Date(Date.now() - 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: freshCacheTime,
      }]);
      
      const store: RequestStore = {
        getSql: () => mockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      const result = await requestContext.run(store, async () => {
        return resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      });
      
      // Should return cached plan
      expect(result.plan.key).toBe("growth");
      expect(result.fromCache).toBe(true);
      
      // waitUntil should NOT be called (cache is fresh)
      expect(mockWaitUntil).not.toHaveBeenCalled();
      
      // Shopify API should NOT be called
      expect(adminGraphQL).not.toHaveBeenCalled();
    });

    it("does not block or await the refresh in the response path", async () => {
      const mockWaitUntil = vi.fn();
      let refreshCompleted = false;
      
      const specialMockSql = Object.assign(
        vi.fn(async (strings: TemplateStringsArray) => {
          const query = strings.join("?");
          
          if (query.includes("plan_key") && query.includes("plan_cached_at")) {
            const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
            return [{
              plan_key: "growth",
              subscription_id: "sub-123",
              subscription_name: "Growth",
              is_test: false,
              plan_cached_at: staleCacheTime,
            }];
          }
          
          if (query.includes('SELECT') && query.includes('"Shop"') && query.includes('id')) {
            return [{ id: TEST_SHOP_ID }];
          }
          
          if (query.includes("UPDATE")) {
            return [];
          }
          
          return [];
        }),
        { json: vi.fn((v) => v) }
      );
      
      // Track refresh completion
      adminGraphQL.mockImplementation(async () => {
        // Simulate slow API call
        await new Promise(resolve => setTimeout(resolve, 50));
        refreshCompleted = true;
        return {
          success: true,
          data: {
            currentAppInstallation: {
              activeSubscriptions: [{
                id: "gid://shopify/AppSubscription/456",
                name: "Scale",
                status: "ACTIVE",
                test: false,
                lineItems: [],
              }],
            },
          },
        };
      });
      
      const store: RequestStore = {
        getSql: () => specialMockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };
      
      const result = await requestContext.run(store, async () => {
        return resolvePlan(specialMockSql as unknown as Sql, TEST_SHOP);
      });
      
      // Response should be returned before refresh completes
      expect(result.plan.key).toBe("growth");
      expect(result.fromCache).toBe(true);
      expect(refreshCompleted).toBe(false);
      
      // Now wait for the background refresh
      const promise = mockWaitUntil.mock.calls[0][0];
      await promise;
      
      // Refresh should now be completed
      expect(refreshCompleted).toBe(true);
    });
  });
});
