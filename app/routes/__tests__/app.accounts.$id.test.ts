import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";

/**
 * Tests for account detail page sync banner logic (app/routes/app.accounts.$id.tsx).
 *
 * Covers:
 * - Loader correctly determines syncState based on syncPending, error marker, and dead-letter
 * - Three states: "synced", "pending_retry", "needs_attention"
 * - hasDeadLetteredSync flag is set correctly
 * - syncErrorInfo is computed with typed helper (no raw error codes in UI)
 * - Dead-letter query filters: time, shop scope, original_queue
 */

const mockSql = Object.assign(vi.fn(), { 
  unsafe: vi.fn((s) => s),
  json: vi.fn((v) => JSON.stringify(v)),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => undefined),
}));

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
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
import { isAccountActive, isGatingEnforced } from "~/services/gating.server";

const mockGetCreditStatusDisplay = vi.mocked(getCreditStatusDisplay);
const mockGetCompanyTotals = vi.mocked(getCompanyTotals);
const mockGetBuyerInvoices = vi.mocked(getBuyerInvoices);
const mockIsAccountActive = vi.mocked(isAccountActive);
const mockIsGatingEnforced = vi.mocked(isGatingEnforced);

const TEST_SHOP = "test-shop.myshopify.com";
const TEST_SHOP_ID = "shop-123";
const TEST_ACCOUNT_ID = "acc-123";

