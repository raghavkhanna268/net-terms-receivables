import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";

/**
 * #292: Currency gate tests for app.reconcile loader and action.
 *
 * Tests verify that when a shop's currency is not supported (non-INR, NULL, XXX):
 * - The loader returns notSupported: true with no payment/match amounts
 * - The action rejects all operations with "Currency not supported"
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

const mockGetUnmatchedPayments = vi.fn();
const mockGetSuggestedMatches = vi.fn();
const mockGetPaymentWithMatches = vi.fn();

vi.mock("~/lib/matching/queries.server", () => ({
  getUnmatchedPayments: mockGetUnmatchedPayments,
  getSuggestedMatches: mockGetSuggestedMatches,
  getPaymentWithMatches: mockGetPaymentWithMatches,
}));

const mockRunMatcher = vi.fn();
const mockConfirmMatch = vi.fn();
const mockRejectMatch = vi.fn();

vi.mock("~/services/matcher.server", () => ({
  runMatcher: mockRunMatcher,
  confirmMatch: mockConfirmMatch,
  rejectMatch: mockRejectMatch,
  MAX_PAYMENTS_PER_REQUEST: 100,
}));

vi.mock("~/services/apply.server", () => ({
  applyMatch: vi.fn().mockResolvedValue({ success: true }),
  unmatchMatch: vi.fn().mockResolvedValue({ success: true }),
  RECONCILE_HUMAN_MESSAGES: [],
}));

vi.mock("~/services/access-log.server", () => ({
  recordAccess: vi.fn(),
  getActorFromSessionToken: vi.fn().mockReturnValue("test-actor"),
}));

const TEST_SHOP = "test-reconcile-gate.myshopify.com";
const TEST_SHOP_ID = "shop-reconcile-123";

describe("#292 currency gate on /app/reconcile", () => {
  function createLoaderArgs(view = "suggested"): LoaderFunctionArgs {
    const url = new URL(`https://example.com/app/reconcile?view=${view}`);
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
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  function createActionArgs(formData: FormData): ActionFunctionArgs {
    const url = new URL("https://example.com/app/reconcile");
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
      params: {},
    } as unknown as ActionFunctionArgs;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetSuggestedMatches.mockResolvedValue({
      matches: [
        {
          id: "match-1",
          paymentId: "payment-1",
          invoiceId: "invoice-1",
          invoiceName: "#1001",
          amountPaise: 100000n,
          score: 85,
          reasons: [],
          state: "suggested",
          buyerName: "Test Buyer",
        },
      ],
      totalCount: 1,
    });
    mockGetUnmatchedPayments.mockResolvedValue({
      payments: [
        {
          id: "payment-1",
          amountPaise: 100000n,
          narration: "TEST",
          payerText: "Buyer",
          utr: "NEFT123",
          rail: "NEFT",
        },
      ],
      totalCount: 1,
    });
    mockRunMatcher.mockResolvedValue({
      paymentsProcessed: 1,
      matchesCreated: 1,
      highConfidenceMatches: 1,
      hasMore: false,
    });
    mockConfirmMatch.mockResolvedValue({ success: true });
    mockRejectMatch.mockResolvedValue({ success: true });
  });

  function setupSqlMock(storedCurrency: string | null) {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        return Promise.resolve([
          { id: TEST_SHOP_ID, currency: storedCurrency },
        ]);
      }
      if (query.includes("COUNT(*)") && query.includes("Match")) {
        return Promise.resolve([{ count: "1" }]);
      }
      if (query.includes("COUNT(*)") && query.includes("Payment")) {
        return Promise.resolve([{ count: "1" }]);
      }
      return Promise.resolve([]);
    });
  }

  describe("loader", () => {
    it("USD shop: notSupported=true, no payments/matches in payload", async () => {
      setupSqlMock("USD");

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("USD");
      expect(result.payments).toHaveLength(0);
      expect(result.matches).toHaveLength(0);
      expect(result.selectedPayment).toBeNull();

      expect(mockGetSuggestedMatches).not.toHaveBeenCalled();
    });

    it("XXX (unknown) shop: notSupported=true, fail-closed", async () => {
      setupSqlMock("XXX");

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("XXX");
      expect(result.payments).toHaveLength(0);
      expect(result.matches).toHaveLength(0);
    });

    it("NULL currency: notSupported=true, fail-closed", async () => {
      setupSqlMock(null);

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(true);
      expect(result.shopCurrency).toBe("XXX");
      expect(result.payments).toHaveLength(0);
    });

    it("INR shop: notSupported=false, payments/matches present", async () => {
      setupSqlMock("INR");

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.notSupported).toBe(false);
      expect(result.shopCurrency).toBe("INR");

      expect(mockGetSuggestedMatches).toHaveBeenCalled();
    });
  });

  describe("action", () => {
    it("USD shop: rejects run_matcher with 'Currency not supported'", async () => {
      setupSqlMock("USD");

      const formData = new FormData();
      formData.append("intent", "run_matcher");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Currency not supported");
      expect(mockRunMatcher).not.toHaveBeenCalled();
    });

    it("XXX shop: rejects confirm with 'Currency not supported'", async () => {
      setupSqlMock("XXX");

      const formData = new FormData();
      formData.append("intent", "confirm");
      formData.append("matchId", "match-1");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Currency not supported");
      expect(mockConfirmMatch).not.toHaveBeenCalled();
    });

    it("NULL currency: rejects reject with 'Currency not supported'", async () => {
      setupSqlMock(null);

      const formData = new FormData();
      formData.append("intent", "reject");
      formData.append("matchId", "match-1");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Currency not supported");
    });

    it("INR shop: allows run_matcher", async () => {
      setupSqlMock("INR");

      const formData = new FormData();
      formData.append("intent", "run_matcher");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(true);
      expect(mockRunMatcher).toHaveBeenCalled();
    });
  });
});
