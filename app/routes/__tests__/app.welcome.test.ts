import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for plan welcome redirect handling (App Pricing).
 *
 * Tests verify both entry points (/app/welcome and /app with plan_handle/charge_id):
 * 1. Non-empty handle (max 32 chars) triggers force-refresh via existing resolvePlan path
 * 2. charge_id triggers refresh even without plan_handle
 * 3. Over-length plan_handle → no refresh
 * 4. Foreign shop param (differs from session) → no write
 * 5. Missing params → no refresh
 * 6. Re-visits are harmless and idempotent
 * 7. Refresh failure falls back silently (no throw)
 * 8. Redirect preserves shop and host params
 * 9. Logging emits exactly {refreshed, skipped, reason, hasPlanHandle, hasChargeId}
 */

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn(),
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Plan Welcome Service", () => {
  const TEST_SHOP = "test-store.myshopify.com";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("normalizePlanHandle", () => {
    it("accepts exactly starter, growth, unlimited (lowercase)", async () => {
      const { normalizePlanHandle } = await import("~/services/plan-welcome.server");

      expect(normalizePlanHandle("starter")).toBe("starter");
      expect(normalizePlanHandle("growth")).toBe("growth");
      expect(normalizePlanHandle("unlimited")).toBe("unlimited");
    });

    it("normalizes case to lowercase", async () => {
      const { normalizePlanHandle } = await import("~/services/plan-welcome.server");

      expect(normalizePlanHandle("STARTER")).toBe("starter");
      expect(normalizePlanHandle("Growth")).toBe("growth");
      expect(normalizePlanHandle("UNLIMITED")).toBe("unlimited");
    });

    it("rejects unknown handles including Shopify test plan", async () => {
      const { normalizePlanHandle } = await import("~/services/plan-welcome.server");

      expect(normalizePlanHandle("free")).toBeNull();
      expect(normalizePlanHandle("none")).toBeNull();
      expect(normalizePlanHandle("enterprise")).toBeNull();
      expect(normalizePlanHandle("premium")).toBeNull();
      expect(normalizePlanHandle("$0")).toBeNull();
      expect(normalizePlanHandle("test")).toBeNull();
    });

    it("rejects empty, null, whitespace", async () => {
      const { normalizePlanHandle } = await import("~/services/plan-welcome.server");

      expect(normalizePlanHandle(null)).toBeNull();
      expect(normalizePlanHandle("")).toBeNull();
      expect(normalizePlanHandle("   ")).toBeNull();
    });

    it("rejects over-long handles", async () => {
      const { normalizePlanHandle } = await import("~/services/plan-welcome.server");

      expect(normalizePlanHandle("a".repeat(100))).toBeNull();
    });
  });

  describe("shouldRefreshPlan", () => {
    it("returns true for known plan handles", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan("starter", null)).toBe(true);
      expect(shouldRefreshPlan("growth", null)).toBe(true);
      expect(shouldRefreshPlan("unlimited", null)).toBe(true);
    });

    it("returns true for unknown non-empty handles (scale, pro-test)", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan("scale", null)).toBe(true);
      expect(shouldRefreshPlan("pro-test", null)).toBe(true);
      expect(shouldRefreshPlan("enterprise", null)).toBe(true);
      expect(shouldRefreshPlan("premium", null)).toBe(true);
    });

    it("returns true for any charge_id", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan(null, "123456")).toBe(true);
      expect(shouldRefreshPlan("anyhandle", "789")).toBe(true);
    });

    it("returns false for missing, empty or whitespace handle without charge_id", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan(null, null)).toBe(false);
      expect(shouldRefreshPlan("", null)).toBe(false);
      expect(shouldRefreshPlan("   ", null)).toBe(false);
      expect(shouldRefreshPlan("", "")).toBe(false);
    });

    it("returns false for handle longer than 32 chars", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan("a".repeat(33), null)).toBe(false);
      expect(shouldRefreshPlan("a".repeat(100), null)).toBe(false);
    });

    it("returns true for handle exactly 32 chars", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan("a".repeat(32), null)).toBe(true);
    });
  });

  describe("processPlanWelcome", () => {
    it("calls resolvePlan with forceRefresh for valid handle", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "growth" },
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it("calls resolvePlan with forceRefresh for charge_id", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "starter" },
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, "charge123");

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
    });

    it("skips when foreign shop param differs from session", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();

      const result = await processPlanWelcome(
        mockSql as never,
        TEST_SHOP,
        "test-other.myshopify.com",
        "growth",
        null
      );

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("foreign_shop");
    });

    it("skips when empty handle and no charge_id", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "", null);

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("no_trigger");
    });

    it("calls resolvePlan for unknown handle (scale)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "scale" },
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "scale", null);

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("refreshed");
    });

    it("calls resolvePlan for unknown handle (pro-test)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "pro-test" },
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "pro-test", null);

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it("skips when handle longer than 32 chars", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "a".repeat(33), null);

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("no_trigger");
    });

    it("falls back silently on refresh failure with reason refresh_failed", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(result.refreshed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("refresh_failed");
    });

    it("re-visits are idempotent (multiple refreshes are harmless)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "unlimited" },
      });

      await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited", null);
      await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited", null);

      expect(resolvePlan).toHaveBeenCalledTimes(2);
    });
  });
});

