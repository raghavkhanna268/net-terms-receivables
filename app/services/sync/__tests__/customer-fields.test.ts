import { describe, it, expect } from "vitest";
import {
  CUSTOMER_BASE_FIELDS,
  CUSTOMER_OPTIONAL_PII_FIELDS,
  CUSTOMER_FORBIDDEN_FIELDS,
  shouldIncludePiiFields,
  getCustomerFields,
  buildCustomerFieldSelection,
  validateNoForbiddenFields,
  validateCustomerQuery,
  getCustomerQuery,
  getBulkCustomersQuery,
  escapeTagValue,
  buildTagFilterQuery,
} from "../customer-fields.server";

/**
 * Tests for S8 customer field selection and DPDP compliance.
 *
 * These tests verify:
 * 1. Base fields are always included (id, tags)
 * 2. PII fields (email, displayName) are only included when CUSTOMER_PII_FIELDS=1
 * 3. Forbidden fields (phone, addresses, firstName, lastName) are NEVER included
 * 4. Query validation catches violations
 */

describe("Customer Fields Configuration", () => {
  describe("CUSTOMER_BASE_FIELDS", () => {
    it("includes only id and tags", () => {
      expect(CUSTOMER_BASE_FIELDS).toEqual(["id", "tags"]);
    });
  });

  describe("CUSTOMER_OPTIONAL_PII_FIELDS", () => {
    it("includes email and displayName", () => {
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).toEqual(["email", "displayName"]);
    });
  });

  describe("CUSTOMER_FORBIDDEN_FIELDS", () => {
    it("includes phone, addresses, firstName, lastName, defaultAddress", () => {
      expect(CUSTOMER_FORBIDDEN_FIELDS).toContain("phone");
      expect(CUSTOMER_FORBIDDEN_FIELDS).toContain("addresses");
      expect(CUSTOMER_FORBIDDEN_FIELDS).toContain("firstName");
      expect(CUSTOMER_FORBIDDEN_FIELDS).toContain("lastName");
      expect(CUSTOMER_FORBIDDEN_FIELDS).toContain("defaultAddress");
    });

    it("NEVER appears in field lists regardless of PII flag", () => {
      // Test with flag off
      const fieldsOff = getCustomerFields({});
      for (const forbidden of CUSTOMER_FORBIDDEN_FIELDS) {
        expect(fieldsOff).not.toContain(forbidden);
      }

      // Test with flag on - still forbidden
      const fieldsOn = getCustomerFields({ CUSTOMER_PII_FIELDS: "1" });
      for (const forbidden of CUSTOMER_FORBIDDEN_FIELDS) {
        expect(fieldsOn).not.toContain(forbidden);
      }
    });

    it("NEVER appears in generated queries regardless of PII flag", () => {
      const queryOff = getCustomerQuery({});
      const queryOn = getCustomerQuery({ CUSTOMER_PII_FIELDS: "1" });

      for (const query of [queryOff, queryOn]) {
        expect(query).not.toMatch(/\bphone\b/);
        expect(query).not.toMatch(/\baddresses\b/);
        expect(query).not.toMatch(/\bfirstName\b/);
        expect(query).not.toMatch(/\blastName\b/);
        expect(query).not.toMatch(/\bdefaultAddress\b/);
      }
    });
  });
});

describe("shouldIncludePiiFields", () => {
  it("returns false when CUSTOMER_PII_FIELDS is not set", () => {
    expect(shouldIncludePiiFields({})).toBe(false);
  });

  it("returns false when CUSTOMER_PII_FIELDS is empty", () => {
    expect(shouldIncludePiiFields({ CUSTOMER_PII_FIELDS: "" })).toBe(false);
  });

  it("returns false when CUSTOMER_PII_FIELDS is '0'", () => {
    expect(shouldIncludePiiFields({ CUSTOMER_PII_FIELDS: "0" })).toBe(false);
  });

  it("returns true when CUSTOMER_PII_FIELDS is '1'", () => {
    expect(shouldIncludePiiFields({ CUSTOMER_PII_FIELDS: "1" })).toBe(true);
  });

  it("returns false for other values like 'true'", () => {
    expect(shouldIncludePiiFields({ CUSTOMER_PII_FIELDS: "true" })).toBe(false);
  });
});

