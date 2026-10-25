import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for credit-status.server.ts (S11).
 *
 * Tests verify:
 * 1. Credit status computation from DB values
 * 2. metafieldsSet mutation variables shape
 * 3. Error handling for userErrors
 * 4. Sync-pending flag when metafield write fails
 * 5. DB-backed integration test for persistence
 */

const mockShopifyGraphQLRequest = vi.fn();

vi.mock("../shopify-client.server", () => {
  return {
    shopifyGraphQLRequest: (...args: unknown[]) => mockShopifyGraphQLRequest(...args),
  };
});

const createMockSql = () => {
  const mockResults: Map<string, unknown[]> = new Map();

  const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");

    if (query.includes('FROM "Shop"') && query.includes("domain")) {
      return mockResults.get("shop") ?? [];
    }

    if (query.includes('FROM "Shop"') && query.includes("currency")) {
      return mockResults.get("shop_currency") ?? [];
    }

    if (query.includes('FROM "BuyerAccount"') && query.includes("companyId")) {
      return mockResults.get("company_locations") ?? [];
    }

    if (query.includes('FROM "BuyerAccount"')) {
      return mockResults.get("account") ?? [];
    }

    if (query.includes('UPDATE "BuyerAccount"') && query.includes('syncPending') && query.includes('syncVersion') && !query.includes('syncVersion" + 1')) {
      // This is the clear query: SET syncPending=false WHERE syncVersion=?
      return mockResults.get("clear_sync_pending") ?? [{ id: "acc-123" }];
    }

    if (query.includes('UPDATE "BuyerAccount"') && query.includes('RETURNING')) {
      return mockResults.get("update_account_returning") ?? [{ syncVersion: 1, id: "acc-123" }];
    }

    if (query.includes('UPDATE "BuyerAccount"')) {
      return mockResults.get("update_account") ?? [{ count: 1 }];
    }

    if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
      return mockResults.get("invoice_exposure") ?? [{ total_paise: "0" }];
    }

    if (query.includes("s8_draft_orders") && query.includes("SUM")) {
      return mockResults.get("draft_exposure") ?? [{ total_paise: "0" }];
    }

    if (query.includes("EXISTS") && query.includes("dueAt")) {
      return mockResults.get("overdue_check") ?? [{ has_overdue: false }];
    }

    return [];
  };

  const createTxMock = () => {
    const tx = Object.assign(
      vi.fn(queryHandler),
      {
        json: vi.fn((v) => v),
        array: vi.fn((arr: unknown[]) => arr),
      }
    );
    return tx;
  };

  const sql = Object.assign(
    vi.fn(queryHandler),
    {
      json: vi.fn((v) => v),
      array: vi.fn((arr: unknown[]) => arr),
      begin: vi.fn(async <T>(fn: (tx: typeof sql) => Promise<T>): Promise<T> => {
        const tx = createTxMock();
        return fn(tx as unknown as typeof sql);
      }),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
      clearMockResults: () => mockResults.clear(),
    }
  ) as unknown as Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
    begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  };

  return sql;
};

