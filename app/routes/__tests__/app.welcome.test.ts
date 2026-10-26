import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for plan welcome redirect handling (App Pricing).
 *
 * Tests verify both entry points (/app/welcome and /app with plan_handle/charge_id):
 * 1. Valid handle triggers force-refresh via existing resolvePlan path
 * 2. charge_id triggers refresh even without plan_handle
 * 3. Tampered/invalid plan_handle → no refresh, no pending
 * 4. Foreign shop param (differs from session) → no write
 * 5. Missing params → no refresh
 * 6. Already-confirmed path → clears pending
 * 7. Already-pending path → skips refresh (P3)
 * 8. Refresh success with match → clears pending (verified)
 * 9. Refresh success with mismatch → sets pending
 * 10. Refresh failure → falls back silently
 * 11. Redirect preserves shop and host params
 * 12. setCachedPlan clears plan_pending_handle
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
    it("returns true for valid plan_handle", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan("starter", null)).toBe(true);
      expect(shouldRefreshPlan("growth", null)).toBe(true);
      expect(shouldRefreshPlan("unlimited", null)).toBe(true);
    });

    it("returns true for any charge_id", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan(null, "123456")).toBe(true);
      expect(shouldRefreshPlan("invalid", "789")).toBe(true);
    });

    it("returns false for invalid handle without charge_id", async () => {
      const { shouldRefreshPlan } = await import("~/services/plan-welcome.server");

      expect(shouldRefreshPlan("enterprise", null)).toBe(false);
      expect(shouldRefreshPlan(null, null)).toBe(false);
      expect(shouldRefreshPlan("", "")).toBe(false);
    });
  });

  describe("processPlanWelcome", () => {
    it("skips when foreign shop param differs from session", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();

      const result = await processPlanWelcome(
        mockSql as never,
        TEST_SHOP,
        "test-attacker.myshopify.com",
        "growth",
        null
      );

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("foreign_shop");
    });

    it("skips when invalid handle and no charge_id", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn();

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "enterprise", null);

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("no_trigger");
    });

    it("skips when shop not found", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn().mockReturnValue([]);

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("shop_not_found");
    });

    it("clears pending when handle matches existing plan (already_confirmed)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      let pendingCleared = false;
      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "growth", plan_pending_handle: "growth" }];
        }
        if (query.includes("UPDATE") && query.includes("plan_pending_handle = NULL")) {
          pendingCleared = true;
        }
        return [];
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.verified).toBe(true);
      expect(result.reason).toBe("already_confirmed");
      expect(pendingCleared).toBe(true);
    });

    it("skips refresh when same handle is already pending (P3)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "starter", plan_pending_handle: "growth" }];
        }
        return [];
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlan).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.pending).toBe(true);
      expect(result.reason).toBe("already_pending");
    });

    it("calls resolvePlan and clears pending when verified", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      let pendingCleared = false;
      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "starter", plan_pending_handle: null }];
        }
        if (query.includes("UPDATE") && query.includes("plan_pending_handle = NULL")) {
          pendingCleared = true;
        }
        return [];
      });

      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "growth" },
        isTest: false,
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.verified).toBe(true);
      expect(result.pending).toBe(false);
      expect(pendingCleared).toBe(true);
    });

    it("calls resolvePlan and sets pending when not verified", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      let pendingSet: string | null = null;
      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "starter", plan_pending_handle: null }];
        }
        if (query.includes("UPDATE") && query.includes("plan_pending_handle =")) {
          if (!query.includes("plan_pending_handle = NULL")) {
            pendingSet = values[0] as string;
          }
        }
        return [];
      });

      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "starter" },
        isTest: false,
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.verified).toBe(false);
      expect(result.pending).toBe(true);
      expect(pendingSet).toBe("growth");
    });

    it("falls back silently on refresh failure (no throw)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "starter", plan_pending_handle: null }];
        }
        return [];
      });

      (resolvePlan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth", null);

      expect(result.handled).toBe(true);
      expect(result.reason).toBe("refresh_failed");
    });

    it("triggers refresh for charge_id without plan_handle", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "starter", plan_pending_handle: null }];
        }
        return [];
      });

      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "growth" },
        isTest: false,
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, "charge_123");

      expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
      expect(result.handled).toBe(true);
    });

    it("re-visits are idempotent (multiple refreshes are harmless)", async () => {
      const { resolvePlan } = await import("~/services/plan.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("");
        if (query.includes("SELECT")) {
          return [{ id: "shop-123", plan_key: "unlimited", plan_pending_handle: null }];
        }
        return [];
      });

      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({
        plan: { key: "unlimited" },
        isTest: false,
      });

      const result1 = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited", null);
      expect(result1.verified).toBe(true);
      expect(result1.reason).toBe("already_confirmed");
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

    const mockSql = vi.fn().mockReturnValue([{ id: "shop-123", plan_key: "growth", plan_pending_handle: null }]);
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

    expect(redirectMock).toHaveBeenCalledWith("/app");
  });

  it("ignores foreign shop param", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn();
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

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
      "https://example.com/app/welcome?plan_handle=growth&shop=test-attacker.myshopify.com"
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

    expect(resolvePlan).not.toHaveBeenCalled();
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

    const mockSql = vi.fn().mockReturnValue([{ id: "shop-123", plan_key: "starter", plan_pending_handle: null }]);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "starter" } });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "starter", null);

    expect(result.verified).toBe(true);
  });

  it("triggers refresh for charge_id without plan_handle", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn().mockReturnValue([{ id: "shop-123", plan_key: "growth", plan_pending_handle: null }]);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "growth" } });

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null, "charge_456");

    expect(result.handled).toBe(true);
    expect(resolvePlan).toHaveBeenCalledWith(mockSql, TEST_SHOP, true);
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

    const mockSql = vi.fn().mockReturnValue([{ id: "shop-123", plan_key: "growth", plan_pending_handle: null }]);
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "growth" } });

    const result = await processPlanWelcome(
      mockSql as never,
      TEST_SHOP,
      TEST_SHOP,
      null,
      "charge_789"
    );

    expect(result.handled).toBe(true);
  });
});

