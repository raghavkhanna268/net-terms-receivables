import { describe, it, expect } from "vitest";
import { getCompanyLocationQuery, getCompanyLocationQueryWithoutContact } from "../admin-client.server";

describe("Admin Client GraphQL Queries", () => {
  describe("getCompanyLocationQuery", () => {
    describe("with CUSTOMER_PII_FIELDS=1", () => {
      const query = getCompanyLocationQuery({ CUSTOMER_PII_FIELDS: "1" });

      it("requests id, name, company", () => {
        expect(query).toContain("id");
        expect(query).toContain("name");
        expect(query).toContain("company {");
      });

      it("requests billingAddress.companyName (DPDP compliance)", () => {
        expect(query).toContain("billingAddress");
        expect(query).toContain("companyName");
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
        expect(query).not.toContain("firstName");
        expect(query).not.toContain("lastName");
      });
    });

    describe("with CUSTOMER_PII_FIELDS off (empty env)", () => {
      const query = getCompanyLocationQuery({});

      it("requests mainContact.customer.id only (no email/displayName)", () => {
        expect(query).toContain("mainContact");
        expect(query).toContain("customer {");
        expect(query).toContain("id");
        expect(query).not.toContain("email");
        expect(query).not.toContain("displayName");
      });

      it("still requests base location fields", () => {
        expect(query).toContain("billingAddress");
        expect(query).toContain("paymentTermsTemplate");
      });
    });
  });

  describe("getCompanyLocationQueryWithoutContact", () => {
    const query = getCompanyLocationQueryWithoutContact();

    it("requests base location fields", () => {
      expect(query).toContain("id");
      expect(query).toContain("name");
      expect(query).toContain("company {");
      expect(query).toContain("billingAddress");
      expect(query).toContain("paymentTermsTemplate");
    });

    it("does NOT request mainContact at all (ACCESS_DENIED fallback)", () => {
      expect(query).not.toContain("mainContact");
      expect(query).not.toContain("email");
      expect(query).not.toContain("displayName");
    });
  });
});
