import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * #292: Currency recovery tests for app._index loader.
 *
 * Tests verify that when a non-INR shop loads /app:
 * 1. USD shop switches to INR (no financial rows) → updates DB, pushes metafield, drops banner
 * 2. USD shop re-read returns USD → stays not-supported
 * 3. USD shop re-read throws → stays not-supported, keeps stored USD
 * 4. XXX shop re-read returns INR → becomes supported
 * 5. USD shop switches to INR (has Invoice) → blocked, currency unchanged, flipBlocked=true
 * 6. USD shop switches to INR (has Payment) → blocked, currency unchanged, flipBlocked=true
 * 7. USD shop switches to INR (has s8_draft_orders) → blocked, currency unchanged, flipBlocked=true
 */

const createMockSqlFn = () =>
  vi.fn().mockImplementation(() => Promise.resolve([]));

const mockSql = Object.assign(createMockSqlFn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((arr: unknown[]) => arr),
  unsafe: vi.fn((s: string) => s),
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(createMockSqlFn(), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  }),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
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
    companies: { current: 2, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
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

const TEST_SHOP = "test-recovery.myshopify.com";
const TEST_SHOP_ID = "shop-recovery-123";
const TEST_SHOP_GID = "gid://shopify/Shop/12345";

describe("#292 currency recovery on /app load", () => {
  let mockGraphql: ReturnType<typeof vi.fn>;
  let sqlCalls: Array<{ query: string; values: unknown[] }>;

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app?skipOnboarding=true");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              admin: { graphql: mockGraphql },
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

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sqlCalls = [];

    mockGraphql = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupSqlMock(storedCurrency: string, opts?: { hasFinancialRows?: boolean }) {
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });

      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: storedCurrency, timezone: "Asia/Kolkata" },
        ]);
      }
      // For hasFinancialRows check - returns shopId for secondary lookup
      if (query.includes("SELECT id FROM") && query.includes("Shop") && query.includes("domain")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }
      // For hasFinancialRows EXISTS query
      if (query.includes("SELECT EXISTS") && (query.includes("Invoice") || query.includes("Payment") || query.includes("s8_draft_orders"))) {
        return Promise.resolve([{ has_rows: opts?.hasFinancialRows ?? false }]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
      }
      if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL") && query.includes("Invoice")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("UPDATE") && query.includes("Shop")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  }

  function setupGraphqlMock(
    currencyResponse: string | null,
    throwError = false,
    shopConfigCurrency?: string | null,
  ) {
    mockGraphql.mockImplementation(async (query: string) => {
      if (throwError) {
        throw new Error("Network error");
      }

      if (query.includes("ShopCurrencyAndId")) {
        const metafield = shopConfigCurrency !== undefined
          ? (shopConfigCurrency === null ? null : { value: JSON.stringify({ schemaVersion: 1, currencyCode: shopConfigCurrency }) })
          : (currencyResponse ? { value: JSON.stringify({ schemaVersion: 1, currencyCode: currencyResponse }) } : null);
        return {
          json: async () => ({
            data: currencyResponse
              ? { shop: { id: TEST_SHOP_GID, currencyCode: currencyResponse, metafield } }
              : { shop: null },
          }),
        };
      }

      if (query.includes("WriteShopConfig") || query.includes("metafieldsSet")) {
        return {
          json: async () => ({
            data: { metafieldsSet: { metafields: [{ id: "mf-123" }], userErrors: [] } },
          }),
        };
      }

      return { json: async () => ({ data: {} }) };
    });
  }

  it("C.1: USD shop switches to INR (no financial rows) → updates currency, pushes INR metafield, drops banner", async () => {
    setupSqlMock("USD", { hasFinancialRows: false });
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");
    expect(result.currencyFlipBlocked).toBe(false);

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    // Check that 'INR' is in the values array (parameterized query)
    expect(updateCalls.some((c) => c.values.includes("INR"))).toBe(true);

    const graphqlCalls = mockGraphql.mock.calls;
    expect(graphqlCalls.length).toBeGreaterThanOrEqual(2);

    const currencyQuery = graphqlCalls.find((c) => c[0].includes("ShopCurrencyAndId"));
    expect(currencyQuery).toBeDefined();

    const metafieldMutation = graphqlCalls.find((c) => c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet"));
    expect(metafieldMutation).toBeDefined();
  });

  it("C.2: USD shop re-read returns USD → stays not-supported", async () => {
    setupSqlMock("USD");
    setupGraphqlMock("USD");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBe(0);
  });

  it("C.3: USD shop re-read throws → stays not-supported, keeps stored USD (never XXX)", async () => {
    setupSqlMock("USD");
    setupGraphqlMock(null, true);

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("Shop"));
    const xxxUpdates = updateCalls.filter((c) => c.query.includes("XXX"));
    expect(xxxUpdates.length).toBe(0);

    consoleSpy.mockRestore();
  });

  it("C.4: XXX shop re-read returns INR → becomes supported", async () => {
    setupSqlMock("XXX");
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    // Check that 'INR' is in the values array (parameterized query)
    expect(updateCalls.some((c) => c.values.includes("INR"))).toBe(true);

    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });

  // #292 Item 4: Re-read currency on EVERY /app load to catch hardcoded INR rows
  it("C.5: INR shop re-read returns INR → stays supported, no DB update", async () => {
    setupSqlMock("INR");
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");

    // No DB update should occur (currencies match)
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);
  });

  // #292 Item 4: Catch shops that switch away from INR
  it("C.6: INR shop re-read returns USD → becomes not-supported, updates currency", async () => {
    setupSqlMock("INR");
    setupGraphqlMock("USD");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    // Should have written metafield and updated DB
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.some((c) => c.values.includes("USD"))).toBe(true);

    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });

  // #292 Item 3: Metafield write fails → currency NOT updated in DB
  it("C.7: USD shop switches to INR but metafield write fails → stays USD (no DB update)", async () => {
    setupSqlMock("USD");
    
    // Configure graphql mock to fail the metafield write
    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: { shop: { id: TEST_SHOP_GID, currencyCode: "INR" } },
          }),
        };
      }

      if (query.includes("WriteShopConfig") || query.includes("metafieldsSet")) {
        return {
          json: async () => ({
            data: { metafieldsSet: { metafields: [], userErrors: [{ field: "value", message: "Write failed" }] } },
          }),
        };
      }

      return { json: async () => ({ data: {} }) };
    });

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    // Should stay as USD because metafield write failed
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    // No DB update should occur (metafield write failed)
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    consoleSpy.mockRestore();
  });

  // #292 Stale shop_config tests
  it("C.8: DB USD, live currency USD, stale shop_config INR → re-pushed as USD", async () => {
    setupSqlMock("USD");
    // DB is USD, Shopify returns USD, but shop_config metafield has INR (stale)
    setupGraphqlMock("USD", false, "INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    // Currency should stay USD (matches live)
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    // No DB update needed (currencies match)
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    // But shop_config should have been re-pushed because it was stale
    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });

  it("C.9: DB INR, live currency INR, stale shop_config USD → re-pushed as INR", async () => {
    setupSqlMock("INR");
    // DB is INR, Shopify returns INR, but shop_config metafield has USD (stale)
    setupGraphqlMock("INR", false, "USD");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    // Currency should stay INR (matches live)
    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");

    // No DB update needed (currencies match)
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    // But shop_config should have been re-pushed because it was stale
    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });

  it("C.10: Missing shop_config metafield → pushed even when DB matches", async () => {
    setupSqlMock("USD");
    // DB is USD, Shopify returns USD, shop_config is missing (null)
    setupGraphqlMock("USD", false, null);

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    // Currency should stay USD
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    // shop_config should have been pushed because it was missing
    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });

  // #292 Currency Flip Safety tests
  it("C.11: USD shop switches to INR with financial rows → blocked, currency unchanged, flipBlocked=true", async () => {
    setupSqlMock("USD", { hasFinancialRows: true });
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    // Currency flip should be blocked
    expect(result.currencyFlipBlocked).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");

    // No DB update should occur (flip blocked)
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    // No metafield push (flip blocked)
    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBe(0);
  });

  it("C.12: EUR shop switches to INR with financial rows → blocked", async () => {
    setupSqlMock("EUR", { hasFinancialRows: true });
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencyFlipBlocked).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("EUR");
  });

  it("C.13: XXX shop switches to INR with financial rows → blocked (fail-closed)", async () => {
    setupSqlMock("XXX", { hasFinancialRows: true });
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    // #292 fail-closed: XXX with financial rows is blocked to prevent relabeling
    expect(result.currencyFlipBlocked).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("XXX");
  });

  it("C.14: INR shop stays INR with financial rows → no change, no block (already INR)", async () => {
    setupSqlMock("INR", { hasFinancialRows: true });
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data;

    expect(result.currencyFlipBlocked).toBe(false);
    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");
  });
});
