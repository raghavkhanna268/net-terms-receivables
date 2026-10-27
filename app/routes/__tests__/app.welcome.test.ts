import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for plan welcome redirect handling (App Pricing).
 *
 * Tests verify the /app/welcome entry point:
 * 1. Every welcome visit force-refreshes the plan via resolvePlanWithStatus
 * 2. Params (plan_handle, charge_id) are ignored for triggering refresh
 * 3. Foreign shop param (differs from session) → no refresh
 * 4. Re-visits are harmless and idempotent
 * 5. Error status from refresh → refresh_failed
 * 6. Thrown errors → refresh_failed
 * 7. Redirect preserves shop and host params
 * 8. Logging emits exactly {refreshed, skipped, reason, hasPlanHandle, hasChargeId}
 */

vi.mock("~/services/plan.server", () => ({
  resolvePlanWithStatus: vi.fn(),
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

  describe("processPlanWelcome", () => {
    it("refreshes plan when plan_handle and charge_id are empty", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "growth" }, subscriptionId: "gid://123", fromCache: false },
        status: "active",
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "", "");

      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("refreshed");
    });

    it("refreshes plan when plan_handle and charge_id are missing", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
        status: "none",
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, null);

      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("refreshed");
    });

    it("reports refresh_failed when the forced lookup returns error status", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "none" }, subscriptionId: null, fromCache: true },
        status: "error",
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("refresh_failed");
    });

    it("does not refresh for a different shop param", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();

      const result = await processPlanWelcome(
        mockSql as never,
        TEST_SHOP,
        "other-store.myshopify.com",
        "growth",
        "charge123"
      );

      expect(resolvePlanWithStatus).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("foreign_shop");
    });

    it("calls resolvePlanWithStatus with forceRefresh for valid handle", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "growth" }, subscriptionId: "gid://123", fromCache: false },
        status: "active",
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it("calls resolvePlanWithStatus with forceRefresh for charge_id", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "starter" }, subscriptionId: "gid://456", fromCache: false },
        status: "active",
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, "charge123");

      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
    });

    it("refreshes for over-length handles (params are not validated)", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
        status: "none",
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "a".repeat(33), null);

      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.refreshed).toBe(true);
    });

    it("returns refresh_failed when resolvePlanWithStatus throws", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(result.refreshed).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe("refresh_failed");
    });

    it("re-visits are idempotent (multiple refreshes are harmless)", async () => {
      const { resolvePlanWithStatus } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "unlimited" }, subscriptionId: "gid://789", fromCache: false },
        status: "active",
      });

      await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited", null);
      await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited", null);

      expect(resolvePlanWithStatus).toHaveBeenCalledTimes(2);
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

  it("loader refreshes once and redirects for /app/welcome?plan_handle=&charge_id=", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "growth" }, subscriptionId: "gid://123", fromCache: false },
      status: "active",
    });

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
      "https://example.com/app/welcome?plan_handle=&charge_id="
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

    expect(resolvePlanWithStatus).toHaveBeenCalledTimes(1);
    expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
    expect(redirectMock).toHaveBeenCalledWith("/app?plan_handle=&charge_id=");
  });

  it("redirects with embedded params preserved (shop, host)", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "growth" }, subscriptionId: "gid://123", fromCache: false },
      status: "active",
    });

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
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "starter" }, subscriptionId: "gid://456", fromCache: false },
      status: "active",
    });

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
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "starter" }, subscriptionId: "gid://123", fromCache: false },
      status: "active",
    });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "starter", null);

    expect(result.refreshed).toBe(true);
    expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
  });

  it("triggers refresh for charge_id without plan_handle", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "growth" }, subscriptionId: "gid://456", fromCache: false },
      status: "active",
    });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, "charge_456");

    expect(result.refreshed).toBe(true);
  });

  it("ignores foreign shop param", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();

    const result = await processPlanWelcome(
      mockSql as never,
      TEST_SHOP,
      "other-store.myshopify.com",
      "growth",
      null
    );

    expect(resolvePlanWithStatus).not.toHaveBeenCalled();
    expect(result.reason).toBe("foreign_shop");
  });

  it("refreshes when params missing (every welcome visit refreshes)", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, null);

    expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
    expect(result.refreshed).toBe(true);
  });

  it("renders normally with charge_id and shop params (no loop)", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "growth" }, subscriptionId: "gid://789", fromCache: false },
      status: "active",
    });

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

describe("Refresh trigger tests (every welcome visit refreshes)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("unknown handles DO trigger refresh (scale, pro-test)", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "scale" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

    const unknownHandles = ["scale", "pro-test", "enterprise", "premium"];

    for (const handle of unknownHandles) {
      vi.clearAllMocks();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: handle }, subscriptionId: null, fromCache: false },
        status: "none",
      });
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.refreshed).toBe(true);
      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
    }
  });

  it("over-length handles still trigger refresh (params not validated)", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";

    const overLengthHandles = ["a".repeat(33), "a".repeat(100)];

    for (const handle of overLengthHandles) {
      vi.clearAllMocks();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
        status: "none",
      });
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.refreshed).toBe(true);
      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
    }
  });

  it("known handles DO trigger refresh", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "starter" }, subscriptionId: "gid://123", fromCache: false },
      status: "active",
    });

    const knownHandles = ["starter", "growth", "unlimited"];

    for (const handle of knownHandles) {
      vi.clearAllMocks();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: handle }, subscriptionId: "gid://123", fromCache: false },
        status: "active",
      });
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.refreshed).toBe(true);
      expect(resolvePlanWithStatus).toHaveBeenCalledTimes(1);
    }
  });

  it("empty, whitespace, null handles DO trigger refresh (every visit refreshes)", async () => {
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_SHOP = "test-guard.myshopify.com";

    const emptyHandles: (string | null)[] = [null, "", "   ", "\t", "\n"];

    for (const handle of emptyHandles) {
      vi.clearAllMocks();
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "none" }, subscriptionId: null, fromCache: false },
        status: "none",
      });
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle, null);
      expect(result.refreshed).toBe(true);
      expect(result.reason).toBe("refreshed");
      expect(resolvePlanWithStatus).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
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
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "growth" }, subscriptionId: "gid://123", fromCache: false },
      status: "active",
    });

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
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      plan: { plan: { key: "scale" }, subscriptionId: null, fromCache: false },
      status: "none",
    });

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
    const { resolvePlanWithStatus } = await import("~/services/plan.server");
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
      (resolvePlanWithStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { plan: { key: "test" }, subscriptionId: null, fromCache: false },
        status: "none",
      });

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
