/**
 * Tests for Invoice Eligibility Logic (S9 Refs)
 *
 * Covers all eligibility paths:
 * - (a) Order has Shopify paymentTerms
 * - (b) CompanyLocation with active BuyerAccount with explicit terms
 * - (b-neg) CompanyLocation WITHOUT explicit terms → NOT eligible
 * - (c) Customer matches a configured tag rule
 * - Retail orders (no B2B, no tag) → excluded
 * - Terminal or ineligible financial statuses → excluded
 * - No buyer account → retryable failure
 */

import { describe, it, expect, vi } from "vitest";
import type { ShopifyOrder } from "~/services/sync/types";
import {
  checkOrderEligibility,
  isEligibleFinancialStatus,
  isTerminalFinancialStatus,
  type EligibilityContext,
} from "../invoice-eligibility";

// Mock the dependencies
vi.mock("~/services/gating.server", () => ({
  activeAccountFragment: (sql: unknown) => {
    // Return SQL fragment that filters for non-gated accounts
    return (sql as { unsafe: (s: string) => unknown }).unsafe("gated_at IS NULL");
  },
}));

// Helper to create mock SQL client
function createMockSql(queryResults: Map<string, unknown[]>) {
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => {
    // Concatenate template to identify the query
    const query = strings.join("?");

    // Check for specific patterns
    if (query.includes("FROM \"BuyerAccount\"") && query.includes("companyLocationId")) {
      return Promise.resolve(queryResults.get("buyerAccountByLocation") ?? []);
    }
    if (query.includes("FROM \"BuyerAccount\"") && query.includes("companyId") && !query.includes("companyLocationId")) {
      return Promise.resolve(queryResults.get("buyerAccountByCompany") ?? []);
    }
    if (query.includes("FROM \"BuyerAccount\"") && query.includes("customerId")) {
      return Promise.resolve(queryResults.get("buyerAccountByCustomer") ?? []);
    }
    if (query.includes("FROM \"BuyerAccount\"") && query.includes("WHERE id =")) {
      return Promise.resolve(queryResults.get("buyerAccountById") ?? []);
    }
    if (query.includes("FROM s8_tagged_customers")) {
      return Promise.resolve(queryResults.get("customerTags") ?? []);
    }

    return Promise.resolve([]);
  };

  // Add the unsafe method for the gating fragment
  sql.unsafe = (s: string) => s;

  return sql;
}

// Helper to create a minimal order
function createOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: "gid://shopify/Order/123",
    name: "#1001",
    createdAt: "2025-01-15T10:00:00Z",
    displayFinancialStatus: "PENDING",
    ...overrides,
  };
}

// Default context for tests
const defaultContext: EligibilityContext = {
  shopId: "shop-123",
  shopTimezone: "Asia/Kolkata",
  shopDefaultTermsDays: null,
  tagRules: [],
};

