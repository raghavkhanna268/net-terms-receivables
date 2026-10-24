import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  buildClientSchema,
  parse,
  validate,
  type GraphQLSchema,
} from "graphql";
import {
  validateBulkQueryRulesAST,
  checkScopeDenylist,
  CUSTOMER_PII_DENYLIST,
  CUSTOMER_PII_ALLOWLIST,
} from "../validate-graphql-schema";
import {
  CUSTOMER_FORBIDDEN_FIELDS,
  CUSTOMER_OPTIONAL_PII_FIELDS,
} from "../../app/services/sync/customer-fields.server";

const SCHEMA_PATH = path.join(__dirname, "../../test/fixtures/admin-2026-10.schema.json");

/**
 * Load the Admin API schema from the fixture file.
 */
function loadSchema(): GraphQLSchema {
  const schemaJson = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8"));
  return buildClientSchema(schemaJson.data);
}

describe("validate-graphql-schema AST validation", () => {
  const schema = loadSchema();

  describe("validateBulkQueryRulesAST", () => {
    it("accepts valid bulk query with edges/node pattern", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                name
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(0);
    });

    it("rejects bulk query without edges", () => {
      const query = `
        query BulkInner {
          orders {
            id
            name
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(1);
      expect(errors.some(e => e.message.includes("should use edges { node { ... } } pattern"))).toBe(true);
    });

    it("rejects bulk query with edges but no node", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              cursor
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(1);
      expect(errors.some(e => e.message.includes("has 'edges' but missing 'node'"))).toBe(true);
    });

    it("validates nested connection fields", () => {
      const query = `
        query BulkInner {
          companies {
            edges {
              node {
                id
                companyLocations {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(0);
    });

    it("accepts paymentSchedules connection field", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                paymentTerms {
                  paymentSchedules {
                    edges {
                      node {
                        id
                        dueAt
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(0);
    });

    it("rejects paymentSchedules without edges/node pattern", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                paymentTerms {
                  paymentSchedules {
                    id
                    dueAt
                  }
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = validateBulkQueryRulesAST(parsed, "TEST_QUERY");

      expect(errors).toHaveLength(1);
      expect(errors.some(e => e.message.includes("paymentSchedules"))).toBe(true);
      expect(errors.some(e => e.message.includes("should use edges { node { ... } } pattern"))).toBe(true);
    });
  });

  describe("schema validation integration", () => {
    it("validates orders query fields against schema", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                name
                createdAt
                processedAt
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const schemaErrors = validate(schema, parsed);

      expect(schemaErrors).toHaveLength(0);
    });

    it("detects invalid field in orders query", () => {
      const query = `
        query BulkInner {
          orders {
            edges {
              node {
                id
                nonExistentField
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const schemaErrors = validate(schema, parsed);

      expect(schemaErrors.length).toBeGreaterThan(0);
      expect(schemaErrors.some(e => e.message.includes("Cannot query field"))).toBe(true);
    });
  });

  describe("CUSTOMER_PII_DENYLIST", () => {
    it("contains all forbidden customer fields", () => {
      expect(CUSTOMER_PII_DENYLIST.Customer).toBeDefined();
      expect(CUSTOMER_PII_DENYLIST.Customer.has("phone")).toBe(true);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("addresses")).toBe(true);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("firstName")).toBe(true);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("lastName")).toBe(true);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("defaultAddress")).toBe(true);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("addressesV2")).toBe(true);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("defaultPhoneNumber")).toBe(true);
    });

    it("does NOT contain allowed PII fields", () => {
      expect(CUSTOMER_PII_DENYLIST.Customer.has("email")).toBe(false);
      expect(CUSTOMER_PII_DENYLIST.Customer.has("displayName")).toBe(false);
    });

    it("stays in sync with CUSTOMER_FORBIDDEN_FIELDS", () => {
      const denylistFields = Array.from(CUSTOMER_PII_DENYLIST.Customer).sort();
      const forbiddenFields = [...CUSTOMER_FORBIDDEN_FIELDS].sort();
      expect(denylistFields).toEqual(forbiddenFields);
    });
  });

  describe("CUSTOMER_PII_ALLOWLIST", () => {
    it("contains exactly email and displayName", () => {
      expect(CUSTOMER_PII_ALLOWLIST.has("email")).toBe(true);
      expect(CUSTOMER_PII_ALLOWLIST.has("displayName")).toBe(true);
      expect(CUSTOMER_PII_ALLOWLIST.size).toBe(2);
    });

    it("does NOT contain forbidden fields", () => {
      expect(CUSTOMER_PII_ALLOWLIST.has("phone")).toBe(false);
      expect(CUSTOMER_PII_ALLOWLIST.has("addresses")).toBe(false);
      expect(CUSTOMER_PII_ALLOWLIST.has("firstName")).toBe(false);
      expect(CUSTOMER_PII_ALLOWLIST.has("lastName")).toBe(false);
      expect(CUSTOMER_PII_ALLOWLIST.has("defaultAddress")).toBe(false);
      expect(CUSTOMER_PII_ALLOWLIST.has("addressesV2")).toBe(false);
      expect(CUSTOMER_PII_ALLOWLIST.has("defaultPhoneNumber")).toBe(false);
    });

    it("stays in sync with CUSTOMER_OPTIONAL_PII_FIELDS", () => {
      const allowlistFields = Array.from(CUSTOMER_PII_ALLOWLIST).sort();
      const optionalPiiFields = [...CUSTOMER_OPTIONAL_PII_FIELDS].sort();
      expect(allowlistFields).toEqual(optionalPiiFields);
    });
  });

  describe("checkScopeDenylist - customer PII fields", () => {
    it("rejects query with Customer.phone field", () => {
      const query = `
        query CustomerWithPhone($id: ID!) {
          customer(id: $id) {
            id
            phone
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("phone"))).toBe(true);
    });

    it("rejects query with Customer.addresses field", () => {
      const query = `
        query CustomerWithAddresses($id: ID!) {
          customer(id: $id) {
            id
            addresses {
              id
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("addresses"))).toBe(true);
    });

    it("rejects query with Customer.firstName field", () => {
      const query = `
        query CustomerWithFirstName($id: ID!) {
          customer(id: $id) {
            id
            firstName
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("firstName"))).toBe(true);
    });

    it("rejects query with Customer.lastName field", () => {
      const query = `
        query CustomerWithLastName($id: ID!) {
          customer(id: $id) {
            id
            lastName
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("lastName"))).toBe(true);
    });

    it("rejects query with Customer.defaultAddress field", () => {
      const query = `
        query CustomerWithDefaultAddress($id: ID!) {
          customer(id: $id) {
            id
            defaultAddress {
              id
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("defaultAddress"))).toBe(true);
    });

    it("ALLOWS query with Customer.email field", () => {
      const query = `
        query CustomerWithEmail($id: ID!) {
          customer(id: $id) {
            id
            email
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      // No PII denylist errors for email
      const piiErrors = errors.filter(e => e.message.includes("forbidden PII field"));
      expect(piiErrors).toHaveLength(0);
    });

    it("ALLOWS query with Customer.displayName field", () => {
      const query = `
        query CustomerWithDisplayName($id: ID!) {
          customer(id: $id) {
            id
            displayName
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      // No PII denylist errors for displayName
      const piiErrors = errors.filter(e => e.message.includes("forbidden PII field"));
      expect(piiErrors).toHaveLength(0);
    });

    it("rejects customer PII in bulk query inner", () => {
      const query = `
        query BulkInner {
          customers {
            edges {
              node {
                id
                phone
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "BULK_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
    });

    it("rejects query with Customer.addressesV2 field", () => {
      const query = `
        query CustomerWithAddressesV2($id: ID!) {
          customer(id: $id) {
            id
            addressesV2(first: 10) {
              edges {
                node {
                  id
                }
              }
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("addressesV2"))).toBe(true);
    });

    it("rejects query with Customer.defaultPhoneNumber field", () => {
      const query = `
        query CustomerWithDefaultPhoneNumber($id: ID!) {
          customer(id: $id) {
            id
            defaultPhoneNumber {
              phoneNumber
            }
          }
        }
      `;
      const parsed = parse(query);
      const errors = checkScopeDenylist(schema, parsed, "TEST_QUERY");

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes("forbidden PII field"))).toBe(true);
      expect(errors.some(e => e.message.includes("defaultPhoneNumber"))).toBe(true);
    });
  });
});
