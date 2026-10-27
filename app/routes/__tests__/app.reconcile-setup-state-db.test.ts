/**
 * #548: Setup state tests for app.reconcile route.
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

const TEST_SHOP = "test-reconcile-setup.myshopify.com";

describe("#548 setup state on /app/reconcile", () => {
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
      matches: [],
      totalCount: 0,
    });
    mockGetUnmatchedPayments.mockResolvedValue({
      payments: [],
      totalCount: 0,
    });
    mockRunMatcher.mockResolvedValue({
      paymentsProcessed: 0,
      matchesCreated: 0,
      highConfidenceMatches: 0,
      hasMore: false,
    });
  });

  function setupSqlMockNoShop() {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        return Promise.resolve([]);
      }
      if (query.includes("COUNT(*)")) {
        return Promise.resolve([{ count: "0" }]);
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
      if (query.includes("COUNT(*)")) {
        return Promise.resolve([{ count: "0" }]);
      }
      return Promise.resolve([]);
    });
  }

  describe("loader", () => {
    it("returns settingUp: true when shop row is missing", async () => {
      setupSqlMockNoShop();

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.settingUp).toBe(true);
      expect(result.error).toBeNull();
      expect(result.notSupported).toBe(false);
      expect(result.payments).toHaveLength(0);
      expect(result.matches).toHaveLength(0);
    });

    it("returns settingUp: true when currency is XXX (placeholder)", async () => {
      setupSqlMockWithShop("XXX");

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.settingUp).toBe(true);
      expect(result.notSupported).toBe(false);
    });

    it("returns settingUp: false when shop exists with INR currency", async () => {
      setupSqlMockWithShop("INR");

      const { loader } = await import("../app.reconcile");
      const result = await loader(createLoaderArgs());

      expect(result.settingUp).toBe(false);
      expect(result.notSupported).toBe(false);
    });
  });

  describe("action", () => {
    it("rejects run_matcher when shop row is missing", async () => {
      setupSqlMockNoShop();

      const formData = new FormData();
      formData.append("intent", "run_matcher");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
      expect(mockRunMatcher).not.toHaveBeenCalled();
    });

    it("rejects confirm when shop row is missing", async () => {
      setupSqlMockNoShop();

      const formData = new FormData();
      formData.append("intent", "confirm");
      formData.append("matchId", "match-1");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("rejects when currency is XXX (setting up)", async () => {
      setupSqlMockWithShop("XXX");

      const formData = new FormData();
      formData.append("intent", "run_matcher");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("allows run_matcher when shop exists with INR currency", async () => {
      setupSqlMockWithShop("INR");

      const formData = new FormData();
      formData.append("intent", "run_matcher");

      const { action } = await import("../app.reconcile");
      const result = await action(createActionArgs(formData));

      expect(result.success).toBe(true);
      expect(mockRunMatcher).toHaveBeenCalled();
    });
  });
});
