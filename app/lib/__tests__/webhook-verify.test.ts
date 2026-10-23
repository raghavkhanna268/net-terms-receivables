import { describe, it, expect } from "vitest";
import {
  verifyWebhook,
  verifyPayloadShopMatch,
  normalizeWebhookTopic,
} from "../webhook-verify.server";

const TEST_API_SECRET = "test-api-secret-for-hmac-validation";
const TEST_SHOP = "test-shop.myshopify.com";

const encoder = new TextEncoder();

/**
 * Generate HMAC-SHA256 signature over raw bytes using Web Crypto.
 * This matches how production code signs payloads.
 */
async function generateHmacFromBytes(secret: string, bodyBytes: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, bodyBytes);
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Generate HMAC from a string body (convenience wrapper).
 */
async function generateHmac(secret: string, body: string): Promise<string> {
  return generateHmacFromBytes(secret, encoder.encode(body).buffer as ArrayBuffer);
}

/**
 * Create a mock webhook request with traditional X-Shopify-* headers.
 */
function createWebhookRequest(
  body: string,
  topic: string,
  hmac: string,
  webhookId = "test-webhook-id-123",
  shop = TEST_SHOP
): Request {
  return new Request("https://example.com/webhooks/compliance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Webhook-Id": webhookId,
      "X-Shopify-API-Version": "2026-10",
    },
    body,
  });
}

/**
 * Create a mock webhook request with event-style shopify-* headers.
 */
function createEventsWebhookRequest(
  body: string,
  topic: string,
  hmac: string,
  webhookId = "test-webhook-id-123",
  shop = TEST_SHOP
): Request {
  return new Request("https://example.com/webhooks/compliance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "shopify-topic": topic,
      "shopify-shop-domain": shop,
      "shopify-hmac-sha256": hmac,
      "shopify-webhook-id": webhookId,
      "shopify-api-version": "2026-10",
    },
    body,
  });
}

describe("verifyWebhook", () => {
  describe("HMAC verification", () => {
    it("accepts valid HMAC signature", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "shop/redact", hmac);

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.shop).toBe(TEST_SHOP);
      expect(result.topic).toBe("shop/redact");
      expect(result.webhookId).toBe("test-webhook-id-123");
      expect(result.payload).toEqual({ shop_id: 123 });
    });

    it("rejects invalid HMAC signature with 401", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const request = createWebhookRequest(body, "shop/redact", "invalid-hmac");

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("rejects HMAC signed with wrong secret", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac("wrong-secret", body);
      const request = createWebhookRequest(body, "shop/redact", hmac);

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("rejects tampered body with original HMAC", async () => {
      const originalBody = JSON.stringify({ shop_id: 123 });
      const tamperedBody = JSON.stringify({ shop_id: 999 });
      const hmac = await generateHmac(TEST_API_SECRET, originalBody);
      const request = createWebhookRequest(tamperedBody, "shop/redact", hmac);

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("correctly handles non-ASCII payload (Hindi company name)", async () => {
      const payload = {
        shop_id: 456,
        company_name: "भारतीय कंपनी",
        customer: { name: "राहुल शर्मा" },
      };
      const body = JSON.stringify(payload);
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "customers/data_request", hmac);

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.payload).toEqual(payload);
      expect((result.payload as typeof payload).company_name).toBe("भारतीय कंपनी");
    });

    it("verifies HMAC over raw bytes to avoid UTF-8 round-trip mismatch", async () => {
      const body = JSON.stringify({ emoji: "🎉", japanese: "日本語" });
      const bodyBytes = encoder.encode(body);
      const hmac = await generateHmacFromBytes(TEST_API_SECRET, bodyBytes.buffer as ArrayBuffer);
      const request = createWebhookRequest(body, "shop/redact", hmac);

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.payload).toEqual({ emoji: "🎉", japanese: "日本語" });
    });
  });

  describe("method validation", () => {
    it("rejects non-POST requests with 405", async () => {
      const request = new Request("https://example.com/webhooks/compliance", {
        method: "GET",
      });

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(405);
      }
    });
  });

  describe("header validation", () => {
    it("rejects request missing HMAC header with 401 (Shopify compliance)", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "X-Shopify-Topic": "shop/redact",
          "X-Shopify-Shop-Domain": TEST_SHOP,
          "X-Shopify-Webhook-Id": "test-id",
          "X-Shopify-API-Version": "2026-10",
        },
        body,
      });

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("rejects request missing shop domain header with 400", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "X-Shopify-Topic": "shop/redact",
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "test-id",
          "X-Shopify-API-Version": "2026-10",
        },
        body,
      });

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }
    });
  });

  describe("shop domain validation", () => {
    it("accepts valid shop domain format", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "shop/redact", hmac, "test-id", "my-shop123.myshopify.com");

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.shop).toBe("my-shop123.myshopify.com");
    });

    it("rejects shop domain without .myshopify.com suffix", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "shop/redact", hmac, "test-id", "malicious.com");

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
        expect((error as Response).statusText).toBe("Invalid shop domain format");
      }
    });

    it("rejects shop domain starting with hyphen", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "shop/redact", hmac, "test-id", "-invalid.myshopify.com");

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }
    });

    it("rejects shop domain with uppercase letters", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "shop/redact", hmac, "test-id", "MyShop.myshopify.com");

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }
    });

    it("rejects shop domain with special characters", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "shop/redact", hmac, "test-id", "shop_name.myshopify.com");

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
      }
    });
  });

  describe("event-style headers (shopify-*)", () => {
    it("accepts valid HMAC with event-style headers", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createEventsWebhookRequest(body, "shop/redact", hmac);

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.shop).toBe(TEST_SHOP);
      expect(result.topic).toBe("shop/redact");
    });

    it("rejects invalid HMAC with event-style headers", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const request = createEventsWebhookRequest(body, "shop/redact", "invalid-hmac");

      try {
        await verifyWebhook(request, TEST_API_SECRET);
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }
    });

    it("event-style headers take precedence over traditional headers", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "shopify-topic": "events/topic",
          "shopify-shop-domain": "events-shop.myshopify.com",
          "shopify-hmac-sha256": hmac,
          "shopify-webhook-id": "events-id",
          "shopify-api-version": "2026-10",
          "X-Shopify-Topic": "traditional/topic",
          "X-Shopify-Shop-Domain": "traditional-shop.myshopify.com",
          "X-Shopify-Hmac-Sha256": "traditional-hmac",
          "X-Shopify-Webhook-Id": "traditional-id",
          "X-Shopify-API-Version": "2025-01",
        },
        body,
      });

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.shop).toBe("events-shop.myshopify.com");
      expect(result.topic).toBe("events/topic");
      expect(result.webhookId).toBe("events-id");
    });

    it("falls back to traditional headers when event-style HMAC is missing", async () => {
      const body = JSON.stringify({ shop_id: 123 });
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "traditional/topic",
          "X-Shopify-Shop-Domain": TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "traditional-id",
          "X-Shopify-API-Version": "2026-10",
        },
        body,
      });

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.topic).toBe("traditional/topic");
      expect(result.webhookId).toBe("traditional-id");
    });
  });

  describe("payload parsing", () => {
    it("returns parsed JSON payload", async () => {
      const payload = { shop_id: 123, customer: { id: 456 } };
      const body = JSON.stringify(payload);
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "customers/redact", hmac);

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.payload).toEqual(payload);
    });

    it("returns empty object for invalid JSON when requireValidJson is false", async () => {
      const body = "not-valid-json";
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "app/uninstalled", hmac);

      const result = await verifyWebhook(request, TEST_API_SECRET);

      expect(result.payload).toEqual({});
    });

    it("throws 400 for invalid JSON when requireValidJson is true", async () => {
      const body = "not-valid-json";
      const hmac = await generateHmac(TEST_API_SECRET, body);
      const request = createWebhookRequest(body, "customers/redact", hmac);

      try {
        await verifyWebhook(request, TEST_API_SECRET, { requireValidJson: true });
        expect.fail("Expected verifyWebhook to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
        expect((error as Response).statusText).toBe("Invalid JSON payload");
      }
    });
  });
});

