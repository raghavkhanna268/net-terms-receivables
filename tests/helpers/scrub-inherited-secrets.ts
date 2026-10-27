/**
 * Vitest setup file that scrubs inherited credential-like env vars.
 *
 * Runs before any test file in each worker process. Deletes any process.env
 * key that matches credential-like patterns but is NOT in SECRET_VAR_NAMES.
 *
 * This ensures tests never accidentally use real credentials inherited from
 * the developer's shell or CI runtime environment.
 *
 * vitest.config.ts configures this as a setupFile so it runs before tests.
 */

import { SECRET_VAR_NAMES, SECRET_NAME_PATTERN } from "./env-secrets";

/**
 * Extra pattern for segment-bounded credential markers not in SECRET_NAME_PATTERN.
 * Matches PAT, PRIVATE, AUTH as whole segments (underscore or start/end bounded).
 * Does NOT match PATH, PATHEXT, AUTHOR, etc. due to segment boundaries.
 */
export const EXTRA_CREDENTIAL_PATTERN = /(^|_)(PAT|PRIVATE|AUTH)(_|$)/i;

/**
 * Check if an env var name looks like a credential that should be scrubbed.
 * Matches SECRET_NAME_PATTERN OR EXTRA_CREDENTIAL_PATTERN, excluding SECRET_VAR_NAMES.
 */
export function isInheritedCredentialName(name: string): boolean {
  if (SECRET_VAR_NAMES.has(name)) {
    return false;
  }
  return SECRET_NAME_PATTERN.test(name) || EXTRA_CREDENTIAL_PATTERN.test(name);
}

/**
 * Scrub inherited credential-like env vars from process.env.
 * Returns array of scrubbed variable names.
 */
export function scrubInheritedCredentials(): string[] {
  const scrubbed: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (isInheritedCredentialName(key)) {
      delete process.env[key];
      scrubbed.push(key);
    }
  }
  return scrubbed;
}

const scrubbed = scrubInheritedCredentials();

if (scrubbed.length > 0 && process.env.DEBUG_ENV_SCRUB) {
  console.log(`[env-scrub] Removed ${scrubbed.length} inherited secret-like vars: ${scrubbed.join(", ")}`);
}
