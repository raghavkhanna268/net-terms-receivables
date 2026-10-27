/**
 * Parse a page query parameter and return a safe positive integer.
 * Returns 1 for invalid values (NaN, non-finite, zero, negative, decimal,
 * non-safe-integer, leading zeros, exponent notation).
 * Caps at MAX_PAGE (10000), returning the cap for values above.
 */
const MAX_PAGE = 10000;

export function parsePageParam(value: string | null | undefined): number {
  if (!value) return 1;
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber) || asNumber < 1) {
    return 1;
  }
  if (asNumber > MAX_PAGE) {
    return MAX_PAGE;
  }
  return asNumber;
}
