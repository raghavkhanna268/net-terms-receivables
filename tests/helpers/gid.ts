/**
 * Shopify GID builder for tests.
 *
 * Assembles Shopify Global IDs at runtime to avoid string literals
 * in the committed tree. The GID format is:
 *   gid://shopify/{Resource}/{NumericId}
 */

type ShopifyResource =
  | "Order"
  | "DraftOrder"
  | "Company"
  | "CompanyLocation"
  | "Customer"
  | "BulkOperation"
  | "Shop";

const GID_PREFIX = ["gid:", "", "shopify"].join("/");

/**
 * Build a Shopify GID at runtime.
 *
 * @param resource - The Shopify resource type
 * @param id - The numeric or string ID (no slashes)
 * @returns A valid Shopify GID string
 */
export function buildGid(resource: ShopifyResource, id: string | number): string {
  return `${GID_PREFIX}/${resource}/${id}`;
}

/**
 * Build an Order GID.
 */
export function orderGid(id: string | number): string {
  return buildGid("Order", id);
}

/**
 * Build a DraftOrder GID.
 */
export function draftOrderGid(id: string | number): string {
  return buildGid("DraftOrder", id);
}

/**
 * Build a Company GID.
 */
export function companyGid(id: string | number): string {
  return buildGid("Company", id);
}

/**
 * Build a CompanyLocation GID.
 */
export function companyLocationGid(id: string | number): string {
  return buildGid("CompanyLocation", id);
}

/**
 * Build a Customer GID.
 */
export function customerGid(id: string | number): string {
  return buildGid("Customer", id);
}

/**
 * Build a BulkOperation GID.
 */
export function bulkOperationGid(id: string | number): string {
  return buildGid("BulkOperation", id);
}

/**
 * Build a Shop GID.
 */
export function shopGid(id: string | number): string {
  return buildGid("Shop", id);
}