describe("getCustomerFields", () => {
  it("returns only base fields when PII flag is off", () => {
    const fields = getCustomerFields({});
    expect(fields).toEqual(["id", "tags"]);
    expect(fields).not.toContain("email");
    expect(fields).not.toContain("displayName");
  });

  it("returns exactly [id, tags, email, displayName] when CUSTOMER_PII_FIELDS=1", () => {
    const fields = getCustomerFields({ CUSTOMER_PII_FIELDS: "1" });
    // Exact list - no firstName, no lastName, no phone, no addresses
    expect(fields).toEqual(["id", "tags", "email", "displayName"]);
  });

  it("NEVER includes forbidden fields even with PII flag on", () => {
    const fields = getCustomerFields({ CUSTOMER_PII_FIELDS: "1" });
    expect(fields).not.toContain("phone");
    expect(fields).not.toContain("addresses");
    expect(fields).not.toContain("firstName");
    expect(fields).not.toContain("lastName");
    expect(fields).not.toContain("defaultAddress");
  });
});

describe("buildCustomerFieldSelection", () => {
  it("returns newline-separated fields for GraphQL", () => {
    const selection = buildCustomerFieldSelection({});
    expect(selection).toBe("id\ntags");
  });

  it("includes PII fields when enabled", () => {
    const selection = buildCustomerFieldSelection({ CUSTOMER_PII_FIELDS: "1" });
    expect(selection).toContain("id");
    expect(selection).toContain("tags");
    expect(selection).toContain("email");
    expect(selection).toContain("displayName");
  });
});

describe("validateNoForbiddenFields", () => {
  it("allows queries with only base fields", () => {
    expect(() => validateNoForbiddenFields("{ customer { id tags } }")).not.toThrow();
  });

  it("allows queries with PII fields", () => {
    expect(() =>
      validateNoForbiddenFields("{ customer { id tags email displayName } }")
    ).not.toThrow();
  });

  it("throws for query containing phone", () => {
    expect(() => validateNoForbiddenFields("{ customer { id phone } }")).toThrow(
      /forbidden customer field "phone"/i
    );
  });

  it("throws for query containing addresses", () => {
    expect(() => validateNoForbiddenFields("{ customer { id addresses } }")).toThrow(
      /forbidden customer field "addresses"/i
    );
  });

  it("throws for query containing firstName", () => {
    expect(() => validateNoForbiddenFields("{ customer { id firstName } }")).toThrow(
      /forbidden customer field "firstName"/i
    );
  });

  it("throws for query containing lastName", () => {
    expect(() => validateNoForbiddenFields("{ customer { id lastName } }")).toThrow(
      /forbidden customer field "lastName"/i
    );
  });

  it("throws for query containing defaultAddress", () => {
    expect(() => validateNoForbiddenFields("{ customer { id defaultAddress } }")).toThrow(
      /forbidden customer field "defaultAddress"/i
    );
  });

  it("does not match partial field names", () => {
    // phoneticName should not match phone
    expect(() =>
      validateNoForbiddenFields("{ customer { id phoneticName } }")
    ).not.toThrow();
  });
});

describe("validateCustomerQuery", () => {
  it("allows base-only queries when PII flag is off", () => {
    expect(() => validateCustomerQuery("{ customer { id tags } }", {})).not.toThrow();
  });

  it("throws for email when PII flag is off", () => {
    expect(() => validateCustomerQuery("{ customer { id email } }", {})).toThrow(
      /PII field "email".*CUSTOMER_PII_FIELDS is not enabled/i
    );
  });

  it("throws for displayName when PII flag is off", () => {
    expect(() => validateCustomerQuery("{ customer { id displayName } }", {})).toThrow(
      /PII field "displayName".*CUSTOMER_PII_FIELDS is not enabled/i
    );
  });

  it("still throws for forbidden fields even when PII flag is on", () => {
    // Each forbidden field should throw regardless of PII flag
    const forbiddenFields = ["phone", "addresses", "firstName", "lastName", "defaultAddress"];
    for (const field of forbiddenFields) {
      expect(() =>
        validateCustomerQuery(`{ customer { id ${field} } }`, { CUSTOMER_PII_FIELDS: "1" })
      ).toThrow(/forbidden customer field/i);
    }
  });

  it("allows email and displayName when PII flag is on", () => {
    expect(() =>
      validateCustomerQuery("{ customer { id email displayName } }", {
        CUSTOMER_PII_FIELDS: "1",
      })
    ).not.toThrow();
  });
});

