import { describe, it, expect } from "vitest";
import { COMPANY_LOCATION_QUERY } from "../admin-client.server";

describe("Admin Client GraphQL Queries", () => {
  describe("COMPANY_LOCATION_QUERY", () => {
    it("requests id, name, company", () => {
      expect(COMPANY_LOCATION_QUERY).toContain("id");
      expect(COMPANY_LOCATION_QUERY).toContain("name");
      expect(COMPANY_LOCATION_QUERY).toContain("company {");
    });

    it("requests billingAddress.companyName (DPDP compliance)", () => {
      expect(COMPANY_LOCATION_QUERY).toContain("billingAddress");
      expect(COMPANY_LOCATION_QUERY).toContain("companyName");
    });

    it("requests paymentTermsTemplate for default terms", () => {
      expect(COMPANY_LOCATION_QUERY).toContain("paymentTermsTemplate");
      expect(COMPANY_LOCATION_QUERY).toContain("dueInDays");
    });

    it("requests mainContact for B2B reminder emails", () => {
      expect(COMPANY_LOCATION_QUERY).toContain("mainContact");
      expect(COMPANY_LOCATION_QUERY).toContain("customer {");
      expect(COMPANY_LOCATION_QUERY).toContain("email");
      expect(COMPANY_LOCATION_QUERY).toContain("displayName");
    });

    it("does not request forbidden customer fields in mainContact (DPDP compliance)", () => {
      expect(COMPANY_LOCATION_QUERY).not.toContain("phone");
      expect(COMPANY_LOCATION_QUERY).not.toContain("addresses");
      expect(COMPANY_LOCATION_QUERY).not.toContain("defaultAddress");
      expect(COMPANY_LOCATION_QUERY).not.toContain("firstName");
      expect(COMPANY_LOCATION_QUERY).not.toContain("lastName");
    });
  });
});
