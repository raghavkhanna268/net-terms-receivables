import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseRecipientAllowlist,
  isRecipientAllowed,
  filterRecipients,
  isAllowlistEnforced,
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

describe("isAllowlistEnforced", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_RECIPIENT_ALLOWLIST_ENFORCED", undefined as unknown as string);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true when env var is undefined (not set)", () => {
    expect(isAllowlistEnforced({})).toBe(true);
  });

  it("returns true when env var is empty string", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "" })).toBe(true);
  });

  it("returns false only when env var is exactly 'false'", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" })).toBe(false);
  });

  it("returns true when env var is 'FALSE' (wrong case)", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "FALSE" })).toBe(true);
  });

  it("returns true when env var is 'False' (wrong case)", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "False" })).toBe(true);
  });

  it("returns true when env var is '0'", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "0" })).toBe(true);
  });

  it("returns true when env var is 'true'", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "true" })).toBe(true);
  });

  it("returns true when env var is ' false ' (with spaces)", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: " false " })).toBe(true);
  });

  it("returns true when env var is 'no'", () => {
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "no" })).toBe(true);
  });

  it("falls back to process.env when env param has no value", () => {
    vi.stubEnv("RESEND_RECIPIENT_ALLOWLIST_ENFORCED", "false");
    expect(isAllowlistEnforced({})).toBe(false);
  });

  it("prefers env param over process.env", () => {
    vi.stubEnv("RESEND_RECIPIENT_ALLOWLIST_ENFORCED", "false");
    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "true" })).toBe(true);
  });
});

describe("isRecipientAllowed with enforcement flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns true for any address when enforcement is disabled", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" };
    
    expect(isRecipientAllowed("allowed@test-example.com", allowlist, env)).toBe(true);
    expect(isRecipientAllowed("notallowed@test-example.com", allowlist, env)).toBe(true);
    expect(isRecipientAllowed("random@example.com", allowlist, env)).toBe(true);
  });

  it("returns true for any address when enforcement is disabled and allowlist is empty", () => {
    const allowlist = parseRecipientAllowlist("");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" };
    
    expect(isRecipientAllowed("buyer@test-example.com", allowlist, env)).toBe(true);
    expect(isRecipientAllowed("anyone@example.com", allowlist, env)).toBe(true);
  });

  it("enforces allowlist when enforcement is enabled (default)", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    
    expect(isRecipientAllowed("allowed@test-example.com", allowlist)).toBe(true);
    expect(isRecipientAllowed("notallowed@test-example.com", allowlist)).toBe(false);
  });

  it("blocks all addresses when enforcement is enabled and allowlist is empty", () => {
    const allowlist = parseRecipientAllowlist("");
    
    expect(isRecipientAllowed("buyer@test-example.com", allowlist)).toBe(false);
  });

  it("enforces allowlist when env var is 'FALSE' (wrong case)", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "FALSE" };
    
    expect(isRecipientAllowed("allowed@test-example.com", allowlist, env)).toBe(true);
    expect(isRecipientAllowed("notallowed@test-example.com", allowlist, env)).toBe(false);
  });

  it("enforces allowlist when env var is ' false ' (with spaces)", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: " false " };
    
    expect(isRecipientAllowed("allowed@test-example.com", allowlist, env)).toBe(true);
    expect(isRecipientAllowed("notallowed@test-example.com", allowlist, env)).toBe(false);
  });
});

describe("filterRecipients with enforcement flag", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows all addresses when enforcement is disabled", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" };
    
    const result = filterRecipients(
      ["allowed@test-example.com", "notallowed@test-example.com", "random@example.com"],
      allowlist,
      env
    );
    
    expect(result.allowed).toHaveLength(3);
    expect(result.skippedCount).toBe(0);
  });

  it("allows all addresses when enforcement is disabled and allowlist is empty", () => {
    const allowlist = parseRecipientAllowlist("");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" };
    
    const result = filterRecipients(
      ["buyer1@test-example.com", "buyer2@example.com"],
      allowlist,
      env
    );
    
    expect(result.allowed).toHaveLength(2);
    expect(result.skippedCount).toBe(0);
  });

  it("filters addresses when enforcement is enabled (default)", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    
    const result = filterRecipients(
      ["allowed@test-example.com", "notallowed@test-example.com"],
      allowlist
    );
    
    expect(result.allowed).toEqual(["allowed@test-example.com"]);
    expect(result.skippedCount).toBe(1);
  });

  it("skips all addresses when enforcement is enabled and allowlist is empty", () => {
    const allowlist = parseRecipientAllowlist("");
    
    const result = filterRecipients(
      ["buyer1@test-example.com", "buyer2@test-example.com"],
      allowlist
    );
    
    expect(result.allowed).toHaveLength(0);
    expect(result.skippedCount).toBe(2);
  });

  it("filters addresses when env var is 'FALSE' (wrong case)", () => {
    const allowlist = parseRecipientAllowlist("allowed@test-example.com");
    const env = { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "FALSE" };
    
    const result = filterRecipients(
      ["allowed@test-example.com", "notallowed@test-example.com"],
      allowlist,
      env
    );
    
    expect(result.allowed).toEqual(["allowed@test-example.com"]);
    expect(result.skippedCount).toBe(1);
  });
});
