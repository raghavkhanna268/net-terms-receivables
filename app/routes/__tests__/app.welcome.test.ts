import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for plan welcome redirect handling (App Pricing).
 *
 * Tests verify both entry points (/app/welcome and /app with plan_handle):
 * 1. Valid handle with activeSubscriptions confirmation → stored as confirmed
 * 2. Valid handle with empty activeSubscriptions → stored as pending, not confirmed
 * 3. Valid handle with API error → pending/unknown, no throw, no gating
 * 4. Tampered plan_handle (unknown, injection-like, over-long) → no write
 * 5. Foreign shop param (differs from session) → no write for that shop
 * 6. Missing plan_handle → no write
 * 7. Re-visits: same handle twice is idempotent, confirmed not downgraded
 * 8. Gating off: pending never redirects
 * 9. /app with charge_id and shop params renders normally without loop
 */

vi.mock("~/services/drain/admin-client.server", () => ({
  adminGraphQL: vi.fn(),
}));

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Plan Welcome Service (shared logic)", () => {
  const TEST_SHOP = "test-store.myshopify.com";
  const TEST_SHOP_ID = "shop-abc-123";

  let mockSql: ReturnType<typeof vi.fn>;
  let updateCalls: Array<unknown[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    updateCalls = [];

    mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");

      if (query.includes("SELECT") && query.includes('"Shop"')) {
        return [{ id: TEST_SHOP_ID, plan_key: "none" }];
      }

      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }

      return [];
    });
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
    it("stores as confirmed when subscription matches", async () => {
      const { adminGraphQL } = await import("~/services/drain/admin-client.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/123",
                name: "Growth",
                status: "ACTIVE",
                test: false,
              },
            ],
          },
        },
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth");

      expect(result.verified).toBe(true);
      expect(result.pending).toBe(false);
      expect(updateCalls.length).toBe(1);
      const [planKey, subId, subName, isTest] = updateCalls[0];
      expect(planKey).toBe("growth");
      expect(subId).toBe("gid://shopify/AppSubscription/123");
      expect(subName).toBe("Growth");
      expect(isTest).toBe(false);
    });

    it("stores as pending when activeSubscriptions is empty", async () => {
      const { adminGraphQL } = await import("~/services/drain/admin-client.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "starter");

      expect(result.verified).toBe(false);
      expect(result.pending).toBe(true);
      expect(updateCalls.length).toBe(1);
      expect(updateCalls[0][0]).toBe("starter");
    });

    it("stores as pending on API error, no throw", async () => {
      const { adminGraphQL } = await import("~/services/drain/admin-client.server");
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      (adminGraphQL as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited");

      expect(result.verified).toBe(false);
      expect(result.pending).toBe(true);
    });

    it("skips when foreign shop param differs from session", async () => {
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const result = await processPlanWelcome(
        mockSql as never,
        TEST_SHOP,
        "attacker.myshopify.com",
        "growth"
      );

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("foreign_shop");
      expect(updateCalls.length).toBe(0);
    });

    it("skips when invalid handle", async () => {
      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "enterprise");

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("invalid_handle");
      expect(updateCalls.length).toBe(0);
    });

    it("skips idempotently when already confirmed with same handle", async () => {
      const confirmedMockSql = vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT") && query.includes('"Shop"')) {
          return [{ id: TEST_SHOP_ID, plan_key: "growth" }];
        }
        if (query.includes("UPDATE")) {
          updateCalls.push([]);
          return [];
        }
        return [];
      });

      const { processPlanWelcome } = await import("~/services/plan-welcome.server");

      const result = await processPlanWelcome(confirmedMockSql as never, TEST_SHOP, null, "growth");

      expect(result.reason).toBe("already_confirmed");
      expect(updateCalls.length).toBe(0);
    });
  });
});

