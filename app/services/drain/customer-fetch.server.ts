/**
 * Customer fetch with ACCESS_DENIED fallback for PII fields.
 *
 * When CUSTOMER_PII_FIELDS=1, we request email and displayName.
 * If Shopify returns ACCESS_DENIED (PCD not approved), we retry
 * with base fields only (id, tags) and process without PII.
 *
 * This allows the app to function while PCD approval is pending,
 * without dead-lettering every customer message.
 *
 * Conditional PII fetch:
 * - fetchCustomerBaseFields: Always fetches id + tags (no PII)
 * - fetchCustomerPiiFields: Fetches email + displayName (requires PII approval)
 * - fetchCustomerWithFallback: Legacy combined fetch with ACCESS_DENIED fallback
 */

import type { Sql } from "~/lib/db-light.server";
import { adminGraphQL, type AdminClientResult } from "./admin-client.server";
import { getCustomerByNodeQuery } from "~/services/sync/customer-fields.server";
import { getRequestEnv } from "~/lib/request-context.server";
import type { ShopifyCustomer } from "~/services/sync/types";

/**
 * Result of fetching a customer with fallback info.
 */
export interface CustomerFetchResult {
  success: boolean;
  data?: ShopifyCustomer | null;
  error?: string;
  retryable: boolean;
  /** True if we used the non-PII fallback due to ACCESS_DENIED */
  usedFallback?: boolean;
}

/**
 * Check if a GraphQL response contains ACCESS_DENIED error.
 *
 * Uses errorCode from shopify-client which is set from GraphQL extensions.code.
 * Falls back to error message matching for backwards compatibility.
 */
function hasAccessDeniedError(result: AdminClientResult<unknown>): boolean {
  if (result.success) return false;
  
  // Primary check: use errorCode (safe, from extensions.code)
  if (result.errorCode === "access_denied") {
    return true;
  }
  
  // Fallback: check error message for legacy compatibility
  const error = result.error ?? "";
  return (
    error.includes("ACCESS_DENIED") ||
    error.toLowerCase().includes("access denied")
  );
}

/**
 * Fetch a customer with automatic fallback on ACCESS_DENIED.
 *
 * 1. First tries with PII fields (if CUSTOMER_PII_FIELDS=1)
 * 2. If ACCESS_DENIED, retries with base fields only
 * 3. On fallback success: returns customer with null email/displayName
 *
 * @param shop - Shop domain
 * @param customerId - Customer GID
 * @returns Fetch result with fallback indicator
 */
export async function fetchCustomerWithFallback(
  shop: string,
  customerId: string
): Promise<CustomerFetchResult> {
  const env = getRequestEnv() ?? {};
  const piiQuery = getCustomerByNodeQuery(env);

  // First attempt: with PII fields
  const piiResult = await adminGraphQL<{ node: ShopifyCustomer | null }>(
    shop,
    piiQuery,
    { id: customerId }
  );

  if (piiResult.success) {
    return {
      success: true,
      data: piiResult.data?.node ?? null,
      retryable: false,
      usedFallback: false,
    };
  }

  // Check for ACCESS_DENIED
  if (!hasAccessDeniedError(piiResult)) {
    // Not ACCESS_DENIED - return the error as-is
    return {
      success: false,
      error: piiResult.error,
      retryable: piiResult.retryable,
      usedFallback: false,
    };
  }

  // ACCESS_DENIED on PII - retry with base fields only
  // Use getCustomerByNodeQuery with CUSTOMER_PII_FIELDS='0' to get base-only query
  const baseQuery = getCustomerByNodeQuery({ CUSTOMER_PII_FIELDS: "0" });
  const baseResult = await adminGraphQL<{ node: ShopifyCustomer | null }>(
    shop,
    baseQuery,
    { id: customerId }
  );

  if (baseResult.success) {
    // Fallback success - customer has no PII fields
    const customer = baseResult.data?.node;
    if (customer) {
      // Explicitly null out PII fields (they weren't fetched)
      customer.email = null;
      customer.displayName = null;
    }

    return {
      success: true,
      data: customer,
      retryable: false,
      usedFallback: true,
    };
  }

  // Fallback also failed
  return {
    success: false,
    error: baseResult.error,
    retryable: baseResult.retryable,
    usedFallback: true,
  };
}

/**
 * Result of fetching customer base fields.
 */
export interface CustomerBaseFieldsResult {
  success: boolean;
  data?: ShopifyCustomer | null;
  error?: string;
  retryable: boolean;
}

