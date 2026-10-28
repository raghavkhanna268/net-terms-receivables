/**
 * Tests for account-href.ts encoding helper.
 *
 * Verifies that buyer account ids containing '/' and ':' (e.g. seed ids
 * with embedded path separators) are properly encoded so they don't 404
 * into the catch-all route.
 */
import { describe, it, expect } from "vitest";
import { accountHref } from "../account-href";

const TEST_ID_WITH_SLASHES = "seed-test-0000-example/part:9";

describe("accountHref", () => {
  it("encodes a simple id", () => {
    const href = accountHref("buyer-123");
    expect(href).toBe("/app/accounts/buyer-123");
  });

  it("encodes an id containing '/' and ':'", () => {
    const href = accountHref(TEST_ID_WITH_SLASHES);
    expect(href).toBe(`/app/accounts/${encodeURIComponent(TEST_ID_WITH_SLASHES)}`);
    expect(href).toContain("%2F");
    expect(href).toContain("%3A");
    expect(href).not.toContain("/part");
  });

  it("encodes a seed-style id with multiple path separators", () => {
    const seedId = "seed-account-shop123-loc://internal/location/456";
    const href = accountHref(seedId);
    expect(href).toBe(`/app/accounts/${encodeURIComponent(seedId)}`);
    expect(href).not.toMatch(/\/internal\//);
  });

  it("returns a single path segment after /app/accounts/", () => {
    const href = accountHref(TEST_ID_WITH_SLASHES);
    const segments = href.split("/").filter(Boolean);
    expect(segments).toHaveLength(3);
    expect(segments).toEqual(["app", "accounts", encodeURIComponent(TEST_ID_WITH_SLASHES)]);
  });
});