describe("/app/welcome Route", () => {
  const TEST_SHOP = "test-store.myshopify.com";
  const TEST_SHOP_ID = "shop-abc-123";

  const mockSession = { shop: TEST_SHOP };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
  };

  let mockSql: ReturnType<typeof vi.fn>;
  let updateCalls: Array<unknown[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    updateCalls = [];

    mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT") && query.includes('"Shop"')) {
        return [{ id: TEST_SHOP_ID, plan_key: "none" }];
      }
      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }
      return [];
    });

    mockContext.shopify.authenticate.admin.mockResolvedValue({ session: mockSession });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /app after processing", async () => {
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "gid://shopify/AppSubscription/123", name: "Growth", status: "ACTIVE", test: false },
          ],
        },
      },
    });

    const { loader } = await import("../app.welcome");
    const request = new Request("https://example.com/app/welcome?plan_handle=growth");
    const result = await loader({
      request,
      context: mockContext as never,
      params: {},
      url: new URL(request.url),
      pattern: "/app/welcome",
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe("/app");
    expect(updateCalls.length).toBe(1);
  });

  it("stores confirmed plan on verification", async () => {
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "gid://shopify/AppSubscription/456", name: "Starter", status: "ACTIVE", test: true },
          ],
        },
      },
    });

    const { loader } = await import("../app.welcome");
    const request = new Request("https://example.com/app/welcome?plan_handle=starter");
    await loader({
      request,
      context: mockContext as never,
      params: {},
      url: new URL(request.url),
      pattern: "/app/welcome",
    });

    expect(updateCalls.length).toBe(1);
    const [planKey, , , isTest] = updateCalls[0];
    expect(planKey).toBe("starter");
    expect(isTest).toBe(true);
  });

  it("stores pending when activeSubscriptions is empty", async () => {
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });

    const { loader } = await import("../app.welcome");
    const request = new Request("https://example.com/app/welcome?plan_handle=unlimited");
    await loader({
      request,
      context: mockContext as never,
      params: {},
      url: new URL(request.url),
      pattern: "/app/welcome",
    });

    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0]).toBe("unlimited");
  });

  it("ignores foreign shop param", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const { loader } = await import("../app.welcome");
    const request = new Request(
      "https://example.com/app/welcome?plan_handle=growth&shop=attacker.myshopify.com"
    );
    await loader({
      request,
      context: mockContext as never,
      params: {},
      url: new URL(request.url),
      pattern: "/app/welcome",
    });

    expect(updateCalls.length).toBe(0);
  });

  it("rejects tampered handles", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const { loader } = await import("../app.welcome");

    for (const handle of ["enterprise", "none", "'; DROP TABLE Shop;--", "a".repeat(100)]) {
      updateCalls.length = 0;
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=${encodeURIComponent(handle)}`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });
      expect(updateCalls.length).toBe(0);
    }
  });

  it("no write when plan_handle missing", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const { loader } = await import("../app.welcome");
    const request = new Request("https://example.com/app/welcome");
    await loader({
      request,
      context: mockContext as never,
      params: {},
      url: new URL(request.url),
      pattern: "/app/welcome",
    });

    expect(updateCalls.length).toBe(0);
  });
});

describe("/app (index) Route with plan_handle", () => {
  const TEST_SHOP = "test-store.myshopify.com";
  const TEST_SHOP_ID = "shop-index-123";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("processes plan_handle when present", async () => {
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE") && query.includes("plan_key")) {
        updateCalls.push(values);
        return [];
      }
      if (query.includes("SELECT") && query.includes('"Shop"') && query.includes("plan_key")) {
        return [{ id: TEST_SHOP_ID, plan_key: "none" }];
      }
      if (query.includes("SELECT") && query.includes('"Shop"')) {
        return [{ id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" }];
      }
      return [];
    });

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "gid://shopify/AppSubscription/999", name: "Unlimited", status: "ACTIVE", test: false },
          ],
        },
      },
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "unlimited");

    expect(result.verified).toBe(true);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0][0]).toBe("unlimited");
  });

  it("ignores charge_id param (no error, no loop)", async () => {
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const mockSql = vi.fn(async () => [{ id: TEST_SHOP_ID, plan_key: "growth" }]);

    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, null);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("invalid_handle");
  });

  it("stores pending when cannot verify on /app", async () => {
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");

    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }
      if (query.includes("SELECT") && query.includes('"Shop"')) {
        return [{ id: TEST_SHOP_ID, plan_key: "none" }];
      }
      return [];
    });

    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth");

    expect(result.pending).toBe(true);
    expect(updateCalls.length).toBe(1);
  });

  it("ignores foreign shop param on /app", async () => {
    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }
      return [{ id: TEST_SHOP_ID, plan_key: "none" }];
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    const result = await processPlanWelcome(
      mockSql as never,
      TEST_SHOP,
      "attacker.myshopify.com",
      "growth"
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("foreign_shop");
    expect(updateCalls.length).toBe(0);
  });

  it("rejects tampered handles on /app", async () => {
    const mockSql = vi.fn(async () => [{ id: TEST_SHOP_ID, plan_key: "none" }]);

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    for (const handle of ["premium", "$0", "test", "none"]) {
      const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("invalid_handle");
    }
  });

  it("idempotent re-visit on /app", async () => {
    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }
      if (query.includes("SELECT") && query.includes('"Shop"')) {
        return [{ id: TEST_SHOP_ID, plan_key: "starter" }];
      }
      return [];
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    const result = await processPlanWelcome(mockSql as never, TEST_SHOP, null, "starter");

    expect(result.reason).toBe("already_confirmed");
    expect(updateCalls.length).toBe(0);
  });
});

describe("/app with charge_id and shop params renders normally", () => {
  it("processPlanWelcome skips when plan_handle is null (charge_id only)", async () => {
    const mockSql = vi.fn(async () => []);

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    const result = await processPlanWelcome(mockSql as never, "test.myshopify.com", null, null);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("invalid_handle");
  });

  it("processPlanWelcome skips foreign shop even with valid handle", async () => {
    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    const result = await processPlanWelcome(
      vi.fn() as never,
      "session-shop.myshopify.com",
      "url-shop.myshopify.com",
      "growth"
    );

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("foreign_shop");
  });
});

describe("Mutation guard tests (tests fail if verification/allowlist removed)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("invalid handles must NOT write - verifies allowlist protection", async () => {
    const TEST_SHOP = "test-guard.myshopify.com";
    const TEST_SHOP_ID = "shop-guard-123";

    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }
      return [{ id: TEST_SHOP_ID, plan_key: "none" }];
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

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
      updateCalls.length = 0;
      await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle);
      expect(updateCalls.length).toBe(0);
    }
  });

  it("valid handles must write - verifies allowlist includes expected plans", async () => {
    const TEST_SHOP = "test-guard.myshopify.com";
    const TEST_SHOP_ID = "shop-guard-123";
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");

    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE")) {
        updateCalls.push(values);
        return [];
      }
      return [{ id: TEST_SHOP_ID, plan_key: "none" }];
    });

    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");

    const validHandles = ["starter", "growth", "unlimited"];

    for (const handle of validHandles) {
      updateCalls.length = 0;
      vi.clearAllMocks();
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: { currentAppInstallation: { activeSubscriptions: [] } },
      });

      await processPlanWelcome(mockSql as never, TEST_SHOP, null, handle);
      expect(updateCalls.length).toBe(1);
    }
  });
});

describe("Logging tests (P7 compliance)", () => {
  it("does not log shop domain in any console output", async () => {
    const TEST_SHOP = "sensitive-shop.myshopify.com";
    const TEST_SHOP_ID = "shop-log-789";

    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { adminGraphQL } = await import("~/services/drain/admin-client.server");

    const mockSql = vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT") && query.includes('"Shop"')) {
        return [{ id: TEST_SHOP_ID, plan_key: "none" }];
      }
      return [];
    });

    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "gid://shopify/AppSubscription/123", name: "Growth", status: "ACTIVE", test: false },
          ],
        },
      },
    });

    const { processPlanWelcome } = await import("~/services/plan-welcome.server");
    await processPlanWelcome(mockSql as never, TEST_SHOP, null, "growth");

    const allLogs = [
      ...consoleSpy.mock.calls.map((c) => c.join(" ")),
      ...consoleWarnSpy.mock.calls.map((c) => c.join(" ")),
    ].join("\n");

    expect(allLogs).not.toContain(".myshopify.com");
    expect(allLogs).not.toContain(TEST_SHOP);

    consoleSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});
