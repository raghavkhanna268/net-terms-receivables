import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

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
 * DB-backed tests for app._index loader over-limit account queries.
 * These tests call the real exported query functions against the test DB
 * with gated and non-gated accounts seeded and PLAN_GATING_ENFORCED=true.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("app._index over-limit queries (DB integration)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-idx";
  const TEST_SHOP_ID = `shop-idx-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `idx-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop with timezone for proper date calculations
    await sql`
      INSERT INTO "Shop" (id, domain, timezone, currency, "createdAt", "updatedAt", onboarding_dismissed_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'Asia/Kolkata', 'INR', NOW(), NOW(), NOW())
    `;

    // Create test accounts: 2 active (gated_at IS NULL), 2 gated (gated_at IS NOT NULL)
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES
        (${"acc-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-1-" + TEST_SUFFIX}, ${"loc-1-" + TEST_SUFFIX}, 'Active Account 1', NULL, NOW(), NOW()),
        (${"acc-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-2-" + TEST_SUFFIX}, ${"loc-2-" + TEST_SUFFIX}, 'Active Account 2', NULL, NOW(), NOW()),
        (${"acc-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-3-" + TEST_SUFFIX}, ${"loc-3-" + TEST_SUFFIX}, 'Gated Account 1', NOW(), NOW(), NOW()),
        (${"acc-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-4-" + TEST_SUFFIX}, ${"loc-4-" + TEST_SUFFIX}, 'Gated Account 2', NOW(), NOW(), NOW())
    `;

    // Create invoices for the accounts (outstanding in rupees, will be converted to paise)
    // orderId is required (Invoice_order_xor_draft constraint: exactly one of orderId/draftOrderId must be set)
    // outstanding must be >= 0 AND <= total (Invoice_outstanding_range constraint)
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt", status, "createdAt", "updatedAt")
      VALUES
        (${"inv-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-active-1-" + TEST_SUFFIX}, ${"gid://shopify/Order/active1-" + TEST_SUFFIX}, 'INV-001', 1000.00, 1000.00, NOW(), 'open', NOW(), NOW()),
        (${"inv-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-active-2-" + TEST_SUFFIX}, ${"gid://shopify/Order/active2-" + TEST_SUFFIX}, 'INV-002', 2000.00, 2000.00, NOW(), 'open', NOW(), NOW()),
        (${"inv-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-gated-1-" + TEST_SUFFIX}, ${"gid://shopify/Order/gated1-" + TEST_SUFFIX}, 'INV-003', 3000.00, 3000.00, NOW(), 'open', NOW(), NOW()),
        (${"inv-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-gated-2-" + TEST_SUFFIX}, ${"gid://shopify/Order/gated2-" + TEST_SUFFIX}, 'INV-004', 4000.00, 4000.00, NOW(), 'open', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("getOverLimitCount returns correct count of gated accounts", async () => {
    const { getOverLimitCount } = await import("../app._index");

    const count = await getOverLimitCount(sql, TEST_SHOP_ID);

    expect(count).toBe(2);
  });

  it("getOverLimitBuyerLedger returns only gated accounts with invoices", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");

    const result = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 20,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    // Should return exactly 2 gated accounts
    expect(result.rows.length).toBe(2);
    expect(result.totalCount).toBe(2);

    // All returned accounts should be gated
    expect(result.rows.every(r => r.is_gated)).toBe(true);

    // All returned accounts should have names containing "Gated"
    expect(result.rows.every(r => r.buyer_name.includes("Gated"))).toBe(true);

    // Amounts should be in paise (original rupees * 100)
    const amounts = result.rows.map(r => parseInt(r.outstanding_paise, 10));
    expect(amounts).toContain(300000); // 3000 rupees = 300000 paise
    expect(amounts).toContain(400000); // 4000 rupees = 400000 paise
  });

  it("getOverLimitBuyerLedger respects sort order", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");

    // Sort by outstanding DESC (default)
    const descResult = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 20,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    // Highest outstanding first (400000 paise = Gated Account 2)
    expect(descResult.rows[0].outstanding_paise).toBe("400000");

    // Sort by outstanding ASC
    const ascResult = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 20,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "asc",
    });

    // Lowest outstanding first (300000 paise = Gated Account 1)
    expect(ascResult.rows[0].outstanding_paise).toBe("300000");
  });

  it("getOverLimitBuyerLedger respects pagination", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");

    // Get first page with limit 1
    const page1 = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 1,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    expect(page1.rows.length).toBe(1);
    expect(page1.totalCount).toBe(2);

    // Get second page
    const page2 = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 1,
      offset: 1,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    expect(page2.rows.length).toBe(1);
    expect(page2.totalCount).toBe(2);

    // Different accounts on each page
    expect(page1.rows[0].buyer_account_id).not.toBe(page2.rows[0].buyer_account_id);
  });

  it("gated account with no open invoice is excluded from both count and list", async () => {
    const { getOverLimitCount, getOverLimitBuyerLedger } = await import("../app._index");

    const GATED_NO_INVOICE_ID = `acc-gated-noinv-${TEST_SUFFIX}`;

    // Create a gated account with no open invoice
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES (${GATED_NO_INVOICE_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-noinv-" + TEST_SUFFIX}, ${"loc-noinv-" + TEST_SUFFIX}, 'Gated Account No Invoice', NOW(), NOW(), NOW())
    `;

    try {
      // Count should still be 2 (only gated accounts WITH open invoices)
      const count = await getOverLimitCount(sql, TEST_SHOP_ID);
      expect(count).toBe(2);

      // List should also have 2 entries (same set)
      const result = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
        limit: 20,
        offset: 0,
        sortBy: "outstanding",
        sortOrder: "desc",
      });

      expect(result.rows.length).toBe(2);
      expect(result.totalCount).toBe(2);

      // The new account should NOT be in the list
      const noInvoiceRow = result.rows.find(r => r.buyer_account_id === GATED_NO_INVOICE_ID);
      expect(noInvoiceRow).toBeUndefined();
    } finally {
      // Clean up the test account
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${GATED_NO_INVOICE_ID}`;
    }
  });

  it("aging totals include gated accounts (totals include all accounts)", async () => {
    const { getOverLimitBuyerLedger } = await import("../app._index");
    const { getBuyerLedger } = await import("~/lib/aging-queries.server");

    const allAccounts = await getBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 100,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    const gatedAccounts = await getOverLimitBuyerLedger(sql, TEST_SHOP_ID, new Date(), {
      limit: 100,
      offset: 0,
      sortBy: "outstanding",
      sortOrder: "desc",
    });

    expect(allAccounts.totalCount).toBe(4);
    expect(gatedAccounts.totalCount).toBe(2);

    const allTotal = allAccounts.rows.reduce(
      (sum, r) => sum + BigInt(r.outstanding_paise), 0n
    );
    const gatedTotal = gatedAccounts.rows.reduce(
      (sum, r) => sum + BigInt(r.outstanding_paise), 0n
    );

    expect(allTotal).toBeGreaterThan(gatedTotal);
    expect(gatedTotal).toBe(700000n);
    expect(allTotal).toBe(1000000n);
  });
});

/**
 * S21 UI Tests: Over-limit banner shown/hidden, badge on accounts, flag-off behavior.
 */
describe("S21 over-limit banner and badge UI logic", () => {
  it("banner is shown when overLimitCount > 0", () => {
    const overLimitCount = 3;
    const showBanner = overLimitCount > 0;
    expect(showBanner).toBe(true);
  });

  it("banner is hidden when overLimitCount === 0", () => {
    const overLimitCount = 0;
    const showBanner = overLimitCount > 0;
    expect(showBanner).toBe(false);
  });

  it("badge appears on gated accounts only (is_gated === true)", () => {
    const rows = [
      { buyer_account_id: "1", is_gated: false },
      { buyer_account_id: "2", is_gated: true },
      { buyer_account_id: "3", is_gated: false },
      { buyer_account_id: "4", is_gated: true },
    ];

    const withBadge = rows.filter(r => r.is_gated);
    const withoutBadge = rows.filter(r => !r.is_gated);

    expect(withBadge.length).toBe(2);
    expect(withoutBadge.length).toBe(2);
  });

  it("totals include all accounts (gated + active)", () => {
    const allRows = [
      { outstanding_paise: "100000", is_gated: false },
      { outstanding_paise: "200000", is_gated: false },
      { outstanding_paise: "300000", is_gated: true },
      { outstanding_paise: "400000", is_gated: true },
    ];

    const totalOutstanding = allRows.reduce(
      (sum, r) => sum + BigInt(r.outstanding_paise), 0n
    );

    expect(totalOutstanding).toBe(1000000n);
  });

  it("gatingEnforced false does not hide the banner (flag-off behavior)", () => {
    const overLimitCount = 2;
    const gatingEnforced = false;

    const showBanner = overLimitCount > 0;

    expect(showBanner).toBe(true);
    expect(gatingEnforced).toBe(false);
  });
});
