import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for account detail page sync banner logic (app/routes/app.accounts.$id.tsx).
 *
 * Covers:
 * - Loader correctly determines syncState based on syncPending, error marker, and dead-letter
 * - Three states: "synced", "pending_retry", "needs_attention"
 * - hasDeadLetteredSync flag is set correctly
 */

const mockSql = Object.assign(vi.fn(), { 
  unsafe: vi.fn((s) => s),
  json: vi.fn((v) => JSON.stringify(v)),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn(),
  getCompanyTotals: vi.fn(),
  updateCreditStatus: vi.fn(),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

import { getCreditStatusDisplay, getCompanyTotals } from "~/services/credit-status.server";
import { getBuyerInvoices } from "~/lib/aging-queries.server";

const mockGetCreditStatusDisplay = vi.mocked(getCreditStatusDisplay);
const mockGetCompanyTotals = vi.mocked(getCompanyTotals);
const mockGetBuyerInvoices = vi.mocked(getBuyerInvoices);

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-123";
const TEST_ACCOUNT_ID = "acc-123";

function createBaseCreditStatus(overrides: Partial<{
  syncPending: boolean;
  syncErrorCode: string | null;
}> = {}) {
  return {
    creditLimitAmount: 100000,
    creditLimitPaise: 10000000n,
    exposurePaise: 5000000n,
    draftExposurePaise: 0n,
    availableCreditPaise: 5000000n,
    currency: "INR",
    holdState: "OK" as const,
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
    ...overrides,
  };
}

describe("app.accounts.$id loader syncState", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetCompanyTotals.mockResolvedValue(null);
    mockGetBuyerInvoices.mockResolvedValue({ rows: [], totalCount: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createLoaderArgs(accountId: string = TEST_ACCOUNT_ID): LoaderFunctionArgs {
    return {
      request: new Request("https://example.com/app/accounts/" + accountId),
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
      params: { id: accountId },
    } as unknown as LoaderFunctionArgs;
  }

  function setupBaseMocks(options: {
    syncPending?: boolean;
    syncErrorCode?: string | null;
    hasDeadLetteredSync?: boolean;
  } = {}) {
    const { syncPending = false, syncErrorCode = null, hasDeadLetteredSync = false } = options;

    mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");

      if (query.includes("SELECT id FROM \"Shop\"")) {
        return Promise.resolve([{ id: TEST_SHOP_ID }]);
      }

      if (query.includes("SELECT") && query.includes("FROM \"BuyerAccount\"") && query.includes("WHERE id =")) {
        return Promise.resolve([{
          id: TEST_ACCOUNT_ID,
          name: "Test Account",
          kind: "COMPANY",
          companyId: "gid://shopify/Company/123",
          companyLocationId: "gid://shopify/CompanyLocation/456",
          customerId: null,
          defaultTermsDays: 30,
          defaultTermsSource: "explicit",
          gatedAt: null,
        }]);
      }

      if (query.includes("s6_dead_letter") && query.includes("CREDIT_STATUS_RECOMPUTE")) {
        return Promise.resolve([{ exists: hasDeadLetteredSync }]);
      }

      return Promise.resolve([]);
    });

    mockGetCreditStatusDisplay.mockResolvedValue(createBaseCreditStatus({
      syncPending,
      syncErrorCode,
    }));
  }

  describe("syncState determination", () => {
    it("returns synced when syncPending is false", async () => {
      setupBaseMocks({ syncPending: false, syncErrorCode: null, hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus).not.toBeNull();
      expect(result.creditStatus?.syncState).toBe("synced");
      expect(result.creditStatus?.syncPending).toBe(false);
    });

    it("returns pending_retry when syncPending true, no error, no dead-letter", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus).not.toBeNull();
      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.syncPending).toBe(true);
      expect(result.creditStatus?.syncErrorCode).toBeNull();
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(false);
    });

    it("returns needs_attention when syncPending true with error marker", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "no_session", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus).not.toBeNull();
      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncPending).toBe(true);
      expect(result.creditStatus?.syncErrorCode).toBe("no_session");
    });

    it("returns needs_attention when syncPending true with dead-lettered message", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: true });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus).not.toBeNull();
      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncPending).toBe(true);
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(true);
    });

    it("returns needs_attention when both error marker and dead-lettered", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "access_denied", hasDeadLetteredSync: true });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus).not.toBeNull();
      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorCode).toBe("access_denied");
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(true);
    });
  });

  describe("error marker types", () => {
    it("handles no_session error marker", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "no_session", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorCode).toBe("no_session");
      expect(result.creditStatus?.syncState).toBe("needs_attention");
    });

    it("handles invalid_grant error marker", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "invalid_grant", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorCode).toBe("invalid_grant");
      expect(result.creditStatus?.syncState).toBe("needs_attention");
    });

    it("handles user_error marker", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "user_error", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorCode).toBe("user_error");
      expect(result.creditStatus?.syncState).toBe("needs_attention");
    });
  });

  describe("account not found", () => {
    it("returns null creditStatus when account not found", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT id FROM \"Shop\"")) {
          return Promise.resolve([{ id: TEST_SHOP_ID }]);
        }

        if (query.includes("FROM \"BuyerAccount\"")) {
          return Promise.resolve([]);
        }

        return Promise.resolve([]);
      });

      mockGetCreditStatusDisplay.mockResolvedValue(null);

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs("non-existent"));

      expect(result.creditStatus).toBeNull();
    });
  });
});