describe("Invoice Eligibility", () => {
  describe("isEligibleFinancialStatus", () => {
    it("returns true for PENDING", () => {
      expect(isEligibleFinancialStatus("PENDING")).toBe(true);
    });

    it("returns true for PARTIALLY_PAID", () => {
      expect(isEligibleFinancialStatus("PARTIALLY_PAID")).toBe(true);
    });

    it("returns true for AUTHORIZED", () => {
      expect(isEligibleFinancialStatus("AUTHORIZED")).toBe(true);
    });

    it("returns false for PAID", () => {
      expect(isEligibleFinancialStatus("PAID")).toBe(false);
    });

    it("returns false for null", () => {
      expect(isEligibleFinancialStatus(null)).toBe(false);
    });
  });

  describe("isTerminalFinancialStatus", () => {
    it("returns true for PAID", () => {
      expect(isTerminalFinancialStatus("PAID")).toBe(true);
    });

    it("returns true for REFUNDED", () => {
      expect(isTerminalFinancialStatus("REFUNDED")).toBe(true);
    });

    it("returns true for VOIDED", () => {
      expect(isTerminalFinancialStatus("VOIDED")).toBe(true);
    });

    it("returns true for PARTIALLY_REFUNDED", () => {
      expect(isTerminalFinancialStatus("PARTIALLY_REFUNDED")).toBe(true);
    });

    it("returns false for PENDING", () => {
      expect(isTerminalFinancialStatus("PENDING")).toBe(false);
    });
  });

  describe("checkOrderEligibility", () => {
    describe("Path (a): Order has Shopify paymentTerms", () => {
      it("is eligible when order has paymentTerms and buyer account exists", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", [{ id: "ba-123" }]],
          ["buyerAccountById", [{ defaultTermsDays: 30, defaultTermsSource: "explicit" }]],
          ["customerTags", []],
        ]));

        const order = createOrder({
          paymentTerms: {
            id: "pt-1",
            paymentTermsName: "Net 30",
            paymentTermsType: "NET",
            dueInDays: 30,
          },
          purchasingEntity: {
            __typename: "PurchasingCompany",
            location: { id: "gid://shopify/CompanyLocation/456" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(true);
        expect(result.reason).toBe("shopify_payment_terms");
        expect(result.buyerAccountId).toBe("ba-123");
      });

      it("returns retryable failure when order has paymentTerms but no buyer account", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", []],
          ["buyerAccountByCompany", []],
          ["buyerAccountByCustomer", []],
        ]));

        const order = createOrder({
          paymentTerms: {
            id: "pt-1",
            paymentTermsName: "Net 30",
            paymentTermsType: "NET",
            dueInDays: 30,
          },
          purchasingEntity: {
            __typename: "PurchasingCompany",
            location: { id: "gid://shopify/CompanyLocation/456" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("no_buyer_account");
        expect(result.retryable).toBe(true);
      });
    });

    describe("Path (b): CompanyLocation with explicit terms", () => {
      it("is eligible when location has active account with explicit terms", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", [{ 
            id: "ba-456", 
            defaultTermsDays: 45, 
            defaultTermsSource: "explicit" 
          }]],
        ]));

        const order = createOrder({
          purchasingEntity: {
            __typename: "PurchasingCompany",
            location: { id: "gid://shopify/CompanyLocation/789" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(true);
        expect(result.reason).toBe("company_account_terms");
        expect(result.buyerAccountId).toBe("ba-456");
        expect(result.accountDefaultTermsDays).toBe(45);
        expect(result.explanation).toContain("CompanyLocation account has explicit default terms");
      });

      it("is NOT eligible (permanent) when location has account but no explicit terms (b-neg)", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", [{ 
            id: "ba-456", 
            defaultTermsDays: null, 
            defaultTermsSource: null 
          }]],
          ["customerTags", []],
        ]));

        const order = createOrder({
          purchasingEntity: {
            __typename: "PurchasingCompany",
            location: { id: "gid://shopify/CompanyLocation/789" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("retail_order");
        expect(result.retryable).toBeUndefined(); // Permanent skip
      });

      it("is NOT eligible (permanent) when location has tag-derived terms (not explicit)", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", [{ 
            id: "ba-456", 
            defaultTermsDays: 30, 
            defaultTermsSource: "tag" 
          }]],
          ["customerTags", []],
        ]));

        const order = createOrder({
          purchasingEntity: {
            __typename: "PurchasingCompany",
            location: { id: "gid://shopify/CompanyLocation/789" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("retail_order");
        expect(result.retryable).toBeUndefined(); // Permanent skip
      });

      it("returns retryable failure when B2B location exists but no BuyerAccount synced yet", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", []], // No account for this location yet
          ["customerTags", []],
        ]));

        const order = createOrder({
          purchasingEntity: {
            __typename: "PurchasingCompany",
            location: { id: "gid://shopify/CompanyLocation/789" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("no_buyer_account");
        expect(result.retryable).toBe(true); // Should retry when company syncs
      });
    });

    describe("Path (c): Customer matches tag rule", () => {
      it("is eligible when customer tag matches a rule and account exists", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", []],
          ["buyerAccountByCompany", []],
          ["buyerAccountByCustomer", [{ 
            id: "ba-789", 
            defaultTermsDays: 30, 
            defaultTermsSource: "tag" 
          }]],
          ["customerTags", [{ tags: ["wholesale", "net-terms"] }]],
        ]));

        const order = createOrder({
          customer: { id: "gid://shopify/Customer/111" },
        });

        const context: EligibilityContext = {
          ...defaultContext,
          tagRules: [{ tag: "net-terms", defaultTermsDays: 30 }],
        };

        const result = await checkOrderEligibility(sql as never, order, context);

        expect(result.eligible).toBe(true);
        expect(result.reason).toBe("tagged_customer");
        expect(result.buyerAccountId).toBe("ba-789");
        expect(result.matchedTagRule).toEqual({ tag: "net-terms", defaultTermsDays: 30 });
      });

      it("returns retryable failure when tag matches but no buyer account", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", []],
          ["buyerAccountByCompany", []],
          ["buyerAccountByCustomer", []],
          ["customerTags", [{ tags: ["net-terms"] }]],
        ]));

        const order = createOrder({
          customer: { id: "gid://shopify/Customer/111" },
        });

        const context: EligibilityContext = {
          ...defaultContext,
          tagRules: [{ tag: "net-terms", defaultTermsDays: 30 }],
        };

        const result = await checkOrderEligibility(sql as never, order, context);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("no_buyer_account");
        expect(result.retryable).toBe(true);
      });
    });

    describe("Retail orders (no B2B, no tag)", () => {
      it("is NOT eligible when no paymentTerms, no company, no tag match", async () => {
        const sql = createMockSql(new Map([
          ["customerTags", [{ tags: ["regular-customer"] }]],
        ]));

        const order = createOrder({
          customer: { id: "gid://shopify/Customer/111" },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("retail_order");
        expect(result.retryable).toBeUndefined();
      });
    });

    describe("Terminal and ineligible financial statuses", () => {
      it("rejects orders with terminal status PAID", async () => {
        const sql = createMockSql(new Map());
        const order = createOrder({ displayFinancialStatus: "PAID" });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("terminal_status");
      });

      it("rejects orders with terminal status REFUNDED", async () => {
        const sql = createMockSql(new Map());
        const order = createOrder({ displayFinancialStatus: "REFUNDED" });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("terminal_status");
      });

      it("rejects orders with terminal status VOIDED", async () => {
        const sql = createMockSql(new Map());
        const order = createOrder({ displayFinancialStatus: "VOIDED" });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("terminal_status");
      });

      it("rejects orders with null status as status_missing", async () => {
        const sql = createMockSql(new Map());
        const order = createOrder({ displayFinancialStatus: null });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("status_missing");
        expect(result.explanation).toContain("null displayFinancialStatus");
      });
    });

    describe("Company-wide fallback behavior", () => {
      it("uses company fallback when no location and exactly one account exists", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByCompany", [{ 
            id: "ba-company", 
            defaultTermsDays: 60, 
            defaultTermsSource: "explicit" 
          }]],
        ]));

        const order = createOrder({
          purchasingEntity: {
            __typename: "PurchasingCompany",
            company: { id: "gid://shopify/Company/999" },
            // No location
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        expect(result.eligible).toBe(true);
        expect(result.reason).toBe("company_account_terms");
        expect(result.explanation).toContain("single location");
      });

      it("does NOT use company fallback when location exists but has no terms", async () => {
        const sql = createMockSql(new Map([
          ["buyerAccountByLocation", [{ 
            id: "ba-loc", 
            defaultTermsDays: null, 
            defaultTermsSource: null 
          }]],
          ["buyerAccountByCompany", [{ 
            id: "ba-company", 
            defaultTermsDays: 60, 
            defaultTermsSource: "explicit" 
          }]],
          ["customerTags", []],
        ]));

        const order = createOrder({
          purchasingEntity: {
            __typename: "PurchasingCompany",
            company: { id: "gid://shopify/Company/999" },
            location: { id: "gid://shopify/CompanyLocation/111" },
          },
        });

        const result = await checkOrderEligibility(sql as never, order, defaultContext);

        // Should NOT use company fallback when location exists
        expect(result.eligible).toBe(false);
        expect(result.reason).toBe("retail_order");
      });
    });
  });
});
