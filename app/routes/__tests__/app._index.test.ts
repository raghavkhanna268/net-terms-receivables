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
      // Mock overLimitCount query (gated accounts count)
      if (query.includes("COUNT(*)") && query.includes("gated_at IS NOT NULL")) {
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
        // overLimitCount query
        if (query.includes("COUNT(*)") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{ count: "1" }]);
        }
        // Filtered count query for overlimit=true
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{ count: "1" }]);
        }
        // Filtered rows query for overlimit=true (WITH invoice_totals)
        if (query.includes("WITH invoice_totals") && query.includes("gated_at IS NOT NULL")) {
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
        // overLimitCount query - returns 2 gated accounts total
        if (query.includes("COUNT(*)") && query.includes("gated_at IS NOT NULL")) {
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
        // overLimitCount query
        if (query.includes("COUNT(*)") && query.includes("gated_at IS NOT NULL") && !query.includes("DISTINCT")) {
          return Promise.resolve([{ count: "2" }]);
        }
        // Filtered count query
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{ count: "2" }]);
        }
        // Filtered rows query (WITH invoice_totals)
        if (query.includes("WITH invoice_totals") && query.includes("gated_at IS NOT NULL")) {
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
 * These tests verify that the SQL queries for overLimitCount and
 * the filtered list work correctly with PLAN_GATING_ENFORCED=true.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("app._index loader over-limit queries (DB integration)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-idx";
  const TEST_SHOP_ID = `shop-idx-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `idx-test-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, "createdAt", "updatedAt", onboarding_dismissed_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, NOW(), NOW(), NOW())
    `;

    // Create test accounts: 2 active, 2 gated
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, gated_at, "createdAt", "updatedAt")
      VALUES
        (${"acc-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-1-" + TEST_SUFFIX}, ${"loc-1-" + TEST_SUFFIX}, 'Active Account 1', NULL, NOW(), NOW()),
        (${"acc-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-2-" + TEST_SUFFIX}, ${"loc-2-" + TEST_SUFFIX}, 'Active Account 2', NULL, NOW(), NOW()),
        (${"acc-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-3-" + TEST_SUFFIX}, ${"loc-3-" + TEST_SUFFIX}, 'Gated Account 1', NOW(), NOW(), NOW()),
        (${"acc-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, 'COMPANY', ${"co-4-" + TEST_SUFFIX}, ${"loc-4-" + TEST_SUFFIX}, 'Gated Account 2', NOW(), NOW(), NOW())
    `;

    // Create invoices for the accounts (so they show in the ledger)
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", name, currency, outstanding, status, "createdAt", "updatedAt")
      VALUES
        (${"inv-active-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-active-1-" + TEST_SUFFIX}, 'INV-001', 'INR', 100000, 'open', NOW(), NOW()),
        (${"inv-active-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-active-2-" + TEST_SUFFIX}, 'INV-002', 'INR', 200000, 'open', NOW(), NOW()),
        (${"inv-gated-1-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-gated-1-" + TEST_SUFFIX}, 'INV-003', 'INR', 300000, 'open', NOW(), NOW()),
        (${"inv-gated-2-" + TEST_SUFFIX}, ${TEST_SHOP_ID}, ${"acc-gated-2-" + TEST_SUFFIX}, 'INV-004', 'INR', 400000, 'open', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  it("overLimitCount query returns correct count of gated accounts with PLAN_GATING_ENFORCED=true", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    process.env.PLAN_GATING_ENFORCED = "true";

    try {
      // This is the exact query used in the loader for overLimitCount
      const [result] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count
        FROM "BuyerAccount"
        WHERE "shopId" = ${TEST_SHOP_ID}
          AND gated_at IS NOT NULL
      `;

      expect(parseInt(result.count, 10)).toBe(2);
    } finally {
      process.env.PLAN_GATING_ENFORCED = originalEnv;
    }
  });

  it("filtered ledger query returns only gated accounts with outstanding invoices", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    process.env.PLAN_GATING_ENFORCED = "true";

    try {
      const asOf = new Date();

      // This is the filtered query used when overlimit=true
      const filteredRows = await sql<{ buyer_account_id: string; buyer_name: string; is_gated: boolean }[]>`
        WITH invoice_totals AS (
          SELECT
            ba.id as buyer_account_id,
            ba.name as buyer_name,
            ba."creditLimitPaise"::text as credit_limit_paise,
            ba."holdState" as hold_state,
            i.currency,
            COALESCE(SUM(i.outstanding), 0)::text as outstanding_paise,
            COALESCE(SUM(CASE WHEN i.due_at < ${asOf} THEN i.outstanding ELSE 0 END), 0)::text as overdue_paise,
            MAX(CASE WHEN i.due_at < ${asOf} THEN EXTRACT(DAY FROM ${asOf}::timestamp - i.due_at::timestamp)::integer ELSE NULL END) as oldest_overdue_days,
            ba.gated_at IS NOT NULL as is_gated
          FROM "BuyerAccount" ba
          LEFT JOIN "Invoice" i ON i."buyerAccountId" = ba.id AND i.status = 'open' AND i.outstanding > 0
          WHERE ba."shopId" = ${TEST_SHOP_ID}
            AND ba.gated_at IS NOT NULL
          GROUP BY ba.id, ba.name, ba."creditLimitPaise", ba."holdState", i.currency, ba.gated_at
          HAVING COALESCE(SUM(i.outstanding), 0) > 0
        )
        SELECT * FROM invoice_totals
        ORDER BY outstanding_paise DESC
        LIMIT 20
        OFFSET 0
      `;

      // Should return exactly 2 gated accounts
      expect(filteredRows.length).toBe(2);
      expect(filteredRows.every(r => r.is_gated)).toBe(true);
      expect(filteredRows.every(r => r.buyer_name.includes("Gated"))).toBe(true);

      // Verify filtered count query
      const [countResult] = await sql<{ count: string }[]>`
        SELECT COUNT(DISTINCT ba.id)::text as count
        FROM "BuyerAccount" ba
        JOIN "Invoice" i ON i."buyerAccountId" = ba.id AND i.status = 'open' AND i.outstanding > 0
        WHERE ba."shopId" = ${TEST_SHOP_ID}
          AND ba.gated_at IS NOT NULL
      `;
      expect(parseInt(countResult.count, 10)).toBe(2);
    } finally {
      process.env.PLAN_GATING_ENFORCED = originalEnv;
    }
  });

  it("gated accounts appear in query results even when PLAN_GATING_ENFORCED=true", async () => {
    const originalEnv = process.env.PLAN_GATING_ENFORCED;
    process.env.PLAN_GATING_ENFORCED = "true";

    try {
      // Verify gated accounts exist and have the correct gated_at status
      const accounts = await sql<{ id: string; name: string; gated_at: Date | null }[]>`
        SELECT id, name, gated_at
        FROM "BuyerAccount"
        WHERE "shopId" = ${TEST_SHOP_ID}
      `;

      expect(accounts.length).toBe(4);

      const gatedAccounts = accounts.filter(a => a.gated_at !== null);
      const activeAccounts = accounts.filter(a => a.gated_at === null);

      expect(gatedAccounts.length).toBe(2);
      expect(activeAccounts.length).toBe(2);

      // Gated accounts should have names containing "Gated"
      expect(gatedAccounts.every(a => a.name.includes("Gated"))).toBe(true);
      expect(activeAccounts.every(a => a.name.includes("Active"))).toBe(true);
    } finally {
      process.env.PLAN_GATING_ENFORCED = originalEnv;
    }
  });
});