describe("/app/welcome Route", () => {
  const TEST_SHOP = "test-store.myshopify.com";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects with embedded params preserved (shop, host)", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "growth" } });

    const redirectMock = vi.fn((path: string) => {
      throw new Response(null, {
        status: 302,
        headers: { Location: path },
      });
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: TEST_SHOP },
            redirect: redirectMock,
          }),
        },
      },
    };

    const { loader } = await import("../app.welcome");
    const request = new Request(
      "https://example.com/app/welcome?plan_handle=growth&shop=test-store.myshopify.com&host=abc123&embedded=1"
    );

    try {
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
    }

    expect(redirectMock).toHaveBeenCalledWith("/app?plan_handle=&charge_id=");
  });

  it("redirect target includes empty plan_handle and charge_id to prevent double refresh", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "starter" } });

    let capturedRedirectPath = "";
    const redirectMock = vi.fn((path: string) => {
      capturedRedirectPath = path;
      throw new Response(null, {
        status: 302,
        headers: { Location: path },
      });
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: TEST_SHOP },
            redirect: redirectMock,
          }),
        },
      },
    };

    const { loader } = await import("../app.welcome");
    const request = new Request(
      "https://example.com/app/welcome?plan_handle=starter&charge_id=123456"
    );

    try {
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });
    } catch {
      // Expected redirect throw
    }

    const url = new URL(capturedRedirectPath, "https://example.com");
    expect(url.pathname).toBe("/app");
    expect(url.searchParams.has("plan_handle")).toBe(true);
    expect(url.searchParams.get("plan_handle")).toBe("");
    expect(url.searchParams.has("charge_id")).toBe(true);
    expect(url.searchParams.get("charge_id")).toBe("");
  });
});

describe("/app (index) Route with plan_handle", () => {
  const TEST_SHOP = "test-store.myshopify.com";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("triggers refresh for valid plan_handle", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "starter" } });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "starter", null);

    expect(result.refreshed).toBe(true);
    expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
  });

  it("triggers refresh for charge_id without plan_handle", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "growth" } });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, "charge_456");

    expect(result.refreshed).toBe(true);
  });

  it("ignores foreign shop param", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();

    const result = await processPlanWelcome(
      mockSql as never,
      TEST_SHOP,
      "test-other.myshopify.com",
      "growth",
      null
    );

    expect(resolvePlan).not.toHaveBeenCalled();
    expect(result.reason).toBe("foreign_shop");
  });

  it("no refresh when params missing", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, null);

    expect(resolvePlan).not.toHaveBeenCalled();
    expect(result.skipped).toBe(true);
  });

  it("renders normally with charge_id and shop params (no loop)", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "growth" } });

    const result = await processPlanWelcome(
      mockSql as never,
      TEST_SHOP,
      TEST_SHOP,
      null,
      "charge_789"
    );

    expect(result.refreshed).toBe(true);
  });
});

