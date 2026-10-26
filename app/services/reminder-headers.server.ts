/**
 * RFC 8058 List-Unsubscribe header builder (S18 #232).
 *
 * Builds the List-Unsubscribe and List-Unsubscribe-Post headers for
 * payment reminder emails, enabling one-click unsubscribe in email clients.
 *
 * RFC 8058 requirements:
 * - List-Unsubscribe header contains an HTTPS URI
 * - List-Unsubscribe-Post header contains "List-Unsubscribe=One-Click"
 * - The URI contains enough info to identify the recipient (via signed token)
 * - POST to the URI with the body "List-Unsubscribe=One-Click" unsubscribes
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8058
 * @see https://resend.com/docs/api-reference/emails/send-email (headers param)
 */

import {
  generateUnsubscribeToken,
  buildUnsubscribeUrl,
  isUnsubscribeSecretConfigured,
} from "./reminder-unsubscribe-token.server";

/**
 * Headers object for Resend's send-email API headers field.
 * Includes index signature for compatibility with Record<string, string>.
 */
export interface UnsubscribeHeaders {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": string;
  [key: string]: string;
}

/**
 * Build List-Unsubscribe headers for a reminder email.
 *
 * Returns null if the unsubscribe secret is not configured. In that case,
 * the send path should NOT send the email (fail closed) and log a count.
 *
 * The headers conform to RFC 8058:
 * - List-Unsubscribe: <https://...> (angle-bracket format per RFC 2369)
 * - List-Unsubscribe-Post: List-Unsubscribe=One-Click
 *
 * @param baseUrl - Base URL of the app (e.g., from SHOPIFY_APP_URL env)
 * @param shopId - Shop ID for the signed token
 * @param buyerAccountId - Buyer account ID for the signed token
 * @param secret - HMAC secret from REMINDER_UNSUBSCRIBE_SECRET env
 * @returns Headers object for Resend, or null if secret is missing
 */
export function buildUnsubscribeHeaders(
  baseUrl: string,
  shopId: string,
  buyerAccountId: string,
  secret: string | undefined
): UnsubscribeHeaders | null {
  if (!isUnsubscribeSecretConfigured({ REMINDER_UNSUBSCRIBE_SECRET: secret })) {
    return null;
  }

  const token = generateUnsubscribeToken(shopId, buyerAccountId, secret);
  if (!token) {
    return null;
  }

  const unsubscribeUrl = buildUnsubscribeUrl(baseUrl, token);

  // RFC 2369 format: angle brackets around the URL
  // RFC 8058: List-Unsubscribe-Post signals one-click support
  return {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/**
 * Check if unsubscribe headers can be generated.
 *
 * Use this to fail closed: if headers can't be generated, don't send.
 *
 * @param env - Environment object with REMINDER_UNSUBSCRIBE_SECRET
 * @returns true if headers can be generated
 */
export function canGenerateUnsubscribeHeaders(
  env: { REMINDER_UNSUBSCRIBE_SECRET?: string } = {}
): boolean {
  return isUnsubscribeSecretConfigured(env);
}
