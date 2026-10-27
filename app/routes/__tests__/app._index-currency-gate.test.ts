import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * #292: Currency gate tests for app._index loader.
 *
 * Tests verify that when a shop's currency is not supported (non-INR, NULL, XXX):
 * - The loader returns notSupported: true
 * - No money fields are present in the payload (agingTotals, buyerLedger, selectedBuyerInvoices)
 * - Money queries are not run
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

const mockGetShopAgingTotals = vi.fn();
const mockGetBuyerLedger = vi.fn();
const mockGetBuyerInvoices = vi.fn();

vi.mock("~/lib/aging-queries.server", () => ({
  getShopAgingTotals: mockGetShopAgingTotals,
  getBuyerLedger: mockGetBuyerLedger,
  getBuyerInvoices: mockGetBuyerInvoices,
}));

vi.mock("~/services/shop-currency-recovery.server", () => ({
  checkAndRecoverCurrency: vi.fn().mockImplementation(
    (_sql, _domain, storedCurrency) => Promise.resolve({
      currency: storedCurrency,
      flipBlocked: false,
    })
  ),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

const TEST_SHOP = "test-gate.myshopify.com";
const TEST_SHOP_ID = "shop-gate-123";

describe("#292 currency gate on /app loader", () => {
  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app?skipOnboarding=true");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              sessionToken: "test-token",
              redirect: vi.fn(),
              admin: { graphql: vi.fn() },
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
    mockGetShopAgingTotals.mockResolvedValue({
      totalByCurrency: { INR: "1000000" },
      buckets: {
        current: { byCurrency: { INR: "500000" } },
        "1-30": { byCurrency: {} },
        "31-60": { byCurrency: {} },
        "61-90": { byCurrency: {} },
        "90+": { byCurrency: {} },
      },
      overdueByCurrency: {},
      oldestOverdueDays: null,
    });
    mockGetBuyerLedger.mockResolvedValue({ rows: [{ buyer_account_id: "b1" }], totalCount: 1 });
    mockGetBuyerInvoices.mockResolvedValue({ rows: [], totalCount: 0 });
  });

  function setupSqlMock(storedCurrency: string | null) {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: storedCurrency, timezone: "Asia/Kolkata" },
        ]);
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
      }
      if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });
  }

  const MONEY_KEY_PATTERNS = [
    /balance/i,
    /amount/i,
    /outstanding/i,
    /aging/i,
    /total(?!Count)/i,
    /creditLimit/i,
    /paise/i,
    /exposure/i,
  ];

  function assertNoMoneyKeysInPayload(serialized: string) {
    for (const pattern of MONEY_KEY_PATTERNS) {
      // Match money keys with non-null values (numbers, strings, objects, arrays)
      const match = serialized.match(new RegExp(`"[^"]*${pattern.source}[^"]*"\\s*:\\s*([0-9"\\[{])`, "i"));
      if (match && !match[0].includes("totalCount")) {
        throw new Error(`Serialized payload contains money key with value matching ${pattern}: ${match[0]}`);
      }
    }
  }

  it("USD shop: storeSetupStatus=not_supported, no money fields in payload, money queries not run", async () => {
    setupSqlMock("USD");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data as Record<string, unknown>;

    expect(result.notSupported).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.storeSetupStatus).toBe("not_supported");
    expect(result.shopCurrency).toBe("USD");
    expect(result.agingTotals).toBeNull();
    expect(result.buyerLedger).toBeNull();
    expect(result.selectedBuyerInvoices).toBeNull();

    // Verify serialized payload has no money keys with values
    const serialized = JSON.stringify(result);
    assertNoMoneyKeysInPayload(serialized);

    expect(mockGetShopAgingTotals).not.toHaveBeenCalled();
    expect(mockGetBuyerLedger).not.toHaveBeenCalled();
  });

  it("XXX (unknown) shop: storeSetupStatus=setting_up, no money fields, fail-closed", async () => {
    setupSqlMock("XXX");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data as Record<string, unknown>;

    expect(result.notSupported).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.storeSetupStatus).toBe("setting_up");
    expect(result.shopCurrency).toBe("XXX");
    expect(result.agingTotals).toBeNull();
    expect(result.buyerLedger).toBeNull();

    // Verify serialized payload has no money keys with values
    const serialized = JSON.stringify(result);
    assertNoMoneyKeysInPayload(serialized);

    expect(mockGetShopAgingTotals).not.toHaveBeenCalled();
  });

  it("NULL currency: storeSetupStatus=setting_up, no money fields, fail-closed", async () => {
    setupSqlMock(null);

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data as Record<string, unknown>;

    expect(result.notSupported).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.storeSetupStatus).toBe("setting_up");
    expect(result.shopCurrency).toBe("XXX");
    expect(result.agingTotals).toBeNull();
    expect(result.buyerLedger).toBeNull();

    // Verify serialized payload has no money keys with values
    const serialized = JSON.stringify(result);
    assertNoMoneyKeysInPayload(serialized);

    expect(mockGetShopAgingTotals).not.toHaveBeenCalled();
  });

  it("INR shop: currencySupported=true, money fields present, queries run", async () => {
    setupSqlMock("INR");

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data as Record<string, unknown>;

    expect(result.notSupported).toBeUndefined();
    expect(result.currencySupported).toBe(true);
    expect(result.shopCurrency).toBe("INR");
    expect(result.agingTotals).not.toBeNull();
    expect(result.buyerLedger).not.toBeNull();

    expect(mockGetShopAgingTotals).toHaveBeenCalled();
    expect(mockGetBuyerLedger).toHaveBeenCalled();
  });

  it("no Shop row: storeSetupStatus=setting_up, fail-closed with XXX sentinel", async () => {
    // Simulate no shop row found
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([]); // No shop found
      }
      if (query.includes("onboarding_dismissed_at")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data as Record<string, unknown>;

    // Fail-closed: no Shop row triggers setting_up state
    expect(result.notSupported).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.storeSetupStatus).toBe("setting_up");
    expect(result.shopCurrency).toBe("XXX");
    expect(result.agingTotals).toBeNull();
    expect(result.buyerLedger).toBeNull();

    // Verify serialized payload has no money keys with values
    const serialized = JSON.stringify(result);
    assertNoMoneyKeysInPayload(serialized);

    expect(mockGetShopAgingTotals).not.toHaveBeenCalled();
    expect(mockGetBuyerLedger).not.toHaveBeenCalled();
  });

  it("currency not-supported wins over onboarding redirect (decision order preserved)", async () => {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "USD", timezone: "America/New_York" },
        ]);
      }
      if (query.includes("should_redirect")) {
        return Promise.resolve([{ should_redirect: true }]);
      }
      if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgs());
    const result = dataResponse.data as Record<string, unknown>;

    expect(result.notSupported).toBe(true);
    expect(result.currencySupported).toBe(false);
    expect(result.shopCurrency).toBe("USD");
    expect(mockGetShopAgingTotals).not.toHaveBeenCalled();
    expect(mockGetBuyerLedger).not.toHaveBeenCalled();
  });

  it("onboarding redirect does NOT happen when currency is unsupported (no redirect thrown)", async () => {
    let redirectCalled = false;
    
    function createLoaderArgsWithRedirectTracking(): LoaderFunctionArgs {
      const url = new URL("https://example.com/app");
      return {
        request: new Request(url.toString()),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                session: { shop: TEST_SHOP },
                sessionToken: "test-token",
                redirect: vi.fn((path: string) => {
                  redirectCalled = true;
                  throw new Response(null, { status: 302, headers: { Location: path } });
                }),
                admin: { graphql: vi.fn() },
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

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency, timezone FROM")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: "EUR", timezone: "Europe/London" },
        ]);
      }
      if (query.includes("should_redirect")) {
        return Promise.resolve([{ should_redirect: true }]);
      }
      if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });

    const { loader } = await import("../app._index");
    const dataResponse = await loader(createLoaderArgsWithRedirectTracking());
    const result = dataResponse.data as Record<string, unknown>;

    expect(redirectCalled).toBe(false);
    expect(result.notSupported).toBe(true);
    expect(result.currencySupported).toBe(false);
  });
});