function createBaseCreditStatus(overrides: Partial<{
  syncPending: boolean;
  syncErrorCode: string | null;
  metafieldSyncedAt: Date | null;
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
    metafieldSyncedAt: null,
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
    metafieldSyncedAt?: Date | null;
    gatedAt?: Date | null;
  } = {}) {
    const { 
      syncPending = false, 
      syncErrorCode = null, 
      hasDeadLetteredSync = false,
      metafieldSyncedAt = null,
      gatedAt = null,
    } = options;

    mockIsAccountActive.mockReturnValue(gatedAt === null);

    mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");

      if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
        return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
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
          gatedAt,
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
      metafieldSyncedAt,
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

  describe("banner render output (syncErrorInfo messages)", () => {
    it("pending_retry shows warning banner message", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.syncErrorInfo).toBeNull();
    });

    it("session error (no_session) shows reinstall message without raw code", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "no_session", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("reopen the app or reinstall");
      expect(result.creditStatus?.syncErrorInfo?.message).not.toContain("no_session");
    });

    it("session error (invalid_grant) shows reinstall message without raw code", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "invalid_grant", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
      expect(result.creditStatus?.syncErrorInfo?.message).not.toContain("invalid_grant");
    });

    it("permission error (access_denied) shows permission message without raw code", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "access_denied", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("permission");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("missing required permissions");
      expect(result.creditStatus?.syncErrorInfo?.message).not.toContain("access_denied");
    });

    it("owner error (owner_not_found) shows entity deleted message without raw code", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "owner_not_found", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("owner");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("no longer exists");
      expect(result.creditStatus?.syncErrorInfo?.message).not.toContain("owner_not_found");
    });

    it("generic error (user_error) shows support message without raw code", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "user_error", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("generic");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("contact support");
      expect(result.creditStatus?.syncErrorInfo?.message).not.toContain("user_error");
    });

    it("dead-letter only (no error code) shows support message", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: true });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("generic");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("multiple failures");
    });

    it("synced state shows no banner (syncErrorInfo is null)", async () => {
      setupBaseMocks({ syncPending: false, syncErrorCode: null, hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("synced");
      expect(result.creditStatus?.syncErrorInfo).toBeNull();
    });
  });

  describe("account not found", () => {
    it("returns null creditStatus when account not found", async () => {
      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
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

  describe("syncErrorInfo typed helper", () => {
    it("returns session category for no_session error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "no_session", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo).not.toBeNull();
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("reopen the app or reinstall");
    });

    it("returns session category for invalid_grant error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "invalid_grant", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
    });

    it("returns session category for token_refresh_failed error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "token_refresh_failed", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
    });

    it("returns session category for no_refresh_token error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "no_refresh_token", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
    });

    it("returns session category for missing_credentials error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "missing_credentials", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
    });

    it("returns permission category for access_denied error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "access_denied", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("permission");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("missing required permissions");
    });

    it("returns owner category for owner_not_found error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "owner_not_found", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("owner");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("no longer exists");
    });

    it("returns generic category for user_error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "user_error", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("generic");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("contact support");
    });

    it("returns generic category for redacted error", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "redacted", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("generic");
    });

    it("returns generic category for unknown error codes", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: "some_unknown_error", hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("generic");
      expect(result.creditStatus?.syncErrorInfo?.message).not.toContain("some_unknown_error");
    });

    it("returns generic category for dead-letter only (no error code)", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: true });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncErrorInfo?.category).toBe("generic");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("multiple failures");
    });

    it("returns null syncErrorInfo when synced state", async () => {
      setupBaseMocks({ syncPending: false, syncErrorCode: null, hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("synced");
      expect(result.creditStatus?.syncErrorInfo).toBeNull();
    });

    it("returns null syncErrorInfo when pending_retry state", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.syncErrorInfo).toBeNull();
    });
  });

  describe("dead-letter query parameters", () => {
    it("passes shop domain to dead-letter query", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: false });
      let capturedShopParam: unknown;

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
        }

        if (query.includes("FROM \"BuyerAccount\"")) {
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

        if (query.includes("s6_dead_letter")) {
          capturedShopParam = values[1];
          return Promise.resolve([{ exists: false }]);
        }

        return Promise.resolve([]);
      });

      const { loader } = await import("../app.accounts.$id");
      await loader(createLoaderArgs());

      expect(capturedShopParam).toBe(TEST_SHOP);
    });

    it("passes metafieldSyncedAt to dead-letter time filter", async () => {
      const syncTime = new Date("2026-10-24T12:00:00Z");
      setupBaseMocks({ 
        syncPending: true, 
        syncErrorCode: null, 
        hasDeadLetteredSync: false,
        metafieldSyncedAt: syncTime,
      });
      let capturedTimeParam: unknown;

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
        }

        if (query.includes("FROM \"BuyerAccount\"")) {
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

        if (query.includes("s6_dead_letter")) {
          capturedTimeParam = values[2];
          return Promise.resolve([{ exists: false }]);
        }

        return Promise.resolve([]);
      });

      const { loader } = await import("../app.accounts.$id");
      await loader(createLoaderArgs());

      expect(capturedTimeParam).toEqual(syncTime);
    });

    it("includes original_queue filter in dead-letter query", async () => {
      setupBaseMocks({ syncPending: true, syncErrorCode: null, hasDeadLetteredSync: false });
      let capturedDeadLetterQuery = "";

      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
        }

        if (query.includes("FROM \"BuyerAccount\"") && !query.includes("reminderOptOutAt")) {
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

        if (query.includes("s6_dead_letter")) {
          capturedDeadLetterQuery = query;
          return Promise.resolve([{ exists: false }]);
        }

        // Handle opt-out status query
        if (query.includes("reminderOptOutAt")) {
          return Promise.resolve([{ optOutAt: null, optOutSource: null }]);
        }

        return Promise.resolve([]);
      });

      const { loader } = await import("../app.accounts.$id");
      await loader(createLoaderArgs());

      expect(capturedDeadLetterQuery).toContain("original_queue = ");
    });
  });

  describe("gated account behavior", () => {
    it("sets isGated true for gated account", async () => {
      const gatedDate = new Date("2026-10-01T00:00:00Z");
      setupBaseMocks({ 
        syncPending: false, 
        syncErrorCode: null, 
        hasDeadLetteredSync: false,
        gatedAt: gatedDate,
      });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.account?.isGated).toBe(true);
    });

    it("sets isGated false for non-gated account", async () => {
      setupBaseMocks({ 
        syncPending: false, 
        syncErrorCode: null, 
        hasDeadLetteredSync: false,
        gatedAt: null,
      });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.account?.isGated).toBe(false);
    });

    it("gated account with syncPending=true still gets banner data when gating enforced", async () => {
      const gatedDate = new Date("2026-10-01T00:00:00Z");
      mockIsGatingEnforced.mockReturnValue(true);
      setupBaseMocks({ 
        syncPending: true, 
        syncErrorCode: "no_session", 
        hasDeadLetteredSync: false,
        gatedAt: gatedDate,
      });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.account?.isGated).toBe(true);
      expect(result.creditStatus?.syncState).toBe("needs_attention");
      expect(result.creditStatus?.syncErrorInfo?.category).toBe("session");
      expect(result.creditStatus?.syncErrorInfo?.message).toContain("reopen the app or reinstall");
      
      mockIsGatingEnforced.mockReturnValue(false);
    });
  });

  describe("cross-shop isolation", () => {
    it("account from different shop returns not found, no credit-status or dead-letter queries", async () => {
      const OTHER_ACCOUNT_ID = "other-shop-acc-999";
      let deadLetterQueryCount = 0;

      mockSql.mockImplementation((strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
        }

        if (query.includes("SELECT") && query.includes("FROM \"BuyerAccount\"") && query.includes("WHERE id =")) {
          return Promise.resolve([]);
        }

        if (query.includes("s6_dead_letter")) {
          deadLetterQueryCount++;
        }

        return Promise.resolve([]);
      });

      mockGetCreditStatusDisplay.mockClear();
      mockGetCreditStatusDisplay.mockResolvedValue(null);

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs(OTHER_ACCOUNT_ID));

      expect(result.error).toBe("Account not found");
      expect(result.account).toBeNull();
      expect(result.creditStatus).toBeNull();

      expect(mockGetCreditStatusDisplay).not.toHaveBeenCalled();
      expect(deadLetterQueryCount).toBe(0);
    });
  });

  describe("old dead-letter row (time filter)", () => {
    it("passes metafieldSyncedAt to time filter, old row gives pending_retry", async () => {
      const syncTime = new Date("2026-10-24T12:00:00Z");
      let capturedTimeParam: unknown;

      mockIsAccountActive.mockReturnValue(true);

      mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
          return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
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

        if (query.includes("s6_dead_letter")) {
          capturedTimeParam = values[2];
          return Promise.resolve([{ exists: false }]);
        }

        return Promise.resolve([]);
      });

      mockGetCreditStatusDisplay.mockResolvedValue(createBaseCreditStatus({
        syncPending: true,
        syncErrorCode: null,
        metafieldSyncedAt: syncTime,
      }));

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(capturedTimeParam).toEqual(syncTime);

      expect(result.creditStatus?.syncState).toBe("pending_retry");
      expect(result.creditStatus?.hasDeadLetteredSync).toBe(false);
    });
  });

  describe("upgradeUrl in loader", () => {
    const originalAppHandle = process.env.APP_HANDLE;

    beforeEach(() => {
      process.env.APP_HANDLE = "net-terms-receivables-1";
    });

    afterEach(() => {
      process.env.APP_HANDLE = originalAppHandle;
    });

    it("returns upgradeUrl in loader data", async () => {
      setupBaseMocks({ syncPending: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.upgradeUrl).toBeDefined();
      expect(result.upgradeUrl).toContain("https://admin.shopify.com/store/");
      expect(result.upgradeUrl).toContain("/charges/");
      expect(result.upgradeUrl).toContain("/pricing_plans");
    });

    it("upgradeUrl uses shop domain to derive store handle", async () => {
      setupBaseMocks({ syncPending: false });

      const { loader } = await import("../app.accounts.$id");
      const result = await loader(createLoaderArgs());

      expect(result.upgradeUrl).toContain("test-shop");
    });
  });
});

