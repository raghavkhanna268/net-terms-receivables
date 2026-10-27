import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for plan selection redirect in the app layout loader (app.tsx).
 *
 * When PLAN_SELECTION_REDIRECT_ENABLED="true", merchants without an active
 * subscription are redirected to the Shopify-hosted plan selection page.
 *
 * Guards:
 * - Only the exact string "true" enables the redirect
 * - Skip when path is /app/welcome (parallel loader may not have finished refresh)
 * - Skip when plan_handle or charge_id key is PRESENT in URL (even if empty)
 * - Skip when APP_HANDLE is not set
 * - Skip when plan status is "error" or "active"
 * - Only redirect when status is confirmed "none"
 */

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_APP_HANDLE = "test-app-handle";
const EXPECTED_PRICING_URL = `https://admin.shopify.com/store/test-shop/charges/${TEST_APP_HANDLE}/pricing_plans`;

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

const mockResolvePlanWithStatus = vi.fn();
vi.mock("~/services/plan.server", () => ({
  resolvePlanWithStatus: mockResolvePlanWithStatus,
}));

const mockIsPlanSelectionRedirectEnabled = vi.fn();
vi.mock("~/services/gating.server", () => ({
  isPlanSelectionRedirectEnabled: mockIsPlanSelectionRedirectEnabled,
}));

const mockGetAppHandle = vi.fn();
const mockBuildPlanSelectionUrl = vi.fn();
vi.mock("~/lib/plan-url", () => ({
  getAppHandle: () => mockGetAppHandle(),
  buildPlanSelectionUrl: (shop: string, handle: string) => mockBuildPlanSelectionUrl(shop, handle),
}));

vi.mock("~/lib/after-auth.server", () => ({
  runAfterAuth: vi.fn().mockResolvedValue(undefined),
}));

class MockServerTiming {
  startPhase = vi.fn();
  endPhase = vi.fn();
  logAllPhases = vi.fn();
  toHeaderValue = vi.fn().mockReturnValue(null);
}

vi.mock("~/lib/server-timing.server", () => ({
  ServerTiming: MockServerTiming,
  readColdOnce: vi.fn().mockReturnValue(false),
}));

describe("app.tsx plan selection redirect", () => {
  const originalEnv = { ...process.env };

  function createLoaderArgs(path: string = "/app", searchParams: string = ""): LoaderFunctionArgs {
    const fullUrl = `https://example.com${path}${searchParams ? `?${searchParams}` : ""}`;
    let redirectCaptured: { url: string; options?: { target?: string } } | null = null;

    return {
      request: new Request(fullUrl),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: vi.fn() },
              redirect: vi.fn((url: string, options?: { target?: string }) => {
                redirectCaptured = { url, options };
                const err = new Response(null, {
                  status: 302,
                  headers: { Location: url },
                });
                (err as Response & { __redirectCaptured?: typeof redirectCaptured }).__redirectCaptured = redirectCaptured;
                throw err;
              }),
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(false);
    mockGetAppHandle.mockReturnValue(TEST_APP_HANDLE);
    mockBuildPlanSelectionUrl.mockImplementation((shop: string, handle: string) => {
      const storeHandle = shop.replace(".myshopify.com", "");
      return `https://admin.shopify.com/store/${storeHandle}/charges/${handle}/pricing_plans`;
    });
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("flag on, confirmed none: redirects to the exact pricing URL with target _top", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const args = createLoaderArgs("/app");

    try {
      await loader(args);
      expect.fail("Expected redirect to be thrown");
    } catch (e) {
      const response = e as Response & { __redirectCaptured?: { url: string; options?: { target?: string } } };
      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(302);
      expect(response.__redirectCaptured?.url).toBe(EXPECTED_PRICING_URL);
      expect(response.__redirectCaptured?.options?.target).toBe("_top");
    }
  });

  it("flag on, active plan: no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "starter" }, subscriptionId: "gid://shopify/AppSubscription/123", fromCache: false },
      status: "active",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
  });

  it("flag on, lookup error: no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: true },
      status: "error",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
  });

  it("flag on, /app/welcome: no redirect (parallel loader may not have finished)", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app/welcome"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag on, plan_handle present (non-empty): no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app", "plan_handle=growth"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag on, plan_handle present but EMPTY: no redirect (return from welcome flow)", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: true },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app", "plan_handle=&charge_id="));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag on, /app/onboarding with empty plan_handle and charge_id: no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: true },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app/onboarding", "plan_handle=&charge_id="));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag on, charge_id present (non-empty): no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app", "charge_id=abc123"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag on, APP_HANDLE unset: no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockGetAppHandle.mockReturnValue(null);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag on, APP_HANDLE empty string: no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(true);
    mockGetAppHandle.mockReturnValue("");
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it("flag absent (undefined): no redirect", async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(false);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it('flag "false": no redirect', async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(false);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it('flag "TRUE" (uppercase): no redirect (only exact "true" counts)', async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(false);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });

  it('flag "1": no redirect (only exact "true" counts)', async () => {
    mockIsPlanSelectionRedirectEnabled.mockReturnValue(false);
    mockResolvePlanWithStatus.mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const { loader } = await import("../app");
    const result = await loader(createLoaderArgs("/app"));

    expect(result).toBeDefined();
    expect(result.data).toHaveProperty("apiKey");
    expect(mockResolvePlanWithStatus).not.toHaveBeenCalled();
  });
});
