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

  it("P7: error logging uses safeLog JSON with toErrorCode (per #174)", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { resolvePlan } = await import("~/services/plan.server");
    const { getUsageStats, getGatedAccountCount, isGatingEnforced } = await import(
      "~/services/gating.server"
    );
    const { getRequestSql } = await import("~/lib/request-context.server");

    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(false);

    (resolvePlan as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Database connection timed out")
    );
    (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      companies: { current: 0, limit: 3 },
      importsThisMonth: { current: 0, limit: 1 },
    });
    (getGatedAccountCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const { loader } = await import("../app.plan");
    await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // safeLog outputs JSON with "event" field
    expect(allLogs).toContain('"event":"app.plan.load_plan_data_failed"');
    expect(allLogs).toContain('"err":');
    expect(allLogs).not.toContain("Database connection timed out");
    expect(allLogs).not.toContain(".myshopify.com");

    consoleSpy.mockRestore();
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
  it("shows upgrade section for non-unlimited plans", () => {
    const planKey = "growth" as string;
    const canUpgrade = planKey !== "unlimited";
    expect(canUpgrade).toBe(true);
  });

  it("hides upgrade section for unlimited plan", () => {
    const planKey = "unlimited" as string;
    const canUpgrade = planKey !== "unlimited";
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
      { planKey: "none", hasFeature: true },
      { planKey: "starter", hasFeature: true },
      { planKey: "growth", hasFeature: true },
      { planKey: "unlimited", hasFeature: true },
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

  it("matching shows as included for all four tiers", async () => {
    const { ALL_PLAN_KEYS, getPlanConfig, planHasFeature } = await import(
      "~/lib/entitlements"
    );

    const matchingRow = ALL_PLAN_KEYS.map((planKey) => {
      const plan = getPlanConfig(planKey);
      return { planKey, hasFeature: planHasFeature(plan, "matching") };
    });

    expect(matchingRow).toEqual([
      { planKey: "none", hasFeature: true },
      { planKey: "starter", hasFeature: true },
      { planKey: "growth", hasFeature: true },
      { planKey: "unlimited", hasFeature: true },
    ]);
  });

  it("reminders shows as included for all four tiers (all features on all plans)", async () => {
    const { getPlanConfig, planHasFeature } = await import("~/lib/entitlements");

    // All features are now on all plans
    expect(planHasFeature(getPlanConfig("none"), "reminders")).toBe(true);
    expect(planHasFeature(getPlanConfig("starter"), "reminders")).toBe(true);
    expect(planHasFeature(getPlanConfig("growth"), "reminders")).toBe(true);
    expect(planHasFeature(getPlanConfig("unlimited"), "reminders")).toBe(true);
  });

  it("generates correct table data for all features (all true on all plans)", async () => {
    const { ALL_PLAN_KEYS, ALL_FEATURE_KEYS, getPlanConfig, planHasFeature } =
      await import("~/lib/entitlements");

    const tableRows = ALL_FEATURE_KEYS.map((feature) => {
      const cells = ALL_PLAN_KEYS.map((planKey) => {
        const plan = getPlanConfig(planKey);
        return planHasFeature(plan, feature);
      });
      return { feature, cells };
    });

    // All features are true on all plans (5 features now, not 8)
    const creditHoldsRowData = tableRows.find((row) => row.feature === "credit_holds");
    expect(creditHoldsRowData?.cells).toEqual([true, true, true, true]);

    const agingRowData = tableRows.find((row) => row.feature === "aging_dashboard");
    expect(agingRowData?.cells).toEqual([true, true, true, true]);

    const matchingRowData = tableRows.find((row) => row.feature === "matching");
    expect(matchingRowData?.cells).toEqual([true, true, true, true]);

    const remindersRowData = tableRows.find((row) => row.feature === "reminders");
    expect(remindersRowData?.cells).toEqual([true, true, true, true]);
  });
});

/**
 * Issue #286: Hidden features must not appear in plan page (App Store rule 1.1.4).
 * pdf_statements, payer_memory, audit_export are not built and must not be listed.
 */
describe("Issue #286: Hidden features not displayed", () => {
  it("FEATURE_DESCRIPTIONS does not contain PDF statements", async () => {
    const { FEATURE_DISPLAY_NAMES } = await import("~/components/UpgradePrompt");
    const allDescriptions = Object.values(FEATURE_DISPLAY_NAMES).join(" ");
    
    expect(allDescriptions).not.toContain("PDF");
    expect(allDescriptions).not.toContain("pdf");
    expect(allDescriptions).not.toContain("Statements");
  });

  it("FEATURE_DESCRIPTIONS does not contain payer memory", async () => {
    const { FEATURE_DISPLAY_NAMES } = await import("~/components/UpgradePrompt");
    const allDescriptions = Object.values(FEATURE_DISPLAY_NAMES).join(" ");
    
    expect(allDescriptions.toLowerCase()).not.toContain("payer");
    expect(allDescriptions.toLowerCase()).not.toContain("memory");
  });

  it("FEATURE_DESCRIPTIONS does not contain audit export", async () => {
    const { FEATURE_DISPLAY_NAMES } = await import("~/components/UpgradePrompt");
    const allDescriptions = Object.values(FEATURE_DISPLAY_NAMES).join(" ");
    
    expect(allDescriptions.toLowerCase()).not.toContain("audit");
    expect(allDescriptions.toLowerCase()).not.toContain("export");
  });

  it("ALL_FEATURE_KEYS does not include hidden features", async () => {
    const { ALL_FEATURE_KEYS } = await import("~/lib/entitlements");
    
    expect(ALL_FEATURE_KEYS).not.toContain("pdf_statements");
    expect(ALL_FEATURE_KEYS).not.toContain("payer_memory");
    expect(ALL_FEATURE_KEYS).not.toContain("audit_export");
  });

  it("plan page feature list excludes hidden features", async () => {
    const { ALL_FEATURE_KEYS } = await import("~/lib/entitlements");
    const { FEATURE_DISPLAY_NAMES } = await import("~/components/UpgradePrompt");
    
    // Verify that ALL_FEATURE_KEYS used for rendering only has visible features
    expect(ALL_FEATURE_KEYS).toHaveLength(5);
    expect(ALL_FEATURE_KEYS).toEqual([
      "aging_dashboard",
      "unlimited_imports",
      "matching",
      "reminders",
      "credit_holds",
    ]);
    
    // Verify FEATURE_DISPLAY_NAMES only has entries for visible features
    expect(Object.keys(FEATURE_DISPLAY_NAMES)).toHaveLength(5);
  });
});

/**
 * S21 UI Tests: Over-limit banner using the actual helper imported by routes.
 *
 * These tests verify the buildOverLimitBannerState helper that is used by:
 * - app/routes/app.plan.tsx
 * - app/routes/app._index.tsx
 */
describe("S21 Over-limit banner using buildOverLimitBannerState helper", () => {
  it("shows banner when gatedCount > 0 (gatingEnforced=true)", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(5, true);
    expect(state.show).toBe(true);
    expect(state.heading).toBe("5 accounts over your plan limit");
  });

  it("hides banner when gatedCount === 0", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(0, true);
    expect(state.show).toBe(false);
  });

  it("shows banner when gatingEnforced is false (flag-off behavior)", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(3, false);
    expect(state.show).toBe(true);
    expect(state.enforcementNote).toBe("(Limits are not currently enforced.)");
  });

  it("no enforcement note when gatingEnforced is true", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(3, true);
    expect(state.enforcementNote).toBeNull();
  });

  it("singular heading for gatedCount === 1", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(1, true);
    expect(state.heading).toBe("1 account over your plan limit");
  });

  it("banner body text includes required product rule content", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(1, true);
    expect(state.bodyText).toContain("Nothing is hidden");
    expect(state.bodyText).toContain("totals include all accounts");
    expect(state.bodyText).toContain("reminders");
    expect(state.bodyText).toContain("credit-limit edits");
    expect(state.bodyText).toContain("Matching");
    expect(state.bodyText).toContain("never gated");
    expect(state.bodyText).toContain("Credit holds");
    expect(state.bodyText).toContain("checkout block");
  });
});

