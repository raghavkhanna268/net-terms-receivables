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

vi.mock("../shopify-client.server", () => ({
  shopifyGraphQLRequest: mockShopifyGraphQLRequest,
}));

const createMockSql = () => {
  const mockResults: Map<string, unknown[]> = new Map();

  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
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

      if (query.includes('UPDATE "BuyerAccount"')) {
        return mockResults.get("update_account") ?? { count: 1 };
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
    }),
    {
      json: vi.fn((v) => v),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value as unknown[]),
      clearMockResults: () => mockResults.clear(),
    }
  ) as unknown as Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
  };

  return sql;
};

describe("credit-status.server", () => {
  let mockSql: ReturnType<typeof createMockSql>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql = createMockSql();
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    it("returns error for gated accounts", async () => {
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
        gatedAt: new Date(),
      }]);

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: null,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("gated");
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
        holdReasonCode: null,
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

    it("sets metafieldSyncPending when API call fails", async () => {
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
        gatedAt: null,
      }]);

      mockSql.setMockResult("shop", [{ domain: "test.myshopify.com", currency: "INR" }]);
      mockSql.setMockResult("invoice_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("draft_exposure", [{ total_paise: "0" }]);
      mockSql.setMockResult("overdue_check", [{ has_overdue: false }]);

      mockShopifyGraphQLRequest.mockResolvedValueOnce({
        success: false,
        error: "Network error",
        retryable: true,
      });

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: null,
      });

      expect(result.success).toBe(true);
      expect(result.metafieldSyncPending).toBe(true);
      expect(result.error).toContain("sync failed");
    });

    it("surfaces userErrors from metafieldsSet mutation", async () => {
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
            metafields: null,
            userErrors: [
              { field: ["metafields", "0", "value"], message: "Invalid JSON" },
            ],
          },
        },
      });

      const result = await updateCreditStatus(mockSql, "acc-123", {
        creditLimitAmount: 100000,
        manualHold: false,
        holdReasonCode: null,
      });

      expect(result.success).toBe(true);
      expect(result.metafieldSyncPending).toBe(true);
      expect(result.userErrors).toHaveLength(1);
      expect(result.userErrors?.[0].message).toBe("Invalid JSON");
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
});

// DB-backed integration tests moved to credit-status-db.test.ts
// to avoid vitest mock hoisting issues
