/**
 * Parse a page query parameter and return a safe positive integer.
 * Returns 1 for invalid values (NaN, non-finite, zero, negative, decimal).
 */
export function parsePageParam(value: string | null | undefined): number {
  if (!value) return 1;
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed !== Number(value)) {
    return 1;
  }
  return parsed;
}
