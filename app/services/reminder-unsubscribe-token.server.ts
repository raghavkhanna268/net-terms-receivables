/**
 * Signed token helpers for reminder unsubscribe links (S18 #232).
 *
 * Implements RFC 8058 one-click unsubscribe with HMAC-SHA256 signed tokens.
 * The token binds shopId, buyerAccountId, and a fixed purpose string to
 * prevent token reuse across different contexts.
 *
 * Security:
 * - HMAC-SHA256 signature using REMINDER_UNSUBSCRIBE_SECRET (env only, never in code)
 * - Constant-time comparison to prevent timing attacks
 * - Purpose string prevents token reuse in other contexts
 * - No PII in the token (only IDs)
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8058
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { safeLog } from "~/lib/log.server";

/**
 * Verify HMAC signature with constant-time comparison.
 */
function verifySignature(payloadBase64: string, sig: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payloadBase64).digest("base64url");
  const pBuf = Buffer.from(sig, "utf8");
  const eBuf = Buffer.from(expected, "utf8");
  return pBuf.length === eBuf.length && timingSafeEqual(pBuf, eBuf);
}

/**
 * Purpose string included in the token payload.
 * Prevents tokens from being reused in other contexts.
 */
const TOKEN_PURPOSE = "reminder-unsubscribe-v1";

/**
 * Token version for future compatibility.
 * Bump this when changing the token format.
 */
const TOKEN_VERSION = 1;

/**
 * Environment variable name for the unsubscribe secret.
 * The secret is set via `wrangler secret put REMINDER_UNSUBSCRIBE_SECRET`.
 * Never commit the actual value to code, tests, or logs.
 */
export const UNSUBSCRIBE_SECRET_ENV_NAME = "REMINDER_UNSUBSCRIBE_SECRET";

/**
 * Check if the unsubscribe secret is configured.
 * If missing, the send path should skip sending reminders and log a count.
 *
 * @param env - Environment object or process.env
 * @returns true if the secret is configured and non-empty
 */
export function isUnsubscribeSecretConfigured(
  env: { REMINDER_UNSUBSCRIBE_SECRET?: string } = {}
): boolean {
  const secret = env.REMINDER_UNSUBSCRIBE_SECRET ?? process.env.REMINDER_UNSUBSCRIBE_SECRET;
  return typeof secret === "string" && secret.trim().length > 0;
}

/**
 * Token payload structure (not exposed to clients).
 */
interface TokenPayload {
  v: number; // version
  p: string; // purpose
  s: string; // shopId
  b: string; // buyerAccountId
}

/**
 * Generate a signed unsubscribe token.
 *
 * The token is URL-safe base64 encoded and contains:
 * - Version number for future compatibility
 * - Purpose string to prevent misuse
 * - Shop ID and buyer account ID
 * - HMAC-SHA256 signature
 *
 * @param shopId - Shop ID (required for shop-scoped validation)
 * @param buyerAccountId - Buyer account ID
 * @param secret - HMAC secret (from REMINDER_UNSUBSCRIBE_SECRET env)
 * @returns URL-safe base64 encoded token, or null if secret is missing
 */
export function generateUnsubscribeToken(
  shopId: string,
  buyerAccountId: string,
  secret: string | undefined
): string | null {
  if (!secret || secret.trim().length === 0) {
    return null;
  }

  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    p: TOKEN_PURPOSE,
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

/**
 * Verify and decode an unsubscribe token.
 *
 * Uses constant-time comparison for the signature to prevent timing attacks.
 * Supports dual-key verification for secret rotation: tries current secret first,
 * then optional previous secret if configured.
 *
 * @param token - The token to verify
 * @param secret - HMAC secret (from REMINDER_UNSUBSCRIBE_SECRET env)
 * @param previousSecret - Previous HMAC secret for key rotation (optional)
 * @returns Decoded payload with shopId and buyerAccountId, or null if invalid
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string | undefined,
  previousSecret?: string | undefined
): { shopId: string; buyerAccountId: string } | null {
  if (!secret || secret.trim().length === 0) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [payloadBase64, providedSignature] = parts;

  // Verify signature: try current secret, then previous if configured
  let sigValid = verifySignature(payloadBase64, providedSignature, secret);
  if (!sigValid && previousSecret && previousSecret.trim().length > 0) {
    sigValid = verifySignature(payloadBase64, providedSignature, previousSecret);
  }
  if (!sigValid) {
    return null;
  }

  // Decode and validate payload
  let payload: TokenPayload;
  try {
    const payloadJson = Buffer.from(payloadBase64, "base64url").toString("utf8");
    payload = JSON.parse(payloadJson) as TokenPayload;
  } catch {
    return null;
  }

  // Validate version and purpose
  if (payload.v !== TOKEN_VERSION) {
    return null;
  }

  if (payload.p !== TOKEN_PURPOSE) {
    return null;
  }

  // Validate required fields
  if (typeof payload.s !== "string" || payload.s.length === 0) {
    return null;
  }

  if (typeof payload.b !== "string" || payload.b.length === 0) {
    return null;
  }

  return {
    shopId: payload.s,
    buyerAccountId: payload.b,
  };
}

/**
 * Build the unsubscribe URL for inclusion in email headers.
 *
 * @param baseUrl - Base URL of the app (e.g., https://app.example.com)
 * @param token - Signed unsubscribe token
 * @returns Full unsubscribe URL
 */
export function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  // Remove trailing slash if present
  const base = baseUrl.replace(/\/$/, "");
  return `${base}/unsubscribe?token=${encodeURIComponent(token)}`;
}

/**
 * Log unsubscribe token generation failure (secret missing).
 * Logs only counts and IDs, never the secret or token.
 *
 * @param shopId - Shop ID for context
 * @param invoiceCount - Number of invoices that couldn't get tokens
 */
export function logUnsubscribeSecretMissing(
  shopId: string,
  invoiceCount: number
): void {
  safeLog("warn", "reminder_unsubscribe_secret_missing", {
    shopId,
    invoiceCount,
    secretConfigured: false,
  });
}
