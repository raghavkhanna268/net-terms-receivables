import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * #292: Currency recovery tests for app._index loader.
 *
 * Tests verify that when a non-INR shop loads /app:
 * 1. USD shop switches to INR → updates DB, pushes metafield, drops banner
 * 2. USD shop re-read returns USD → stays not-supported
 * 3. USD shop re-read throws → stays not-supported, keeps stored USD
 * 4. XXX shop re-read returns INR → becomes supported
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

  function setupSqlMock(storedCurrency: string) {
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });

      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: storedCurrency, timezone: "Asia/Kolkata" },
        ]);
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

  function setupGraphqlMock(currencyResponse: string | null, throwError = false) {
    mockGraphql.mockImplementation(async (query: string) => {
      if (throwError) {
        throw new Error("Network error");
      }

      if (query.includes("ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: currencyResponse
              ? { shop: { id: TEST_SHOP_GID, currencyCode: currencyResponse } }
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

  it("C.1: USD shop switches to INR → updates currency, pushes INR metafield, drops banner", async () => {
    setupSqlMock("USD");
    setupGraphqlMock("INR");

    const { loader } = await import("../app._index");
    const result = await loader(createLoaderArgs());

    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.some((c) => c.query.includes("'INR'"))).toBe(true);

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
    const result = await loader(createLoaderArgs());

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
    const result = await loader(createLoaderArgs());

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
    const result = await loader(createLoaderArgs());

    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.some((c) => c.query.includes("'INR'"))).toBe(true);

    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });
});
