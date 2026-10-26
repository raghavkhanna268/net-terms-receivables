/**
 * Pre-launch recipient allowlist for email sends.
 *
 * Until launch, reminder emails may only be sent to addresses explicitly listed
 * in the RESEND_TEST_RECIPIENTS environment variable. This is a comma-separated
 * list that is matched case-insensitively after trimming whitespace.
 *
 * If the allowlist is missing, empty, or contains only whitespace/commas,
 * ALL sends are blocked (fail closed).
 *
 * The allowlist guard can be disabled by setting RESEND_RECIPIENT_ALLOWLIST_ENFORCED
 * to the exact string "false". Any other value (including unset, empty, "False",
 * "0", "no", whitespace, etc.) keeps the guard enforced.
 *
 * @module
 */

/**
 * Parsed recipient allowlist - a Set of lowercase, trimmed email addresses.
 * An empty Set means the allowlist is empty or not configured (fail closed, no sends allowed).
 */
export type RecipientAllowlist = Set<string>;

/**
 * Environment interface for allowlist enforcement check.
 */
export interface AllowlistEnforcementEnv {
  RESEND_RECIPIENT_ALLOWLIST_ENFORCED?: string;
}

/**
 * Check if the recipient allowlist guard is enforced.
 *
 * The guard is ENFORCED by default. It is ONLY disabled when the environment
 * variable RESEND_RECIPIENT_ALLOWLIST_ENFORCED is exactly the string "false".
 *
 * Any other value keeps the guard enforced:
 * - undefined (not set)
 * - empty string ""
 * - "False" (wrong case)
 * - "FALSE" (wrong case)
 * - "0"
 * - "no"
 * - " false " (whitespace)
 * - "true"
 * - any other value
 *
 * No trimming or lowercasing is applied - the comparison is exact.
 *
 * @param env - Environment object with RESEND_RECIPIENT_ALLOWLIST_ENFORCED
 * @returns true if the guard is enforced, false only when env var is exactly "false"
 */
export function isAllowlistEnforced(env: AllowlistEnforcementEnv = {}): boolean {
  const value = env.RESEND_RECIPIENT_ALLOWLIST_ENFORCED ?? process.env.RESEND_RECIPIENT_ALLOWLIST_ENFORCED;
  return value !== "false";
}

/**
 * Parse the RESEND_TEST_RECIPIENTS environment variable into a Set.
 *
 * Returns an empty Set if:
 * - raw is undefined
 * - raw is empty string
 * - raw contains only whitespace and/or commas
 *
 * @param raw - The raw RESEND_TEST_RECIPIENTS value
 * @returns Set of lowercase, trimmed email addresses
 */
export function parseRecipientAllowlist(raw: string | undefined): RecipientAllowlist {
  if (raw === undefined || raw === null) {
    return new Set();
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return new Set();
  }

  const addresses = trimmed
    .split(",")
    .map((addr) => addr.trim().toLowerCase())
    .filter((addr) => addr.length > 0);

  return new Set(addresses);
}

/**
 * Check if a recipient email address is in the allowlist.
 *
 * Comparison is case-insensitive (both sides lowercased).
 *
 * Automatically checks RESEND_RECIPIENT_ALLOWLIST_ENFORCED from the environment.
 * When the guard is disabled (env var is exactly "false"), always returns true.
 * When enforced (default), checks the allowlist.
 *
 * @param address - The recipient email address to check
 * @param allowlist - The parsed allowlist from parseRecipientAllowlist
 * @param env - Optional environment object for enforcement check (defaults to process.env)
 * @returns true if the address is allowed
 */
export function isRecipientAllowed(
  address: string,
  allowlist: RecipientAllowlist,
  env: AllowlistEnforcementEnv = {}
): boolean {
  if (!isAllowlistEnforced(env)) {
    return true;
  }
  if (allowlist.size === 0) {
    return false;
  }
  return allowlist.has(address.trim().toLowerCase());
}

/**
 * Filter a list of recipient addresses to only those in the allowlist.
 *
 * Automatically checks RESEND_RECIPIENT_ALLOWLIST_ENFORCED from the environment.
 * When the guard is disabled (env var is exactly "false"), all addresses are allowed.
 * When enforced (default), only allowlisted addresses pass.
 *
 * @param addresses - Array of recipient email addresses
 * @param allowlist - The parsed allowlist from parseRecipientAllowlist
 * @param env - Optional environment object for enforcement check (defaults to process.env)
 * @returns Object with allowed addresses and skipped count
 */
export function filterRecipients(
  addresses: string[],
  allowlist: RecipientAllowlist,
  env: AllowlistEnforcementEnv = {}
): { allowed: string[]; skippedCount: number } {
  const enforced = isAllowlistEnforced(env);
  
  if (!enforced) {
    return { allowed: [...addresses], skippedCount: 0 };
  }

  const allowed: string[] = [];
  let skippedCount = 0;

  for (const addr of addresses) {
    if (isRecipientAllowed(addr, allowlist, env)) {
      allowed.push(addr);
    } else {
      skippedCount++;
    }
  }

  return { allowed, skippedCount };
}