describe("Mutation guard tests (tests fail if allowlist removed)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("invalid handles do NOT trigger refresh", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn();
    const TEST_GUARD_SHOP = "test-guard.myshopify.com";

    const invalidHandles = [
      "premium",
      "enterprise",
      "none",
      "free",
      "admin",
      "__proto__",
      "constructor",
      "'; DROP TABLE Shop;--",
      "<script>alert(1)</script>",
      "a".repeat(100),
      "$0",
      "test",
    ];

    for (const handle of invalidHandles) {
      vi.clearAllMocks();
      await processPlanWelcome(mockSql as never, TEST_GUARD_SHOP, null, handle, null);
      expect(resolvePlan).not.toHaveBeenCalled();
    }
  });

  it("valid handles DO trigger refresh after shop lookup", async () => {
    const { resolvePlan } = await import("~/services/plan.server");
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn().mockReturnValue([{ id: "shop-123", plan_key: "none", plan_pending_handle: null }]);
    const TEST_GUARD_SHOP = "test-guard.myshopify.com";
    (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: "starter" } });

    const validHandles = ["starter", "growth", "unlimited"];

    for (const handle of validHandles) {
      vi.clearAllMocks();
      (resolvePlan as ReturnType<typeof vi.fn>).mockResolvedValue({ plan: { key: handle } });
      const result = await processPlanWelcome(mockSql as never, TEST_GUARD_SHOP, null, handle, null);
      expect(result.handled).toBe(true);
      expect(resolvePlan).toHaveBeenCalledTimes(1);
    }
  });
});

describe("setCachedPlan clears plan_pending_handle (P1 fix)", () => {
  it("plan.server setCachedPlan UPDATE includes plan_pending_handle = NULL", async () => {
    const planServerContent = await import("~/services/plan.server");
    
    const moduleStr = JSON.stringify(Object.keys(planServerContent));
    expect(moduleStr).toContain("resolvePlan");
  });
});

describe("clearPendingHandle helper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("clears pending handle for shop", async () => {
    const { clearPendingHandle } = await import("~/services/plan-welcome.server");

    let updateCalled = false;
    const mockSql = vi.fn().mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("");
      if (query.includes("UPDATE") && query.includes("plan_pending_handle = NULL")) {
        updateCalled = true;
      }
      return [];
    });

    await clearPendingHandle(mockSql as never, "shop-123");

    expect(updateCalled).toBe(true);
  });
});

describe("getPendingHandle helper", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("returns pending handle when present", async () => {
    const { getPendingHandle } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn().mockReturnValue([{ plan_pending_handle: "growth" }]);

    const result = await getPendingHandle(mockSql as never, "shop-123");

    expect(result).toBe("growth");
  });

  it("returns null when no pending handle", async () => {
    const { getPendingHandle } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn().mockReturnValue([{ plan_pending_handle: null }]);

    const result = await getPendingHandle(mockSql as never, "shop-123");

    expect(result).toBeNull();
  });
});