describe("credit-status.server", () => {
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql = createMockSql();
    mockShopifyGraphQLRequest.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("computeHoldState", () => {
    it("returns BYPASS with hold:false when bypass is true", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: true,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 0n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("BYPASS");
      expect(result.metafieldHold).toBe(false);
      expect(result.holdReasonCode).toBeNull();
    });

    it("returns BYPASS even when manualHold is true (bypass takes precedence)", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: true,
        manualHold: true,
        isOverLimit: true,
        isOverdue: true,
        exposurePaise: 100000n,
        limitPaise: 50000n,
      });

      expect(result.holdState).toBe("BYPASS");
      expect(result.metafieldHold).toBe(false);
    });

    it("returns HELD with hold:true when manualHold is true", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState(
        {
          bypass: false,
          manualHold: true,
          isOverLimit: false,
          isOverdue: false,
          exposurePaise: 0n,
          limitPaise: 100000n,
        },
        "MANUAL_HOLD"
      );

      expect(result.holdState).toBe("HELD");
      expect(result.metafieldHold).toBe(true);
      expect(result.holdReasonCode).toBe("MANUAL_HOLD");
    });

    it("returns HELD with reason code from manualHoldReasonCode", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState(
        {
          bypass: false,
          manualHold: true,
          isOverLimit: false,
          isOverdue: false,
          exposurePaise: 0n,
          limitPaise: 100000n,
        },
        "FRAUD_SUSPECTED"
      );

      expect(result.holdState).toBe("HELD");
      expect(result.holdReasonCode).toBe("FRAUD_SUSPECTED");
    });

    it("returns HELD with CREDIT_REVIEW when isOverLimit is true", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: true,
        isOverdue: false,
        exposurePaise: 110000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("HELD");
      expect(result.metafieldHold).toBe(true);
      expect(result.holdReasonCode).toBe("CREDIT_REVIEW");
    });

    it("returns HELD with PAYMENT_OVERDUE when isOverdue is true", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: false,
        isOverdue: true,
        exposurePaise: 50000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("HELD");
      expect(result.metafieldHold).toBe(true);
      expect(result.holdReasonCode).toBe("PAYMENT_OVERDUE");
    });

    it("returns NEAR_LIMIT at exactly 80% utilization", async () => {
      const { computeHoldState, NEAR_LIMIT_THRESHOLD } = await import("../credit-status.server");

      expect(NEAR_LIMIT_THRESHOLD).toBe(0.8);

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 80000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("NEAR_LIMIT");
      expect(result.metafieldHold).toBe(false);
      expect(result.holdReasonCode).toBeNull();
    });

    it("returns OK at 79% utilization (below threshold)", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 79000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("OK");
      expect(result.metafieldHold).toBe(false);
    });

    it("returns NEAR_LIMIT at 100% utilization (not over limit)", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 100000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("NEAR_LIMIT");
      expect(result.metafieldHold).toBe(false);
    });

    it("no-limit account never gets NEAR_LIMIT", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 1000000000n,
        limitPaise: null,
      });

      expect(result.holdState).toBe("OK");
      expect(result.metafieldHold).toBe(false);
    });

    it("bypass overrides NEAR_LIMIT", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: true,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 90000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("BYPASS");
      expect(result.metafieldHold).toBe(false);
    });

    it("HELD overrides NEAR_LIMIT", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState(
        {
          bypass: false,
          manualHold: true,
          isOverLimit: false,
          isOverdue: false,
          exposurePaise: 90000n,
          limitPaise: 100000n,
        },
        "MANUAL_HOLD"
      );

      expect(result.holdState).toBe("HELD");
      expect(result.metafieldHold).toBe(true);
    });

    it("returns OK when no conditions apply", async () => {
      const { computeHoldState } = await import("../credit-status.server");

      const result = computeHoldState({
        bypass: false,
        manualHold: false,
        isOverLimit: false,
        isOverdue: false,
        exposurePaise: 50000n,
        limitPaise: 100000n,
      });

      expect(result.holdState).toBe("OK");
      expect(result.metafieldHold).toBe(false);
    });
  });

  describe("validation", () => {
    it("rejects Infinity credit limit", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: Infinity,
        manualHold: false,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not Infinity or NaN");
    });

    it("rejects NaN credit limit", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: NaN,
        manualHold: false,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not Infinity or NaN");
    });

    it("rejects credit limit exceeding MAX_CREDIT_LIMIT_AMOUNT", async () => {
      const { updateCreditStatus, MAX_CREDIT_LIMIT_AMOUNT } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: MAX_CREDIT_LIMIT_AMOUNT + 1,
        manualHold: false,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot exceed");
    });

    it("rejects invalid holdReasonCode", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: true,
        holdReasonCode: "INVALID_CODE" as "MANUAL_HOLD",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid holdReasonCode");
    });

    it("accepts valid holdReasonCode", async () => {
      const { VALID_HOLD_REASON_CODES } = await import("../credit-status.server");

      expect(VALID_HOLD_REASON_CODES).toContain("MANUAL_HOLD");
      expect(VALID_HOLD_REASON_CODES).toContain("PAYMENT_OVERDUE");
      expect(VALID_HOLD_REASON_CODES).toContain("CREDIT_REVIEW");
      expect(VALID_HOLD_REASON_CODES).toContain("NEW_ACCOUNT");
      expect(VALID_HOLD_REASON_CODES).toContain("FRAUD_SUSPECTED");
    });

    it("requires explicit noLimit flag to set null credit limit", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: null,
        noLimit: false,
        manualHold: false,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
    });

    it("allows null credit limit when noLimit is true", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      });

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: null,
        noLimit: true,
        manualHold: false,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(true);
    });

    it("allows transition from no-limit to limit", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: null,
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 50000,
        noLimit: false,
        manualHold: false,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(true);

      const [, , variables] = mockShopifyGraphQLRequest.mock.calls[0];
      const metafieldValue = JSON.parse(variables.metafields[0].value);
      expect(metafieldValue.limitPaise).toBe("5000000");
    });


    it("requires holdReasonCode when manualHold is true", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: true,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("holdReasonCode is required");
    });

    it("uses provided holdReasonCode for manual hold", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: true,
        holdReasonCode: "FRAUD_SUSPECTED",
      });

      expect(result.success).toBe(true);

      const [, , variables] = mockShopifyGraphQLRequest.mock.calls[0];
      const metafieldValue = JSON.parse(variables.metafields[0].value);
      expect(metafieldValue.hold).toBe(true);
      expect(metafieldValue.holdReasonCode).toBe("FRAUD_SUSPECTED");
    });

    it("metafield is written outside transaction (syncPending=true survives metafield failure)", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: false,
        error: "Network timeout",
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(true);
      expect(result.metafieldSyncPending).toBe(true);
      expect(result.error).toBe("metafield_sync_failed");
    });

    it("clears syncPending on successful metafield write", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: true,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(true);
      expect(result.metafieldSyncPending).toBe(false);
    });

    it("sets metafieldSyncPending and returns userErrors when metafield has userErrors", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: null,
            userErrors: [
              { field: ["metafields", "0", "value"], message: "Invalid JSON" },
            ],
          },
        },
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(true);
      expect(result.metafieldSyncPending).toBe(true);
      expect(result.userErrors).toHaveLength(1);
      expect(result.userErrors?.[0].message).toBe("Invalid JSON");
    });
  });

  describe("updateCreditStatus", () => {
    it("validates that holdReasonCode is required when manualHold is true", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: true,
        holdReasonCode: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("holdReasonCode is required");
    });

    it("validates credit limit is non-negative", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: -1000,
        manualHold: false,
        holdReasonCode: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("must be >= 0");
    });

    it("returns error when account not found", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", []);

      const result = await updateCreditStatus(mockSql, "nonexistent", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("succeeds for gated accounts (gating applies only to value-add actions)", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/123",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: new Date(),
      }]);
      mockSql.setMockResult("shop", [{ domain: "test-gated.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: null,
      });

      // Gated accounts can now have their credit status updated
      // (gating only applies to value-add actions like reminders, not holds)
      expect(result.success).toBe(true);
    });

    it("calls metafieldsSet with correct variables for COMPANY account", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "5000000" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123", namespace: "$app", key: "credit_status" }],
            userErrors: [],
          },
        },
      });

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(true);
      expect(mockShopifyGraphQLRequest).toHaveBeenCalledTimes(1);

      const [shopDomain, _mutation, variables] = mockShopifyGraphQLRequest.mock.calls[0];
      expect(shopDomain).toBe("test.myshopify.com");
      expect(variables.metafields[0].ownerId).toBe("gid://shopify/CompanyLocation/456");
      expect(variables.metafields[0].namespace).toBe("$app");
      expect(variables.metafields[0].key).toBe("credit_status");
      expect(variables.metafields[0].type).toBe("json");

      const metafieldValue = JSON.parse(variables.metafields[0].value);
      expect(metafieldValue.schemaVersion).toBe(1);
      expect(metafieldValue.currencyCode).toBe("INR");
      expect(metafieldValue.hold).toBe(false);
      expect(metafieldValue.limitPaise).toBe("10000000");
    });

    it("calls metafieldsSet with Customer owner for TAGGED_CUSTOMER account", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-456",
        shopId: "shop-123",
        kind: "TAGGED_CUSTOMER",
        companyLocationId: null,
        customerId: "gid://shopify/Customer/789",
        creditLimit: null,
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/456", namespace: "$app", key: "credit_status" }],
            userErrors: [],
          },
        },
      });

      const result = await updateCreditStatus(mockSql, "acc-456", {
        creditLimitAmount: null,
        noLimit: true,
        manualHold: true,
        holdReasonCode: "MANUAL_HOLD",
      });

      expect(result.success).toBe(true);

      const [_shopDomain, _mutation, variables] = mockShopifyGraphQLRequest.mock.calls[0];
      expect(variables.metafields[0].ownerId).toBe("gid://shopify/Customer/789");

      const metafieldValue = JSON.parse(variables.metafields[0].value);
      expect(metafieldValue.hold).toBe(true);
      expect(metafieldValue.holdReasonCode).toBe("MANUAL_HOLD");
    });

  });

  describe("getCreditStatusDisplay", () => {
    it("computes utilization percentage correctly", async () => {
      const { getCreditStatusDisplay } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop_currency", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "5000000" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "2500000" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      const status = await getCreditStatusDisplay(mockSql, "acc-123");

      expect(status).not.toBeNull();
      expect(status?.utilizationPercent).toBe(75);
      expect(status?.isOnHold).toBe(false);
      expect(status?.isOverLimit).toBe(false);
    });

    it("includes draft order exposure in total", async () => {
      const { getCreditStatusDisplay } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop_currency", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "8000000" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "3000000" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      const status = await getCreditStatusDisplay(mockSql, "acc-123");

      expect(status).not.toBeNull();
      expect(status?.exposurePaise.toString()).toBe("11000000");
      expect(status?.isOverLimit).toBe(true);
      expect(status?.isOnHold).toBe(true);
      expect(status?.holdReasonDisplay).toBe("Over credit limit");
    });

    it("returns null for non-existent account", async () => {
      const { getCreditStatusDisplay } = await import("../credit-status.server");

      mockSql.setMockResult("account", []);

      const status = await getCreditStatusDisplay(mockSql, "nonexistent");

      expect(status).toBeNull();
    });
  });

  describe("getCompanyTotals", () => {
    it("returns null for null companyId", async () => {
      const { getCompanyTotals } = await import("../credit-status.server");

      const totals = await getCompanyTotals(mockSql, "", "shop-123");

      expect(totals).toBeNull();
    });

    it("returns null when no locations found", async () => {
      const { getCompanyTotals } = await import("../credit-status.server");

      mockSql.setMockResult("company_locations", []);

      const totals = await getCompanyTotals(mockSql, "co-123", "shop-123");

      expect(totals).toBeNull();
    });
  });

  describe("syncVersion race condition handling", () => {
    it("leaves syncPending=true when syncVersion mismatch (simulates older write finishing last)", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      // This test verifies the key behavior: when a write tries to clear syncPending
      // but the syncVersion doesn't match (because a newer write incremented it),
      // syncPending should remain true.

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);
      // Transaction returns syncVersion=1
      mockSql.setMockResult("update_account_returning", [{ syncVersion: 1 }]);
      // Simulate: syncPending clear returns 0 rows (version mismatch)
      mockSql.setMockResult("clear_sync_pending", []);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      }));

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(true);
      // syncPending should stay true because the clear returned 0 rows
      expect(result.metafieldSyncPending).toBe(true);
    });

    it("clears syncPending when syncVersion matches (happy path)", async () => {
      const { updateCreditStatus } = await import("../credit-status.server");

      mockSql.setMockResult("account", [{
        id: "acc-123",
        shopId: "shop-123",
        kind: "COMPANY",
        companyLocationId: "gid://shopify/CompanyLocation/456",
        customerId: null,
        creditLimit: "100000",
        holdState: "OK",
        bypass: false,
        manualHold: false,
        holdReasonCode: null,
        holdNote: null,
        syncPending: false,
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockImplementation(() => Promise.resolve({
        success: true,
        data: {
          metafieldsSet: {
            metafields: [{ id: "gid://shopify/Metafield/123" }],
            userErrors: [],
          },
        },
      }));

      // Single write - syncVersion should match and clear syncPending
      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: undefined,
      });

      expect(result.success).toBe(true);
      expect(result.metafieldSyncPending).toBe(false);
    });
  });
});

