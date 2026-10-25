import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for app._index loader (S7 Aging Dashboard).
 *
 * Tests verify:
 * 1. Empty state when no invoices exist
 * 2. Aging totals are loaded correctly
 * 3. Buyer ledger pagination works
 * 4. Error handling
 */

// Mock SQL client
const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn((s) => s) });

// Mock modules
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
    companies: { current: 2, limit: 3 },
    importsThisMonth: { current: 0, limit: 1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getShopAgingTotals: vi.fn(),
  getBuyerLedger: vi.fn(),
  getBuyerInvoices: vi.fn(),
}));

import {
  getShopAgingTotals,
  getBuyerLedger,
  getBuyerInvoices,
} from "~/lib/aging-queries.server";

const mockGetShopAgingTotals = vi.mocked(getShopAgingTotals);
const mockGetBuyerLedger = vi.mocked(getBuyerLedger);
const mockGetBuyerInvoices = vi.mocked(getBuyerInvoices);

describe("app._index loader", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const TEST_SHOP_ID = "shop-123";

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock for shop query
    mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("SELECT name FROM")) {
        return Promise.resolve([{ name: "Test Buyer" }]);
      }
      // S23: Mock onboarding queries to prevent redirect during tests
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
      }
      // Mock overLimitCount query (gated accounts with open invoices)
      if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL") && query.includes("Invoice")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "1" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    // Default mocks for aging queries
    mockGetShopAgingTotals.mockResolvedValue({
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
    });

    mockGetBuyerLedger.mockResolvedValue({
      rows: [],
      totalCount: 0,
    });

    mockGetBuyerInvoices.mockResolvedValue({
      rows: [],
      totalCount: 0,
    });
  });

  function createLoaderArgs(
    searchParams: Record<string, string> = {}
  ): LoaderFunctionArgs {
    const url = new URL("https://example.com/app");
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, value);
    }

    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
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

  describe("empty state", () => {
    it("returns empty aging totals when no invoices exist", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.agingTotals).toEqual({
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
      });
      expect(result.buyerLedger?.rows).toHaveLength(0);
      expect(result.error).toBeNull();
    });
  });

  describe("aging totals", () => {
    it("returns aging totals with data", async () => {
      mockGetShopAgingTotals.mockResolvedValue({
        totalByCurrency: { INR: "10000000" },
        buckets: {
          current: { byCurrency: { INR: "5000000" } },
          "1-30": { byCurrency: { INR: "3000000" } },
          "31-60": { byCurrency: { INR: "2000000" } },
          "61-90": { byCurrency: {} },
          "90+": { byCurrency: {} },
        },
        overdueByCurrency: { INR: "5000000" },
        oldestOverdueDays: 45,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.agingTotals?.totalByCurrency).toEqual({ INR: "10000000" });
      expect(result.agingTotals?.overdueByCurrency).toEqual({ INR: "5000000" });
      expect(result.agingTotals?.oldestOverdueDays).toBe(45);
    });

    it("handles multi-currency totals", async () => {
      mockGetShopAgingTotals.mockResolvedValue({
        totalByCurrency: { INR: "10000000", USD: "5000000" },
        buckets: {
          current: { byCurrency: { INR: "5000000", USD: "2500000" } },
          "1-30": { byCurrency: { INR: "5000000", USD: "2500000" } },
          "31-60": { byCurrency: {} },
          "61-90": { byCurrency: {} },
          "90+": { byCurrency: {} },
        },
        overdueByCurrency: { INR: "5000000", USD: "2500000" },
        oldestOverdueDays: 15,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.agingTotals?.totalByCurrency.INR).toBe("10000000");
      expect(result.agingTotals?.totalByCurrency.USD).toBe("5000000");
    });
  });

  describe("buyer ledger pagination", () => {
    it("uses default pagination values", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        {
          limit: 20,
          offset: 0,
          sortBy: "outstanding",
          sortOrder: "desc",
        }
      );
    });

    it("respects page parameter", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ page: "3" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          offset: 40, // (3-1) * 20
        })
      );
    });

    it("respects sortBy and sortOrder parameters", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ sortBy: "name", sortOrder: "asc" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          sortBy: "name",
          sortOrder: "asc",
        })
      );
    });

    it("defaults page to 1 for NaN values", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ page: "invalid" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          offset: 0, // page 1
        })
      );
    });

    it("defaults page to 1 for negative values", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ page: "-5" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          offset: 0, // page 1
        })
      );
    });

    it("defaults page to 1 for zero", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ page: "0" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          offset: 0, // page 1
        })
      );
    });

    it("defaults sortBy to outstanding for invalid values", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ sortBy: "invalid" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          sortBy: "outstanding",
        })
      );
    });

    it("defaults sortOrder to desc for invalid values", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs({ sortOrder: "invalid" }));

      expect(mockGetBuyerLedger).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        expect.any(Date),
        expect.objectContaining({
          sortOrder: "desc",
        })
      );
    });

    it("returns buyer ledger data", async () => {
      mockGetBuyerLedger.mockResolvedValue({
        rows: [
          {
            buyer_account_id: "buyer-1",
            buyer_name: "Acme Corp",
            credit_limit_paise: "10000000",
            hold_state: "OK",
            currency: "INR",
            outstanding_paise: "5000000",
            overdue_paise: "2000000",
            oldest_overdue_days: 15,
            is_gated: false,
          },
        ],
        totalCount: 1,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.buyerLedger?.rows).toHaveLength(1);
      expect(result.buyerLedger?.rows[0].buyer_name).toBe("Acme Corp");
      expect(result.pagination.totalCount).toBe(1);
    });
  });

  describe("buyer invoice drill-down", () => {
    it("loads invoices when buyer parameter is provided", async () => {
      mockGetBuyerLedger.mockResolvedValue({
        rows: [
          {
            buyer_account_id: "buyer-1",
            buyer_name: "Acme Corp",
            credit_limit_paise: "10000000",
            hold_state: "OK",
            currency: "INR",
            outstanding_paise: "5000000",
            overdue_paise: "0",
            oldest_overdue_days: null,
            is_gated: false,
          },
        ],
        totalCount: 1,
      });

      mockGetBuyerInvoices.mockResolvedValue({
        rows: [
          {
            id: "inv-1",
            name: "#1001",
            order_id: "gid://shopify/Order/123",
            due_at: new Date("2026-10-30"),
            outstanding_paise: "5000000",
            currency: "INR",
            days_past_due: -7,
          },
        ],
        totalCount: 1,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs({ buyer: "buyer-1" }));

      expect(mockGetBuyerInvoices).toHaveBeenCalledWith(
        expect.anything(),
        TEST_SHOP_ID,
        "buyer-1",
        expect.any(Date),
        { limit: 50, offset: 0 }
      );
      expect(result.selectedBuyerInvoices?.rows).toHaveLength(1);
      expect(result.selectedBuyerInvoices?.buyerName).toBe("Acme Corp");
    });

    it("fetches buyer name from DB when not in ledger", async () => {
      mockGetBuyerLedger.mockResolvedValue({
        rows: [],
        totalCount: 0,
      });

      mockGetBuyerInvoices.mockResolvedValue({
        rows: [],
        totalCount: 0,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs({ buyer: "buyer-unknown" }));

      expect(result.selectedBuyerInvoices?.buyerName).toBe("Test Buyer");
    });
  });

  describe("error handling", () => {
    it("returns error message when aging queries fail", async () => {
      mockGetShopAgingTotals.mockRejectedValue(new Error("Database error"));

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.error).toBe("Failed to load aging data. Please try again.");
      expect(result.agingTotals).toBeNull();
    });

    it("P7: error logging uses safeLog JSON with toErrorCode (per #174)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockGetShopAgingTotals.mockRejectedValue(new Error("Database connection failed"));

      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const allLogs = consoleSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      // safeLog outputs JSON with "event" field
      expect(allLogs).toContain('"event":"app._index.load_aging_data_failed"');
      expect(allLogs).toContain('"err":');
      expect(allLogs).not.toContain("Database connection failed");
      expect(allLogs).not.toContain(".myshopify.com");

      consoleSpy.mockRestore();
    });

    it("handles missing shop gracefully", async () => {
      mockSql.mockImplementation(() => Promise.resolve([]));

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.agingTotals).toBeNull();
      expect(result.buyerLedger).toBeNull();
    });
  });

  describe("shop metadata", () => {
    it("returns shop domain and currency", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.shopDomain).toBe(TEST_SHOP);
      expect(result.shopCurrency).toBe("INR");
      expect(result.storeHandle).toBe("test-shop");
    });
  });

  describe("over-limit account filter", () => {
    it("defaults onlyOverLimit to false when no query param", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.onlyOverLimit).toBe(false);
    });

    it("sets onlyOverLimit to true when overlimit=true query param", async () => {
      // Mock the filtered query and count queries for overlimit=true
      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("SELECT id, currency, timezone FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" }]);
        }
        if (query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
        }
        // overLimitCount query (now uses COUNT(DISTINCT) with Invoice join)
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL") && query.includes("Invoice")) {
          return Promise.resolve([{ count: "1" }]);
        }
        // Filtered count query for getOverLimitBuyerLedger
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{ count: "1" }]);
        }
        // Filtered rows query for overlimit=true (WITH buyer_invoices)
        if (query.includes("WITH buyer_invoices") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{
            buyer_account_id: "buyer-gated",
            buyer_name: "Gated Buyer",
            credit_limit_paise: null,
            hold_state: "OK",
            currency: "INR",
            outstanding_paise: "200000",
            overdue_paise: "0",
            oldest_overdue_days: null,
            is_gated: true,
          }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "1" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs({ overlimit: "true" }));

      expect(result.onlyOverLimit).toBe(true);
    });

    it("counts over-limit accounts via SQL across all pages", async () => {
      // Mock SQL to return overLimitCount of 2 (from SQL, not client-side filter)
      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("SELECT id, currency, timezone FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" }]);
        }
        if (query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
        }
        // overLimitCount query - returns 2 gated accounts with open invoices
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL") && query.includes("Invoice")) {
          return Promise.resolve([{ count: "2" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "3" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      mockGetBuyerLedger.mockResolvedValue({
        rows: [
          {
            buyer_account_id: "buyer-1",
            buyer_name: "Active Buyer",
            credit_limit_paise: null,
            hold_state: "OK",
            currency: "INR",
            outstanding_paise: "100000",
            overdue_paise: "0",
            oldest_overdue_days: null,
            is_gated: false,
          },
        ],
        totalCount: 1,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      // overLimitCount is from SQL (2), not from current page (which has 0 gated)
      expect(result.overLimitCount).toBe(2);
      expect(result.buyerLedger?.rows).toHaveLength(1);
    });

    it("filters to only over-limit accounts via SQL when overlimit=true", async () => {
      // Mock SQL queries for overlimit=true - uses direct SQL instead of getBuyerLedger
      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("SELECT id, currency, timezone FROM")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" }]);
        }
        if (query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
        }
        // overLimitCount query (uses COUNT(DISTINCT) with Invoice join)
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL") && query.includes("Invoice")) {
          return Promise.resolve([{ count: "2" }]);
        }
        // Filtered count query for getOverLimitBuyerLedger
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{ count: "2" }]);
        }
        // Filtered rows query (WITH buyer_invoices) - matches getOverLimitBuyerLedger
        if (query.includes("WITH buyer_invoices") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([
            {
              buyer_account_id: "buyer-2",
              buyer_name: "Gated Buyer 1",
              credit_limit_paise: null,
              hold_state: "OK",
              currency: "INR",
              outstanding_paise: "200000",
              overdue_paise: "0",
              oldest_overdue_days: null,
              is_gated: true,
            },
            {
              buyer_account_id: "buyer-3",
              buyer_name: "Gated Buyer 2",
              credit_limit_paise: null,
              hold_state: "OK",
              currency: "INR",
              outstanding_paise: "300000",
              overdue_paise: "0",
              oldest_overdue_days: null,
              is_gated: true,
            },
          ]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "3" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs({ overlimit: "true" }));

      expect(result.onlyOverLimit).toBe(true);
      expect(result.buyerLedger?.rows).toHaveLength(2);
      expect(result.buyerLedger?.rows[0].buyer_name).toBe("Gated Buyer 1");
      expect(result.buyerLedger?.rows[1].buyer_name).toBe("Gated Buyer 2");
      expect(result.buyerLedger?.totalCount).toBe(2);
      expect(result.overLimitCount).toBe(2);
    });

    it("returns all accounts by default (no filtering)", async () => {
      mockGetBuyerLedger.mockResolvedValue({
        rows: [
          {
            buyer_account_id: "buyer-1",
            buyer_name: "Active Buyer",
            credit_limit_paise: null,
            hold_state: "OK",
            currency: "INR",
            outstanding_paise: "100000",
            overdue_paise: "0",
            oldest_overdue_days: null,
            is_gated: false,
          },
          {
            buyer_account_id: "buyer-2",
            buyer_name: "Gated Buyer",
            credit_limit_paise: null,
            hold_state: "OK",
            currency: "INR",
            outstanding_paise: "200000",
            overdue_paise: "0",
            oldest_overdue_days: null,
            is_gated: true,
          },
        ],
        totalCount: 2,
      });

      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      expect(result.onlyOverLimit).toBe(false);
      expect(result.buyerLedger?.rows).toHaveLength(2);
    });
  });
});

