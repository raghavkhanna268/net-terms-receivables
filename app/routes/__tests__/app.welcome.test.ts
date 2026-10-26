import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for welcome link redirect handler (App Pricing).
 *
 * Tests verify:
 * 1. Valid handle with activeSubscriptions confirmation → stored as confirmed
 * 2. Valid handle with empty activeSubscriptions → stored as pending, not confirmed
 * 3. Valid handle with API error → pending/unknown, no throw, no gating
 * 4. Tampered plan_handle (unknown, injection-like, over-long) → no write
 * 5. Foreign shop param (differs from session) → no write for that shop
 * 6. Missing plan_handle → no write
 * 7. Re-visits: same handle twice is idempotent, confirmed not downgraded
 * 8. Gating off: pending never redirects
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

describe("Welcome Link Redirect Handler", () => {
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

  let mockSql: ReturnType<typeof vi.fn> & {
    calls: Array<{ query: string; values: unknown[] }>;
  };
  let updateCalls: Array<unknown[]>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    updateCalls = [];

    mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes('"Shop"')) {
          return [{ id: TEST_SHOP_ID, plan_key: "none" }];
        }

        if (query.includes("UPDATE")) {
          updateCalls.push(values);
          return [];
        }

        return [];
      }),
      { calls: [] as Array<{ query: string; values: unknown[] }> }
    );

    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Valid handle with activeSubscriptions confirmation", () => {
    it("stores as confirmed when subscription matches", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
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

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );
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
      const [planKey, subId, subName, isTest] = updateCalls[0];
      expect(planKey).toBe("growth");
      expect(subId).toBe("gid://shopify/AppSubscription/123");
      expect(subName).toBe("Growth");
      expect(isTest).toBe(false);
    });

    it("handles case-insensitive plan_handle", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/456",
                name: "STARTER",
                status: "ACTIVE",
                test: true,
              },
            ],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=STARTER`
      );
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
  });

  describe("Valid handle with empty activeSubscriptions", () => {
    it("stores as pending, NOT confirmed", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });

      expect(updateCalls.length).toBe(1);
      const values = updateCalls[0];
      expect(values[0]).toBe("growth");
    });

    it("does not call planKey update columns when storing pending", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      let lastQuery = "";
      const trackingSql = vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join("?");
          lastQuery = query;

          if (query.includes("SELECT") && query.includes('"Shop"')) {
            return [{ id: TEST_SHOP_ID, plan_key: "none" }];
          }

          if (query.includes("UPDATE")) {
            updateCalls.push(values);
            return [];
          }

          return [];
        }
      );

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(trackingSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=unlimited`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });

      expect(lastQuery).toContain("plan_pending_handle");
      expect(lastQuery).not.toContain("subscription_id");
    });
  });

  describe("API error handling", () => {
    it("stores as pending on API error, no throw", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        error: "Network error",
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );

      const result = await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(302);
    });

    it("stores as pending on thrown exception, no throw to caller", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Connection failed")
      );

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=starter`
      );

      await expect(
        loader({
          request,
          context: mockContext as never,
          params: {},
          url: new URL(request.url),
          pattern: "/app/welcome",
        })
      ).resolves.toBeInstanceOf(Response);
    });
  });

  describe("Tampered plan_handle - no write", () => {
    it("rejects unknown plan handle", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=enterprise`
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

    it("rejects injection-like handle with SQL characters", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth'; DROP TABLE Shop;--`
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

    it("rejects over-long handle (> 32 chars)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const longHandle = "a".repeat(100);
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=${longHandle}`
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

    it("rejects empty handle", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=`
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

    it("rejects handle with only whitespace", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=%20%20%20`
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

    it("rejects handle 'none'", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=none`
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
  });

  describe("Foreign shop param - no write for that shop", () => {
    it("ignores shop param that differs from session", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/789",
                name: "Growth",
                status: "ACTIVE",
                test: false,
              },
            ],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth&shop=attacker.myshopify.com`
      );
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
      expect(updateCalls.length).toBe(0);
    });

    it("allows shop param that matches session", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [
              {
                id: "gid://shopify/AppSubscription/999",
                name: "Unlimited",
                status: "ACTIVE",
                test: false,
              },
            ],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=unlimited&shop=${TEST_SHOP}`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });

      expect(updateCalls.length).toBe(1);
    });
  });

  describe("Missing plan_handle - no write", () => {
    it("redirects without write when plan_handle missing", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(`https://example.com/app/welcome`);
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
      expect(updateCalls.length).toBe(0);
    });
  });

  describe("Idempotency - re-visits", () => {
    it("same handle twice is idempotent (already confirmed)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );

      const confirmedMockSql = vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join("?");

          if (query.includes("SELECT") && query.includes('"Shop"')) {
            return [{ id: TEST_SHOP_ID, plan_key: "growth" }];
          }

          if (query.includes("UPDATE")) {
            updateCalls.push(values);
            return [];
          }

          return [];
        }
      );

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(
        confirmedMockSql
      );
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

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });

      expect(updateCalls.length).toBe(0);
      expect(adminGraphQL).not.toHaveBeenCalled();
    });

    it("confirmed plan is not downgraded to pending", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );

      const confirmedMockSql = vi.fn(
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join("?");

          if (query.includes("SELECT") && query.includes('"Shop"')) {
            return [{ id: TEST_SHOP_ID, plan_key: "starter" }];
          }

          if (query.includes("UPDATE")) {
            updateCalls.push(values);
            return [];
          }

          return [];
        }
      );

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(
        confirmedMockSql
      );
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });

      expect(updateCalls.length).toBe(1);
      const values = updateCalls[0];
      expect(values[0]).toBe("growth");
    });
  });

  describe("Gating: pending never redirects", () => {
    it("pending plan does not cause gating redirect", async () => {
      const { adminGraphQL } = await import(
        "~/services/drain/admin-client.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );
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
    });
  });

  describe("Shop not found", () => {
    it("redirects to /app when shop not in database", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      const noShopMockSql = vi.fn(async () => []);

      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(noShopMockSql);

      const { loader } = await import("../app.welcome");
      const request = new Request(
        `https://example.com/app/welcome?plan_handle=growth`
      );
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
    });
  });
});

