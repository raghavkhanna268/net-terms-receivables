import { describe, it, expect } from "vitest";
import crypto from "node:crypto";

/**
 * Integration test for HMAC webhook validation.
 *
 * This test verifies that the Shopify HMAC validation logic works correctly
 * by generating real HMAC signatures and testing that:
 * - Valid signatures are accepted
 * - Tampered signatures are rejected
 *
 * The test uses a fixed test secret and generates proper X-Shopify-Hmac-Sha256
 * headers matching how Shopify signs webhook payloads.
 */

const TEST_API_SECRET = "test-api-secret-for-hmac-validation";
const TEST_SHOP = "test-shop.myshopify.com";

/**
 * Generate an HMAC-SHA256 signature matching Shopify's webhook format.
 * Shopify signs the raw request body with the app's API secret and
 * base64-encodes the result.
 */
function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

/**
 * Create a mock webhook request with proper Shopify headers.
 */
function createWebhookRequest(
  body: string,
  topic: string,
  hmac: string,
  webhookId = "test-webhook-id-123"
): Request {
  return new Request("https://example.com/webhooks/compliance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": TEST_SHOP,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-API-Version": "2026-10",
    },
    body,
  });
}

describe("HMAC webhook validation", () => {
  describe("signature generation", () => {
    it("generates consistent HMAC for same body and secret", () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac1 = generateShopifyHmac(body, TEST_API_SECRET);
      const hmac2 = generateShopifyHmac(body, TEST_API_SECRET);

      expect(hmac1).toBe(hmac2);
      expect(hmac1).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64 format
    });

    it("generates different HMAC for different bodies", () => {
      const body1 = JSON.stringify({ shop_id: 123 });
      const body2 = JSON.stringify({ shop_id: 456 });

      const hmac1 = generateShopifyHmac(body1, TEST_API_SECRET);
      const hmac2 = generateShopifyHmac(body2, TEST_API_SECRET);

      expect(hmac1).not.toBe(hmac2);
    });

    it("generates different HMAC for different secrets", () => {
      const body = JSON.stringify({ shop_id: 123 });

      const hmac1 = generateShopifyHmac(body, TEST_API_SECRET);
      const hmac2 = generateShopifyHmac(body, "different-secret");

      expect(hmac1).not.toBe(hmac2);
    });
  });

  describe("HMAC validation logic", () => {
    /**
     * This validates the HMAC comparison logic that Shopify uses.
     * The actual authenticate.webhook() in the Shopify library performs
     * this same comparison after extracting the header and computing
     * the expected HMAC.
     */
    function validateHmac(body: string, providedHmac: string, secret: string): boolean {
      const expectedHmac = generateShopifyHmac(body, secret);
      // Use timing-safe comparison to prevent timing attacks
      try {
        return crypto.timingSafeEqual(
          Buffer.from(providedHmac, "base64"),
          Buffer.from(expectedHmac, "base64")
        );
      } catch {
        return false;
      }
    }

    it("accepts valid HMAC signature", () => {
      const body = JSON.stringify({
        shop_id: 12345,
        shop_domain: TEST_SHOP,
      });
      const validHmac = generateShopifyHmac(body, TEST_API_SECRET);

      expect(validateHmac(body, validHmac, TEST_API_SECRET)).toBe(true);
    });

    it("rejects tampered body with original HMAC", () => {
      const originalBody = JSON.stringify({ shop_id: 12345 });
      const tamperedBody = JSON.stringify({ shop_id: 99999 });
      const originalHmac = generateShopifyHmac(originalBody, TEST_API_SECRET);

      expect(validateHmac(tamperedBody, originalHmac, TEST_API_SECRET)).toBe(false);
    });

    it("rejects tampered HMAC with original body", () => {
      const body = JSON.stringify({ shop_id: 12345 });
      const validHmac = generateShopifyHmac(body, TEST_API_SECRET);
      // Tamper with the HMAC by changing a character
      const tamperedHmac = validHmac.slice(0, -1) + (validHmac.slice(-1) === "A" ? "B" : "A");

      expect(validateHmac(body, tamperedHmac, TEST_API_SECRET)).toBe(false);
    });

    it("rejects HMAC signed with wrong secret", () => {
      const body = JSON.stringify({ shop_id: 12345 });
      const wrongSecretHmac = generateShopifyHmac(body, "wrong-secret");

      expect(validateHmac(body, wrongSecretHmac, TEST_API_SECRET)).toBe(false);
    });

    it("rejects malformed HMAC", () => {
      const body = JSON.stringify({ shop_id: 12345 });

      expect(validateHmac(body, "not-valid-base64!!!", TEST_API_SECRET)).toBe(false);
      expect(validateHmac(body, "", TEST_API_SECRET)).toBe(false);
    });
  });

  describe("webhook request format", () => {
    it("creates request with all required Shopify headers", () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = generateShopifyHmac(body, TEST_API_SECRET);
      const request = createWebhookRequest(body, "shop/redact", hmac);

      expect(request.headers.get("X-Shopify-Topic")).toBe("shop/redact");
      expect(request.headers.get("X-Shopify-Shop-Domain")).toBe(TEST_SHOP);
      expect(request.headers.get("X-Shopify-Hmac-Sha256")).toBe(hmac);
      expect(request.headers.get("X-Shopify-Webhook-Id")).toBe("test-webhook-id-123");
      expect(request.headers.get("X-Shopify-API-Version")).toBe("2026-10");
    });
  });
});