describe("getCustomerQuery", () => {
  it("generates query with only base fields by default", () => {
    const query = getCustomerQuery({});
    expect(query).toContain("id");
    expect(query).toContain("tags");
    expect(query).not.toContain("email");
    expect(query).not.toContain("displayName");
  });

  it("includes PII fields when flag is on", () => {
    const query = getCustomerQuery({ CUSTOMER_PII_FIELDS: "1" });
    expect(query).toContain("email");
    expect(query).toContain("displayName");
  });

  it("NEVER includes forbidden fields", () => {
    const queryOff = getCustomerQuery({});
    const queryOn = getCustomerQuery({ CUSTOMER_PII_FIELDS: "1" });

    for (const query of [queryOff, queryOn]) {
      expect(query).not.toContain("phone");
      expect(query).not.toContain("addresses");
      expect(query).not.toContain("firstName");
      expect(query).not.toContain("lastName");
      expect(query).not.toContain("defaultAddress");
    }
  });

  it("is a valid GraphQL query structure", () => {
    const query = getCustomerQuery({});
    expect(query).toContain("query CustomerMinimal");
    expect(query).toContain("customer(id: $id)");
  });
});

describe("escapeTagValue", () => {
  // @see https://shopify.dev/docs/api/usage/search-syntax#special-characters
  // Shopify uses backslash escaping. The result is embedded in a GraphQL string,
  // so backslashes are doubled again for that nesting level.

  it("returns simple tags unchanged", () => {
    expect(escapeTagValue("net-terms")).toBe("net-terms");
  });

  it("escapes single quotes with backslash (doubled for GraphQL)", () => {
    // Shopify needs: buyer\'s → GraphQL string needs: buyer\\'s
    expect(escapeTagValue("buyer's-special")).toBe("buyer\\\\'s-special");
  });

  it("handles multiple quotes", () => {
    expect(escapeTagValue("it's-a-buyer's-tag")).toBe("it\\\\'s-a-buyer\\\\'s-tag");
  });

  it("handles tags with only a quote", () => {
    expect(escapeTagValue("'")).toBe("\\\\'");
  });

  it("preserves spaces (Shopify handles quoted tags)", () => {
    expect(escapeTagValue("net terms")).toBe("net terms");
  });

  it("escapes backslashes (quadrupled for two nesting levels)", () => {
    // Shopify needs: a\\b → GraphQL string needs: a\\\\b
    expect(escapeTagValue("a\\b")).toBe("a\\\\\\\\b");
  });

  it("handles both quotes and backslashes", () => {
    // tag: it\'s\a → Shopify: it\\'s\\a → GraphQL: it\\\\'s\\\\a
    expect(escapeTagValue("it's\\a")).toBe("it\\\\'s\\\\\\\\a");
  });

  it("escapes double quotes for GraphQL string literal", () => {
    // Double quotes need escaping for the GraphQL string literal (not for Shopify)
    // tag: test"value → GraphQL: test\"value
    expect(escapeTagValue('test"value')).toBe('test\\"value');
  });

  it("handles double quotes mixed with single quotes and backslashes", () => {
    // Complex case: tag with all special chars
    // tag: it's"a\test → Shopify escaping: it\'s"a\\test → GraphQL: it\\'s\"a\\\\test
    expect(escapeTagValue("it's\"a\\test")).toBe("it\\\\'s\\\"a\\\\\\\\test");
  });
});

describe("buildTagFilterQuery", () => {
  it("returns null for empty tag rules array", () => {
    expect(buildTagFilterQuery([])).toBeNull();
  });

  it("builds query for single tag rule", () => {
    const query = buildTagFilterQuery([{ tag: "net-terms" }]);
    expect(query).toBe("tag:'net-terms'");
  });

  it("builds query for multiple tag rules with OR", () => {
    const query = buildTagFilterQuery([
      { tag: "net-terms" },
      { tag: "gold-tier" },
    ]);
    expect(query).toBe("tag:'net-terms' OR tag:'gold-tier'");
  });

  it("escapes quotes in tag values (backslash doubled for GraphQL)", () => {
    const query = buildTagFilterQuery([{ tag: "buyer's" }]);
    // Shopify: tag:'buyer\'s' → GraphQL: tag:'buyer\\'s'
    expect(query).toBe("tag:'buyer\\\\'s'");
  });

  it("handles tags with spaces", () => {
    const query = buildTagFilterQuery([{ tag: "net terms" }]);
    expect(query).toBe("tag:'net terms'");
  });

  it("builds complex query with quotes and spaces", () => {
    const query = buildTagFilterQuery([
      { tag: "net-terms" },
      { tag: "buyer's special" },
      { tag: "gold tier" },
    ]);
    expect(query).toBe("tag:'net-terms' OR tag:'buyer\\\\'s special' OR tag:'gold tier'");
  });

  it("escapes double quotes in tag values (for GraphQL string)", () => {
    const query = buildTagFilterQuery([{ tag: 'test"tag' }]);
    // Double quote only needs GraphQL escaping: " → \"
    expect(query).toBe("tag:'test\\\"tag'");
  });
});

