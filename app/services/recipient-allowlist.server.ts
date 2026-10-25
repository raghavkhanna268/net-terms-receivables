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
 * @module
 */

/**
 * Parsed recipient allowlist - a Set of lowercase, trimmed email addresses.
 * An empty Set means the allowlist is empty or not configured (fail closed, no sends allowed).
 */
export type RecipientAllowlist = Set<string>;

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
 * @param address - The recipient email address to check
 * @param allowlist - The parsed allowlist from parseRecipientAllowlist
 * @returns true if the address is allowed
 */
export function isRecipientAllowed(
  address: string,
  allowlist: RecipientAllowlist
): boolean {
  if (allowlist.size === 0) {
    return false;
  }
  return allowlist.has(address.trim().toLowerCase());
}

/**
 * Filter a list of recipient addresses to only those in the allowlist.
 *
 * @param addresses - Array of recipient email addresses
 * @param allowlist - The parsed allowlist from parseRecipientAllowlist
 * @returns Object with allowed addresses and skipped count
 */
export function filterRecipients(
  addresses: string[],
  allowlist: RecipientAllowlist
): { allowed: string[]; skippedCount: number } {
  const allowed: string[] = [];
  let skippedCount = 0;

  for (const addr of addresses) {
    if (isRecipientAllowed(addr, allowlist)) {
      allowed.push(addr);
    } else {
      skippedCount++;
    }
  }

  return { allowed, skippedCount };
}