// DB-backed integration tests moved to credit-status-db.test.ts
// to avoid vitest mock hoisting issues

describe("getOwnerGid", () => {
  it("returns CompanyLocation GID for COMPANY with companyLocationId", async () => {
    const { getOwnerGid } = await import("../credit-status.server");

    const result = getOwnerGid({
      kind: "COMPANY",
      companyLocationId: "gid://shopify/CompanyLocation/123",
      customerId: null,
    });

    expect(result).toEqual({
      gid: "gid://shopify/CompanyLocation/123",
      type: "CompanyLocation",
    });
  });

  it("returns Customer GID for TAGGED_CUSTOMER with customerId", async () => {
    const { getOwnerGid } = await import("../credit-status.server");

    const result = getOwnerGid({
      kind: "TAGGED_CUSTOMER",
      companyLocationId: null,
      customerId: "gid://shopify/Customer/456",
    });

    expect(result).toEqual({
      gid: "gid://shopify/Customer/456",
      type: "Customer",
    });
  });

  it("returns null for COMPANY with null companyLocationId (no-owner)", async () => {
    const { getOwnerGid } = await import("../credit-status.server");

    const result = getOwnerGid({
      kind: "COMPANY",
      companyLocationId: null,
      customerId: null,
    });

    expect(result).toBeNull();
  });

  it("returns null for TAGGED_CUSTOMER with null customerId (no-owner)", async () => {
    const { getOwnerGid } = await import("../credit-status.server");

    const result = getOwnerGid({
      kind: "TAGGED_CUSTOMER",
      companyLocationId: null,
      customerId: null,
    });

    expect(result).toBeNull();
  });

  it("returns null for COMPANY with customerId but no companyLocationId (kind/owner mismatch)", async () => {
    const { getOwnerGid } = await import("../credit-status.server");

    const result = getOwnerGid({
      kind: "COMPANY",
      companyLocationId: null,
      customerId: "gid://shopify/Customer/789",
    });

    expect(result).toBeNull();
  });

  it("returns null for TAGGED_CUSTOMER with companyLocationId but no customerId (kind/owner mismatch)", async () => {
    const { getOwnerGid } = await import("../credit-status.server");

    const result = getOwnerGid({
      kind: "TAGGED_CUSTOMER",
      companyLocationId: "gid://shopify/CompanyLocation/101",
      customerId: null,
    });

    expect(result).toBeNull();
  });
});

