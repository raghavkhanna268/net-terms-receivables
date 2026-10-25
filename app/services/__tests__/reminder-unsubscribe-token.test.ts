/**
 * Unit tests for reminder unsubscribe token module (S18 #232).
 *
 * Tests:
 * - Token generation and verification
 * - Tampered tokens rejected (constant-time comparison)
 * - Missing/invalid secret handling
 * - URL building
 *
 * Uses obviously fake secret values for testing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
}));

import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  isUnsubscribeSecretConfigured,
  buildUnsubscribeUrl,
  logUnsubscribeSecretMissing,
} from "../reminder-unsubscribe-token.server";
import { safeLog } from "~/lib/log.server";

const mockSafeLog = vi.mocked(safeLog);

const FAKE_SECRET = "test-secret-obviously-fake-for-testing-only";
const TEST_SHOP_ID = "shop-token-test";
const TEST_BUYER_ID = "buyer-token-test";

describe("reminder unsubscribe token module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("generateUnsubscribeToken", () => {
    it("returns null when secret is undefined", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, undefined);
      expect(token).toBeNull();
    });

    it("returns null when secret is empty string", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, "");
      expect(token).toBeNull();
    });

    it("generates a valid base64url token with signature", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);

      expect(token).not.toBeNull();
      // Token format is: payload.signature (both base64url encoded)
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    });

    it("generates different tokens for different buyers", () => {
      const token1 = generateUnsubscribeToken(TEST_SHOP_ID, "buyer-1", FAKE_SECRET);
      const token2 = generateUnsubscribeToken(TEST_SHOP_ID, "buyer-2", FAKE_SECRET);

      expect(token1).not.toBeNull();
      expect(token2).not.toBeNull();
      expect(token1).not.toBe(token2);
    });

    it("generates different tokens for different shops", () => {
      const token1 = generateUnsubscribeToken("shop-1", TEST_BUYER_ID, FAKE_SECRET);
      const token2 = generateUnsubscribeToken("shop-2", TEST_BUYER_ID, FAKE_SECRET);

      expect(token1).not.toBeNull();
      expect(token2).not.toBeNull();
      expect(token1).not.toBe(token2);
    });

    it("generates same token for same inputs (deterministic)", () => {
      const token1 = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const token2 = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);

      expect(token1).toBe(token2);
    });
  });

  describe("verifyUnsubscribeToken", () => {
    it("returns null when secret is undefined", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const payload = verifyUnsubscribeToken(token!, undefined);

      expect(payload).toBeNull();
    });

    it("returns null when secret is empty", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const payload = verifyUnsubscribeToken(token!, "");

      expect(payload).toBeNull();
    });

    it("returns payload for valid token", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const payload = verifyUnsubscribeToken(token!, FAKE_SECRET);

      expect(payload).not.toBeNull();
      expect(payload!.shopId).toBe(TEST_SHOP_ID);
      expect(payload!.buyerAccountId).toBe(TEST_BUYER_ID);
    });

    it("rejects token with modified payload", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      
      // Decode, modify, re-encode
      const decoded = Buffer.from(token!, "base64url");
      const modified = Buffer.concat([decoded.slice(0, 10), Buffer.from("X"), decoded.slice(11)]);
      const tamperedToken = modified.toString("base64url");

      const payload = verifyUnsubscribeToken(tamperedToken, FAKE_SECRET);
      expect(payload).toBeNull();
    });

    it("rejects token with modified signature", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      
      // Modify last character of token (signature)
      const tamperedToken = token!.slice(0, -1) + (token!.slice(-1) === "A" ? "B" : "A");

      const payload = verifyUnsubscribeToken(tamperedToken, FAKE_SECRET);
      expect(payload).toBeNull();
    });

    it("rejects token signed with different secret", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const payload = verifyUnsubscribeToken(token!, "different-secret");

      expect(payload).toBeNull();
    });

    it("rejects malformed base64url token", () => {
      const payload = verifyUnsubscribeToken("not-valid-base64!!!", FAKE_SECRET);
      expect(payload).toBeNull();
    });

    it("rejects empty token", () => {
      const payload = verifyUnsubscribeToken("", FAKE_SECRET);
      expect(payload).toBeNull();
    });

    it("rejects truncated token", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const truncated = token!.slice(0, Math.floor(token!.length / 2));

      const payload = verifyUnsubscribeToken(truncated, FAKE_SECRET);
      expect(payload).toBeNull();
    });
  });

  describe("isUnsubscribeSecretConfigured", () => {
    it("returns true when secret is non-empty in env object", () => {
      expect(isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: FAKE_SECRET })).toBe(true);
    });

    it("returns false when secret is undefined in env object", () => {
      expect(isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: undefined })).toBe(false);
    });

    it("returns false when secret is empty string in env object", () => {
      expect(isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: "" })).toBe(false);
    });

    it("returns false when env object is empty", () => {
      expect(isUnsubscribeSecretConfigured({})).toBe(false);
    });
  });

  describe("buildUnsubscribeUrl", () => {
    it("builds correct URL with token", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const url = buildUnsubscribeUrl("https://example.com", token!);

      expect(url).toBe(`https://example.com/unsubscribe?token=${token}`);
    });

    it("handles trailing slash in base URL", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, FAKE_SECRET);
      const url = buildUnsubscribeUrl("https://example.com/", token!);

      expect(url).toBe(`https://example.com/unsubscribe?token=${token}`);
    });
  });

  describe("logUnsubscribeSecretMissing", () => {
    it("logs warning with shopId and invoiceCount only (no PII)", () => {
      logUnsubscribeSecretMissing(TEST_SHOP_ID, 5);

      expect(mockSafeLog).toHaveBeenCalledWith(
        "warn",
        "reminder_unsubscribe_secret_missing",
        { shopId: TEST_SHOP_ID, invoiceCount: 5, secretConfigured: false }
      );
      
      const logCall = mockSafeLog.mock.calls[0];
      expect(logCall[2]).not.toHaveProperty("buyerAccountId");
      expect(logCall[2]).not.toHaveProperty("token");
      expect(logCall[2]).not.toHaveProperty("email");
    });
  });
});
