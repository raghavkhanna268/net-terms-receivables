/**
 * Unit tests for reminder headers module (S18 #232).
 *
 * Tests RFC 8058 header generation for Resend.
 */
import { describe, it, expect, vi } from "vitest";
import { buildUnsubscribeHeaders, canGenerateUnsubscribeHeaders } from "../reminder-headers.server";

const TEST_BASE_URL = "https://example.com";
const TEST_SHOP_ID = "shop-headers-test";
const TEST_BUYER_ID = "buyer-headers-test";
const FAKE_SECRET = "test-secret-obviously-fake-for-testing-only";

describe("buildUnsubscribeHeaders", () => {
  it("returns correct List-Unsubscribe header with angle brackets", () => {
    const headers = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);

    expect(headers).not.toBeNull();
    expect(headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/example\.com\/unsubscribe\?token=.+>$/);
  });

  it("returns exact List-Unsubscribe-Post header value", () => {
    const headers = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);

    expect(headers).not.toBeNull();
    expect(headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("returns object with exactly two keys", () => {
    const headers = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);

    expect(headers).not.toBeNull();
    expect(Object.keys(headers!)).toHaveLength(2);
    expect(headers).toHaveProperty("List-Unsubscribe");
    expect(headers).toHaveProperty("List-Unsubscribe-Post");
  });

  it("returns null when secret is missing", () => {
    const headers = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, TEST_BUYER_ID, undefined);

    expect(headers).toBeNull();
  });

  it("returns null when secret is empty string", () => {
    const headers = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, TEST_BUYER_ID, "");

    expect(headers).toBeNull();
  });

  it("headers are compatible with Resend API", () => {
    const headers = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);

    expect(headers).not.toBeNull();
    // Resend expects string values, not arrays
    expect(typeof headers!["List-Unsubscribe"]).toBe("string");
    expect(typeof headers!["List-Unsubscribe-Post"]).toBe("string");
  });

  it("generates different URLs for different buyers", () => {
    const headers1 = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, "buyer-1", FAKE_SECRET);
    const headers2 = buildUnsubscribeHeaders(TEST_BASE_URL, TEST_SHOP_ID, "buyer-2", FAKE_SECRET);

    expect(headers1).not.toBeNull();
    expect(headers2).not.toBeNull();
    expect(headers1!["List-Unsubscribe"]).not.toBe(headers2!["List-Unsubscribe"]);
  });
});

describe("canGenerateUnsubscribeHeaders", () => {
  it("returns true when secret is configured", () => {
    expect(canGenerateUnsubscribeHeaders({ REMINDER_UNSUBSCRIBE_SECRET: FAKE_SECRET })).toBe(true);
  });

  it("returns false when secret is missing", () => {
    vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", "");
    expect(canGenerateUnsubscribeHeaders({})).toBe(false);
  });

  it("returns false when secret is empty", () => {
    expect(canGenerateUnsubscribeHeaders({ REMINDER_UNSUBSCRIBE_SECRET: "" })).toBe(false);
  });
});
