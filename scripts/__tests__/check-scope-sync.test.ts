import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  describe("S24 production scope assertions", () => {
    const ROOT = resolve(import.meta.dirname, "..", "..");
    const tomlContent = readFileSync(resolve(ROOT, "shopify.app.toml"), "utf-8");
    const wranglerContent = readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf-8");
    const tomlScopes = extractTomlScopes(tomlContent);
    const wranglerScopes = extractJsoncScopes(wranglerContent);

    const EXPECTED_SCOPES = [
      "read_draft_orders",
      "read_payment_terms",
      "write_companies",
      "write_customers",
      "write_merchant_managed_fulfillment_orders",
      "write_orders",
      "write_payment_customizations",
      "write_validations",
    ].sort();

    it("shopify.app.toml has exactly 8 scopes", () => {
      expect(tomlScopes).not.toBeNull();
      const scopes = tomlScopes!.split(",").sort();
      expect(scopes).toHaveLength(8);
      expect(scopes).toEqual(EXPECTED_SCOPES);
    });

    it("wrangler.jsonc SCOPES matches shopify.app.toml exactly", () => {
      expect(wranglerScopes).not.toBeNull();
      expect(normalizeScopes(wranglerScopes!)).toBe(normalizeScopes(tomlScopes!));
    });

    it("write_payment_terms is NOT present", () => {
      expect(tomlScopes).not.toContain("write_payment_terms");
      expect(wranglerScopes).not.toContain("write_payment_terms");
    });

    it("write_draft_orders is NOT present", () => {
      expect(tomlScopes).not.toContain("write_draft_orders");
      expect(wranglerScopes).not.toContain("write_draft_orders");
    });

    it("read_locations is NOT present", () => {
      expect(tomlScopes).not.toContain("read_locations");
      expect(wranglerScopes).not.toContain("read_locations");
    });

    it("read_all_orders is NOT present", () => {
      expect(tomlScopes).not.toContain("read_all_orders");
      expect(wranglerScopes).not.toContain("read_all_orders");
    });

    it("dropped read_companies, read_customers, read_orders are NOT present", () => {
      expect(tomlScopes).not.toContain("read_companies");
      expect(tomlScopes).not.toContain("read_customers");
      expect(tomlScopes).not.toContain("read_orders");
      expect(wranglerScopes).not.toContain("read_companies");
      expect(wranglerScopes).not.toContain("read_customers");
      expect(wranglerScopes).not.toContain("read_orders");
    });
  });
});
