/**
 * Secret environment variable definitions for test isolation.
 *
 * This module defines which environment variables are secrets (API keys,
 * tokens, DSNs, etc.) that must be overridden with fake values during tests
 * to ensure tests never accidentally use real credentials.
 *
 * The list is derived from scanning the codebase for process.env.* and env.*
 * references that match secret-like patterns (KEY, SECRET, TOKEN, DSN, etc.)
 * and cross-referencing with .env.example, .dev.vars.example, and the Env type.
 *
 * Non-secret config vars (PLAN_GATING_ENFORCED, RESEND_FROM, SCOPES, etc.)
 * are intentionally excluded - those are safe to inherit from the shell.
 *
 * Database vars (TEST_DATABASE_URL, DATABASE_URL) are excluded because DB
 * tests need the real CI Postgres connection.
 *
 * The fake values are applied via vitest's `test.env` configuration in
 * vitest.config.ts, which sets them before any test code runs.
 */

export interface SecretVarDef {
  name: string;
  fakeValue: string;
}

/**
 * Secret environment variables that must be overridden with fake values.
 *
 * URL/DSN-shaped vars use https://fake.example.com.
 * API keys/tokens/secrets use test-fake-<lowercase-name>.
 *
 * These values are mirrored in vitest.config.ts `test.env` block.
 * Keep both in sync when adding or removing secrets.
 */
export const SECRET_ENV_VARS: readonly SecretVarDef[] = [
  { name: "SHOPIFY_API_SECRET", fakeValue: "test-fake-shopify-api-secret" },
  { name: "SHOPIFY_API_KEY", fakeValue: "test-fake-shopify-api-key" },
  { name: "SHOPIFY_ADMIN_TOKEN", fakeValue: "test-fake-shopify-admin-token" },
  { name: "JOBS_DRAIN_SECRET", fakeValue: "test-fake-jobs-drain-secret" },
  { name: "REMINDER_UNSUBSCRIBE_SECRET", fakeValue: "test-fake-reminder-unsubscribe-secret" },
  { name: "REMINDER_UNSUBSCRIBE_SECRET_PREVIOUS", fakeValue: "test-fake-reminder-unsubscribe-secret-previous" },
  { name: "SENTRY_DSN", fakeValue: "https://fake.example.com/sentry" },
  { name: "RESEND_API_KEY", fakeValue: "test-fake-resend-api-key" },
  { name: "ALLOWED_DEV_STORE", fakeValue: "test-fake-allowed-dev-store.myshopify.com" },
] as const;

/**
 * Set of secret var names for fast lookup.
 */
export const SECRET_VAR_NAMES = new Set(SECRET_ENV_VARS.map((v) => v.name));

/**
 * Regex pattern for detecting secret-looking variable names.
 * Matches: KEY, SECRET, TOKEN, PASSWORD, DSN, CREDENTIAL (case-insensitive)
 */
export const SECRET_NAME_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|DSN|CREDENTIAL/i;

/**
 * Check if a value looks like a fake test value.
 * Fake values start with "test-fake-" or are the fake URL.
 */
export function isFakeValue(value: string | undefined): boolean {
  if (!value) return false;
  return value.startsWith("test-fake-") || value === "https://fake.example.com/sentry";
}
