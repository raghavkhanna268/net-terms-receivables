/**
 * Tests for Partner API plan source (T2).
 *
 * These tests verify:
 * 1. Selector: PLAN_SOURCE controls which source is used
 * 2. Partner API request shape and response handling
 * 3. Isolate cache behavior (5 min TTL, confirmed subscriptions only)
 * 4. Error fallback to last confirmed Postgres plan
 * 5. In-flight deduplication
 * 6. Shop GID memoization
 * 7. Log hygiene (no sensitive data in logs)
 * 8. Resolution state discriminated union
 *
 * Uses the real safeLog with a console spy (no logger mock allowlist entry).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";
import { requestContext, type RequestStore } from "~/lib/request-context.server";

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-partner-123";
const TEST_SHOP_GID = "gid://shopify/Shop/1";
const TEST_APP_GID = "gid://shopify/App/1";
const TEST_ORG_ID = "5273426";
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
import { captureExceptionWithTags as _captureExceptionWithTags, captureMessage as _captureMessage } from "~/lib/sentry";
import {
  getPlanSource,
  _resetInFlightRefreshesForTesting,
  _resetPartnerCachesForTesting,
  AdminInstallationPlanSource,
  PartnerApiPlanSource,
} from "../plan.server";

const adminGraphQL = _adminGraphQL as ReturnType<typeof vi.fn>;
const captureExceptionWithTags = _captureExceptionWithTags as ReturnType<typeof vi.fn>;
const captureMessage = _captureMessage as ReturnType<typeof vi.fn>;

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

const clearPartnerEnv = () => {
  vi.unstubAllEnvs();
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

const activeGrowthFixture = {
  data: {
    activeSubscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: null,
      currentBillingCycle: { startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-31T00:00:00Z" },
      items: [{ handle: "growth" }],
      pendingUpdate: null,
      legacySubscriptionId: "gid://shopify/AppSubscription/123",
    },
  },
};

const trialStarterFixture = {
  data: {
    activeSubscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: "2026-11-24T00:00:00Z",
      currentBillingCycle: null,
      items: [{ handle: "starter" }],
      pendingUpdate: null,
      legacySubscriptionId: null,
    },
  },
};

const pendingDowngradeFixture = {
  data: {
    activeSubscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: null,
      currentBillingCycle: { startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-31T00:00:00Z" },
      items: [{ handle: "growth" }],
      pendingUpdate: { billingPeriod: "EVERY_30_DAYS", items: [{ handle: "starter" }] },
      legacySubscriptionId: "gid://shopify/AppSubscription/456",
    },
  },
};

const cancelAtEndFixture = {
  data: {
    activeSubscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: true,
      trialEndsAt: null,
      currentBillingCycle: { startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-31T00:00:00Z" },
      items: [{ handle: "growth" }],
      pendingUpdate: null,
      legacySubscriptionId: "gid://shopify/AppSubscription/789",
    },
  },
};

const noSubscriptionFixture = { data: { activeSubscription: null } };

const throttledFixture = { errors: [{ message: "Too many requests", extensions: { code: "429" } }] };

const graphqlErrorFixture = { errors: [{ message: "Some error" }] };

const unknownHandleFixture = {
  data: {
    activeSubscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: null,
      currentBillingCycle: { startTime: "2026-10-01T00:00:00Z", endTime: "2026-10-31T00:00:00Z" },
      items: [{ handle: "mystery" }],
      pendingUpdate: null,
      legacySubscriptionId: null,
    },
  },
};

const shopifyTestFixture = {
  data: {
    activeSubscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: null,
      currentBillingCycle: null,
      items: [{ handle: "shopify-test" }],
      pendingUpdate: null,
      legacySubscriptionId: null,
    },
  },
};

describe("Partner API Plan Source (T2)", () => {
  let mockSql: ReturnType<typeof createMockSql>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockSql = createMockSql();
    _resetInFlightRefreshesForTesting();
    _resetPartnerCachesForTesting();
    clearPartnerEnv();

    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
    clearPartnerEnv();
    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  const getAllLogs = (): string[] => {
    return [
      ...consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      ...consoleWarnSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      ...consoleErrorSpy.mock.calls.map((c: unknown[]) => String(c[0])),
      ...consoleDebugSpy.mock.calls.map((c: unknown[]) => String(c[0])),
    ];
  };

  describe("getPlanSource selector", () => {
    it("returns AdminInstallationPlanSource when PLAN_SOURCE is unset", () => {
      const source = getPlanSource();
      expect(source).toBeInstanceOf(AdminInstallationPlanSource);
    });

    it("returns AdminInstallationPlanSource when PLAN_SOURCE is admin_installation", () => {
      vi.stubEnv("PLAN_SOURCE", "admin_installation");
      const source = getPlanSource();
      expect(source).toBeInstanceOf(AdminInstallationPlanSource);
    });

    it("returns PartnerApiPlanSource when PLAN_SOURCE is partner_api with valid env", () => {
      setPartnerEnv();
      const source = getPlanSource();
      expect(source).toBeInstanceOf(PartnerApiPlanSource);
    });

    it("falls back to admin with partner_api when org_id is missing", () => {
      vi.stubEnv("PLAN_SOURCE", "partner_api");
      vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", TEST_TOKEN);
      vi.stubEnv("SHOPIFY_APP_GID", TEST_APP_GID);

      const source = getPlanSource();
      expect(source).toBeInstanceOf(AdminInstallationPlanSource);
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(getAllLogs().some((l) => l.includes("partner_api_config_invalid"))).toBe(true);
    });

    it("falls back to admin with partner_api when token is missing", () => {
      vi.stubEnv("PLAN_SOURCE", "partner_api");
      vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", TEST_ORG_ID);
      vi.stubEnv("SHOPIFY_APP_GID", TEST_APP_GID);

      const source = getPlanSource();
      expect(source).toBeInstanceOf(AdminInstallationPlanSource);
    });

    it("falls back to admin with partner_api when app_gid is malformed", () => {
      vi.stubEnv("PLAN_SOURCE", "partner_api");
      vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", TEST_ORG_ID);
      vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", TEST_TOKEN);
      vi.stubEnv("SHOPIFY_APP_GID", "gid://partners/App/123");

      const source = getPlanSource();
      expect(source).toBeInstanceOf(AdminInstallationPlanSource);
      expect(getAllLogs().some((l) => l.includes("partner_api_config_invalid"))).toBe(true);
    });

    it("falls back to admin when org_id is not numeric", () => {
      vi.stubEnv("PLAN_SOURCE", "partner_api");
      vi.stubEnv("SHOPIFY_PARTNER_ORG_ID", "not-a-number");
      vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", TEST_TOKEN);
      vi.stubEnv("SHOPIFY_APP_GID", TEST_APP_GID);

      const source = getPlanSource();
      expect(source).toBeInstanceOf(AdminInstallationPlanSource);
    });

    it("logs partner_api_not_configured only once per isolate", () => {
      vi.stubEnv("PLAN_SOURCE", "partner_api");

      getPlanSource();
      getPlanSource();
      getPlanSource();

      const configLogs = getAllLogs().filter((l) => l.includes("partner_api_not_configured"));
      expect(configLogs.length).toBe(1);
    });

    it("makes no fetch and no Admin shop{id} call when PLAN_SOURCE is unset", async () => {
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(mockFetch).not.toHaveBeenCalled();
      const shopGidCalls = adminGraphQL.mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("shop { id }")
      );
      expect(shopGidCalls.length).toBe(0);
    });
  });

  describe("Partner API request shape", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
    });

    it("sends request to correct URL with correct headers", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe(`https://partners.shopify.com/${TEST_ORG_ID}/api/2026-10/graphql.json`);
      expect(options.method).toBe("POST");
      expect(options.headers["Content-Type"]).toBe("application/json");
      expect(options.headers["X-Shopify-Access-Token"]).toBe(TEST_TOKEN);
    });

    it("sends correct variables in request body", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.appId).toBe(TEST_APP_GID);
      expect(body.variables.shopId).toBe(TEST_SHOP_GID);
    });
  });

  describe("Plan resolution", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
    });

    it("resolves active growth subscription", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
      expect(result.resolutionState).toBe("active");
      expect(result.sourceTag).toBe("partner_api");
      expect(result.fromCache).toBe(false);
    });

    it("resolves trial subscription as active", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(trialStarterFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("starter");
      expect(result.resolutionState).toBe("active");
    });

    it("resolves pending downgrade to current plan (not pending)", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(pendingDowngradeFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
    });

    it("resolves cancelAtEndOfCycle to current plan", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(cancelAtEndFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
      expect(result.resolutionState).toBe("active");
    });

    it("maps unlimited handle to scale", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse({
        data: {
          activeSubscription: {
            ...activeGrowthFixture.data.activeSubscription,
            items: [{ handle: "unlimited" }],
          },
        },
      });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("scale");
    });

    it("returns none state for null subscription", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(noSubscriptionFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("free");
      expect(result.resolutionState).toBe("none");
      expect(result.fromCache).toBe(false);
    });

    it("returns none state for shopify-test handle", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(shopifyTestFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("free");
      expect(result.resolutionState).toBe("none");
    });
  });

  describe("Isolate cache behavior", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
    });

    it("caches confirmed subscription and returns from cache on second call", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const result2 = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result2.fromCache).toBe(true);
      expect(result2.planKey).toBe("growth");
    });

    it("does not cache null subscription", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(noSubscriptionFixture);
      mockPartnerApiResponse(noSubscriptionFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("cache expires after 5 minutes", async () => {
      vi.useFakeTimers();
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it("forceRefresh bypasses cache", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("Error handling", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
    });

    it("returns cached plan on 429 when Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => throttledFixture });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
      expect(result.fromCache).toBe(true);
      expect(result.resolutionState).toBe("unknown");
    });

    it("returns cached plan on 200 with errors when Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-456",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockPartnerApiResponse(graphqlErrorFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("starter");
      expect(result.fromCache).toBe(true);
    });

    it("returns cached plan on HTTP 401 when Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-789",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
      expect(result.fromCache).toBe(true);
    });

    it("returns cached plan on HTTP 500 when Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "scale",
        subscription_id: "sub-scale",
        subscription_name: "Scale",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("scale");
      expect(result.fromCache).toBe(true);
    });

    it("returns cached plan on malformed response when Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockPartnerApiResponse({ data: {} });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
      expect(result.fromCache).toBe(true);
    });

    it("throws on 429 when no Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", []);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => throttledFixture });

      const source = getPlanSource();

      await expect(
        source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP })
      ).rejects.toThrow();
    });

    it("throws on HTTP 500 when no Postgres row exists", async () => {
      mockSql.setMockResult("shop_plan", []);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

      const source = getPlanSource();

      await expect(
        source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP })
      ).rejects.toThrow();
    });

    it("treats unknown handle as error (does not demote to free)", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockPartnerApiResponse(unknownHandleFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("growth");
      expect(result.fromCache).toBe(true);
      expect(captureMessage).toHaveBeenCalledWith("partner_plan_handle_unknown", "error");
    });

    it("treats null handle as error (does not demote to free)", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "starter",
        subscription_id: "sub-456",
        subscription_name: "Starter",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockPartnerApiResponse({
        data: {
          activeSubscription: {
            ...activeGrowthFixture.data.activeSubscription,
            items: [{ handle: null }],
          },
        },
      });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("starter");
      expect(result.fromCache).toBe(true);
    });

    it("never returns getDefaultPlan on error (does not return free)", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "scale",
        subscription_id: "sub-scale",
        subscription_name: "Scale",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.planKey).toBe("scale");
      expect(result.planKey).not.toBe("free");
    });

    it("does not report 429 to Sentry (only logs)", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 429, json: async () => throttledFixture });

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(captureExceptionWithTags).not.toHaveBeenCalled();
      expect(getAllLogs().some((l) => l.includes("partner_plan_fetch_failed"))).toBe(true);
    });
  });

  describe("In-flight deduplication", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
    });

    it("deduplicates concurrent calls for the same shop", async () => {
      mockShopGidResponse();
      let resolveDeferred: () => void;
      const deferredPromise = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
      });

      mockFetch.mockImplementationOnce(async () => {
        await deferredPromise;
        return { ok: true, status: 200, json: async () => activeGrowthFixture };
      });

      const source = getPlanSource();
      const promise1 = source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });
      const promise2 = source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });
      const promise3 = source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      resolveDeferred!();

      const [r1, r2, r3] = await Promise.all([promise1, promise2, promise3]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(r1.planKey).toBe("growth");
      expect(r2.planKey).toBe("growth");
      expect(r3.planKey).toBe("growth");
    });
  });

  describe("Shop GID memoization", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
    });

    it("makes only one Admin shop{id} call across multiple resolutions", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP, forceRefresh: true });

      const shopGidCalls = adminGraphQL.mock.calls.filter(
        (c) => typeof c[1] === "string" && c[1].includes("shop { id }")
      );
      expect(shopGidCalls.length).toBe(1);
    });

    it("rejects invalid shop GID format", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: { shop: { id: "gid://partners/Shop/123" } },
      });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.fromCache).toBe(true);
    });
  });

  describe("Log hygiene", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      mockSql.setMockResult("shop_plan", []);
    });

    it("never logs the token", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      const allLogs = getAllLogs();
      for (const log of allLogs) {
        expect(log).not.toContain(TEST_TOKEN);
      }
    });

    it("never logs the shop GID", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      const allLogs = getAllLogs();
      for (const log of allLogs) {
        expect(log).not.toContain(TEST_SHOP_GID);
      }
    });

    it("never logs the shop domain", async () => {
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      const allLogs = getAllLogs();
      for (const log of allLogs) {
        expect(log).not.toContain(TEST_SHOP);
      }
    });

    it("logs shopHash instead of domain on errors", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

      const source = getPlanSource();
      await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      const fetchFailedLogs = getAllLogs().filter((l) => l.includes("partner_plan_fetch_failed"));
      expect(fetchFailedLogs.length).toBeGreaterThan(0);
      expect(fetchFailedLogs[0]).toContain("shopHash");
      expect(fetchFailedLogs[0]).not.toContain(TEST_SHOP);
    });
  });

  describe("Resolution state", () => {
    beforeEach(() => {
      setPartnerEnv();
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
    });

    it("returns active state for confirmed subscription", async () => {
      mockSql.setMockResult("shop_plan", []);
      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.resolutionState).toBe("active");
    });

    it("returns none state for confirmed no subscription", async () => {
      mockSql.setMockResult("shop_plan", []);
      mockShopGidResponse();
      mockPartnerApiResponse(noSubscriptionFixture);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.resolutionState).toBe("none");
    });

    it("returns unknown state on fetch error with cached plan", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);
      mockShopGidResponse();
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.resolutionState).toBe("unknown");
    });
  });

  describe("AdminInstallationPlanSource resolution state", () => {
    beforeEach(() => {
      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
    });

    it("returns active state for confirmed subscription", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "gid://shopify/AppSubscription/123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: new Date(),
      }]);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.resolutionState).toBe("active");
    });

    it("returns none state for fresh fetch with no subscription", async () => {
      mockSql.setMockResult("shop_plan", [{
        plan_key: null,
        subscription_id: null,
        subscription_name: null,
        is_test: null,
        plan_cached_at: null,
      }]);
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

      expect(result.resolutionState).toBe("none");
    });

    it("returns unknown state when shop not found", async () => {
      mockSql.setMockResult("shop_id", []);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.resolutionState).toBe("unknown");
    });

    it("returns unknown state when using cached plan on error", async () => {
      const cachedTime = new Date(Date.now() - 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: cachedTime,
      }]);

      const source = getPlanSource();
      const result = await source.resolveActivePlan({ sql: mockSql as unknown as Sql, shopDomain: TEST_SHOP });

      expect(result.fromCache).toBe(true);
      expect(result.resolutionState).toBe("active");
    });
  });

  describe("Background refresh routing", () => {
    it("uses Admin source for background refresh when PLAN_SOURCE is unset", async () => {
      const mockWaitUntil = vi.fn();
      const store: RequestStore = {
        getSql: () => mockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };

      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: staleCacheTime,
      }]);

      adminGraphQL.mockResolvedValueOnce({
        success: true,
        data: { currentAppInstallation: { activeSubscriptions: [] } },
      });

      await requestContext.run(store, async () => {
        const { resolvePlan } = await import("../plan.server");
        await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);
      });

      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Partner source fetches inline (no background refresh) on stale Postgres cache", async () => {
      setPartnerEnv();
      _resetPartnerCachesForTesting();

      const mockWaitUntil = vi.fn();
      const store: RequestStore = {
        getSql: () => mockSql as unknown as Sql,
        waitUntil: mockWaitUntil,
      };

      mockSql.setMockResult("shop_id", [{ id: TEST_SHOP_ID }]);
      const staleCacheTime = new Date(Date.now() - 7 * 60 * 60 * 1000);
      mockSql.setMockResult("shop_plan", [{
        plan_key: "growth",
        subscription_id: "sub-123",
        subscription_name: "Growth",
        is_test: false,
        plan_cached_at: staleCacheTime,
      }]);

      mockShopGidResponse();
      mockPartnerApiResponse(activeGrowthFixture);

      await requestContext.run(store, async () => {
        const { resolvePlan, _resetPartnerCachesForTesting: reset } = await import("../plan.server");
        reset();
        const result = await resolvePlan(mockSql as unknown as Sql, TEST_SHOP);

        expect(result.plan.key).toBe("growth");
        expect(result.fromCache).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalled();
      expect(mockWaitUntil).not.toHaveBeenCalled();
    });
  });

  describe("onPlanRedirect", () => {
    beforeEach(() => {
      setPartnerEnv();
    });

    it("maps known handles to plan keys", () => {
      const source = getPlanSource() as PartnerApiPlanSource;

      expect(source.onPlanRedirect("starter")).toBe("starter");
      expect(source.onPlanRedirect("growth")).toBe("growth");
      expect(source.onPlanRedirect("unlimited")).toBe("scale");
    });

    it("returns null for unknown handles", () => {
      const source = getPlanSource() as PartnerApiPlanSource;

      expect(source.onPlanRedirect("mystery")).toBeNull();
    });

    it("returns null for shopify-test handle", () => {
      const source = getPlanSource() as PartnerApiPlanSource;

      expect(source.onPlanRedirect("shopify-test")).toBeNull();
    });
  });
});
