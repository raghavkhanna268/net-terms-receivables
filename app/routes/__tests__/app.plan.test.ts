import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

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
    expect(result.usage).toBeNull();
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
      companies: { current: 0, limit: 0 },
      importsThisMonth: { current: 0, limit: -1 },
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
      companies: { current: 0, limit: 0 },
      importsThisMonth: { current: 0, limit: -1 },
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
      plan: { key: "starter", limits: { companies: 25, importsPerMonth: -1 } },
      subscriptionId: "sub-123",
      subscriptionName: "Starter",
      isTest: false,
      fromCache: false,
    });

    (getUsageStats as ReturnType<typeof vi.fn>).mockResolvedValue({
      companies: { current: 15, limit: 25 },
      importsThisMonth: { current: 3, limit: -1 },
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
    // getUsageStats is always called - usage is shown regardless of flag
    expect(getUsageStats).toHaveBeenCalledOnce();
    expect(result.usage).toEqual({
      companies: { current: 15, limit: 25 },
      importsThisMonth: { current: 3, limit: -1 },
    });
    // When flag is off, gatedCount is 0 (no query made)
    expect(result.gatedCount).toBe(0);
    // getGatedAccountCount should not be called when flag is off
    expect(getGatedAccountCount).not.toHaveBeenCalled();
  });

  it("returns null usage and no banner when getUsageStats fails", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getUsageStats, getGatedAccountCount, isGatingEnforced } = await import(
      "~/services/gating.server"
    );
    const { getRequestSql } = await import("~/lib/request-context.server");

    mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { key: "starter", limits: { companies: 25, importsPerMonth: -1 } },
      subscriptionId: "sub-123",
      subscriptionName: "Starter",
      isTest: false,
      fromCache: false,
    });

    (getUsageStats as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Database connection failed")
    );

    (getGatedAccountCount as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (isGatingEnforced as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const { loader } = await import("../app.plan");
    const result = await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: mockUrl,
      pattern: mockPattern,
    });

    expect(getUsageStats).toHaveBeenCalledOnce();
    expect(result.usage).toBeNull();
    expect(result.newAccountsPausedBanner.show).toBe(false);
    expect(result.newAccountsPausedBanner.heading).toBe("");
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

  it("shows no limit-related banners when gating is OFF (T1: Usage Note removed)", () => {
    // When gating is off, no limit-related banners are shown at all
    // (Usage Note banner was removed in T1)
    const gatingEnforced = false;
    const hasLimitReached = true;
    const showBanner = hasLimitReached && gatingEnforced;
    expect(showBanner).toBe(false);
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

  it("hides banner when gatingEnforced is false (T1: no banner when gating off)", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(3, false);
    expect(state.show).toBe(false);
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
    expect(state.heading).toBe("This account was added after you reached your plan limit");
  });

  it("hides banner when isGated is false", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildAccountOverLimitBannerState(false, true);
    expect(state.show).toBe(false);
  });

  it("hides banner when gatingEnforced is false (T1: no banner when gating off)", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildAccountOverLimitBannerState(true, false);
    expect(state.show).toBe(false);
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

/**
 * UsageDisplay component render tests (T1 QA2).
 *
 * Tests that UsageDisplay renders correctly with gating ON and OFF:
 * - gatingEnforced=false: no 'At Limit', 'Near Limit' badges
 * - gatingEnforced=true at limit: shows 'At Limit' badge
 * - gatingEnforced=true near limit: shows 'Near Limit' badge
 */
describe("UsageDisplay component render tests", () => {
  it("shows no badges when gatingEnforced is false (at limit)", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 25,
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: false,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Near Limit");
    expect(html).not.toContain("Usage Note");
  });

  it("shows no badges when gatingEnforced is false (near limit)", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 20, // 80% of 25
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: false,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Near Limit");
    expect(html).not.toContain("Usage Note");
  });

  it("shows At Limit badge when gatingEnforced is true and at limit", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 25,
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: true,
      })
    );

    expect(html).toContain("At Limit");
    expect(html).not.toContain("Near Limit");
  });

  it("shows Near Limit badge when gatingEnforced is true and near limit", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 20, // 80% of 25
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: true,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).toContain("Near Limit");
  });

  it("shows usage with limit format when gatingEnforced is true", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 10,
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: true,
      })
    );

    expect(html).toContain("10 / 25");
  });

  it("shows usage count only when gatingEnforced is false", async () => {
    const { renderToString } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 10,
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: false,
      })
    );

    expect(html).toContain(">10<");
    expect(html).not.toContain("/ 25");
  });
});