describe("syncCreditStatusMetafield no-owner branch", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let mockSql: Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
    begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  };

  const NO_OWNER_ACCOUNT_ID = "acc-noowner-unit-test";
  const NO_OWNER_SHOP_ID = "shop-noowner-unit-test";

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockShopifyGraphQLRequest.mockClear();
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-1" }], userErrors: [] } },
    });

    const mockResults: Map<string, unknown[]> = new Map();

    const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");

      if (query.includes('FROM "Shop"') && query.includes("domain")) {
        return mockResults.get("shop") ?? [];
      }

      if (query.includes('FROM "BuyerAccount"')) {
        return mockResults.get("account") ?? [];
      }

      if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) {
        return mockResults.get("update_account_returning") ?? [{ syncVersion: 1 }];
      }

      if (query.includes('INSERT INTO "AuditEvent"')) {
        return [];
      }

      if (query.includes('FROM "Invoice"') && query.includes("SUM")) {
        return mockResults.get("invoice_exposure") ?? [{ total_paise: "0" }];
      }

      if (query.includes("s8_draft_orders") && query.includes("SUM")) {
        return mockResults.get("draft_exposure") ?? [{ total_paise: "0" }];
      }

      if (query.includes("EXISTS") && query.includes("dueAt")) {
        return mockResults.get("overdue_check") ?? [{ has_overdue: false }];
      }

      return [];
    };

    const createTxMock = () => {
      const tx = Object.assign(vi.fn(queryHandler), {
        json: vi.fn((v) => v),
        array: vi.fn((arr: unknown[]) => arr),
      });
      return tx;
    };

    mockSql = Object.assign(vi.fn(queryHandler), {
      json: vi.fn((v) => v),
      array: vi.fn((arr: unknown[]) => arr),
      begin: vi.fn(async <T>(fn: (tx: typeof mockSql) => Promise<T>): Promise<T> => {
        const tx = createTxMock();
        return fn(tx as unknown as typeof mockSql);
      }),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
      clearMockResults: () => mockResults.clear(),
    }) as unknown as typeof mockSql;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("no-owner account: holdState persisted, syncVersion bumped, metafieldSyncedAt untouched, no Shopify write", async () => {
    const { syncCreditStatusMetafield } = await import("../credit-status.server");

    mockSql.setMockResult("account", [{
      id: NO_OWNER_ACCOUNT_ID,
      shopId: NO_OWNER_SHOP_ID,
      kind: "COMPANY",
      companyLocationId: null,
      customerId: null,
      creditLimit: "100000",
      holdState: "OK",
      bypass: false,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      syncPending: true,
      gatedAt: null,
    }]);
    mockSql.setMockResult("shop", [{ domain: "noowner.myshopify.com", currency: "INR" }]);
    mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("overdue_check", [{ has_overdue: true }]);
    mockSql.setMockResult("update_account_returning", [{ syncVersion: 1 }]);

    const result = await syncCreditStatusMetafield(mockSql, NO_OWNER_ACCOUNT_ID, "daily_sweep");

    expect(result.success).toBe(true);
    expect(result.metafieldSyncPending).toBe(false);
    expect(result.noOwner).toBe(true);
    expect(mockShopifyGraphQLRequest).not.toHaveBeenCalled();
  });

  it("no-owner effective hold change: exactly ONE warn log with correct payload", async () => {
    const { syncCreditStatusMetafield } = await import("../credit-status.server");

    mockSql.setMockResult("account", [{
      id: NO_OWNER_ACCOUNT_ID,
      shopId: NO_OWNER_SHOP_ID,
      kind: "COMPANY",
      companyLocationId: null,
      customerId: null,
      creditLimit: "100000",
      holdState: "OK",
      bypass: false,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      syncPending: true,
      gatedAt: null,
    }]);
    mockSql.setMockResult("shop", [{ domain: "noowner.myshopify.com", currency: "INR" }]);
    mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("overdue_check", [{ has_overdue: true }]);
    mockSql.setMockResult("update_account_returning", [{ syncVersion: 1 }]);

    await syncCreditStatusMetafield(mockSql, NO_OWNER_ACCOUNT_ID, "daily_sweep");

    const warnCalls = consoleSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("credit_status_no_owner")
    );
    expect(warnCalls.length).toBe(1);

    const logPayload = JSON.parse(warnCalls[0][0] as string);
    expect(logPayload).toEqual({
      event: "credit_status_no_owner",
      buyerAccountId: NO_OWNER_ACCOUNT_ID,
      ownerType: "CompanyLocation",
    });
  });

  it("no-owner no effective hold change (no-op): ZERO warn logs", async () => {
    const { syncCreditStatusMetafield } = await import("../credit-status.server");

    mockSql.setMockResult("account", [{
      id: NO_OWNER_ACCOUNT_ID,
      shopId: NO_OWNER_SHOP_ID,
      kind: "COMPANY",
      companyLocationId: null,
      customerId: null,
      creditLimit: "100000",
      holdState: "OK",
      bypass: false,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      syncPending: true,
      gatedAt: null,
    }]);
    mockSql.setMockResult("shop", [{ domain: "noowner.myshopify.com", currency: "INR" }]);
    mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);
    mockSql.setMockResult("update_account_returning", [{ syncVersion: 1 }]);

    await syncCreditStatusMetafield(mockSql, NO_OWNER_ACCOUNT_ID, "daily_sweep");

    const warnCalls = consoleSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("credit_status_no_owner")
    );
    expect(warnCalls.length).toBe(0);
  });

  it("no-owner TAGGED_CUSTOMER: ownerType is Customer in log", async () => {
    const { syncCreditStatusMetafield } = await import("../credit-status.server");

    mockSql.setMockResult("account", [{
      id: NO_OWNER_ACCOUNT_ID,
      shopId: NO_OWNER_SHOP_ID,
      kind: "TAGGED_CUSTOMER",
      companyLocationId: null,
      customerId: null,
      creditLimit: "100000",
      holdState: "OK",
      bypass: false,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      syncPending: true,
      gatedAt: null,
    }]);
    mockSql.setMockResult("shop", [{ domain: "noowner.myshopify.com", currency: "INR" }]);
    mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
    mockSql.setMockResult("overdue_check", [{ has_overdue: true }]);
    mockSql.setMockResult("update_account_returning", [{ syncVersion: 1 }]);

    await syncCreditStatusMetafield(mockSql, NO_OWNER_ACCOUNT_ID, "daily_sweep");

    const warnCalls = consoleSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("credit_status_no_owner")
    );
    expect(warnCalls.length).toBe(1);

    const logPayload = JSON.parse(warnCalls[0][0] as string);
    expect(logPayload.ownerType).toBe("Customer");
  });
});