/**
 * S21 UI Tests: Over-limit banner using the actual helper imported by app._index.tsx.
 *
 * DB integration tests are in app._index-overlimit-db.test.ts to avoid vi.mock conflicts.
 */
describe("S21 over-limit banner using buildOverLimitBannerState helper", () => {
  it("banner is shown when overLimitCount > 0", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(3, true);
    expect(state.show).toBe(true);
  });

  it("banner is hidden when overLimitCount === 0", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(0, true);
    expect(state.show).toBe(false);
  });

  it("banner shows enforcement note when gatingEnforced is false", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(2, false);
    expect(state.show).toBe(true);
    expect(state.enforcementNote).toBe("(Limits are not currently enforced.)");
  });

  it("banner does not show enforcement note when gatingEnforced is true", async () => {
    const { buildOverLimitBannerState } = await import("~/lib/over-limit-banner");
    const state = buildOverLimitBannerState(2, true);
    expect(state.enforcementNote).toBeNull();
  });
});

/**
 * S21 Plan Gating: Gated accounts in dashboard.
 * Verifies that gated accounts have is_gated set and are included in totals.
 * The UI uses is_gated to render the "over plan limit" badge.
 */
describe("S21 gated accounts in dashboard listing and totals", () => {
  const TEST_SHOP = "test-gated-dash.myshopify.com";
  const TEST_SHOP_ID = "shop-gated-dash";

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" }]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
      }
      if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL") && query.includes("Invoice")) {
        return Promise.resolve([{ count: "1" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "2" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });
  });

  function createLoaderArgs() {
    const url = new URL(`https://example.com/app?skipOnboarding=true`);
    return {
      request: new Request(url),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn(),
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
      url,
      pattern: "/app",
    } as unknown;
  }

  it("gated account in ledger has is_gated=true for badge rendering", async () => {
    mockGetBuyerLedger.mockResolvedValue({
      rows: [
        {
          buyer_account_id: "buyer-active",
          buyer_name: "Active Buyer",
          credit_limit_paise: "10000000",
          hold_state: "OK",
          currency: "INR",
          outstanding_paise: "100000",
          overdue_paise: "0",
          oldest_overdue_days: null,
          is_gated: false,
        },
        {
          buyer_account_id: "buyer-gated",
          buyer_name: "Over Limit Buyer",
          credit_limit_paise: "5000000",
          hold_state: "OK",
          currency: "INR",
          outstanding_paise: "300000",
          overdue_paise: "0",
          oldest_overdue_days: null,
          is_gated: true,
        },
      ],
      totalCount: 2,
    });

    mockGetShopAgingTotals.mockResolvedValue({
      totalByCurrency: { INR: "400000" },
      buckets: {
        current: { byCurrency: { INR: "400000" } },
        "1-30": { byCurrency: {} },
        "31-60": { byCurrency: {} },
        "61-90": { byCurrency: {} },
        "90+": { byCurrency: {} },
      },
      overdueByCurrency: {},
      oldestOverdueDays: null,
    });

    const { loader } = await import("../app._index");
    const result = await loader(createLoaderArgs() as never);

    expect(result.buyerLedger?.rows).toHaveLength(2);

    const gatedAccount = result.buyerLedger?.rows.find(r => r.buyer_account_id === "buyer-gated");
    expect(gatedAccount).toBeDefined();
    expect(gatedAccount?.is_gated).toBe(true);
    expect(gatedAccount?.buyer_name).toBe("Over Limit Buyer");

    const activeAccount = result.buyerLedger?.rows.find(r => r.buyer_account_id === "buyer-active");
    expect(activeAccount).toBeDefined();
    expect(activeAccount?.is_gated).toBe(false);
  });

  it("aging totals include both gated and non-gated accounts", async () => {
    mockGetBuyerLedger.mockResolvedValue({
      rows: [
        {
          buyer_account_id: "buyer-active",
          buyer_name: "Active Buyer",
          credit_limit_paise: null,
          hold_state: "OK",
          currency: "INR",
          outstanding_paise: "100000",
          overdue_paise: "0",
          oldest_overdue_days: null,
          is_gated: false,
        },
        {
          buyer_account_id: "buyer-gated",
          buyer_name: "Gated Buyer",
          credit_limit_paise: null,
          hold_state: "OK",
          currency: "INR",
          outstanding_paise: "200000",
          overdue_paise: "0",
          oldest_overdue_days: null,
          is_gated: true,
        },
      ],
      totalCount: 2,
    });

    mockGetShopAgingTotals.mockResolvedValue({
      totalByCurrency: { INR: "300000" },
      buckets: {
        current: { byCurrency: { INR: "300000" } },
        "1-30": { byCurrency: {} },
        "31-60": { byCurrency: {} },
        "61-90": { byCurrency: {} },
        "90+": { byCurrency: {} },
      },
      overdueByCurrency: {},
      oldestOverdueDays: null,
    });

    const { loader } = await import("../app._index");
    const result = await loader(createLoaderArgs() as never);

    expect(result.agingTotals?.totalByCurrency.INR).toBe("300000");

    expect(result.buyerLedger?.totalCount).toBe(2);
  });

  it("overLimitCount reflects gated accounts and is included in data", async () => {
    mockGetBuyerLedger.mockResolvedValue({
      rows: [{
        buyer_account_id: "buyer-1",
        buyer_name: "Active Buyer",
        credit_limit_paise: null,
        hold_state: "OK",
        currency: "INR",
        outstanding_paise: "100000",
        overdue_paise: "0",
        oldest_overdue_days: null,
        is_gated: false,
      }],
      totalCount: 1,
    });

    mockGetShopAgingTotals.mockResolvedValue({
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
    });

    const { loader } = await import("../app._index");
    const result = await loader(createLoaderArgs() as never);

    expect(result.overLimitCount).toBe(1);
  });
});
