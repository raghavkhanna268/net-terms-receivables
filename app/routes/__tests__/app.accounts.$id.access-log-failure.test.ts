/**
 * Route-level test: access log insert failure does not break the loader.
 *
 * Tests that when the AuditEvent INSERT fails:
 * - The loader still returns normal data
 * - Exactly one access_log_insert_failed log entry is emitted with no error text
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockSql = vi.fn();

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => undefined),
}));

vi.mock("~/services/gating.server", () => ({
  isAccountActive: vi.fn().mockReturnValue(true),
  isGatingEnforced: vi.fn().mockReturnValue(false),
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 0, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getBuyerInvoices: vi.fn().mockResolvedValue({ rows: [], totalCount: 0 }),
}));

vi.mock("~/services/credit-status.server", () => ({
  getCreditStatusDisplay: vi.fn().mockResolvedValue({
    creditLimitAmount: 100000,
    creditLimitPaise: 10000000n,
    exposurePaise: 0n,
    draftExposurePaise: 0n,
    availableCreditPaise: 10000000n,
    currency: "INR",
    holdState: "OK",
    manualHold: false,
    holdReasonCode: null,
    holdNote: null,
    isOnHold: false,
    holdReasonDisplay: null,
    isOverLimit: false,
    isOverdue: false,
    utilizationPercent: 0,
    syncPending: false,
    syncErrorCode: null,
    metafieldSyncedAt: null,
  }),
  getCompanyTotals: vi.fn().mockResolvedValue(null),
  updateCreditStatus: vi.fn(),
  parseCreditLimitString: vi.fn().mockReturnValue({ valid: true, value: 0 }),
}));

vi.mock("~/services/reminder-optout.server", () => ({
  getBuyerOptOutStatus: vi.fn().mockResolvedValue(null),
  setBuyerOptOut: vi.fn(),
  clearBuyerOptOut: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("app.accounts.$id access log failure", () => {
  const TEST_SHOP_ID = "shop-test-123";
  const TEST_SHOP_DOMAIN = "test-shop.example.com";
  const TEST_ACCOUNT_ID = "acc-test-456";

  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    (mockSql as unknown as { json: (data: unknown) => string }).json = (data: unknown) =>
      JSON.stringify(data);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function createLoaderArgs() {
    const url = new URL("https://example.com/app/accounts/" + TEST_ACCOUNT_ID);
    return {
      request: new Request(url),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP_DOMAIN },
              sessionToken: { sub: "12345" },
            }),
          },
        },
      },
      params: { id: TEST_ACCOUNT_ID },
      url,
      pattern: "/app/accounts/:id",
    } as unknown;
  }

  it("loader returns normal data when AuditEvent insert fails", async () => {
    let insertCallCount = 0;

    mockSql.mockImplementation(async (strings: TemplateStringsArray) => {
      const query = strings.join("");

      if (query.includes('FROM "Shop"')) {
        return [{ id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" }];
      }

      if (query.includes('FROM "BuyerAccount"')) {
        return [{
          id: TEST_ACCOUNT_ID,
          shopId: TEST_SHOP_ID,
          kind: "COMPANY",
          companyId: "co-123",
          companyLocationId: "loc-456",
          name: "Test Company",
          creditLimit: "100000.00",
          holdState: "OK",
          bypass: false,
          syncPending: false,
          metafieldSyncedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }];
      }

      if (query.includes('INSERT INTO "AuditEvent"')) {
        insertCallCount++;
        throw new Error("Simulated database failure for audit event");
      }

      return [];
    });

    const { loader } = await import("../app.accounts.$id");
    const result = await loader(createLoaderArgs() as never);

    expect(result).toBeDefined();
    expect(result.error).toBeNull();
    expect(result.account).toBeDefined();
    expect(result.account?.id).toBe(TEST_ACCOUNT_ID);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(insertCallCount).toBe(1);

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logOutput = consoleErrorSpy.mock.calls[0][0] as string;

    expect(logOutput).toContain('"event":"access_log_insert_failed"');
    expect(logOutput).toContain('"shopId":"shop-test-123"');
    expect(logOutput).toContain('"topic":"access.accounts_detail"');

    expect(logOutput).not.toContain("Simulated database failure");
    expect(logOutput).not.toContain("Error");
    expect(logOutput).not.toContain("@");
    expect(logOutput).not.toContain("myshopify");
  });
});