describe("recomputeCreditStatus no-owner branch", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockShopifyGraphQLRequest.mockClear();
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-1" }], userErrors: [] } },
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("no-owner account returns metafieldWritten:false and noOwner:true", async () => {
    const { recomputeCreditStatus } = await import("../credit-status-recompute.server");

    const mockResults: Map<string, unknown[]> = new Map();
    const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes('FROM "BuyerAccount"')) return mockResults.get("account") ?? [];
      if (query.includes('FROM "Shop"')) return mockResults.get("shop") ?? [];
      if (query.includes('FROM "Invoice"') && query.includes("SUM")) return mockResults.get("invoice_exposure") ?? [{ total_paise: "0" }];
      if (query.includes("s8_draft_orders") && query.includes("SUM")) return mockResults.get("draft_exposure") ?? [{ total_paise: "0" }];
      if (query.includes("EXISTS") && query.includes("dueAt")) return mockResults.get("overdue_check") ?? [{ has_overdue: false }];
      if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) return [{ syncVersion: 1 }];
      if (query.includes('INSERT INTO "AuditEvent"')) return [];
      return [];
    };
    const createTxMock = () => Object.assign(vi.fn(queryHandler), { json: vi.fn((v) => v), array: vi.fn((arr: unknown[]) => arr) });
    const mockSql = Object.assign(vi.fn(queryHandler), {
      json: vi.fn((v) => v),
      array: vi.fn((arr: unknown[]) => arr),
      begin: vi.fn(async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => fn(createTxMock() as unknown as Sql)),
    }) as unknown as Sql;

    mockResults.set("account", [{
      id: "acc-noowner-recompute",
      shopId: "shop-noowner-recompute",
      kind: "COMPANY",
      companyLocationId: null,
      customerId: null,
      creditLimit: "100000",
      holdState: "OK",
      bypass: false,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      syncPending: true,
      gatedAt: null,
    }]);
    mockResults.set("shop", [{ domain: "noowner-recompute.myshopify.com", currency: "INR" }]);
    mockResults.set("overdue_check", [{ has_overdue: true }]);

    const result = await recomputeCreditStatus(mockSql, "acc-noowner-recompute");

    expect(result.success).toBe(true);
    expect(result.metafieldWritten).toBe(false);
    expect(result.noOwner).toBe(true);
    expect(mockShopifyGraphQLRequest).not.toHaveBeenCalled();
  });
});

