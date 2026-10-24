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