describe("getBulkCustomersQuery", () => {
  const singleTagRule = [{ tag: "net-terms" }];
  const multipleTagRules = [{ tag: "net-terms" }, { tag: "gold-tier" }];

  it("returns null when no tag rules (skip backfill)", () => {
    const query = getBulkCustomersQuery([], {});
    expect(query).toBeNull();
  });

  it("generates bulk mutation with tag filter for single rule", () => {
    const query = getBulkCustomersQuery(singleTagRule, {});
    expect(query).not.toBeNull();
    expect(query).toContain("bulkOperationRunQuery");
    expect(query).toContain("customers(query: \"tag:'net-terms'\")");
    expect(query).toContain("id");
    expect(query).toContain("tags");
  });

  it("generates bulk mutation with tag filter for multiple rules", () => {
    const query = getBulkCustomersQuery(multipleTagRules, {});
    expect(query).not.toBeNull();
    expect(query).toContain("customers(query: \"tag:'net-terms' OR tag:'gold-tier'\")");
  });

  it("escapes quotes in tag values (backslash doubled for GraphQL)", () => {
    const query = getBulkCustomersQuery([{ tag: "buyer's-tag" }], {});
    expect(query).not.toBeNull();
    // Shopify: tag:'buyer\'s-tag' → GraphQL: tag:'buyer\\'s-tag'
    expect(query).toContain("customers(query: \"tag:'buyer\\\\'s-tag'\")");
  });

  it("handles tags with spaces", () => {
    const query = getBulkCustomersQuery([{ tag: "net terms" }], {});
    expect(query).not.toBeNull();
    expect(query).toContain("customers(query: \"tag:'net terms'\")");
  });

  it("escapes backslashes in tag values (quadrupled for two nesting levels)", () => {
    const query = getBulkCustomersQuery([{ tag: "path\\tag" }], {});
    expect(query).not.toBeNull();
    // Shopify: tag:'path\\tag' → GraphQL: tag:'path\\\\tag'
    expect(query).toContain("customers(query: \"tag:'path\\\\\\\\tag'\")");
  });

  it("escapes double quotes in tag values (for GraphQL string literal)", () => {
    const query = getBulkCustomersQuery([{ tag: 'test"tag' }], {});
    expect(query).not.toBeNull();
    // Double quote needs GraphQL escaping: " → \"
    expect(query).toContain('customers(query: "tag:\'test\\"tag\'")');
  });

  it("generates bulk mutation with only base fields by default", () => {
    const query = getBulkCustomersQuery(singleTagRule, {});
    expect(query).not.toBeNull();
    expect(query).toContain("id");
    expect(query).toContain("tags");
    expect(query).not.toContain("email");
    expect(query).not.toContain("displayName");
  });

  it("includes PII fields when flag is on", () => {
    const query = getBulkCustomersQuery(singleTagRule, { CUSTOMER_PII_FIELDS: "1" });
    expect(query).not.toBeNull();
    expect(query).toContain("email");
    expect(query).toContain("displayName");
  });

  it("NEVER includes forbidden fields in bulk query", () => {
    const queryOff = getBulkCustomersQuery(singleTagRule, {});
    const queryOn = getBulkCustomersQuery(singleTagRule, { CUSTOMER_PII_FIELDS: "1" });

    for (const query of [queryOff, queryOn]) {
      expect(query).not.toBeNull();
      expect(query).not.toContain("phone");
      expect(query).not.toContain("addresses");
      expect(query).not.toContain("firstName");
      expect(query).not.toContain("lastName");
      expect(query).not.toContain("defaultAddress");
    }
  });

  it("is a valid bulk operation mutation structure", () => {
    const query = getBulkCustomersQuery(singleTagRule, {});
    expect(query).not.toBeNull();
    expect(query).toContain("mutation BulkCustomersExport");
    expect(query).toContain("bulkOperation {");
    expect(query).toContain("userErrors {");
  });
});
