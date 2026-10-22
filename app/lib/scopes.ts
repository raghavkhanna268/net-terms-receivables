/**
 * Parse OAuth scopes from a comma-separated string.
 * Handles empty strings and whitespace-only entries gracefully.
 *
 * @param scopesEnv - Comma-separated scopes string (may be empty or whitespace)
 * @returns Array of scope strings, empty array if input is empty/whitespace
 */
export function parseScopes(scopesEnv: string): string[] {
  return scopesEnv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