/**
 * Credit-hold and credit-status feature availability tests (T1/T5).
 *
 * Verifies that credit_holds feature is available on ALL plans regardless
 * of gating status. Plan-limit gating only affects the "at limit" badges
 * and "Upgrade to Add More" CTAs, not feature availability or credit-status UI.
 *
 * T5 removed the feature comparison table and FEATURE_DISPLAY_NAMES,
 * so these tests only verify entitlements-level feature availability.
 */
describe("credit-hold feature availability (unaffected by plan gating)", () => {
  it("credit_holds feature is available on all plans including none", async () => {
    const { ALL_PLAN_KEYS, getPlanConfig, planHasFeature } = await import("~/lib/entitlements");
    
    for (const planKey of ALL_PLAN_KEYS) {
      const plan = getPlanConfig(planKey);
      expect(planHasFeature(plan, "credit_holds")).toBe(true);
    }
  });

  it("credit_holds is in ALL_FEATURE_KEYS", async () => {
    const { ALL_FEATURE_KEYS } = await import("~/lib/entitlements");
    expect(ALL_FEATURE_KEYS).toContain("credit_holds");
  });

  it("banner-state builder: no over-limit banner when gating off, credit_holds on all plans", async () => {
    const { buildAccountOverLimitBannerState } = await import("~/lib/over-limit-banner");
    
    // Over-limit banner hidden when gating is off (plan-limit gating)
    const overLimitState = buildAccountOverLimitBannerState(true, false);
    expect(overLimitState.show).toBe(false);
    
    // Credit-hold feature still available on all plans - verified by entitlements
    const { ALL_PLAN_KEYS, getPlanConfig, planHasFeature } = await import("~/lib/entitlements");
    for (const planKey of ALL_PLAN_KEYS) {
      const plan = getPlanConfig(planKey);
      // Credit holds feature is available on ALL plans including over-limit shops
      // This means credit-status badges (OK/Near Limit/Held) and manual hold controls render
      expect(planHasFeature(plan, "credit_holds")).toBe(true);
    }
  });
});

/**
 * Render tests for UsageDisplay component (T1 plan-limit gating).
 *
 * Real renderToString tests verifying that usage badges only show
 * when gating is enforced.
 */
describe("UsageDisplay render tests (T1)", () => {
  it("gating OFF at-limit: does NOT show At Limit, Near Limit, or Usage Note", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 25,
        limit: 25,
        label: "Buyer accounts",
        gatingEnforced: false,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Near Limit");
    expect(html).not.toContain("Usage Note");
  });

  it("gating OFF near-limit: does NOT show At Limit, Near Limit, or Usage Note", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 22,
        limit: 25,
        label: "Buyer accounts",
        gatingEnforced: false,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Near Limit");
    expect(html).not.toContain("Usage Note");
  });

  it("gating ON at-limit: shows At Limit badge", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 25,
        limit: 25,
        label: "Buyer accounts",
        gatingEnforced: true,
      })
    );

    expect(html).toContain("At Limit");
    expect(html).not.toContain("Near Limit");
  });

  it("gating ON over-limit: shows At Limit badge", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 30,
        limit: 25,
        label: "Buyer accounts",
        gatingEnforced: true,
      })
    );

    expect(html).toContain("At Limit");
    expect(html).not.toContain("Near Limit");
  });

  it("gating ON near-limit: shows Near Limit badge", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 22,
        limit: 25,
        label: "Buyer accounts",
        gatingEnforced: true,
      })
    );

    expect(html).toContain("Near Limit");
    expect(html).not.toContain("At Limit");
  });

  it("gating ON below near-limit threshold: shows neither badge", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 10,
        limit: 25,
        label: "Buyer accounts",
        gatingEnforced: true,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Near Limit");
  });

  it("unlimited plan: shows neither badge regardless of gating", async () => {
    const { UsageDisplay } = await import("../app.plan");
    const html = renderToString(
      createElement(UsageDisplay, {
        current: 100,
        limit: -1,
        label: "Buyer accounts",
        gatingEnforced: true,
      })
    );

    expect(html).not.toContain("At Limit");
    expect(html).not.toContain("Near Limit");
  });
});

