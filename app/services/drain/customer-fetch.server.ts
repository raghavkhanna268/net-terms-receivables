/**
 * Customer fetch with ACCESS_DENIED fallback for PII fields.
 *
 * When CUSTOMER_PII_FIELDS=1, we request email and displayName.
 * If Shopify returns ACCESS_DENIED (PCD not approved), we retry
 * with base fields only (id, tags) and process without PII.
 *
 * This allows the app to function while PCD approval is pending,
 * without dead-lettering every customer message.
 */

import type { Sql } from "~/lib/db-light.server";
import { adminGraphQL, type AdminClientResult } from "./admin-client.server";
import {
  getCustomerByNodeQuery,
  CUSTOMER_BASE_FIELDS,
} from "~/services/sync/customer-fields.server";
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
 * Build a base-only (non-PII) customer query.
 * Always returns id and tags, never email/displayName.
 */
function getBaseCustomerQuery(): string {
  const fields = CUSTOMER_BASE_FIELDS.join("\n");
  return `
    query CustomerById($id: ID!) {
      node(id: $id) {
        ... on Customer {
          ${fields}
        }
      }
    }
  `;
}

/**
 * Check if a GraphQL response contains ACCESS_DENIED error.
 * This includes both top-level and field-level errors.
 */
function hasAccessDeniedError(result: AdminClientResult<unknown>): boolean {
  if (result.success) return false;
  
  const error = result.error ?? "";
  return (
    error.includes("ACCESS_DENIED") ||
    error.includes("Access denied")
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
  const baseQuery = getBaseCustomerQuery();
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
): Promise<void> {
  await sql`
    INSERT INTO s10b_customer_pii_fallback (shop, day, count)
    VALUES (${shop}, CURRENT_DATE, 1)
    ON CONFLICT (shop, day)
    DO UPDATE SET count = s10b_customer_pii_fallback.count + 1
  `;
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
