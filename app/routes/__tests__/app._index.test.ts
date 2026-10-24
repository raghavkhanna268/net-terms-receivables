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
});
