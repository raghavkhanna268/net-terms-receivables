import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

/**
 * #292: Currency gate tests for app.accounts.$id loader and action.
 *
 * Tests verify that when a shop's currency is not supported (non-INR, NULL, XXX):
 * - The loader returns notSupported: true with no money fields
 * - The action rejects all edits with "Currency not supported"
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

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

const mockGetCreditStatusDisplay = vi.fn();
const mockGetCompanyTotals = vi.fn();
const mockUpdateCreditStatus = vi.fn();

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: mockGetCreditStatusDisplay,
  getCompanyTotals: mockGetCompanyTotals,
  updateCreditStatus: mockUpdateCreditStatus,
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  getBuyerOptOutStatus: vi.fn().mockResolvedValue(null),
  setBuyerOptOut: vi.fn(),
  clearBuyerOptOut: vi.fn(),
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("test-handle"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://example.com/plan"),
}));

const TEST_SHOP = "test-account-gate.myshopify.com";
const TEST_SHOP_ID = "shop-account-123";
const TEST_ACCOUNT_ID = "account-123";

describe("#292 currency gate on /app/accounts/:id", () => {
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
    mockGetCreditStatusDisplay.mockResolvedValue({
      creditLimitAmount: 100000,
      creditLimitPaise: 10000000n,
      exposurePaise: 5000000n,
      draftExposurePaise: 0n,
      availableCreditPaise: 5000000n,
      currency: "INR",
      holdState: "OK",
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      isOnHold: false,
      holdReasonDisplay: null,
      isOverLimit: false,
      isOverdue: false,
      utilizationPercent: 50,
      syncPending: false,
      syncErrorCode: null,
      metafieldSyncedAt: null,
    });
    mockGetCompanyTotals.mockResolvedValue(null);
    mockUpdateCreditStatus.mockResolvedValue({ success: true });
  });

  function setupSqlMock(storedCurrency: string | null) {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: storedCurrency },
        ]);
      }
      if (query.includes("SELECT") && query.includes("BuyerAccount") && query.includes("kind")) {
        return Promise.resolve([
          {
            id: TEST_ACCOUNT_ID,
            name: "Test Buyer",
            kind: "COMPANY",
            companyId: "company-1",
            defaultTermsDays: 30,
            defaultTermsSource: "explicit",
            gatedAt: null,
          },
        ]);
      }
      if (query.includes("SELECT") && query.includes("BuyerAccount") && query.includes("gated_at")) {
        return Promise.resolve([
          { id: TEST_ACCOUNT_ID, gatedAt: null },
        ]);
      }
      if (query.includes("SELECT EXISTS") && query.includes("s6_dead_letter")) {
        return Promise.resolve([{ exists: false }]);
      }
      return Promise.resolve([]);
    });
  }

  const MONEY_KEY_PATTERNS = [
    /balance/i,
    /amount/i,
    /outstanding/i,
    /creditLimit/i,
    /paise/i,
    /exposure/i,
    /utilization/i,
  ];

  function assertNoMoneyKeysInPayload(serialized: string) {
    for (const pattern of MONEY_KEY_PATTERNS) {
      const match = serialized.match(new RegExp(`"[^"]*${pattern.source}[^"]*"\\s*:\\s*[^n]`, "i"));
      if (match && !match[0].includes("null")) {
        throw new Error(`Serialized payload contains money key with value matching ${pattern}: ${match[0]}`);
      }
    }
  }

  describe("loader", () => {
    it("USD shop: notSupported=true, no credit/invoice data in payload", async () => {
      setupSqlMock("USD");

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("USD");
      expect(result.account).toBeNull();
      expect(result.creditStatus).toBeNull();
      expect(result.companyTotals).toBeNull();
      expect(result.invoices.rows).toHaveLength(0);

      // Verify serialized payload has no money keys with values
      const serialized = JSON.stringify(result);
      assertNoMoneyKeysInPayload(serialized);

      expect(mockGetCreditStatusDisplay).not.toHaveBeenCalled();
    });

    it("XXX (unknown) shop: notSupported=true, fail-closed", async () => {
      setupSqlMock("XXX");

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("XXX");
      expect(result.creditStatus).toBeNull();

      // Verify serialized payload has no money keys with values
      const serialized = JSON.stringify(result);
      assertNoMoneyKeysInPayload(serialized);
    });

    it("NULL currency: notSupported=true, fail-closed", async () => {
      setupSqlMock(null);

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("XXX");
      expect(result.creditStatus).toBeNull();

      // Verify serialized payload has no money keys with values
      const serialized = JSON.stringify(result);
      assertNoMoneyKeysInPayload(serialized);
    });

    it("INR shop: creditStatus and invoices present", async () => {
      setupSqlMock("INR");

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBeUndefined();
      expect(result.account).not.toBeNull();
      expect(result.creditStatus).not.toBeNull();

      expect(mockGetCreditStatusDisplay).toHaveBeenCalled();
    });
  });

  describe("action", () => {
    it("USD shop: rejects credit-limit edit with 'Currency not supported'", async () => {
      setupSqlMock("USD");

      const formData = new FormData();
      formData.append("_action", "updateCredit");
      formData.append("creditLimit", "50000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData)) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe("Currency not supported");
      expect(mockUpdateCreditStatus).not.toHaveBeenCalled();
    });

    it("XXX shop: rejects all edits, fail-closed", async () => {
      setupSqlMock("XXX");

      const formData = new FormData();
      formData.append("_action", "updateCredit");
      formData.append("manualHold", "true");
      formData.append("holdOnly", "true");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData)) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe("Currency not supported");
    });

    it("NULL currency: rejects edits, fail-closed", async () => {
      setupSqlMock(null);

      const formData = new FormData();
      formData.append("_action", "updateReminderOptOut");
      formData.append("enable", "true");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData)) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe("Currency not supported");
    });

    it("INR shop: allows credit-limit edit", async () => {
      setupSqlMock("INR");

      const formData = new FormData();
      formData.append("_action", "updateCredit");
      formData.append("creditLimit", "50000");

      const { action } = await import("../app.accounts.$id");
      const result = await action(createActionArgs(formData)) as Record<string, unknown>;

      expect(result.success).toBe(true);
      expect(mockUpdateCreditStatus).toHaveBeenCalled();
    });
  });
});
