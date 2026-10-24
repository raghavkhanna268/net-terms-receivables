/**
 * Gap 4 fixture: Real-looking tokens and domains in test files
 *
 * This fixture tests that the guard correctly identifies:
 * 1. Real-looking tokens (shpat_ + 32 hex chars)
 * 2. Real-looking domains (not in the fake domain allowlist)
 *
 * IMPORTANT: Real-looking values are built via string concatenation
 * so the repo never contains a literal real-looking token/domain.
 */

import { describe, it, expect } from "vitest";

describe("P1: token and domain detection", () => {
  // SHOULD FAIL: Real-looking token (32 random-looking hex chars)
  // Built via concatenation so the literal is never in the repo
  it("flags real-looking token", () => {
    const prefix = "shpat_";
    const body = "a1b2c3d4e5f6" + "7890abcd" + "ef123456" + "7890abcd";
    const realToken = prefix + body;
    expect(realToken).toBeDefined();
  });

  // SHOULD FAIL: Real merchant domain (not in fake allowlist)
  it("flags real-looking domain", () => {
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

  // OK: Fake domain (starts with test-)
  it("allows fake domain - test prefix", () => {
    const domain = "test-shop.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (starts with example)
  it("allows fake domain - example prefix", () => {
    const domain = "example.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Fake domain (placeholder prefix)
  it("allows fake domain - placeholder prefix", () => {
    const domain = "placeholder-store.myshopify.com";
    expect(domain).toBeDefined();
  });

  // OK: Template interpolation
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
