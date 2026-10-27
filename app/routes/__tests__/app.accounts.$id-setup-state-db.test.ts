/**
 * #548: Setup state tests for app.accounts.$id route.
 *
 * Tests verify that when the Shop row is missing (setup in progress):
 * - The loader returns settingUp: true with error: null
 * - The action refuses mutations with a setting-up message
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

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

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 100 },
    importsThisMonth: { current: 0, limit: 100 },
  }),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  getBuyerOptOutStatus: vi.fn().mockResolvedValue(null),
  setBuyerOptOut: vi.fn(),
  clearBuyerOptOut: vi.fn(),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue(null),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn().mockResolvedValue({ success: true }),
  parseCreditLimitString: vi.fn().mockReturnValue({ valid: true, value: 100000 }),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn((e) => String(e)),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("test-handle"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://example.com/plan"),
}));

const TEST_SHOP = "test-accounts-setup.myshopify.com";
const TEST_ACCOUNT_ID = "account-123";

describe("#548 setup state on /app/accounts/$id", () => {
  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL(`https://example.com/app/accounts/${TEST_ACCOUNT_ID}`);
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              sessionToken: "test-token",
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: { id: TEST_ACCOUNT_ID },
    } as unknown as LoaderFunctionArgs;
  }

  function createActionArgs(formData: FormData): ActionFunctionArgs {
    const url = new URL(`https://example.com/app/accounts/${TEST_ACCOUNT_ID}`);
    return {
      request: new Request(url.toString(), {
        method: "POST",
        body: formData,
      }),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP, onlineAccessInfo: { associatedUser: { id: "user-1" } } },
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: { id: TEST_ACCOUNT_ID },
    } as unknown as ActionFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function setupSqlMockNoShop() {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  }

  function setupSqlMockWithShop(currency: string) {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        return Promise.resolve([{ id: "shop-123", currency }]);
      }
      if (query.includes("SELECT") && query.includes("BuyerAccount")) {
        return Promise.resolve([{
          id: TEST_ACCOUNT_ID,
          name: "Test Account",
          kind: "COMPANY",
          companyId: "company-123",
          defaultTermsDays: 30,
          defaultTermsSource: "explicit",
          gatedAt: null,
        }]);
      }
      return Promise.resolve([]);
    });
  }

  describe("loader", () => {
    it("returns settingUp: true when shop row is missing", async () => {
      setupSqlMockNoShop();

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.settingUp).toBe(true);
      expect(result.error).toBeNull();
      expect(result.account).toBeNull();
    });

    it("returns settingUp: undefined (falsy) when shop exists with INR currency", async () => {
      setupSqlMockWithShop("INR");

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.settingUp).toBeFalsy();
      expect(result.notSupported).toBeFalsy();
    });
  });

  describe("action", () => {
    it("rejects updateCredit when shop row is missing", async () => {
      setupSqlMockNoShop();

      const formData = new FormData();
      formData.append("_action", "updateCredit");
      formData.append("creditLimit", "100000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("rejects updateReminderOptOut when shop row is missing", async () => {
      setupSqlMockNoShop();

      const formData = new FormData();
      formData.append("_action", "updateReminderOptOut");
      formData.append("enable", "true");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("rejects when currency is XXX (setting up)", async () => {
      setupSqlMockWithShop("XXX");

      const formData = new FormData();
      formData.append("_action", "updateCredit");
      formData.append("creditLimit", "100000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });
  });
});
