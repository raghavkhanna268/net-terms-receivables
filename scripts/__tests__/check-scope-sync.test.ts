import { describe, it, expect } from "vitest";
import { extractTomlScopes, extractJsoncScopes, normalizeScopes } from "../check-scope-sync";

describe("check-scope-sync", () => {
  describe("extractTomlScopes", () => {
    it("extracts scopes from valid TOML", () => {
      const content = `
[access_scopes]
# Some comment
scopes = "read_orders,write_orders"
`;
      expect(extractTomlScopes(content)).toBe("read_orders,write_orders");
    });

    it("returns null for missing scopes", () => {
      const content = `
[access_scopes]
# No scopes line
`;
      expect(extractTomlScopes(content)).toBeNull();
    });

    it("handles whitespace variations", () => {
      const content = `scopes="read_orders,write_orders"`;
      expect(extractTomlScopes(content)).toBe("read_orders,write_orders");
    });
  });

  describe("extractJsoncScopes", () => {
    it("extracts SCOPES from valid JSONC", () => {
      const content = `{
  // This is a comment
  "vars": {
    "SCOPES": "read_orders,write_orders"
  }
}`;
      expect(extractJsoncScopes(content)).toBe("read_orders,write_orders");
    });

    it("handles URLs in comments without breaking", () => {
      const content = `{
  // See https://example.com/docs for reference
  "vars": {
    // Must match shopify.app.toml
    "SCOPES": "read_orders,write_orders",
    "URL": "https://example.com"
  }
}`;
      expect(extractJsoncScopes(content)).toBe("read_orders,write_orders");
    });

    it("returns null for missing SCOPES", () => {
      const content = `{
  "vars": {
    "OTHER": "value"
  }
}`;
      expect(extractJsoncScopes(content)).toBeNull();
    });

    it("returns null for invalid JSON", () => {
      const content = `{ invalid json }`;
      expect(extractJsoncScopes(content)).toBeNull();
    });

    it("returns null for missing vars", () => {
      const content = `{
  "name": "test"
}`;
      expect(extractJsoncScopes(content)).toBeNull();
    });
  });

  describe("normalizeScopes", () => {
    it("sorts scopes alphabetically", () => {
      expect(normalizeScopes("write_orders,read_orders")).toBe("read_orders,write_orders");
    });

    it("handles already sorted scopes", () => {
      expect(normalizeScopes("a,b,c")).toBe("a,b,c");
    });

    it("handles single scope", () => {
      expect(normalizeScopes("read_orders")).toBe("read_orders");
    });
  });
});
