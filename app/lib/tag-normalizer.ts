/**
 * Tag normalization for consistent tag-rule matching.
 *
 * This module provides a single normalizer used by both:
 * - customer.server.ts (sync processing)
 * - invoice-eligibility.ts (order eligibility)
 *
 * Normalization rules (matching Shopify's tag behavior):
 * - Trim leading/trailing whitespace
 * - Collapse internal whitespace runs to single space
 * - Case-insensitive comparison
 */

/**
 * Normalize a tag for consistent matching.
 *
 * Handles:
 * - Leading/trailing whitespace
 * - Internal whitespace runs (spaces, tabs, etc.)
 * - Case variations
 *
 * @param tag - Raw tag string
 * @returns Normalized tag (lowercase, trimmed, single-spaced) or empty string
 */
export function normalizeTag(tag: string): string {
  if (!tag) return "";
  return tag
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Check if two tags match after normalization.
 *
 * @param tagA - First tag
 * @param tagB - Second tag
 * @returns true if normalized tags are equal
 */
export function tagsMatch(tagA: string, tagB: string): boolean {
  const normalizedA = normalizeTag(tagA);
  const normalizedB = normalizeTag(tagB);
  if (normalizedA === "" || normalizedB === "") return false;
  return normalizedA === normalizedB;
}
