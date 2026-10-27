import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests for resolvePlanWithStatus in plan.server.ts.
 *
 * Status determination:
 * - "active": Confirmed active subscription exists
 * - "none": Confirmed no active subscription (API succeeded, no subscription)
 * - "error": Lookup failed (API error, no shop, exception thrown)
 */

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-123";

const createMockSqlFn = () =>
  vi.fn().mockImplementation(() => Promise.resolve([]));

const mockSql = Object.assign(createMockSqlFn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((arr: unknown[]) => arr),
  unsafe: vi.fn((s: string) => s),
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(createMockSqlFn(), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  }),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
}));

const mockAdminGraphQL = vi.fn();
vi.mock("../drain/admin-client.server", () => ({
  adminGraphQL: (shop: string, query: string) => mockAdminGraphQL(shop, query),
}));

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn((e) => String(e)),
  shopHash: vi.fn().mockResolvedValue("hashed"),
}));

vi.mock("~/lib/sentry", () => ({
  captureMessage: vi.fn(),
  captureExceptionWithTags: vi.fn(),
}));

describe("resolvePlanWithStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id FROM") && query.includes("Shop")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }

      if (query.includes("SELECT") && query.includes("plan_key")) {
        return Promise.resolve([]);
      }

      if (query.includes("UPDATE")) {
        return Promise.resolve([]);
      }

      return Promise.resolve([]);
    });
  });

  describe("status mapping", () => {
    it("returns status 'active' when API returns an active subscription", async () => {
      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/123",
                name: "Starter",
                status: "ACTIVE",
                test: false,
                lineItems: [],
              },
            ],
          },
        },
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("active");
      expect(result.plan.subscriptionId).toBe("gid://shopify/AppSubscription/123");
      expect(result.plan.plan.key).toBe("starter");
    });

    it("returns status 'none' when API succeeds but no active subscription", async () => {
      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("none");
      expect(result.plan.subscriptionId).toBeNull();
      expect(result.plan.plan.key).toBe("none");
    });

    it("returns status 'error' when API call fails", async () => {
      mockAdminGraphQL.mockResolvedValue({
        success: false,
        error: new Error("API error"),
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("error");
      expect(result.plan.plan.key).toBe("none");
    });

    it("returns status 'error' when shop not found", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");

        if (query.includes("SELECT id FROM") && query.includes("Shop")) {
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("error");
      expect(result.plan.plan.key).toBe("none");
    });

    it("returns status 'error' when exception thrown", async () => {
      mockAdminGraphQL.mockRejectedValue(new Error("Network error"));

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("error");
      expect(result.plan.plan.key).toBe("none");
    });
  });

  describe("cache behavior", () => {
    it("returns status 'active' from fresh cache with subscriptionId", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");

        if (query.includes("SELECT id FROM") && query.includes("Shop")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }

        if (query.includes("SELECT") && query.includes("plan_key")) {
          return Promise.resolve([{
            plan_key: "starter",
            subscription_id: "gid://shopify/AppSubscription/123",
            subscription_name: "Starter",
            is_test: false,
            plan_cached_at: new Date(),
          }]);
        }

        return Promise.resolve([]);
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("active");
      expect(result.plan.fromCache).toBe(true);
      expect(mockAdminGraphQL).not.toHaveBeenCalled();
    });

    it("returns status 'none' from fresh cache without subscriptionId", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");

        if (query.includes("SELECT id FROM") && query.includes("Shop")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }

        if (query.includes("SELECT") && query.includes("plan_key")) {
          return Promise.resolve([{
            plan_key: "none",
            subscription_id: null,
            subscription_name: null,
            is_test: false,
            plan_cached_at: new Date(),
          }]);
        }

        return Promise.resolve([]);
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP);

      expect(result.status).toBe("none");
      expect(result.plan.fromCache).toBe(true);
      expect(mockAdminGraphQL).not.toHaveBeenCalled();
    });

    it("returns status 'error' when fetch fails and using stale cache", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");

        if (query.includes("SELECT id FROM") && query.includes("Shop")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }

        if (query.includes("SELECT") && query.includes("plan_key")) {
          const staleDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
          return Promise.resolve([{
            plan_key: "none",
            subscription_id: null,
            subscription_name: null,
            is_test: false,
            plan_cached_at: staleDate,
          }]);
        }

        return Promise.resolve([]);
      });

      mockAdminGraphQL.mockResolvedValue({
        success: false,
        error: new Error("API error"),
      });

      const { resolvePlanWithStatus } = await import("../plan.server");
      const result = await resolvePlanWithStatus(mockSql, TEST_SHOP, true);

      expect(result.status).toBe("error");
      expect(result.plan.fromCache).toBe(true);
    });
  });

  describe("resolvePlan unchanged behavior", () => {
    it("resolvePlan returns same plan data as before", async () => {
      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/456",
                name: "Growth",
                status: "ACTIVE",
                test: true,
                lineItems: [],
              },
            ],
          },
        },
      });

      const { resolvePlan } = await import("../plan.server");
      const result = await resolvePlan(mockSql, TEST_SHOP);

      expect(result.plan.key).toBe("growth");
      expect(result.subscriptionId).toBe("gid://shopify/AppSubscription/456");
      expect(result.subscriptionName).toBe("Growth");
      expect(result.isTest).toBe(true);
      expect(result.fromCache).toBe(false);
    });

    it("resolvePlan returns none plan when no subscription", async () => {
      mockAdminGraphQL.mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { resolvePlan } = await import("../plan.server");
      const result = await resolvePlan(mockSql, TEST_SHOP);

      expect(result.plan.key).toBe("none");
      expect(result.subscriptionId).toBeNull();
    });

    it("resolvePlan returns none plan on error", async () => {
      mockAdminGraphQL.mockResolvedValue({
        success: false,
        error: new Error("API error"),
      });

      const { resolvePlan } = await import("../plan.server");
      const result = await resolvePlan(mockSql, TEST_SHOP);

      expect(result.plan.key).toBe("none");
    });
  });
});
