import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

/**
 * #292 G1: Currency recovery tests for app.onboarding loader and start_sync action.
 *
 * Tests verify that:
 * 1. Onboarding loader recovers USD to INR (banner gone, shop_config re-pushed)
 * 2. It detects an INR shop that switched to USD (banner shown)
 * 3. start_sync is blocked for a non-INR shop and allowed after recovery
 * 4. Currency flip is blocked when shop has financial rows (Invoice, Payment, s8_draft_orders)
 * 5. The flipBlocked banner is shown on onboarding when blocked
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

vi.mock("~/lib/metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: vi.fn().mockResolvedValue([]),
  getMetafieldDefinitionSpecs: vi.fn(() => [{
    definition: { namespace: "$app", key: "credit_status", type: "json" },
    ownerTypes: ["COMPANY_LOCATION", "CUSTOMER"],
  }]),
}));

const TEST_SHOP = "test-onboarding-recovery.myshopify.com";
const TEST_SHOP_ID = "shop-onboarding-recovery-123";
const TEST_SHOP_GID = "gid://shopify/Shop/12345";

describe("#292 G1: currency recovery in onboarding loader", () => {
  let mockGraphql: ReturnType<typeof vi.fn>;
  let sqlCalls: Array<{ query: string; values: unknown[] }>;

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app/onboarding");
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

      if (query.includes("SELECT id") && query.includes("defaultTermsDays")) {
        return Promise.resolve([{
          id: TEST_SHOP_ID,
          defaultTermsDays: 30,
          onboardingDismissedAt: null,
        }]);
      }
      if (query.includes("SELECT currency") && query.includes("Shop")) {
        return Promise.resolve([{ currency: storedCurrency }]);
      }
      // For hasFinancialRows check - returns shopId for secondary lookup
      if (query.includes("SELECT id FROM") && query.includes("Shop") && query.includes("domain")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }
      // For hasFinancialRows EXISTS query
      if (query.includes("SELECT EXISTS") && (query.includes("Invoice") || query.includes("Payment") || query.includes("s8_draft_orders"))) {
        return Promise.resolve([{ has_rows: opts?.hasFinancialRows ?? false }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("s6_bulk_operations")) {
        return Promise.resolve([]);
      }
      if (query.includes("s6_dead_letter")) {
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

      if (query.includes("validations")) {
        return { json: async () => ({ data: { validations: { edges: [] } } }) };
      }

      if (query.includes("paymentCustomizations")) {
        return { json: async () => ({ data: { paymentCustomizations: { edges: [] } } }) };
      }

      if (query.includes("metafieldDefinitions")) {
        return { json: async () => ({ data: { metafieldDefinitions: { edges: [] } } }) };
      }

      return { json: async () => ({ data: {} }) };
    });
  }

  it("G1.1: USD shop switches to INR (no financial rows) → recovers, banner gone, shop_config re-pushed", async () => {
    setupSqlMock("USD", { hasFinancialRows: false });
    setupGraphqlMock("INR");

    const { loader } = await import("../app.onboarding");
    const result = await loader(createLoaderArgs());

    expect(result.currencySupported).toBe(true);
    expect(result.currencyFlipBlocked).toBe(false);

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.some((c) => c.values.includes("INR"))).toBe(true);

    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBeGreaterThan(0);
  });

  it("G1.2: INR shop re-read returns USD → becomes not-supported, banner shown", async () => {
    setupSqlMock("INR");
    setupGraphqlMock("USD");

    const { loader } = await import("../app.onboarding");
    const result = await loader(createLoaderArgs());

    expect(result.currencySupported).toBe(false);

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls.some((c) => c.values.includes("USD"))).toBe(true);
  });

  it("G1.3: USD shop stays USD → not-supported, no recovery", async () => {
    setupSqlMock("USD");
    setupGraphqlMock("USD");

    const { loader } = await import("../app.onboarding");
    const result = await loader(createLoaderArgs());

    expect(result.currencySupported).toBe(false);
    expect(result.currencyFlipBlocked).toBe(false);

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);
  });

  it("G1.8: USD shop switches to INR with financial rows → blocked, flipBlocked=true", async () => {
    setupSqlMock("USD", { hasFinancialRows: true });
    setupGraphqlMock("INR");

    const { loader } = await import("../app.onboarding");
    const result = await loader(createLoaderArgs());

    // Currency flip should be blocked
    expect(result.currencyFlipBlocked).toBe(true);
    expect(result.currencySupported).toBe(false);

    // No DB update should occur (flip blocked)
    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    // No metafield push (flip blocked)
    const metafieldCalls = mockGraphql.mock.calls.filter((c) =>
      c[0].includes("WriteShopConfig") || c[0].includes("metafieldsSet")
    );
    expect(metafieldCalls.length).toBe(0);
  });
});

describe("#292 G1: start_sync blocks non-INR and allows after recovery", () => {
  let mockGraphql: ReturnType<typeof vi.fn>;
  let sqlCalls: Array<{ query: string; values: unknown[] }>;

  function createActionArgs(): ActionFunctionArgs {
    const formData = new FormData();
    formData.set("_action", "start_sync");

    return {
      request: new Request("https://example.com/app/onboarding", {
        method: "POST",
        body: formData,
      }),
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
    } as unknown as ActionFunctionArgs;
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

  function setupSqlMockForAction(storedCurrency: string, liveCurrency: string) {
    let currentCurrency = storedCurrency;

    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });

      if (query.includes("SELECT id FROM") && query.includes("Shop")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }
      if (query.includes("SELECT currency") && query.includes("Shop")) {
        return Promise.resolve([{ currency: currentCurrency }]);
      }
      if (query.includes("s6_bulk_operations") && query.includes("origin")) {
        return Promise.resolve([]);
      }
      if (query.includes("s6_dead_letter")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("s6_processed_webhooks")) {
        return Promise.resolve([]);
      }
      if (query.includes("pgmq.q_s6_sync") && query.includes("webhookId")) {
        return Promise.resolve([]);
      }
      if (query.includes("pgmq.send")) {
        return Promise.resolve([{ send: "1" }]);
      }
      if (query.includes("UPDATE") && query.includes("Shop") && query.includes("currency")) {
        // When currency is updated, track the new value
        currentCurrency = liveCurrency;
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });

    mockGraphql.mockImplementation(async (query: string) => {
      if (query.includes("ShopCurrencyAndId")) {
        return {
          json: async () => ({
            data: {
              shop: {
                id: TEST_SHOP_GID,
                currencyCode: liveCurrency,
                metafield: { value: JSON.stringify({ schemaVersion: 1, currencyCode: liveCurrency }) },
              },
            },
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

  it("G1.4: start_sync is blocked for non-INR shop (USD stored, USD live)", async () => {
    setupSqlMockForAction("USD", "USD");

    const { action } = await import("../app.onboarding");
    const result = await action(createActionArgs());

    expect(result).not.toBeInstanceOf(Response);
    const data = result as { success: boolean; error: string; action: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe("Sync not available for non-INR stores");
    expect(data.action).toBe("start_sync");
  });

  it("G1.5: start_sync is allowed after recovery (USD stored, INR live)", async () => {
    setupSqlMockForAction("USD", "INR");

    const { action } = await import("../app.onboarding");
    const result = await action(createActionArgs());

    expect(result).not.toBeInstanceOf(Response);
    const data = result as { success: boolean; action: string };
    expect(data.success).toBe(true);
    expect(data.action).toBe("start_sync");

    const sendCalls = sqlCalls.filter((c) => c.query.includes("pgmq.send"));
    expect(sendCalls.length).toBeGreaterThan(0);
  });

  it("G1.6: start_sync is blocked when recovery doesn't change currency (INR stored, USD live)", async () => {
    setupSqlMockForAction("INR", "USD");

    const { action } = await import("../app.onboarding");
    const result = await action(createActionArgs());

    expect(result).not.toBeInstanceOf(Response);
    const data = result as { success: boolean; error: string; action: string };
    expect(data.success).toBe(false);
    expect(data.error).toBe("Sync not available for non-INR stores");
    expect(data.action).toBe("start_sync");
  });

  it("G1.7: start_sync is allowed for INR shop (INR stored, INR live)", async () => {
    setupSqlMockForAction("INR", "INR");

    const { action } = await import("../app.onboarding");
    const result = await action(createActionArgs());

    expect(result).not.toBeInstanceOf(Response);
    const data = result as { success: boolean; action: string };
    expect(data.success).toBe(true);
    expect(data.action).toBe("start_sync");
  });
});