describe("CREDIT_STATUS_RECOMPUTE drain handler no-owner branch", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockShopifyGraphQLRequest.mockClear();
    mockShopifyGraphQLRequest.mockResolvedValue({
      success: true,
      data: { metafieldsSet: { metafields: [{ id: "mf-1" }], userErrors: [] } },
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("no-owner account returns action:skipped with no-owner skipReason", async () => {
    const { getSyncHandler } = await import("../drain/processor.server");
    const handler = getSyncHandler("CREDIT_STATUS_RECOMPUTE");
    expect(handler).toBeDefined();

    const mockResults: Map<string, unknown[]> = new Map();
    const queryHandler = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes('FROM "BuyerAccount"')) return mockResults.get("account") ?? [];
      if (query.includes('FROM "Shop"')) return mockResults.get("shop") ?? [];
      if (query.includes('FROM "Invoice"') && query.includes("SUM")) return mockResults.get("invoice_exposure") ?? [{ total_paise: "0" }];
      if (query.includes("s8_draft_orders") && query.includes("SUM")) return mockResults.get("draft_exposure") ?? [{ total_paise: "0" }];
      if (query.includes("EXISTS") && query.includes("dueAt")) return mockResults.get("overdue_check") ?? [{ has_overdue: false }];
      if (query.includes('UPDATE "BuyerAccount"') && query.includes("RETURNING")) return [{ syncVersion: 1 }];
      if (query.includes('INSERT INTO "AuditEvent"')) return [];
      if (query.includes("s6_processed_webhooks")) return [];
      return [];
    };
    const createTxMock = () => Object.assign(vi.fn(queryHandler), { json: vi.fn((v) => v), array: vi.fn((arr: unknown[]) => arr) });
    const mockSql = Object.assign(vi.fn(queryHandler), {
      json: vi.fn((v) => v),
      array: vi.fn((arr: unknown[]) => arr),
      begin: vi.fn(async <T>(fn: (tx: Sql) => Promise<T>): Promise<T> => fn(createTxMock() as unknown as Sql)),
    }) as unknown as Sql;

    mockResults.set("account", [{
      id: "acc-noowner-drain",
      shopId: "shop-noowner-drain",
      kind: "COMPANY",
      companyLocationId: null,
      customerId: null,
      creditLimit: "100000",
      holdState: "OK",
      bypass: false,
      manualHold: false,
      holdReasonCode: null,
      holdNote: null,
      syncPending: true,
      gatedAt: null,
    }]);
    mockResults.set("shop", [{ domain: "noowner-drain.myshopify.com", currency: "INR" }]);
    mockResults.set("overdue_check", [{ has_overdue: true }]);

    const message = {
      topic: "CREDIT_STATUS_RECOMPUTE",
      shop: "noowner-drain.myshopify.com",
      buyerAccountId: "acc-noowner-drain",
      source: "daily_sweep",
      webhookId: `credit_recompute:acc-noowner-drain:${Date.now()}`,
      resourceGid: "acc-noowner-drain",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql, message);

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toContain("No owner GID");
    expect(mockShopifyGraphQLRequest).not.toHaveBeenCalled();
  });
});
