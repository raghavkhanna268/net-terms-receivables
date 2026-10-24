/**
 * Gap 4 fixture: Real-looking tokens and domains in test files
 *
 * This fixture tests that the guard correctly identifies:
 * 1. Real-looking tokens (shpat_ + 32 hex chars)
 * 2. Real-looking domains (not in the fake domain allowlist)
 *
 * NOTE: The guard does text-based scanning, so values built at runtime
 * via concatenation are NOT detectable (correctly so - they're not in source).
 */

import { describe, it, expect } from "vitest";

describe("P1: token and domain detection", () => {
  // NOT DETECTABLE: Runtime-built token - guard correctly ignores this
  // because the 32-hex token is never a literal in the source code
  it("runtime-built token is not detectable (expected)", () => {
    const prefix = "shpat_";
    const body = "a1b2c3d4e5f6" + "7890abcd" + "ef123456" + "7890abcd";
    const realToken = prefix + body;
    expect(realToken).toBeDefined();
  });

  // NOT DETECTABLE: Runtime-built domain - guard correctly ignores this
  // because the domain is assembled at runtime, not a literal in source
  it("runtime-built domain is not detectable (expected)", () => {
    const merchant = "bright" + "furniture";
    const domain = `${merchant}.myshopify.com`;
    expect(domain).toBeDefined();
  });

  // OK: Fake token (synthetic body with repeated chars)
  it("allows synthetic token - repeated chars", () => {
    const token = "shpat_" + "a".repeat(32);
    expect(token).toBeDefined();
  });

  // OK: Fake token (contains 'test')
  it("allows synthetic token - contains test", () => {
    const token = "shpat_test_token_12345678901234567";
    expect(token).toBeDefined();
  });

  // OK: Fake domain (exact match: test)
  it("allows fake domain - exact test", () => {
    const domain = "test.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (test- prefix with boundary)
  it("allows fake domain - test- prefix", () => {
    const domain = "test-shop.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (exact match: example)
  it("allows fake domain - exact example", () => {
    const domain = "example.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (example- prefix)
  it("allows fake domain - example- prefix", () => {
    const domain = "example-store.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (exact match: sentinel)
  it("allows fake domain - exact sentinel", () => {
    const domain = "sentinel.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (sentinel- prefix)
  it("allows fake domain - sentinel- prefix", () => {
    const domain = "sentinel-shop.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (s##- test suite prefix)
  it("allows fake domain - s##- prefix", () => {
    const domain = "s20-test.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Template interpolation (no literal subdomain)
  it("allows template domain", () => {
    const id = "123";
    const domain = `${id}.myshopify.com`;
    expect(domain).toBeDefined();
  });

  // OK: Short token (not 32 chars)
  it("allows short token", () => {
    const token = "shpat_1234567890";
    expect(token).toBeDefined();
  });

  // OK: Sequential token
  it("allows sequential token", () => {
    const token = "shpat_01234567890123456789012345678901";
    expect(token).toBeDefined();
  });
});
