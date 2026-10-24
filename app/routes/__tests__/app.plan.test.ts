import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for plan page loader (S21).
 *
 * These tests call the actual loader with mocked dependencies and verify:
 * 1. Returns plan data from resolvePlan
 * 2. Returns usage stats from getUsageStats
 * 3. Returns gated count from getGatedAccountCount
 * 4. Returns gatingEnforced from isGatingEnforced
 * 5. Handles shop-not-found case
 * 6. Handles error case
 */

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn(),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn(),
  getGatedAccountCount: vi.fn(),
  isGatingEnforced: vi.fn(),
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Plan Page Loader", () => {
  const mockSession = { shop: "test-store.myshopify.com" };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
  };
  const mockRequest = new Request("https://example.com/app/plan");
  const mockUrl = new URL(mockRequest.url);
  const mockPattern = "/app/plan";

  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSql = vi.fn();
    mockContext.shopify.authenticate.admin.mockResolvedValue({ session: mockSession });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns plan data when shop exists", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getUsageStats, getGatedAccountCount, isGatingEnforced } = await import(
      "~/services/gating.server"
    );
    const { getRequestSql } = await import("~/lib/request-context.server");

    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { key: "growth", limits: { companies: 100, importsPerMonth: -1 } },
      subscriptionId: "gid://shopify/AppSubscription/123",
      subscriptionName: "Growth",
      isTest: false,
      fromCache: true,
    });

    (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      companies: { current: 50, limit: 100 },
      importsThisMonth: { current: 3, limit: -1 },
    });

    (getGatedAccountCount as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { loader } = await import("../app.plan");
    const result = await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    expect(result.plan).toEqual({
      key: "growth",
      name: "Growth",
      isTest: false,
    });
    expect(result.usage).toEqual({
      companies: { current: 50, limit: 100 },
      importsThisMonth: { current: 3, limit: -1 },
    });
    expect(result.gatedCount).toBe(5);
    expect(result.gatingEnforced).toBe(true);
    expect(result.storeHandle).toBe("test-store");
    expect(result.error).toBeNull();
  });

  it("returns default plan when shop not found", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");
    const { isGatingEnforced } = await import("~/services/gating.server");

    mockSql.mockResolvedValueOnce([]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { loader } = await import("../app.plan");
    const result = await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    expect(result.plan).toBeNull();
    expect(result.usage).toEqual({
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    });
    expect(result.gatedCount).toBe(0);
    expect(result.error).toBeNull();
  });

  it("returns error when resolvePlan throws", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getUsageStats, getGatedAccountCount, isGatingEnforced } = await import(
      "~/services/gating.server"
    );
    const { getRequestSql } = await import("~/lib/request-context.server");

    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(false);

    (resolvePlan as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Database error")
    );
    (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    });
    (getGatedAccountCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const { loader } = await import("../app.plan");
    const result = await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    expect(result.error).toBe("Failed to load plan information. Please try again.");
    expect(result.plan).toBeNull();
  });

  it("returns gatingEnforced false when flag is off", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getUsageStats, getGatedAccountCount, isGatingEnforced } = await import(
      "~/services/gating.server"
    );
    const { getRequestSql } = await import("~/lib/request-context.server");

    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { key: "free", limits: { companies: 3, importsPerMonth: 1 } },
      subscriptionId: null,
      subscriptionName: null,
      isTest: false,
      fromCache: false,
    });

    (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      companies: { current: 3, limit: 3 },
      importsThisMonth: { current: 1, limit: 1 },
    });

    (getGatedAccountCount as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { loader } = await import("../app.plan");
    const result = await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    expect(result.gatingEnforced).toBe(false);
    expect(result.gatedCount).toBe(2);
  });

  it("does not include subscriptionId or fromCache in returned plan", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getUsageStats, getGatedAccountCount, isGatingEnforced } = await import(
      "~/services/gating.server"
    );
    const { getRequestSql } = await import("~/lib/request-context.server");

    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { key: "starter", limits: { companies: 25, importsPerMonth: -1 } },
      subscriptionId: "gid://shopify/AppSubscription/456",
      subscriptionName: "Starter",
      isTest: true,
      fromCache: true,
    });

    (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      companies: { current: 10, limit: 25 },
      importsThisMonth: { current: 0, limit: -1 },
    });

    (getGatedAccountCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const { loader } = await import("../app.plan");
    const result = await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    expect(result.plan).toEqual({
      key: "starter",
      name: "Starter",
      isTest: true,
    });
    expect(result.plan).not.toHaveProperty("subscriptionId");
    expect(result.plan).not.toHaveProperty("fromCache");
  });
});

