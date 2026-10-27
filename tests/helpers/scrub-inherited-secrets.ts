/**
 * Vitest setup file that scrubs inherited credential-like env vars.
 *
 * Runs before any test file in each worker process. Deletes any process.env
 * key that matches SECRET_NAME_PATTERN but is NOT in SECRET_VAR_NAMES.
 *
 * This ensures tests never accidentally use real credentials inherited from
 * the developer's shell or CI runtime environment.
 *
 * vitest.config.ts configures this as a setupFile so it runs before tests.
 */

import { SECRET_VAR_NAMES, SECRET_NAME_PATTERN } from "./env-secrets";

const scrubbed: string[] = [];

for (const key of Object.keys(process.env)) {
  if (SECRET_NAME_PATTERN.test(key) && !SECRET_VAR_NAMES.has(key)) {
    delete process.env[key];
    scrubbed.push(key);
  }
}

if (scrubbed.length > 0 && process.env.DEBUG_ENV_SCRUB) {
  console.log(`[env-scrub] Removed ${scrubbed.length} inherited secret-like vars: ${scrubbed.join(", ")}`);
}