import { updateCreditStatus } from "~/services/credit-status.server";
const mockUpdateCreditStatus = vi.mocked(updateCreditStatus);

interface ActionResultData {
  ok?: boolean;
  success: boolean;
  error?: string;
  upgradeRequired?: boolean;
  code?: string;
}

function extractActionData(result: unknown): ActionResultData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: ActionResultData }).data;
  }
  return result as ActionResultData;
}

function extractStatus(result: unknown): number | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init: { status?: number } | null }).init;
    return init?.status;
  }
  return undefined;
}

describe("app.accounts.$id action gated credit edit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateCreditStatus.mockResolvedValue({ success: true });
  });

  function createActionArgs(
    accountId: string,
    formData: FormData
  ) {
    return {
      request: new Request("https://example.com/app/accounts/" + accountId, {
        method: "POST",
        body: formData,
      }),
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
    } as unknown;
  }

  function setupActionMocks(options: {
    gatedAt?: Date | null;
    gatingEnforced?: boolean;
  } = {}) {
    const { gatedAt = null, gatingEnforced = false } = options;

    mockIsGatingEnforced.mockReturnValue(gatingEnforced);
    mockIsAccountActive.mockReturnValue(gatedAt === null || !gatingEnforced);

    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("SELECT") && query.includes("FROM \"Shop\"") && query.includes("WHERE domain")) {
        return Promise.resolve([{ id: TEST_SHOP_ID, currency: "INR" }]);
      }

      if (query.includes("SELECT id, gated_at") && query.includes("FROM \"BuyerAccount\"")) {
        return Promise.resolve([{
          id: TEST_ACCOUNT_ID,
          gatedAt,
        }]);
      }

      return Promise.resolve([]);
    });
  }

  describe("gated account credit edit rejection", () => {
    it("returns 403 with upgradeRequired=true when gating enforced and credit edit attempted on gated account", async () => {
      const gatedDate = new Date("2026-10-01T00:00:00Z");
      setupActionMocks({ gatedAt: gatedDate, gatingEnforced: true });

      const { action } = await import("../app.accounts.$id");

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "50000");

      const result = await action(createActionArgs(TEST_ACCOUNT_ID, formData) as never);

      const status = extractStatus(result);
      expect(status).toBe(403);

      const data = extractActionData(result);
      expect(data.ok).toBe(false);
      expect(data.success).toBe(false);
      expect(data.upgradeRequired).toBe(true);
      expect(data.code).toBe("plan_limit_account_gated");
      expect(data.error).toContain("plan limit");
    });

    it("does not call updateCreditStatus when gated account attempts credit edit", async () => {
      const gatedDate = new Date("2026-10-01T00:00:00Z");
      setupActionMocks({ gatedAt: gatedDate, gatingEnforced: true });

      const { action } = await import("../app.accounts.$id");

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "50000");

      await action(createActionArgs(TEST_ACCOUNT_ID, formData) as never);

      expect(mockUpdateCreditStatus).not.toHaveBeenCalled();
    });
  });

  describe("gated account hold-only update succeeds", () => {
    it("allows hold-only update for gated account", async () => {
      const gatedDate = new Date("2026-10-01T00:00:00Z");
      setupActionMocks({ gatedAt: gatedDate, gatingEnforced: true });

      const { action } = await import("../app.accounts.$id");

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("holdOnly", "true");
      formData.set("manualHold", "true");
      formData.set("holdReasonCode", "MANUAL_HOLD");

      const result = await action(createActionArgs(TEST_ACCOUNT_ID, formData) as never);

      const status = extractStatus(result);
      expect(status).toBeUndefined(); // 200 OK returns undefined status

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      expect(mockUpdateCreditStatus).toHaveBeenCalledWith(
        expect.anything(),
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          manualHold: true,
          holdReasonCode: "MANUAL_HOLD",
        })
      );
    });
  });

  describe("non-gated account credit edit succeeds", () => {
    it("allows credit edit for non-gated account", async () => {
      setupActionMocks({ gatedAt: null, gatingEnforced: true });

      const { action } = await import("../app.accounts.$id");

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "50000");

      const result = await action(createActionArgs(TEST_ACCOUNT_ID, formData) as never);

      const status = extractStatus(result);
      expect(status).toBeUndefined(); // 200 OK

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      expect(mockUpdateCreditStatus).toHaveBeenCalledWith(
        expect.anything(),
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          creditLimitAmount: 50000,
        })
      );
    });
  });

  describe("gating flag OFF allows gated_at account edit", () => {
    it("allows credit edit when gating flag is OFF even if account has gated_at set", async () => {
      const gatedDate = new Date("2026-10-01T00:00:00Z");
      setupActionMocks({ gatedAt: gatedDate, gatingEnforced: false });

      const { action } = await import("../app.accounts.$id");

      const formData = new FormData();
      formData.set("_action", "updateCredit");
      formData.set("creditLimit", "75000");

      const result = await action(createActionArgs(TEST_ACCOUNT_ID, formData) as never);

      const status = extractStatus(result);
      expect(status).toBeUndefined(); // 200 OK

      const data = extractActionData(result);
      expect(data.success).toBe(true);

      expect(mockUpdateCreditStatus).toHaveBeenCalledWith(
        expect.anything(),
        TEST_ACCOUNT_ID,
        expect.objectContaining({
          creditLimitAmount: 75000,
        })
      );
    });
  });
});
