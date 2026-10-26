/**
 * Explicit tests for Team Lead rulings 2026-10-25.
 *
 * These tests verify the specific rulings made by the Team Lead during QA review:
 *
 * (1) Unconfirmed shops are not gated (ruling b)
 * (2) Partner outage falls back to last confirmed plan
 * (3) 'none' only from confirmed no-subscription answer; errors return 'unknown'
 * (4) Hold enforcement runs regardless of plan
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-ruling-test-123";
const TEST_SHOP_GID = "gid://shopify/Shop/1";
const TEST_APP_GID = "gid://shopify/App/1";
const TEST_ORG_ID = "123";
const TEST_TOKEN = "test-partner-token-not-real";

vi.mock("../drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
}));

vi.mock("~/lib/sentry", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureExceptionWithTags: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { adminGraphQL as _adminGraphQL } from "../drain/admin-client.server";
import {
  getPlanSource,
  _resetInFlightRefreshesForTesting,
  _resetPartnerCachesForTesting,
  isPlanConfirmed,
} from "../plan.server";
import {
  checkCompanyLimit,
} from "../gating.server";

const adminGraphQL = _adminGraphQL as ReturnType<typeof vi.fn>;

const createMockSql = () => {
  const mockResults: Map<string, unknown[]> = new Map();

  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");

      if (query.includes("plan_key") && query.includes("plan_cached_at")) {
        return mockResults.get("shop_plan") ?? [];
      }

      if (query.includes("UPDATE") && query.includes("plan_key")) {
        return [];
      }

      if (query.includes("SELECT") && query.includes('"Shop"') && query.includes("id")) {
        return mockResults.get("shop_id") ?? [];
      }

      if (query.includes("SELECT") && query.includes("domain")) {
        return mockResults.get("shop_domain") ?? [];
      }

      if (query.includes('COUNT') && query.includes('"BuyerAccount"')) {
        return mockResults.get("buyer_account_count") ?? [{ count: "0" }];
      }

      if (query.includes('COUNT') && query.includes('"BankImport"')) {
        return mockResults.get("bank_import_count") ?? [{ count: "0" }];
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

const setPartnerEnv = () => {
  vi.stubEnv("PLAN_SOURCE", "partner_api");
  vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", TEST_ORG_ID);
  vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", TEST_TOKEN);
  vi.stubEnv("SHOPIFY_APP_GID", TEST_APP_GID);
};

const clearEnv = () => {
  vi.unstubAllEnvs();
  vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", "");
};

const mockPartnerApiResponse = (data: unknown, status = 200) => {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
};

const mockShopGidResponse = (gid: string = TEST_SHOP_GID) => {
  adminGraphQL.mockResolvedValueOnce({
    success: true,
    data: { shop: { id: gid } },
  });
};

describe("Team Lead ruling 2026-10-25: plan resolution", () => {
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql = createMockSql();
    _resetInFlightRefreshesForTesting();
    _resetPartnerCachesForTesting();
    clearEnv();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
    clearEnv();
  });

  describe("(1) Unconfirmed shop is not gated", () => {
    it("isPlanConfirmed returns false when plan_cached_at is null", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "none",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: null, // Unconfirmed
      }]);

      const confirmed = await isPlanConfirmed(mockSql as unknown as Sql, TEST_SHOP_ID);
      expect(confirmed).toBe(false);
    });

    it("isPlanConfirmed returns true when plan_cached_at is set", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "none",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(),
      }]);

      const confirmed = await isPlanConfirmed(mockSql as unknown as Sql, TEST_SHOP_ID);
      expect(confirmed).toBe(true);
    });

    it("checkCompanyLimit allows unconfirmed shop over none limit with gating ON", async () => {
      vi.stubEnv("PLAN_GATING_ENFORCED", "1");
      mockSql.setMockResult("shop_plan", [{
        plan_key: "none",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: null, // Unconfirmed
      }]);
      mockSql.setMockResult("buyer_account_count", [{ count: "100" }]); // Way over none limit

      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain("Plan not confirmed");
    });

    it("resolvePlan returns unknown for unconfirmed shop with fetch error", async () => {
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "none",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: null, // Unconfirmed - getCachedPlan returns null
      }]);

      adminGraphQL.mockResolvedValueOnce({
        success: false,
        error: new Error("Network error"),
      });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({
        sql: mockSql as unknown as Sql,
        shopDomain: TEST_SHOP,
        forceRefresh: true,
      });

      expect(result.planKey).toBe("none");
      expect(result.resolutionState).toBe("unknown");
      expect(result.resolutionState).not.toBe("none");
    });

    it("confirmed none shop over limit is blocked with gating ON", async () => {
      vi.stubEnv("PLAN_GATING_ENFORCED", "1");
      mockSql.setMockResult("shop_plan", [{
        plan_key: "none",
        subscription_id: null,
        subscription_name: null,
        is_test: false,
        plan_cached_at: new Date(), // Confirmed
      }]);
      mockSql.setMockResult("buyer_account_count", [{ count: "10" }]); // Over none limit of 1

      const result = await checkCompanyLimit(mockSql as unknown as Sql, TEST_SHOP_ID);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Company limit reached");
    });
  });

  describe("(2) Partner outage falls back to last confirmed plan", () => {
    const freshCacheTime = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago (fresh)

    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-confirmed-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: freshCacheTime, // Confirmed, use forceRefresh to trigger fetch
      }]);
    });

    it("timeout returns confirmed growth with state unknown", async () => {
      mockShopGidResponse();
      mockFetch.mockRejectedValueOnce(Object.assign(new Error("Timeout"), { name: "TimeoutError" }));

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      expect(result.planKey).toBe("growth");
      expect(result.resolutionState).toBe("unknown");
      expect(result.fromCache).toBe(true);
    });

    it("network throw returns confirmed growth with state unknown", async () => {
      mockShopGidResponse();
      mockFetch.mockRejectedValueOnce(new Error("Network failure"));

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      expect(result.planKey).toBe("growth");
      expect(result.resolutionState).toBe("unknown");
      expect(result.fromCache).toBe(true);
    });

    it("429 returns confirmed growth with state unknown", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse({ errors: [{ message: "Throttled", extensions: { code: "429" } }] }, 429);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      expect(result.planKey).toBe("growth");
      expect(result.resolutionState).toBe("unknown");
      expect(result.fromCache).toBe(true);
    });

    it("500 returns confirmed growth with state unknown", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse({}, 500);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      expect(result.planKey).toBe("growth");
      expect(result.resolutionState).toBe("unknown");
      expect(result.fromCache).toBe(true);
    });

    it("Postgres plan_cached_at is unchanged on error fallback", async () => {
      mockShopGidResponse();
      mockFetch.mockRejectedValueOnce(new Error("Network failure"));

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      // Check that no UPDATE was called on the Shop table
      const sqlMock = mockSql as unknown as { mock: { calls: unknown[][] } };
      const updateCalls = sqlMock.mock.calls.filter(
        (call: unknown[]) => {
          const query = (call[0] as TemplateStringsArray).join("?");
          return query.includes("UPDATE") && query.includes("plan_key");
        }
      );
      expect(updateCalls.length).toBe(0);
    });
  });

  describe("(3) 'none' only from confirmed no-subscription answer", () => {
    describe("Admin source", () => {
      beforeEach(() => {
        mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      });

      it("returns none for 200 with no activeSubscriptions (confirmed answer)", async () => {
        mockSql.setMockResult("shop_plan", []); // No cached plan
        adminGraphQL.mockResolvedValueOnce({
          success: true,
          data: { currentAppInstallation: { activeSubscriptions: [] } },
        });

        const source = getPlanSource();
        const result = await source.resolveActivePlan({
          sql: mockSql as unknown as Sql,
          shopDomain: TEST_SHOP,
          forceRefresh: true,
        });

        expect(result.planKey).toBe("none");
        expect(result.resolutionState).toBe("none");
      });

      it("returns unknown for network error with no cache", async () => {
        mockSql.setMockResult("shop_plan", []);
        adminGraphQL.mockResolvedValueOnce({
          success: false,
          error: new Error("Network error"),
        });

        const source = getPlanSource();
        const result = await source.resolveActivePlan({
          sql: mockSql as unknown as Sql,
          shopDomain: TEST_SHOP,
          forceRefresh: true,
        });

        expect(result.planKey).toBe("none");
        expect(result.resolutionState).toBe("unknown");
      });

      it("returns unknown for network error with cached plan", async () => {
        const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
        mockSql.setMockResult("shop_plan", [{
          plan_key: "starter",
          subscription_id: "sub-123",
          subscription_name: "Starter",
          is_test: false,
          plan_cached_at: staleCacheTime,
        }]);
        adminGraphQL.mockResolvedValueOnce({
          success: false,
          error: new Error("Network error"),
        });

        const source = getPlanSource();
        const result = await source.resolveActivePlan({
          sql: mockSql as unknown as Sql,
          shopDomain: TEST_SHOP,
          forceRefresh: true,
        });

        expect(result.planKey).toBe("starter");
        expect(result.resolutionState).toBe("unknown");
      });

      it("returns unknown when shop not found", async () => {
        mockSql.setMockResult("shop_id", []);

        const source = getPlanSource();
        const result = await source.resolveActivePlan({
          sql: mockSql as unknown as Sql,
          shopDomain: TEST_SHOP,
        });

        expect(result.planKey).toBe("none");
        expect(result.resolutionState).toBe("unknown");
      });
    });

    describe("Partner source", () => {
      const freshCacheTime = new Date(Date.now() - 60 * 60 * 1000);

      beforeEach(() => {
        setPartnerEnv();
        mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      });

      it("returns none for 200 with activeSubscription null (confirmed answer)", async () => {
        mockSql.setMockResult("shop_plan", []);
        mockShopGidResponse();
        mockPartnerApiResponse({ data: { activeSubscription: null } });

        const source = getPlanSource();
        const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

        expect(result.planKey).toBe("none");
        expect(result.resolutionState).toBe("none");
      });

      it("returns unknown for 429 with forceRefresh", async () => {
        mockSql.setMockResult("shop_plan", [{
          plan_key: "starter",
          subscription_id: "sub-456",
          subscription_name: "Starter",
          is_test: false,
          plan_cached_at: freshCacheTime,
        }]);
        mockShopGidResponse();
        mockPartnerApiResponse({}, 429);

        const source = getPlanSource();
        const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

        expect(result.planKey).toBe("starter");
        expect(result.resolutionState).toBe("unknown");
      });

      it("returns unknown for 500 with forceRefresh", async () => {
        mockSql.setMockResult("shop_plan", [{
          plan_key: "unlimited",
          subscription_id: "sub-789",
          subscription_name: "Unlimited",
          is_test: false,
          plan_cached_at: freshCacheTime,
        }]);
        mockShopGidResponse();
        mockPartnerApiResponse({}, 500);

        const source = getPlanSource();
        const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

        expect(result.planKey).toBe("unlimited");
        expect(result.resolutionState).toBe("unknown");
      });

      it("returns unknown for GraphQL error with forceRefresh", async () => {
        mockSql.setMockResult("shop_plan", [{
          plan_key: "growth",
          subscription_id: "sub-growth",
          subscription_name: "Growth",
          is_test: false,
          plan_cached_at: freshCacheTime,
        }]);
        mockShopGidResponse();
        mockPartnerApiResponse({ errors: [{ message: "Internal error" }] });

        const source = getPlanSource();
        const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

        expect(result.planKey).toBe("growth");
        expect(result.resolutionState).toBe("unknown");
      });

      it("returns unknown for network error with no cache", async () => {
        mockSql.setMockResult("shop_plan", []);
        mockShopGidResponse();
        mockFetch.mockRejectedValueOnce(new Error("Network failure"));

        const source = getPlanSource();
        const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

        expect(result.planKey).toBe("none");
        expect(result.resolutionState).toBe("unknown");
      });

      it("returns unknown when shop not found", async () => {
        mockSql.setMockResult("shop_id", []);

        const source = getPlanSource();
        const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

        expect(result.planKey).toBe("none");
        expect(result.resolutionState).toBe("unknown");
      });
    });
  });

  describe("(4) Hold enforcement runs regardless of plan", () => {
    /**
     * Hold enforcement in credit-status.server.ts, overdue.server.ts, and
     * credit-status-recompute.server.ts has NO imports or calls to:
     * - resolvePlan
     * - getPlanByShopId
     * - getPlan
     *
     * This test verifies that hold logic is completely independent of plan.
     * The hold services work with credit limits, overdue states, and hold flags
     * but never check or depend on the shop's subscription plan.
     */
    it("credit-status.server.ts does not import plan functions", async () => {
      // Read the actual file and verify no plan imports
      const fs = await import("fs");
      const path = await import("path");
      const creditStatusPath = path.resolve(__dirname, "../credit-status.server.ts");
      const content = fs.readFileSync(creditStatusPath, "utf-8");

      expect(content).not.toContain("from \"./plan.server\"");
      expect(content).not.toContain("from './plan.server'");
      expect(content).not.toContain("resolvePlan");
      expect(content).not.toContain("getPlanByShopId");
      expect(content).not.toContain("getPlan(");
    });

    it("overdue.server.ts does not import plan functions", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const overduePath = path.resolve(__dirname, "../overdue.server.ts");
      const content = fs.readFileSync(overduePath, "utf-8");

      expect(content).not.toContain("from \"./plan.server\"");
      expect(content).not.toContain("from './plan.server'");
      expect(content).not.toContain("resolvePlan");
      expect(content).not.toContain("getPlanByShopId");
      expect(content).not.toContain("getPlan(");
    });

    it("credit-status-recompute.server.ts does not import plan functions", async () => {
      const fs = await import("fs");
      const path = await import("path");
      const recomputePath = path.resolve(__dirname, "../credit-status-recompute.server.ts");
      const content = fs.readFileSync(recomputePath, "utf-8");

      expect(content).not.toContain("from \"./plan.server\"");
      expect(content).not.toContain("from './plan.server'");
      expect(content).not.toContain("resolvePlan");
      expect(content).not.toContain("getPlanByShopId");
      expect(content).not.toContain("getPlan(");
    });
  });
});