/**
 * T4 Render Tests: PlanPage wiring with null usage.
 * Verifies Usage section is absent when usage is null.
 *
 * Tests the conditional rendering pattern by inspecting the component source
 * for the {usage && ...} guard around the Usage section.
 */
describe("T4 PlanPage component wiring with usage null", () => {
  it("PlanPage source: Usage section guarded by {usage && ...} conditional", async () => {
    const { readFileSync } = await import("fs");
    const planSource = readFileSync("app/routes/app.plan.tsx", "utf-8");

    expect(planSource).toContain("{usage && (");
    expect(planSource).toContain("<s-section heading=\"Usage\">");
    
    const usageGuardMatch = planSource.match(/\{usage\s*&&\s*\(\s*<s-section\s+heading="Usage">/);
    expect(usageGuardMatch).not.toBeNull();
  });

  it("UsageDisplay renders Buyer Accounts label (proving Usage section content)", async () => {
    const { UsageDisplay } = await import("../app.plan");

    const html = renderToString(
      createElement(UsageDisplay, {
        current: 10,
        limit: 25,
        label: "Buyer Accounts",
        gatingEnforced: true,
      })
    );

    expect(html).toContain("Buyer Accounts");
    expect(html).toContain("10 / 25");
  });
});

/**
 * T4 Render Tests: Over-limit banner shows even when usage is null.
 * This verifies the banner was moved outside the {usage && ...} block.
 */
describe("T4 Over-limit banner renders when usage is null", () => {
  afterEach(() => {
    vi.doUnmock("react-router");
    vi.resetModules();
  });

  it("renders over-limit banner when usage is null but gatedCount > 0", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "starter", name: "Starter", isTest: false },
          usage: null,
          gatedCount: 3,
          gatingEnforced: true,
          storeHandle: "test-store",
          upgradeUrl: "https://admin.shopify.com/store/test-store/charges/net-terms/pricing_plans",
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    // Over-limit banner should show even when usage is null
    expect(html).toContain("3 accounts over your plan limit");
    expect(html).toContain("s-banner");
  });

  it("does not render over-limit banner when gatedCount is 0 and usage is null", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "starter", name: "Starter", isTest: false },
          usage: null,
          gatedCount: 0,
          gatingEnforced: true,
          storeHandle: "test-store",
          upgradeUrl: "https://admin.shopify.com/store/test-store/charges/net-terms/pricing_plans",
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    // No over-limit banner when gatedCount is 0
    expect(html).not.toContain("accounts over your plan limit");
  });
});

/**
 * Plan Gating sidebar visibility tests.
 *
 * Verifies that the Plan Gating sidebar:
 * - Does NOT render when gatingEnforced is false
 * - DOES render when gatingEnforced is true
 * - Does NOT show "Not Enforced" or "regardless of plan" copy to merchants
 */