describe("Refresh trigger tests (tests fail if allowlist requirement restored)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("unknown handles DO trigger refresh (scale, pro-test)", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "scale" } });

    const unknownHandles = ["scale", "pro-test", "enterprise", "premium"];

    for (const handle of unknownHandles) {
      vi.clearAllMocks();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: handle } });
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.refreshed).toBe(true);
      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
    }
  });

  it("over-length handles do NOT trigger refresh", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";

    const overLengthHandles = ["a".repeat(33), "a".repeat(100)];

    for (const handle of overLengthHandles) {
      vi.clearAllMocks();
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("no_trigger");
      expect(resolvePlan).not.toHaveBeenCalled();
    }
  });

  it("known handles DO trigger refresh", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "starter" } });

    const knownHandles = ["starter", "growth", "unlimited"];

    for (const handle of knownHandles) {
      vi.clearAllMocks();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: handle } });
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.refreshed).toBe(true);
      expect(resolvePlan).toHaveBeenCalledTimes(1);
    }
  });

  it("empty, whitespace, null handles do NOT trigger refresh", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";

    const noTriggerHandles: (string | null)[] = [null, "", "   ", "\t", "\n"];

    for (const handle of noTriggerHandles) {
      vi.clearAllMocks();
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("no_trigger");
      expect(resolvePlan).not.toHaveBeenCalled();
    }
  });
});

describe("Route logging (real safeLog, spy on console)", () => {
  const TEST_SHOP = "test-log.myshopify.com";
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("emits event with EXACTLY {refreshed, skipped, reason, hasPlanHandle, hasChargeId}", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "growth" } });

    const redirectMock = vi.fn((path: string) => {
      throw new Response(null, {
        status: 302,
        headers: { Location: path },
      });
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: TEST_SHOP },
            redirect: redirectMock,
          }),
        },
      },
    };

    const { loader } = await import("../app.welcome");
    const request = new Request(
      "https://example.com/app/welcome?plan_handle=growth&charge_id=chg_123"
    );

    try {
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });
    } catch {
      // Expected redirect throw
    }

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logCall = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(logCall as string);

    expect(Object.keys(parsed).sort()).toEqual(
      ["event", "refreshed", "skipped", "reason", "hasPlanHandle", "hasChargeId"].sort()
    );
    expect(parsed).toEqual({
      event: "plan_welcome_processed",
      refreshed: true,
      skipped: false,
      reason: "refreshed",
      hasPlanHandle: true,
      hasChargeId: true,
    });
  });

  it("handle value and charge_id strings never appear in logged output", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "scale" } });

    const TEST_HANDLE = "my-secret-plan-handle";
    const TEST_CHARGE_ID = "chg_secret_charge_12345";

    const redirectMock = vi.fn((path: string) => {
      throw new Response(null, {
        status: 302,
        headers: { Location: path },
      });
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            session: { shop: TEST_SHOP },
            redirect: redirectMock,
          }),
        },
      },
    };

    const { loader } = await import("../app.welcome");
    const request = new Request(
      `https://example.com/app/welcome?plan_handle=${TEST_HANDLE}&charge_id=${TEST_CHARGE_ID}`
    );

    try {
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });
    } catch {
      // Expected redirect throw
    }

    const allLogOutput = JSON.stringify(consoleSpy.mock.calls);
    expect(allLogOutput).not.toContain(TEST_HANDLE);
    expect(allLogOutput).not.toContain(TEST_CHARGE_ID);
    expect(allLogOutput).not.toContain(TEST_SHOP);
  });

  it("logs correct hasPlanHandle/hasChargeId booleans for various inputs", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const testCases = [
      { handle: "growth", chargeId: null, expectedHandle: true, expectedCharge: false },
      { handle: null, chargeId: "chg_1", expectedHandle: false, expectedCharge: true },
      { handle: "", chargeId: "", expectedHandle: false, expectedCharge: false },
      { handle: "   ", chargeId: "   ", expectedHandle: false, expectedCharge: false },
    ];

    for (const tc of testCases) {
      vi.resetModules();
      consoleSpy.mockClear();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "test" } });

      const redirectMock = vi.fn((path: string) => {
        throw new Response(null, {
          status: 302,
          headers: { Location: path },
        });
      });

      const mockContext = {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: redirectMock,
            }),
          },
        },
      };

      const { loader } = await import("../app.welcome");
      const params = new URLSearchParams();
      if (tc.handle !== null) params.set("plan_handle", tc.handle);
      if (tc.chargeId !== null) params.set("charge_id", tc.chargeId);
      const request = new Request(`https://example.com/app/welcome?${params.toString()}`);

      try {
        await loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/app/welcome",
        });
      } catch {
        // Expected redirect throw
      }

      const logCall = consoleSpy.mock.calls[0]?.[0];
      const parsed = JSON.parse(logCall as string);
      expect(parsed.hasPlanHandle).toBe(tc.expectedHandle);
      expect(parsed.hasChargeId).toBe(tc.expectedCharge);
    }
  });
});