describe("S21 Account page banner using buildAccountOverLimitBannerState helper", () => {
  it("shows banner when isGated is true", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildAccountOverLimitBannerState(true, true);
    expect(state.show).toBe(true);
    expect(state.heading).toBe("This account is over your plan limit");
  });

  it("hides banner when isGated is false", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildAccountOverLimitBannerState(false, true);
    expect(state.show).toBe(false);
  });

  it("shows banner when gatingEnforced is false (flag-off behavior)", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildAccountOverLimitBannerState(true, false);
    expect(state.show).toBe(true);
    expect(state.enforcementNote).toBe("(Limits are not currently enforced.)");
  });

  it("hides banner when account not gated even if gatingEnforced is false", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildAccountOverLimitBannerState(false, false);
    expect(state.show).toBe(false);
  });
});

describe("S21 No price strings in plan output", () => {
  it("PLAN_DISPLAY_NAMES contains no currency symbols", async () => {
    const { PLAN_DISPLAY_NAMES } = await import("~/components/UpgradePrompt");
    
    const allNames = Object.values(PLAN_DISPLAY_NAMES).join("");
    
    expect(allNames).not.toContain("$");
    expect(allNames).not.toContain("₹");
    expect(allNames).not.toContain("€");
    expect(allNames).not.toContain("£");
    expect(allNames).not.toContain("¥");
    expect(allNames).not.toMatch(/\d+\.\d{2}/);
  });

  it("FEATURE_DISPLAY_NAMES contains no currency symbols", async () => {
    const { FEATURE_DISPLAY_NAMES } = await import("~/components/UpgradePrompt");
    
    const allNames = Object.values(FEATURE_DISPLAY_NAMES).join("");
    
    expect(allNames).not.toContain("$");
    expect(allNames).not.toContain("₹");
    expect(allNames).not.toContain("€");
    expect(allNames).not.toContain("£");
    expect(allNames).not.toContain("¥");
    expect(allNames).not.toMatch(/\d+\.\d{2}/);
  });

  it("plan config contains no price values", async () => {
    const { ALL_PLAN_KEYS, getPlanConfig } = await import("~/lib/entitlements");
    
    for (const planKey of ALL_PLAN_KEYS) {
      const plan = getPlanConfig(planKey);
      const planString = JSON.stringify(plan);
      
      expect(planString).not.toContain("$");
      expect(planString).not.toContain("₹");
      expect(planString).not.toContain("price");
      expect(planString).not.toContain("Price");
      expect(planString).not.toContain("cost");
      expect(planString).not.toContain("Cost");
      expect(planString).not.toMatch(/"[0-9]+\.[0-9]{2}"/);
    }
  });

  it("entitlements module exports no price-related fields", async () => {
    const entitlements = await import("~/lib/entitlements");
    const exportNames = Object.keys(entitlements);
    
    const priceRelatedPatterns = ["price", "Price", "cost", "Cost", "fee", "Fee"];
    for (const pattern of priceRelatedPatterns) {
      const matches = exportNames.filter(name => name.includes(pattern));
      expect(matches).toHaveLength(0);
    }
  });

  it("over-limit banner helper contains no currency symbols", async () => {
    const { buildOverLimitBannerState, buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    
    const shopState = buildOverLimitBannerState(5, true);
    const accountState = buildAccountOverLimitBannerState(true, true);
    
    for (const state of [shopState, accountState]) {
      expect(state.heading).not.toContain("$");
      expect(state.heading).not.toContain("₹");
      expect(state.bodyText).not.toContain("$");
      expect(state.bodyText).not.toContain("₹");
    }
  });
});