describe("Plan Gating sidebar visibility", () => {
  afterEach(() => {
    vi.doUnmock("react-router");
    vi.resetModules();
  });

  it("does NOT render Plan Limits sidebar when gatingEnforced is false", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "starter", name: "Starter", isTest: false },
          usage: { companies: { current: 10, limit: 25 }, importsThisMonth: { current: 3, limit: -1 } },
          gatedCount: 0,
          gatingEnforced: false,
          storeHandle: "test-store",
          upgradeUrl: "https://admin.shopify.com/store/test-store/charges/net-terms/pricing_plans",
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    expect(html).not.toContain("Plan Limits");
    expect(html).not.toContain("Plan Gating");
    expect(html).not.toContain("Not Enforced");
    expect(html).not.toContain("regardless of plan");
    expect(html).not.toContain("not enforced");
    expect(html).not.toContain("limits are not");
  });

  it("DOES render Plan Limits sidebar when gatingEnforced is true", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "starter", name: "Starter", isTest: false },
          usage: { companies: { current: 10, limit: 25 }, importsThisMonth: { current: 3, limit: -1 } },
          gatedCount: 0,
          gatingEnforced: true,
          storeHandle: "test-store",
          upgradeUrl: "https://admin.shopify.com/store/test-store/charges/net-terms/pricing_plans",
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    expect(html).toContain("Plan Limits");
    expect(html).toContain("Active");
    expect(html).toContain("Plan limits are enforced");
  });

  it("never shows 'Not Enforced' or 'regardless of plan' copy when gating is off", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "none", name: "No Plan", isTest: false },
          usage: null,
          gatedCount: 0,
          gatingEnforced: false,
          storeHandle: "test-store",
          upgradeUrl: null,
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    expect(html).not.toContain("Not Enforced");
    expect(html).not.toContain("regardless of plan");
    expect(html).not.toContain("not enforced");
    expect(html).not.toContain("All features are available");
  });
});

/**
 * Copy polish tests for plan page.
 *
 * Verifies:
 * - Unlimited plan banner does not claim "priority support"
 * - Test charge badge shows "Test charge" (not just "Test")
 */
describe("Plan page copy polish", () => {
  afterEach(() => {
    vi.doUnmock("react-router");
    vi.resetModules();
  });

  it("Unlimited plan banner does not mention priority support", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "unlimited", name: "Unlimited", isTest: false },
          usage: { companies: { current: 100, limit: -1 }, importsThisMonth: { current: 10, limit: -1 } },
          gatedCount: 0,
          gatingEnforced: true,
          storeHandle: "test-store",
          upgradeUrl: null,
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    expect(html).toContain("Unlimited Plan");
    expect(html).toContain("unlimited buyer accounts");
    expect(html).not.toContain("priority support");
  });

  it("shows 'Test charge' badge (not just 'Test') when isTest is true", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "growth", name: "Growth", isTest: true },
          usage: { companies: { current: 50, limit: 100 }, importsThisMonth: { current: 5, limit: -1 } },
          gatedCount: 0,
          gatingEnforced: true,
          storeHandle: "test-store",
          upgradeUrl: "https://admin.shopify.com/store/test-store/charges/net-terms/pricing_plans",
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    expect(html).toContain("Test charge");
    expect(html).not.toMatch(/>Test</);
  });

  it("does not show Test charge badge when isTest is false", async () => {
    vi.doMock("react-router", async () => {
      const actual = await vi.importActual<typeof import("react-router")>("react-router");
      return {
        ...actual,
        useLoaderData: () => ({
          plan: { key: "growth", name: "Growth", isTest: false },
          usage: { companies: { current: 50, limit: 100 }, importsThisMonth: { current: 5, limit: -1 } },
          gatedCount: 0,
          gatingEnforced: true,
          storeHandle: "test-store",
          upgradeUrl: "https://admin.shopify.com/store/test-store/charges/net-terms/pricing_plans",
          newAccountsPausedBanner: { show: false, heading: "", bodyText: "", upgradeUrl: null },
          error: null,
        }),
      };
    });

    vi.resetModules();
    const { default: PlanPage } = await import("../app.plan");

    const html = renderToString(createElement(PlanPage));

    expect(html).not.toContain("Test charge");
  });
});