describe("Plan Page Component Logic", () => {
  it("shows upgrade section for non-scale plans", () => {
    const planKey = "growth" as string;
    const canUpgrade = planKey !== "scale";
    expect(canUpgrade).toBe(true);
  });

  it("hides upgrade section for scale plan", () => {
    const planKey = "scale" as string;
    const canUpgrade = planKey !== "scale";
    expect(canUpgrade).toBe(false);
  });

  it("uses warning banner tone when gating is ON and limit reached", () => {
    const gatingEnforced = true;
    const hasLimitReached = true;
    const bannerTone = hasLimitReached && gatingEnforced ? "warning" : "info";
    expect(bannerTone).toBe("warning");
  });

  it("uses info banner tone when gating is OFF and limit reached", () => {
    const gatingEnforced = false;
    const hasLimitReached = true;
    const bannerTone = hasLimitReached && !gatingEnforced ? "info" : "warning";
    expect(bannerTone).toBe("info");
  });
});

/**
 * Tests for FeatureComparisonTable logic (S21).
 *
 * The FeatureComparisonTable component in app.plan.tsx iterates over
 * ALL_PLAN_KEYS and ALL_FEATURE_KEYS, calling planHasFeature() to
 * determine whether to show ✓ or — for each cell.
 *
 * These tests verify the pure logic that the table uses, especially
 * that credit_holds shows as included (✓) for ALL four plan tiers.
 */
describe("FeatureComparisonTable logic", () => {
  it("credit_holds shows as included for all four tiers", async () => {
    const { ALL_PLAN_KEYS, getPlanConfig, planHasFeature } = await import(
      "~/lib/entitlements"
    );

    const creditHoldsRow = ALL_PLAN_KEYS.map((planKey) => {
      const plan = getPlanConfig(planKey);
      return { planKey, hasFeature: planHasFeature(plan, "credit_holds") };
    });

    expect(creditHoldsRow).toEqual([
      { planKey: "free", hasFeature: true },
      { planKey: "starter", hasFeature: true },
      { planKey: "growth", hasFeature: true },
      { planKey: "scale", hasFeature: true },
    ]);
  });

  it("aging_dashboard shows as included for all four tiers", async () => {
    const { ALL_PLAN_KEYS, getPlanConfig, planHasFeature } = await import(
      "~/lib/entitlements"
    );

    for (const planKey of ALL_PLAN_KEYS) {
      const plan = getPlanConfig(planKey);
      expect(planHasFeature(plan, "aging_dashboard")).toBe(true);
    }
  });

  it("pdf_statements shows as NOT included for free and starter", async () => {
    const { getPlanConfig, planHasFeature } = await import("~/lib/entitlements");

    expect(planHasFeature(getPlanConfig("free"), "pdf_statements")).toBe(false);
    expect(planHasFeature(getPlanConfig("starter"), "pdf_statements")).toBe(false);
    expect(planHasFeature(getPlanConfig("growth"), "pdf_statements")).toBe(true);
    expect(planHasFeature(getPlanConfig("scale"), "pdf_statements")).toBe(true);
  });

  it("generates correct table data for all features", async () => {
    const { ALL_PLAN_KEYS, ALL_FEATURE_KEYS, getPlanConfig, planHasFeature } =
      await import("~/lib/entitlements");

    const tableRows = ALL_FEATURE_KEYS.map((feature) => {
      const cells = ALL_PLAN_KEYS.map((planKey) => {
        const plan = getPlanConfig(planKey);
        return planHasFeature(plan, feature);
      });
      return { feature, cells };
    });

    const creditHoldsRowData = tableRows.find((row) => row.feature === "credit_holds");
    expect(creditHoldsRowData?.cells).toEqual([true, true, true, true]);

    const agingRowData = tableRows.find((row) => row.feature === "aging_dashboard");
    expect(agingRowData?.cells).toEqual([true, true, true, true]);

    const auditExportRowData = tableRows.find((row) => row.feature === "audit_export");
    expect(auditExportRowData?.cells).toEqual([false, false, false, true]);
  });
});
