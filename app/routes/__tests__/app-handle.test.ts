import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for APP_HANDLE behavior across plan-related routes.
 *
 * Verifies that:
 * 1. When APP_HANDLE is set, loaders return the correct handle
 * 2. When APP_HANDLE is unset, loaders return null and log a warning
 */

// Mock SQL client
const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn((s) => s), json: vi.fn((v) => v) });

// Mock modules shared by all routes
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
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getGatedAccountCount: vi.fn().mockResolvedValue(0),
  isAccountActive: vi.fn().mockReturnValue(true),
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

vi.mock("~/services/reminder-optout.server", () => ({
  getBuyerOptOutStatus: vi.fn().mockResolvedValue(null),
  setBuyerOptOut: vi.fn(),
  clearBuyerOptOut: vi.fn(),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue(null),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-123";

function createLoaderArgs(searchParams: Record<string, string> = {}): LoaderFunctionArgs {
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
  } as unknown as LoaderFunctionArgs;
}

function createAccountLoaderArgs(): LoaderFunctionArgs {
  const url = new URL("https://example.com/app/accounts/test-account-id");

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
    params: { id: "test-account-id" },
  } as unknown as LoaderFunctionArgs;
}

describe("app._index upgradeUrl behavior", () => {
  const originalEnv = process.env.APP_HANDLE;

  beforeEach(() => {
    vi.resetModules();
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
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
        return Promise.resolve([{ count: "0" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = originalEnv;
  });

  it("returns correct upgradeUrl when APP_HANDLE env is set", async () => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
    const { loader } = await import("../app._index");
    const result = await loader(createLoaderArgs({ skipOnboarding: "true" }));

    expect(result.upgradeUrl).toBe(
      "https://admin.shopify.com/store/test-shop/charges/net-terms-receivables-1/pricing_plans"
    );
  });

  it("returns null upgradeUrl and logs warning when APP_HANDLE env is unset", async () => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = undefined;
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loader } = await import("../app._index");
    const result = await loader(createLoaderArgs({ skipOnboarding: "true" }));

    expect(result.upgradeUrl).toBeNull();

    const allLogs = consoleWarnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toContain('"event":"plan_url_app_handle_missing"');

    consoleWarnSpy.mockRestore();
  });
});

describe("app.plan upgradeUrl behavior", () => {
  const originalEnv = process.env.APP_HANDLE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id FROM")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = originalEnv;
  });

  it("returns correct upgradeUrl when APP_HANDLE env is set", async () => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
    const { loader } = await import("../app.plan");
    const result = await loader(createLoaderArgs());

    expect(result.upgradeUrl).toBe(
      "https://admin.shopify.com/store/test-shop/charges/net-terms-receivables-1/pricing_plans"
    );
  });

  it("returns null upgradeUrl and logs warning when APP_HANDLE env is unset", async () => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = undefined;
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loader } = await import("../app.plan");
    const result = await loader(createLoaderArgs());

    expect(result.upgradeUrl).toBeNull();

    const allLogs = consoleWarnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toContain('"event":"plan_url_app_handle_missing"');

    consoleWarnSpy.mockRestore();
  });
});

describe("app.accounts.$id upgradeUrl behavior", () => {
  const originalEnv = process.env.APP_HANDLE;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id FROM") && query.includes("Shop")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }
      if (query.includes("SELECT") && query.includes("BuyerAccount")) {
        return Promise.resolve([{
          id: "test-account-id",
          name: "Test Account",
          kind: "COMPANY",
          companyId: null,
          defaultTermsDays: null,
          defaultTermsSource: null,
          gatedAt: null,
        }]);
      }
      if (query.includes("EXISTS") && query.includes("s6_dead_letter")) {
        return Promise.resolve([{ exists: false }]);
      }
      return Promise.resolve([]);
    });
  });

  afterEach(() => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = originalEnv;
  });

  it("returns correct upgradeUrl when APP_HANDLE env is set", async () => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
    const { loader } = await import("../app.accounts.$id");
    const result = await loader(createAccountLoaderArgs());

    expect(result.upgradeUrl).toBe(
      "https://admin.shopify.com/store/test-shop/charges/net-terms-receivables-1/pricing_plans"
    );
  });

  it("returns null upgradeUrl and logs warning when APP_HANDLE env is unset", async () => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = undefined;
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { loader } = await import("../app.accounts.$id");
    const result = await loader(createAccountLoaderArgs());

    expect(result.upgradeUrl).toBeNull();

    const allLogs = consoleWarnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(allLogs).toContain('"event":"plan_url_app_handle_missing"');

    consoleWarnSpy.mockRestore();
  });
});
