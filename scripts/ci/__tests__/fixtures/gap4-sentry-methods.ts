/**
 * Gap 4: Sentry methods weren't checked
 * The grep-based checker only checked console.* and safeLog.
 * The AST-based checker also checks Sentry.* methods.
 */

import * as Sentry from "@sentry/cloudflare";
import { captureException, captureMessage } from "~/lib/sentry";

// SHOULD FAIL: addBreadcrumb with sensitive data
export function logBreadcrumb(shop: string) {
  Sentry.addBreadcrumb({
    message: `Processing ${shop}`,
    data: { shop },
  });
}

// SHOULD FAIL: setExtra with sensitive key
export function logExtra(shopDomain: string, amount: number) {
  Sentry.setExtra("shopDomain", shopDomain);
  Sentry.setExtra("amount", amount);
}

// SHOULD FAIL: setExtras with sensitive object
export function logExtras(data: { shop: string; email: string }) {
  Sentry.setExtras(data);
}

// SHOULD FAIL: setContext with sensitive data
export function logContext(shop: string) {
  Sentry.setContext("payment", {
    shop,
    narration: "Payment for order",
  });
}

// SHOULD FAIL: setTag with domain
export function logTag(domain: string) {
  Sentry.setTag("domain", domain);
}

// SHOULD FAIL: setTags with sensitive keys
export function logTags(payer: string, remitter: string) {
  Sentry.setTags({
    payer,
    remitter,
  });
}

// SHOULD FAIL: captureMessage extras with sensitive data
export function logCaptureMessage(shop: string) {
  captureMessage(`Error for ${shop}`, "error");
}

// SHOULD FAIL: captureException with raw error (no tags)
export function logCaptureException() {
  try {
    throw new Error("test");
  } catch (err) {
    captureException(err);
  }
}

// SHOULD PASS: Safe Sentry usage
export function safeSentryUsage(shopId: string, errorCode: string) {
  Sentry.setTag("shopId", shopId);
  Sentry.setTag("code", errorCode);
  Sentry.addBreadcrumb({
    message: "Processing webhook",
    data: { shopId, status: "received" },
  });
}