/**
 * Fetch customer base fields only (id, tags).
 *
 * Used as the first step in conditional PII fetching. This query does not
 * require Protected Customer Data approval and should always succeed if
 * the customer exists.
 *
 * @param shop - Shop domain
 * @param customerId - Customer GID
 * @returns Fetch result with id and tags only
 */
export async function fetchCustomerBaseFields(
  shop: string,
  customerId: string
): Promise<CustomerBaseFieldsResult> {
  const baseQuery = getCustomerByNodeQuery({ CUSTOMER_PII_FIELDS: "0" });

  const result = await adminGraphQL<{ node: ShopifyCustomer | null }>(
    shop,
    baseQuery,
    { id: customerId }
  );

  if (result.success) {
    return {
      success: true,
      data: result.data?.node ?? null,
      retryable: false,
    };
  }

  return {
    success: false,
    error: result.error,
    retryable: result.retryable,
  };
}

/**
 * Result of fetching customer PII fields.
 */
export interface CustomerPiiFieldsResult {
  success: boolean;
  email?: string | null;
  displayName?: string | null;
  error?: string;
  retryable: boolean;
  /** True if we used the fallback due to ACCESS_DENIED */
  usedFallback?: boolean;
}

/**
 * Fetch customer PII fields (email, displayName) with ACCESS_DENIED fallback.
 *
 * Used as the second step in conditional PII fetching, only when the customer
 * matches a tag rule or is already tracked.
 *
 * On ACCESS_DENIED, returns success with usedFallback=true and null PII fields.
 * The caller should use 'fallback' piiMode to preserve existing stored values.
 *
 * @param shop - Shop domain
 * @param customerId - Customer GID
 * @returns Fetch result with email and displayName, or fallback indicator
 */
export async function fetchCustomerPiiFields(
  shop: string,
  customerId: string
): Promise<CustomerPiiFieldsResult> {
  const env = getRequestEnv() ?? {};
  const piiEnabled = env.CUSTOMER_PII_FIELDS === "1";

  if (!piiEnabled) {
    return {
      success: true,
      email: null,
      displayName: null,
      retryable: false,
      usedFallback: false,
    };
  }

  const piiQuery = getCustomerByNodeQuery({ CUSTOMER_PII_FIELDS: "1" });

  const result = await adminGraphQL<{ node: ShopifyCustomer | null }>(
    shop,
    piiQuery,
    { id: customerId }
  );

  if (result.success) {
    const customer = result.data?.node;
    return {
      success: true,
      email: customer?.email ?? null,
      displayName: customer?.displayName ?? null,
      retryable: false,
      usedFallback: false,
    };
  }

  if (hasAccessDeniedError(result)) {
    return {
      success: true,
      email: null,
      displayName: null,
      retryable: false,
      usedFallback: true,
    };
  }

  return {
    success: false,
    error: result.error,
    retryable: result.retryable,
    usedFallback: false,
  };
}

/**
 * Increment the customer PII ACCESS_DENIED fallback counter.
 *
 * Called when a customer fetch falls back to non-PII query due to ACCESS_DENIED.
 * Uses an aggregate table (shop, day, count) - no PII.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 */
export async function incrementCustomerPiiAccessDeniedFallback(
  sql: Sql,
  shop: string
): Promise<boolean> {
  const result = await sql`
    WITH shop_check AS (
      SELECT 1 FROM "Shop" WHERE domain = ${shop} FOR SHARE
    )
    INSERT INTO s10b_customer_pii_fallback (shop, day, count)
    SELECT ${shop}, CURRENT_DATE, 1
    WHERE EXISTS (SELECT 1 FROM shop_check)
    ON CONFLICT (shop, day)
    DO UPDATE SET count = s10b_customer_pii_fallback.count + 1
  `;
  return result.count > 0;
}

/**
 * Get customer PII ACCESS_DENIED fallback count for a shop.
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param since - Optional: only count events after this date
 * @returns Count of fallback events
 */
export async function getCustomerPiiAccessDeniedFallbackCount(
  sql: Sql,
  shop: string,
  since?: Date
): Promise<number> {
  const rows = since
    ? await sql<{ total: string }[]>`
        SELECT COALESCE(SUM(count), 0)::text AS total
        FROM s10b_customer_pii_fallback
        WHERE shop = ${shop} AND day >= ${since}
      `
    : await sql<{ total: string }[]>`
        SELECT COALESCE(SUM(count), 0)::text AS total
        FROM s10b_customer_pii_fallback
        WHERE shop = ${shop}
      `;

  return parseInt(rows[0]?.total ?? "0", 10);
}
