/**
 * P2.5: Sentry setUser and setTag/setExtra value checking
 */

import * as Sentry from "@sentry/cloudflare";

// SHOULD FAIL: setUser (always PII)
export function logSetUser(userId: string, email: string) {
  Sentry.setUser({ id: userId, email });
}

// SHOULD FAIL: setTag with sensitive key
export function logSetTagSensitiveKey(shop: string) {
  Sentry.setTag("shop", shop);
}

// SHOULD FAIL: setTag with sensitive value
export function logSetTagSensitiveValue(shopDomain: string) {
  Sentry.setTag("store", shopDomain);
}

// SHOULD FAIL: setExtra with sensitive key
export function logSetExtraSensitiveKey(email: string) {
  Sentry.setExtra("email", email);
}

// SHOULD FAIL: setExtra with sensitive value
export function logSetExtraSensitiveValue(domain: string) {
  Sentry.setExtra("info", domain);
}

// SHOULD FAIL: setExtra with .message
export function logSetExtraMessage(err: Error) {
  Sentry.setExtra("error", err.message);
}

// SHOULD PASS: Safe Sentry usage
export function safeSentry(shopId: string, errorCode: string) {
  Sentry.setTag("shopId", shopId);
  Sentry.setExtra("code", errorCode);
}
