/**
 * Gap 1 fixture: Sentry.setContext / setExtras / setExtra / setTag with variable/object identifier
 * 
 * The guard should:
 * - Resolve const initializers in the same scope
 * - Flag as sentry-context-unresolved when identifier cannot be resolved
 * - Allow identifiers in SAFE_KEY_ALLOWLIST
 */

import * as Sentry from "@sentry/cloudflare";

// SHOULD FAIL: setContext with unresolved identifier
export function logSetContextUnresolved(data: { shop: string }) {
  Sentry.setContext("payment", data);
}

// SHOULD FAIL: setExtras with unresolved identifier
export function logSetExtrasUnresolved(extras: { email: string }) {
  Sentry.setExtras(extras);
}

// SHOULD PASS: setContext with const object literal (resolved)
export function logSetContextResolved() {
  const ctx = { shopId: "uuid-123", status: "active" };
  Sentry.setContext("payment", ctx);
}

// SHOULD FAIL: setContext with const containing sensitive key (resolved but fails key check)
export function logSetContextResolvedSensitive() {
  const ctx = { shop: "example.myshopify.com" };
  Sentry.setContext("payment", ctx);
}

// SHOULD PASS: setContext with inline object literal (already checked by existing rules)
export function logSetContextInline() {
  Sentry.setContext("metrics", { totalCount: 42, status: "ok" });
}

// SHOULD FAIL: setExtras with function parameter (unresolved)
export function logSetExtrasParam(config: Record<string, unknown>) {
  Sentry.setExtras(config);
}
