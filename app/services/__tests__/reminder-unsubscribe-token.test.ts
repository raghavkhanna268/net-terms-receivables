/**
 * Unit tests for reminder unsubscribe token module (S18 #232).
 *
 * Tests:
 * - Token generation and verification
 * - Tampered tokens rejected (constant-time comparison)
 * - Missing/invalid secret handling
 * - URL building
 * - Wrong-purpose token rejected
 *
 * Uses obviously fake secret values for testing.
 * Uses console spies for safeLog assertions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  isUnsubscribeSecretConfigured,
  buildUnsubscribeUrl,
  logUnsubscribeSecretMissing,
} from "../reminder-unsubscribe-token.server";

let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

/**
 * Create a token with a different purpose to test purpose validation.
 * This mimics an attacker trying to reuse a token from another context.
 */
function createWrongPurposeToken(
  shopId: string,
  buyerAccountId: string,
  secret: string
): string {
  const payload = {
    v: 1,
    p: "wrong-purpose-v1", // Wrong purpose
    s: shopId,
    b: buyerAccountId,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payloadBase64)
    .digest("base64url");
  return `${payloadBase64}.${signature}`;
}

const FAKE_SECRET = "test-secret-obviously-fake-for-testing-only";
const TEST_SHOP_ID = "shop-token-test";
const TEST_BUYER_ID = "buyer-token-test";

describe("reminder unsubscribe token module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
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

    it("rejects token with wrong purpose (prevents cross-context reuse)", () => {
      const wrongPurposeToken = createWrongPurposeToken(
        TEST_SHOP_ID,
        TEST_BUYER_ID,
        FAKE_SECRET
      );

      const payload = verifyUnsubscribeToken(wrongPurposeToken, FAKE_SECRET);
      expect(payload).toBeNull();
    });

    it("rejects token with wrong version", () => {
      const payload = {
        v: 999, // Wrong version
        p: "reminder-unsubscribe-v1",
        s: TEST_SHOP_ID,
        b: TEST_BUYER_ID,
      };
      const payloadBase64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signature = createHmac("sha256", FAKE_SECRET)
        .update(payloadBase64)
        .digest("base64url");
      const wrongVersionToken = `${payloadBase64}.${signature}`;

      const result = verifyUnsubscribeToken(wrongVersionToken, FAKE_SECRET);
      expect(result).toBeNull();
    });
  });

  describe("isUnsubscribeSecretConfigured", () => {
    it("returns true when secret is non-empty in env object", () => {
      expect(isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: FAKE_SECRET })).toBe(true);
    });

    it("returns false when secret is undefined in env object (process.env also cleared)", () => {
      vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", "");
      expect(isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: undefined })).toBe(false);
    });

    it("returns false when secret is empty string in env object", () => {
      expect(isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: "" })).toBe(false);
    });

    it("returns false when env object is empty (process.env also cleared)", () => {
      vi.stubEnv("REMINDER_UNSUBSCRIBE_SECRET", "");
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

      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      const logCall = JSON.parse(consoleWarnSpy.mock.calls[0][0] as string);
      expect(logCall.event).toBe("reminder_unsubscribe_secret_missing");
      expect(logCall.shopId).toBe(TEST_SHOP_ID);
      expect(logCall.invoiceCount).toBe(5);
      expect(logCall.reason).toBe("secret_missing");
      expect(logCall).not.toHaveProperty("buyerAccountId");
      expect(logCall).not.toHaveProperty("token");
      expect(logCall).not.toHaveProperty("email");
    });
  });

  describe("dual-key verification for secret rotation", () => {
    const CURRENT_SECRET = "current-secret-obviously-fake";
    const PREVIOUS_SECRET = "previous-secret-obviously-fake";

    it("(a) token signed with current key verifies", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, CURRENT_SECRET);
      const payload = verifyUnsubscribeToken(token!, CURRENT_SECRET);

      expect(payload).not.toBeNull();
      expect(payload!.shopId).toBe(TEST_SHOP_ID);
      expect(payload!.buyerAccountId).toBe(TEST_BUYER_ID);
    });

    it("(b) token signed with old key verifies when PREVIOUS = old key", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, PREVIOUS_SECRET);
      const payload = verifyUnsubscribeToken(token!, CURRENT_SECRET, PREVIOUS_SECRET);

      expect(payload).not.toBeNull();
      expect(payload!.shopId).toBe(TEST_SHOP_ID);
      expect(payload!.buyerAccountId).toBe(TEST_BUYER_ID);
    });

    it("(c) old-key token FAILS when PREVIOUS is unset", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, PREVIOUS_SECRET);
      const payload = verifyUnsubscribeToken(token!, CURRENT_SECRET);

      expect(payload).toBeNull();
    });

    it("(d) new tokens are signed with current, not previous", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, CURRENT_SECRET);

      const verifiesWithCurrent = verifyUnsubscribeToken(token!, CURRENT_SECRET);
      expect(verifiesWithCurrent).not.toBeNull();

      const verifiesWithPreviousAlone = verifyUnsubscribeToken(token!, PREVIOUS_SECRET);
      expect(verifiesWithPreviousAlone).toBeNull();
    });

    it("(e) tampered token fails under both keys", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, CURRENT_SECRET);
      const tamperedToken = token!.slice(0, -1) + (token!.slice(-1) === "A" ? "B" : "A");

      const payloadCurrent = verifyUnsubscribeToken(tamperedToken, CURRENT_SECRET);
      const payloadBoth = verifyUnsubscribeToken(tamperedToken, CURRENT_SECRET, PREVIOUS_SECRET);

      expect(payloadCurrent).toBeNull();
      expect(payloadBoth).toBeNull();
    });

    it("ignores empty previousSecret", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, PREVIOUS_SECRET);
      const payload = verifyUnsubscribeToken(token!, CURRENT_SECRET, "");

      expect(payload).toBeNull();
    });

    it("ignores whitespace-only previousSecret", () => {
      const token = generateUnsubscribeToken(TEST_SHOP_ID, TEST_BUYER_ID, PREVIOUS_SECRET);
      const payload = verifyUnsubscribeToken(token!, CURRENT_SECRET, "   ");

      expect(payload).toBeNull();
    });
  });
});
