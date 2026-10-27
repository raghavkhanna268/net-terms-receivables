/**
 * Build a URL path to the buyer account page.
 *
 * Encodes the account id so that ids containing '/' or ':' (e.g. seed ids
 * like 'seed-account-shop-gid://shopify/CompanyLocation/123') don't split
 * the path segment and 404 into the catch-all route.
 */
export function accountHref(id: string): string {
  return `/app/accounts/${encodeURIComponent(id)}`;
}