describe("normalizeWebhookTopic", () => {
  it("converts shop/redact to SHOP_REDACT", () => {
    expect(normalizeWebhookTopic("shop/redact")).toBe("SHOP_REDACT");
  });

  it("converts customers/data_request to CUSTOMERS_DATA_REQUEST", () => {
    expect(normalizeWebhookTopic("customers/data_request")).toBe("CUSTOMERS_DATA_REQUEST");
  });

  it("converts customers/redact to CUSTOMERS_REDACT", () => {
    expect(normalizeWebhookTopic("customers/redact")).toBe("CUSTOMERS_REDACT");
  });

  it("converts app/uninstalled to APP_UNINSTALLED", () => {
    expect(normalizeWebhookTopic("app/uninstalled")).toBe("APP_UNINSTALLED");
  });

  it("handles already uppercase topics", () => {
    expect(normalizeWebhookTopic("SHOP_REDACT")).toBe("SHOP_REDACT");
  });
});

describe("verifyPayloadShopMatch", () => {
  it("returns payload shop_domain when it matches header shop", () => {
    const payload = { shop_domain: "test-shop.myshopify.com", shop_id: 123 };
    const result = verifyPayloadShopMatch("test-shop.myshopify.com", payload);
    expect(result).toBe("test-shop.myshopify.com");
  });

  it("throws 400 when payload shop_domain is missing", () => {
    const payload = { shop_id: 123 };
    try {
      verifyPayloadShopMatch("test-shop.myshopify.com", payload);
      expect.fail("Expected verifyPayloadShopMatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(400);
      expect((error as Response).statusText).toBe("Missing shop_domain in payload");
    }
  });

  it("throws 401 when payload shop_domain does not match header", () => {
    const payload = { shop_domain: "other-shop.myshopify.com", shop_id: 123 };
    try {
      verifyPayloadShopMatch("test-shop.myshopify.com", payload);
      expect.fail("Expected verifyPayloadShopMatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(401);
      expect((error as Response).statusText).toBe("Payload shop_domain does not match header shop");
    }
  });

  it("throws 400 when payload is null", () => {
    try {
      verifyPayloadShopMatch("test-shop.myshopify.com", null);
      expect.fail("Expected verifyPayloadShopMatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(400);
    }
  });
});
