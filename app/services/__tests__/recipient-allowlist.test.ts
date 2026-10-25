import { describe, it, expect } from "vitest";
import {
  parseRecipientAllowlist,
  isRecipientAllowed,
  filterRecipients,
} from "../recipient-allowlist.server";

describe("parseRecipientAllowlist", () => {
  it("returns empty Set for undefined input", () => {
    const result = parseRecipientAllowlist(undefined);
    expect(result.size).toBe(0);
  });

  it("returns empty Set for empty string", () => {
    const result = parseRecipientAllowlist("");
    expect(result.size).toBe(0);
  });

  it("returns empty Set for whitespace only", () => {
    const result = parseRecipientAllowlist("   ");
    expect(result.size).toBe(0);
  });

  it("returns empty Set for only commas", () => {
    const result = parseRecipientAllowlist(",,,");
    expect(result.size).toBe(0);
  });

  it("returns empty Set for commas and whitespace", () => {
    const result = parseRecipientAllowlist(" , , , ");
    expect(result.size).toBe(0);
  });

  it("parses single address", () => {
    const result = parseRecipientAllowlist("buyer@test-example.com");
    expect(result.size).toBe(1);
    expect(result.has("buyer@test-example.com")).toBe(true);
  });

  it("parses multiple addresses", () => {
    const result = parseRecipientAllowlist(
      "buyer1@test-example.com,buyer2@test-example.com,buyer3@test-example.com"
    );
    expect(result.size).toBe(3);
    expect(result.has("buyer1@test-example.com")).toBe(true);
    expect(result.has("buyer2@test-example.com")).toBe(true);
    expect(result.has("buyer3@test-example.com")).toBe(true);
  });

  it("trims whitespace from addresses", () => {
    const result = parseRecipientAllowlist(
      "  buyer1@test-example.com  , buyer2@test-example.com  "
    );
    expect(result.size).toBe(2);
    expect(result.has("buyer1@test-example.com")).toBe(true);
    expect(result.has("buyer2@test-example.com")).toBe(true);
  });

  it("lowercases all addresses", () => {
    const result = parseRecipientAllowlist("Buyer@Test-Example.COM,ADMIN@Test-Example.COM");
    expect(result.size).toBe(2);
    expect(result.has("buyer@test-example.com")).toBe(true);
    expect(result.has("admin@test-example.com")).toBe(true);
  });

  it("handles duplicates (Set deduplicates)", () => {
    const result = parseRecipientAllowlist(
      "buyer@test-example.com,BUYER@test-example.com,buyer@TEST-EXAMPLE.COM"
    );
    expect(result.size).toBe(1);
    expect(result.has("buyer@test-example.com")).toBe(true);
  });

  it("handles mixed case and whitespace", () => {
    const result = parseRecipientAllowlist(
      "  Buyer1@Test-Example.COM  ,buyer2@test-example.com,  BUYER3@Test-Example.COM"
    );
    expect(result.size).toBe(3);
    expect(result.has("buyer1@test-example.com")).toBe(true);
    expect(result.has("buyer2@test-example.com")).toBe(true);
    expect(result.has("buyer3@test-example.com")).toBe(true);
  });

  it("filters out empty entries between commas", () => {
    const result = parseRecipientAllowlist("buyer1@test-example.com,,buyer2@test-example.com,,,buyer3@test-example.com");
    expect(result.size).toBe(3);
  });
});

describe("isRecipientAllowed", () => {
  it("returns false for empty allowlist", () => {
    const allowlist = parseRecipientAllowlist("");
    expect(isRecipientAllowed("buyer@test-example.com", allowlist)).toBe(false);
  });

  it("returns false for undefined allowlist (empty Set)", () => {
    const allowlist = parseRecipientAllowlist(undefined);
    expect(isRecipientAllowed("buyer@test-example.com", allowlist)).toBe(false);
  });

  it("returns true for address in allowlist", () => {
    const allowlist = parseRecipientAllowlist("buyer@test-example.com");
    expect(isRecipientAllowed("buyer@test-example.com", allowlist)).toBe(true);
  });

  it("returns false for address not in allowlist", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    expect(isRecipientAllowed("other@test-example.com", allowlist)).toBe(false);
  });

  it("matches case-insensitively", () => {
    const allowlist = parseRecipientAllowlist("buyer@test-example.com");
    expect(isRecipientAllowed("BUYER@test-example.com", allowlist)).toBe(true);
    expect(isRecipientAllowed("Buyer@TEST-EXAMPLE.COM", allowlist)).toBe(true);
  });

  it("trims input address before matching", () => {
    const allowlist = parseRecipientAllowlist("buyer@test-example.com");
    expect(isRecipientAllowed("  buyer@test-example.com  ", allowlist)).toBe(true);
  });

  it("matches mixed case address against mixed case allowlist", () => {
    const allowlist = parseRecipientAllowlist("BUYER@Test-Example.COM");
    expect(isRecipientAllowed("buyer@test-example.com", allowlist)).toBe(true);
  });
});

describe("filterRecipients", () => {
  it("returns all addresses as skipped when allowlist is empty", () => {
    const allowlist = parseRecipientAllowlist("");
    const result = filterRecipients(
      ["buyer1@test-example.com", "buyer2@test-example.com"],
      allowlist
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
  });

  it("returns all addresses as allowed when all are in allowlist", () => {
    const allowlist = parseRecipientAllowlist(
      "buyer1@test-example.com,buyer2@test-example.com"
    );
    const result = filterRecipients(
      ["buyer1@test-example.com", "buyer2@test-example.com"],
      allowlist
    );
    expect(result.allowed).toHaveLength(2);
    expect(result.skippedCount).toBe(0);
  });

  it("filters to only allowed addresses", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const result = filterRecipients(
      ["allowed@test-example.com", "notallowed@test-example.com"],
      allowlist
    );
    expect(result.allowed).toEqual(["allowed@test-example.com"]);
    expect(result.skippedCount).toBe(1);
  });

  it("handles case-insensitive matching", () => {
    const allowlist = parseRecipientAllowlist("ALLOWED@Test-Example.COM");
    const result = filterRecipients(
      ["allowed@test-example.com", "Allowed@Test-Example.COM", "other@test-example.com"],
      allowlist
    );
    expect(result.allowed).toHaveLength(2);
    expect(result.skippedCount).toBe(1);
  });

  it("returns empty array when no addresses match", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const result = filterRecipients(
      ["other1@test-example.com", "other2@test-example.com"],
      allowlist
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
  });
});
