/**
 * Build a URL path to the buyer account page.
 *
 * Encodes the account id so that ids containing '/' or ':' (e.g. seed ids
 * with embedded path separators) don't split the path segment and 404
 * into the catch-all route.
 */
export function accountHref(id: string): string {
  return `/app/accounts/${encodeURIComponent(id)}`;
}

/**
 * Normalize a params.id that may be double-encoded.
 *
 * After a React Router Form POST to a URL with an encoded id (e.g. containing
 * `%2F` for '/'), the id may become double-encoded (`%252F`). When React Router
 * decodes params.id, it decodes once, leaving `%2F` in the id instead of '/'.
 *
 * This function detects and fixes double-encoding by decoding until no more
 * percent-encoded sequences remain that would decode to something different.
 *
 * @example
 * // Single-encoded (normal navigation) - already decoded by React Router
 * normalizeAccountId("gid://shopify/CompanyLocation/1001") // returns same
 *
 * // Double-encoded (after Form POST) - needs one more decode
 * normalizeAccountId("gid%3A%2F%2Fshopify%2FCompanyLocation%2F1001")
 * // returns "gid://shopify/CompanyLocation/1001"
 */
export function normalizeAccountId(id: string): string {
  if (!id.includes("%")) {
    return id;
  }
  try {
    const decoded = decodeURIComponent(id);
    if (decoded === id) {
      return id;
    }
    return decoded;
  } catch {
    return id;
  }
}
