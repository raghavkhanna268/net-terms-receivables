import { describe, it, expect } from "vitest";
import { parseScopes } from "../shopify.server";

describe("parseScopes", () => {
  it("returns empty array for empty string", () => {
    expect(parseScopes("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(parseScopes("   ")).toEqual([]);
  });

  it("returns empty array for comma-only string", () => {
    expect(parseScopes(",")).toEqual([]);
    expect(parseScopes(",,")).toEqual([]);
  });

  it("parses single scope", () => {
    expect(parseScopes("read_orders")).toEqual(["read_orders"]);
  });

  it("parses multiple scopes", () => {
    expect(parseScopes("read_orders,read_customers")).toEqual([
      "read_orders",
      "read_customers",
    ]);
  });

  it("trims whitespace around scopes", () => {
    expect(parseScopes(" read_orders , read_customers ")).toEqual([
      "read_orders",
      "read_customers",
    ]);
  });

  it("filters out empty entries from whitespace", () => {
    expect(parseScopes("read_orders, ,read_customers")).toEqual([
      "read_orders",
      "read_customers",
    ]);
  });

  it("handles mixed empty and valid scopes", () => {
    expect(parseScopes(",read_orders,,read_customers,")).toEqual([
      "read_orders",
      "read_customers",
    ]);
  });
});
