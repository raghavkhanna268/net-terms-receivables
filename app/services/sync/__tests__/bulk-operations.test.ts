import { describe, it, expect } from "vitest";
import {
  BULK_ORDERS_QUERY,
  getBulkCompaniesQuery,
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

    it("includes terminal statuses for updating existing invoices", () => {
      // Terminal statuses (paid, refunded, voided) are included so reconcile
      // can UPDATE existing invoices when their status changes.
      // Eligibility rules still gate CREATION of new invoices.
      expect(BULK_ORDERS_QUERY).toContain("financial_status:paid");
      expect(BULK_ORDERS_QUERY).toContain("financial_status:refunded");
      expect(BULK_ORDERS_QUERY).toContain("financial_status:voided");
    });

    it("includes authorized status for orders that can become net-terms", () => {
      expect(BULK_ORDERS_QUERY).toContain("financial_status:authorized");
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

    it("only requests customer id and tags (DPDP compliance)", () => {
      // Should have customer { id tags } for tag-rule eligibility
      // Tags are merchant-assigned labels (e.g., "wholesale", "net-terms"), NOT PII
      expect(BULK_ORDERS_QUERY).toMatch(/customer\s*\{\s*id\s*\n?\s*tags\s*\}/);
      // Must NOT contain customer PII fields
      expect(BULK_ORDERS_QUERY).not.toContain("customer.email");
      expect(BULK_ORDERS_QUERY).not.toContain("customer.name");
      expect(BULK_ORDERS_QUERY).not.toContain("customer.phone");
    });
  });

  describe("getBulkCompaniesQuery", () => {
    describe("with CUSTOMER_PII_FIELDS=1", () => {
      const query = getBulkCompaniesQuery({ CUSTOMER_PII_FIELDS: "1" });

      it("requests companies with locations", () => {
        expect(query).toContain("companies");
        expect(query).toContain("locations");
      });

      it("only requests billingAddress.companyName (DPDP compliance)", () => {
        expect(query).toContain("billingAddress");
        expect(query).toContain("companyName");
        expect(query).not.toContain("firstName");
        expect(query).not.toContain("lastName");
        expect(query).not.toContain("address1");
        expect(query).not.toContain("city");
        expect(query).not.toContain("country");
      });

      it("requests paymentTermsTemplate for default terms", () => {
        expect(query).toContain("paymentTermsTemplate");
        expect(query).toContain("dueInDays");
      });

      it("requests mainContact with email and displayName when PII flag is on", () => {
        expect(query).toContain("mainContact");
        expect(query).toContain("customer {");
        expect(query).toContain("email");
        expect(query).toContain("displayName");
      });

      it("does not request forbidden customer fields in mainContact (DPDP compliance)", () => {
        expect(query).not.toContain("phone");
        expect(query).not.toContain("addresses");
        expect(query).not.toContain("defaultAddress");
      });
    });

    describe("with CUSTOMER_PII_FIELDS off (empty env)", () => {
      const query = getBulkCompaniesQuery({});

      it("requests mainContact.customer.id only (no email/displayName)", () => {
        expect(query).toContain("mainContact");
        expect(query).toContain("customer {");
        expect(query).toContain("id");
        expect(query).not.toContain("email");
        expect(query).not.toContain("displayName");
      });

      it("still requests base company/location fields", () => {
        expect(query).toContain("companies");
        expect(query).toContain("locations");
        expect(query).toContain("billingAddress");
        expect(query).toContain("paymentTermsTemplate");
      });
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
