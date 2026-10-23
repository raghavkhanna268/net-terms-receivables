/**
 * Lightweight webhook verification using Web Crypto.
 *
 * Validates Shopify webhook HMAC signatures without loading sessions or
 * touching the database. This is optimal for compliance webhooks where
 * the handler either:
 * - Needs no data (customers/data_request, customers/redact)
 * - Only needs to delete data (shop/redact)
 *
 * Benefits over authenticate.webhook():
 * - No session lookup (saves ~5-10ms DB round trip)
 * - No session validation/refresh logic
 * - Pure HMAC verification with Web Crypto (constant-time comparison)
 *
 * Security: Uses the same HMAC-SHA256 algorithm and constant-time comparison
 * as the Shopify library. Rejects invalid signatures with 401 Unauthorized.
 */

export interface WebhookVerifyResult {
  shop: string;
  topic: string;
  webhookId: string;
  payload: unknown;
  apiVersion: string;
  rawBody: ArrayBuffer;
}

export interface WebhookVerifyOptions {
  requireValidJson?: boolean;
}

const decoder = new TextDecoder();

/**
 * Shopify webhook header names (matches library constants).
 */
const WEBHOOK_HEADERS = {
  hmac: "X-Shopify-Hmac-Sha256",
  topic: "X-Shopify-Topic",
  domain: "X-Shopify-Shop-Domain",
  webhookId: "X-Shopify-Webhook-Id",
  apiVersion: "X-Shopify-API-Version",
} as const;

/**
 * Isolate-scoped cache for CryptoKey instances.
 * Keyed by API secret to avoid re-importing the key on every request.
 * importKey is relatively expensive (~0.5-1ms), so caching saves CPU.
 */
const cryptoKeyCache = new Map<string, CryptoKey>();

/**
 * Get or create a cached CryptoKey for HMAC-SHA256 signing.
 * The key is cached at isolate scope, keyed by the secret.
 */
async function getCryptoKey(secret: string): Promise<CryptoKey> {
  const cached = cryptoKeyCache.get(secret);
  if (cached) {
    return cached;
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );

  cryptoKeyCache.set(secret, key);
  return key;
}

/**
 * Compute HMAC-SHA256 over raw bytes using Web Crypto and return as base64.
 * Uses crypto.subtle for native performance on Cloudflare Workers.
 * Signs the raw bytes directly to avoid UTF-8 encoding mismatches.
 */
async function computeHmac(secret: string, rawBody: ArrayBuffer): Promise<string> {
  const key = await getCryptoKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, rawBody);
  return arrayBufferToBase64(signature);
}

/**
 * Convert ArrayBuffer to base64 string.
 * Avoids btoa() which doesn't work with binary data in all environments.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Compares all characters even after finding a mismatch.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Get HMAC header or throw 401 Unauthorized.
 * Shopify's App Store compliance check expects 401 for unauthenticated webhook calls.
 */
function getHmacHeader(request: Request): string {
  const value = request.headers.get(WEBHOOK_HEADERS.hmac);
  if (!value) {
    throw new Response(null, {
      status: 401,
      statusText: "Unauthorized",
    });
  }
  return value;
}

/**
 * Extract required header or throw 400 Bad Request.
 */
function getRequiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (!value) {
    throw new Response(null, {
      status: 400,
      statusText: `Missing required header: ${name}`,
    });
  }
  return value;
}

/**
 * Verify a Shopify webhook request using HMAC-SHA256.
 *
 * @param request - The incoming webhook request
 * @param apiSecret - The Shopify API secret for HMAC verification
 * @param options - Optional settings (requireValidJson for compliance topics)
 * @returns Verified webhook data including shop, topic, webhookId, and parsed payload
 * @throws Response with 401 if HMAC is invalid or missing, 400 if other headers missing or invalid JSON (when required), 405 if not POST
 */
export async function verifyWebhook(
  request: Request,
  apiSecret: string,
  options: WebhookVerifyOptions = {}
): Promise<WebhookVerifyResult> {
  if (request.method !== "POST") {
    throw new Response(null, {
      status: 405,
      statusText: "Method not allowed",
    });
  }

  const providedHmac = getHmacHeader(request);
  const topic = getRequiredHeader(request, WEBHOOK_HEADERS.topic);
  const shop = getRequiredHeader(request, WEBHOOK_HEADERS.domain);
  const webhookId = getRequiredHeader(request, WEBHOOK_HEADERS.webhookId);
  const apiVersion = getRequiredHeader(request, WEBHOOK_HEADERS.apiVersion);

  const rawBody = await request.arrayBuffer();
  const expectedHmac = await computeHmac(apiSecret, rawBody);

  if (!timingSafeEqual(providedHmac, expectedHmac)) {
    throw new Response(null, {
      status: 401,
      statusText: "Unauthorized",
    });
  }

  const bodyText = decoder.decode(new Uint8Array(rawBody));
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    if (options.requireValidJson) {
      throw new Response(null, {
        status: 400,
        statusText: "Invalid JSON payload",
      });
    }
    payload = {};
  }

  return {
    shop,
    topic,
    webhookId,
    payload,
    apiVersion,
    rawBody,
  };
}

/**
 * Convert Shopify's webhook topic format (e.g., "shop/redact") to the
 * enum-style format used by authenticate.webhook (e.g., "SHOP_REDACT").
 *
 * This maintains compatibility with existing handler switch statements.
 */
export function normalizeWebhookTopic(topic: string): string {
  return topic.replace(/\//g, "_").toUpperCase();
}
