/**
 * Tests for account-href.ts encoding helper.
 *
 * Verifies that buyer account ids containing '/' and ':' (e.g. seed ids
 * with embedded path separators) are properly encoded so they don't 404
 * into the catch-all route.
 */
import { describe, it, expect } from "vitest";
import { accountHref, normalizeAccountId } from "../account-href";

const TEST_ID_WITH_SLASHES = "seed-test-0000-example/part:9";
const SYNTHETIC_GID_ID = "gid://shopify/CompanyLocation/1001";

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

describe("normalizeAccountId", () => {
  it("returns simple id unchanged", () => {
    const id = "buyer-123";
    expect(normalizeAccountId(id)).toBe(id);
  });

  it("returns already-decoded GID-style id unchanged", () => {
    expect(normalizeAccountId(SYNTHETIC_GID_ID)).toBe(SYNTHETIC_GID_ID);
  });

  it("decodes single-encoded id (after double-encoding bug)", () => {
    const singleEncoded = encodeURIComponent(SYNTHETIC_GID_ID);
    expect(singleEncoded).toBe("gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001");

    const decoded = normalizeAccountId(singleEncoded);
    expect(decoded).toBe(SYNTHETIC_GID_ID);
  });

  it("decodes id with encoded slashes to original", () => {
    const encoded = "gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001";
    const decoded = normalizeAccountId(encoded);
    expect(decoded).toBe("gid://shopify/CompanyLocation/1001");
    expect(decoded).not.toContain("%");
  });

  it("round-trip: accountHref → single decode → normalizeAccountId = original", () => {
    const original = SYNTHETIC_GID_ID;
    const href = accountHref(original);
    const pathSegment = href.split("/").pop()!;
    const afterRouterDecode = decodeURIComponent(pathSegment);

    expect(normalizeAccountId(afterRouterDecode)).toBe(original);
  });

  it("handles double-encoding scenario: href → double encode → decode once → normalize = original", () => {
    const original = SYNTHETIC_GID_ID;

    const singleEncoded = encodeURIComponent(original);
    const doubleEncoded = encodeURIComponent(singleEncoded);

    const afterRouterDecode = decodeURIComponent(doubleEncoded);
    expect(afterRouterDecode).toBe(singleEncoded);

    const normalized = normalizeAccountId(afterRouterDecode);
    expect(normalized).toBe(original);
  });

  it("handles malformed percent sequences gracefully", () => {
    const malformed = "test%ZZ123";
    expect(normalizeAccountId(malformed)).toBe(malformed);
  });

  it("does not double-decode already-decoded id", () => {
    const id = "gid://shopify/CompanyLocation/1001";
    const normalized = normalizeAccountId(id);
    expect(normalized).toBe(id);

    const normalizedTwice = normalizeAccountId(normalized);
    expect(normalizedTwice).toBe(id);
  });
});
