import { describe, it, expect } from "vitest";
import {
  BULK_ORDERS_QUERY,
  BULK_COMPANIES_QUERY,
  parseBulkOperationResult,
} from "../bulk-operations.server";

describe("Bulk Operations GraphQL", () => {
  describe("BULK_ORDERS_QUERY", () => {
    it("includes pending financial status filter", () => {
      expect(BULK_ORDERS_QUERY).toContain("financial_status:pending");
    });

    it("includes partially_paid financial status filter", () => {
      // Net-terms orders with partial payment should be included
      // @see https://shopify.dev/docs/api/admin-graphql/2026-10/enums/OrderDisplayFinancialStatus
      expect(BULK_ORDERS_QUERY).toContain("financial_status:partially_paid");
    });

    it("does not include paid, refunded, or voided statuses", () => {
      // Terminal statuses should not be in the backfill query
      expect(BULK_ORDERS_QUERY).not.toMatch(/financial_status:paid[^_]/);
      expect(BULK_ORDERS_QUERY).not.toContain("financial_status:refunded");
      expect(BULK_ORDERS_QUERY).not.toContain("financial_status:voided");
    });

    it("requests paymentTerms for filtering", () => {
      expect(BULK_ORDERS_QUERY).toContain("paymentTerms");
      expect(BULK_ORDERS_QUERY).toContain("paymentTermsName");
      expect(BULK_ORDERS_QUERY).toContain("dueInDays");
    });

    it("requests purchasingEntity for BuyerAccount resolution", () => {
      expect(BULK_ORDERS_QUERY).toContain("purchasingEntity");
      expect(BULK_ORDERS_QUERY).toContain("PurchasingCompany");
    });

    it("only requests customer.id (DPDP compliance)", () => {
      // Should have customer { id } but not email, name, tags, etc.
      expect(BULK_ORDERS_QUERY).toMatch(/customer\s*\{\s*id\s*\}/);
      expect(BULK_ORDERS_QUERY).not.toContain("customer.email");
      expect(BULK_ORDERS_QUERY).not.toContain("customer.name");
    });
  });

  describe("BULK_COMPANIES_QUERY", () => {
    it("requests companies with locations", () => {
      expect(BULK_COMPANIES_QUERY).toContain("companies");
      expect(BULK_COMPANIES_QUERY).toContain("locations");
    });

    it("only requests billingAddress.companyName (DPDP compliance)", () => {
      // Should have billingAddress { companyName } but not full address
      // Note: CompanyAddress.company was renamed to companyName in 2026-10
      expect(BULK_COMPANIES_QUERY).toContain("billingAddress");
      expect(BULK_COMPANIES_QUERY).toContain("companyName");
      expect(BULK_COMPANIES_QUERY).not.toContain("firstName");
      expect(BULK_COMPANIES_QUERY).not.toContain("lastName");
      expect(BULK_COMPANIES_QUERY).not.toContain("address1");
      expect(BULK_COMPANIES_QUERY).not.toContain("city");
      expect(BULK_COMPANIES_QUERY).not.toContain("country");
    });

    it("requests paymentTermsTemplate for default terms", () => {
      expect(BULK_COMPANIES_QUERY).toContain("paymentTermsTemplate");
      expect(BULK_COMPANIES_QUERY).toContain("dueInDays");
    });
  });

  describe("parseBulkOperationResult", () => {
    it("returns success with operation ID", () => {
      const response = {
        bulkOperationRunQuery: {
          bulkOperation: {
            id: "gid://shopify/BulkOperation/123",
            status: "CREATED",
          },
          userErrors: [],
        },
      };

      const result = parseBulkOperationResult(response);

      expect(result.success).toBe(true);
      expect(result.bulkOperationId).toBe("gid://shopify/BulkOperation/123");
      expect(result.status).toBe("CREATED");
    });

    it("returns failure on user errors", () => {
      const response = {
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: ["query"], message: "Invalid query" }],
        },
      };

      const result = parseBulkOperationResult(response);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid query");
    });

    it("returns failure on missing response", () => {
      const result = parseBulkOperationResult(null);

      expect(result.success).toBe(false);
      expect(result.error).toBe("No bulkOperationRunQuery in response");
    });
  });
});
