import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/**
 * Tests for app.onboarding route (S23).
 *
 * Tests verify:
 * 1. Dismiss action updates Shop.onboarding_dismissed_at
 * 2. Reopen action clears Shop.onboarding_dismissed_at
 * 3. Loader returns correct onboarding state
 */

const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn((s) => s) });

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn().mockResolvedValue({
    plan: { key: "free" },
    subscriptionName: "Free",
    isTest: false,
  }),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 3 },
    importsThisMonth: { current: 0, limit: 1 },
  }),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getShopAgingTotals: vi.fn().mockResolvedValue({
    totalByCurrency: {},
    buckets: {
      current: { byCurrency: {} },
      "1-30": { byCurrency: {} },
      "31-60": { byCurrency: {} },
      "61-90": { byCurrency: {} },
      "90+": { byCurrency: {} },
    },
    overdueByCurrency: {},
    oldestOverdueDays: null,
  }),
  getBuyerLedger: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

describe("app.onboarding", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("action - dismiss", () => {
    it("updates Shop.onboarding_dismissed_at to NOW()", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("UPDATE") && query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "dismiss");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: true, action: "dismissed" });
      expect(mockSql).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining("UPDATE")]),
        expect.anything()
      );
    });

    it("returns error when shop not found", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "dismiss");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: false, error: "Shop not found" });
    });
  });

  describe("action - reopen", () => {
    it("clears Shop.onboarding_dismissed_at", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        if (query.includes("UPDATE") && query.includes("onboarding_dismissed_at = NULL")) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "reopen");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: true, action: "reopened" });
    });
  });

  describe("action - unknown", () => {
    it("returns error for unknown action", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }
        return Promise.resolve([]);
      });

      const { action } = await import("../app.onboarding");

      const formData = new FormData();
      formData.set("_action", "invalid");

      const result = await action({
        request: new Request("https://example.com/app/onboarding", {
          method: "POST",
          body: formData,
        }),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
              }),
            },
          },
        },
        params: {},
      } as unknown as ActionFunctionArgs);

      expect(result).toEqual({ success: false, error: "Unknown action" });
    });
  });

  describe("loader", () => {
    it("returns error when shop not found", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: {
                  graphql: vi.fn().mockResolvedValue({
                    json: () => Promise.resolve({ data: {} }),
                  }),
                },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.error).toBe("Shop not found");
      expect(result.state).toBeNull();
    });

    it("returns onboarding state with all steps", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: 30,
            onboardingDismissedAt: null,
          }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "5" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "2" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn()
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              validations: {
                edges: [{
                  node: {
                    id: "gid://shopify/Validation/123",
                    shopifyFunction: { handle: "credit-check-validation" },
                    title: "Net Terms Credit Check",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          json: () => Promise.resolve({
            data: {
              paymentCustomizations: {
                edges: [{
                  node: {
                    id: "gid://shopify/PaymentCustomization/456",
                    shopifyFunction: { handle: "hide-terms-payment" },
                    title: "Net Terms Payment Hide",
                    enabled: true,
                  },
                }],
              },
            },
          }),
        });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.error).toBeNull();
      expect(result.state).not.toBeNull();
      expect(result.state?.steps).toHaveLength(5);
      expect(result.state?.isComplete).toBe(true);
      expect(result.shopId).toBe(TEST_SHOP_ID);
    });

    it("returns dismissed state when onboarding was dismissed", async () => {
      const dismissedDate = new Date("2026-10-24T10:00:00Z");
      
      mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
          return Promise.resolve([{
            id: TEST_SHOP_ID,
            defaultTermsDays: null,
            onboardingDismissedAt: dismissedDate,
          }]);
        }
        if (query.includes("COUNT(*)")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const mockGraphql = vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ data: {} }),
      });

      const { loader } = await import("../app.onboarding");

      const result = await loader({
        request: new Request("https://example.com/app/onboarding"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                admin: { graphql: mockGraphql },
              }),
            },
          },
        },
        params: {},
      } as unknown as LoaderFunctionArgs);

      expect(result.error).toBeNull();
      expect(result.state?.dismissedAt).toBe(dismissedDate.toISOString());
    });
  });
});

describe("app._index redirect", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not redirect when onboarding is dismissed", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");

    const result = await loader({
      request: new Request("https://example.com/app"),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn((url: string) => {
                throw new Response(null, { status: 302, headers: { Location: url } });
              }),
            }),
          },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs);

    expect(result.shopDomain).toBe(TEST_SHOP);
  });

  it("does not redirect when buyer accounts exist", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: null }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "5" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");

    const result = await loader({
      request: new Request("https://example.com/app"),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn((url: string) => {
                throw new Response(null, { status: 302, headers: { Location: url } });
              }),
            }),
          },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs);

    expect(result.shopDomain).toBe(TEST_SHOP);
  });
});