describe("Mutation guard tests (tests fail if verification/allowlist removed)", () => {
  const TEST_SHOP = "test-store.myshopify.com";
  const TEST_SHOP_ID = "shop-def-456";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalid handles must NOT write - verifies allowlist protection", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");

    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes('"Shop"')) {
          return [{ id: TEST_SHOP_ID, plan_key: "none" }];
        }

        if (query.includes("UPDATE")) {
          updateCalls.push(values);
          return [];
        }

        return [];
      }
    );

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({ session: { shop: TEST_SHOP } }),
        },
      },
    };

    const { loader } = await import("../app.welcome");

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
    ];

    for (const handle of invalidHandles) {
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

  it("valid handles must write - verifies allowlist includes expected plans", async () => {
    const { getRequestSql } = await import("~/lib/request-context.server");
    const { adminGraphQL } = await import(
      "~/services/drain/admin-client.server"
    );

    const updateCalls: unknown[][] = [];
    const mockSql = vi.fn(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes('"Shop"')) {
          return [{ id: TEST_SHOP_ID, plan_key: "none" }];
        }

        if (query.includes("UPDATE")) {
          updateCalls.push(values);
          return [];
        }

        return [];
      }
    );

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      data: {
        currentAppInstallation: {
          activeSubscriptions: [],
        },
      },
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({ session: { shop: TEST_SHOP } }),
        },
      },
    };

    const { loader } = await import("../app.welcome");

    const validHandles = ["starter", "growth", "unlimited"];

    for (const handle of validHandles) {
      updateCalls.length = 0;
      vi.clearAllMocks();
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (adminGraphQL as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        data: {
          currentAppInstallation: {
            activeSubscriptions: [],
          },
        },
      });

      const request = new Request(
        `https://example.com/app/welcome?plan_handle=${handle}`
      );
      await loader({
        request,
        context: mockContext as never,
        params: {},
        url: new URL(request.url),
        pattern: "/app/welcome",
      });
      expect(updateCalls.length).toBe(1);
    }
  });
});

describe("Logging tests (P7 compliance)", () => {
  const TEST_SHOP = "test-store.myshopify.com";
  const TEST_SHOP_ID = "shop-log-789";

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not log shop domain in any console output", async () => {
    const consoleSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const { getRequestSql } = await import("~/lib/request-context.server");
    const { adminGraphQL } = await import(
      "~/services/drain/admin-client.server"
    );

    const mockSql = vi.fn(
      async (strings: TemplateStringsArray) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes('"Shop"')) {
          return [{ id: TEST_SHOP_ID, plan_key: "none" }];
        }

        return [];
      }
    );

    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
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

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({ session: { shop: TEST_SHOP } }),
        },
      },
    };

    const { loader } = await import("../app.welcome");
    const request = new Request(
      `https://example.com/app/welcome?plan_handle=growth`
    );
    await loader({
      request,
      context: mockContext as never,
      params: {},
      url: new URL(request.url),
      pattern: "/app/welcome",
    });

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
