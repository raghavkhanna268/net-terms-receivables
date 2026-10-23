/**
 * Customer GraphQL field selection for S8 (DPDP compliant).
 *
 * This module defines the single source of truth for customer fields
 * fetched from Shopify's GraphQL API, both for per-customer queries
 * and bulk exports.
 *
 * Data minimization design:
 * - Base fields (always fetched): id, tags
 * - Optional PII fields (email, displayName): gated by CUSTOMER_PII_FIELDS env var
 * - Forbidden fields (NEVER fetched): phone, addresses, firstName, lastName
 *
 * The CUSTOMER_PII_FIELDS flag requires:
 * 1. Shopify Protected Customer Data approval (Level 1 + Email and Name fields)
 * 2. Environment variable CUSTOMER_PII_FIELDS=1 set on the Worker
 *
 * Current state: CUSTOMER_PII_FIELDS is off by default; we fetch neither
 * email nor name. When the approval is granted and the flag is enabled,
 * email and displayName will be included in queries.
 *
 * Phone and address are NEVER fetched, regardless of approval level.
 */

/**
 * Base customer fields that are always safe to fetch.
 * These do not require Protected Customer Data approval.
 */
export const CUSTOMER_BASE_FIELDS = ["id", "tags"] as const;

/**
 * Optional PII fields that require Protected Customer Data (Level 1 + Email/Name).
 * Only included when CUSTOMER_PII_FIELDS=1 is set.
 */
export const CUSTOMER_OPTIONAL_PII_FIELDS = ["email", "displayName"] as const;

/**
 * Forbidden fields that are NEVER fetched, regardless of approval level.
 * Phone and address data is not needed for buyer account management.
 */
export const CUSTOMER_FORBIDDEN_FIELDS = [
  "phone",
  "addresses",
  "firstName",
  "lastName",
  "defaultAddress",
] as const;

/**
 * Check if optional PII fields should be included in queries.
 *
 * Returns true only when CUSTOMER_PII_FIELDS environment variable is set to "1".
 * This should only be enabled after Protected Customer Data Level 2 approval.
 *
 * @param env - Environment object (from Cloudflare Worker context)
 * @returns Whether to include email and displayName in queries
 */
export function shouldIncludePiiFields(env?: { CUSTOMER_PII_FIELDS?: string }): boolean {
  return env?.CUSTOMER_PII_FIELDS === "1";
}

/**
 * Get the list of customer fields to fetch based on current configuration.
 *
 * @param env - Environment object (from Cloudflare Worker context)
 * @returns Array of field names to include in GraphQL queries
 */
export function getCustomerFields(env?: { CUSTOMER_PII_FIELDS?: string }): string[] {
  const fields: string[] = [...CUSTOMER_BASE_FIELDS];

  if (shouldIncludePiiFields(env)) {
    fields.push(...CUSTOMER_OPTIONAL_PII_FIELDS);
  }

  return fields;
}

/**
 * Build GraphQL field selection string for customer queries.
 *
 * @param env - Environment object (from Cloudflare Worker context)
 * @returns GraphQL field selection (e.g., "id\ntags" or "id\ntags\nemail\ndisplayName")
 */
export function buildCustomerFieldSelection(env?: { CUSTOMER_PII_FIELDS?: string }): string {
  return getCustomerFields(env).join("\n");
}

/**
 * Validate that a GraphQL query string does not contain forbidden fields.
 *
 * @param query - GraphQL query string to validate
 * @throws Error if any forbidden field is found in the query
 */
export function validateNoForbiddenFields(query: string): void {
  for (const field of CUSTOMER_FORBIDDEN_FIELDS) {
    // Match field name as a word boundary to avoid false positives
    // e.g., "phone" should match but "phoneticName" should not
    const regex = new RegExp(`\\b${field}\\b`, "i");
    if (regex.test(query)) {
      throw new Error(
        `DPDP violation: forbidden customer field "${field}" found in query. ` +
          `Phone and address fields are never allowed.`
      );
    }
  }
}

/**
 * Validate that a GraphQL query only contains allowed fields.
 *
 * @param query - GraphQL query string to validate
 * @param env - Environment object to check PII flag
 * @throws Error if PII fields are present when flag is off, or forbidden fields are present
 */
export function validateCustomerQuery(query: string, env?: { CUSTOMER_PII_FIELDS?: string }): void {
  // Always check for forbidden fields
  validateNoForbiddenFields(query);

  // If PII flag is off, ensure no PII fields are in the query
  if (!shouldIncludePiiFields(env)) {
    for (const field of CUSTOMER_OPTIONAL_PII_FIELDS) {
      const regex = new RegExp(`\\b${field}\\b`, "i");
      if (regex.test(query)) {
        throw new Error(
          `DPDP violation: PII field "${field}" found in query but CUSTOMER_PII_FIELDS is not enabled. ` +
            `Set CUSTOMER_PII_FIELDS=1 after Protected Customer Data Level 2 approval.`
        );
      }
    }
  }
}

/**
 * GraphQL query to fetch a single customer's minimal data.
 * Built dynamically based on CUSTOMER_PII_FIELDS configuration.
 *
 * @param env - Environment object to check PII flag
 * @returns GraphQL query string
 */
export function getCustomerQuery(env?: { CUSTOMER_PII_FIELDS?: string }): string {
  const fields = buildCustomerFieldSelection(env);
  return `
    query CustomerMinimal($id: ID!) {
      customer(id: $id) {
        ${fields}
      }
    }
  `;
}

/**
 * GraphQL mutation for bulk customer export.
 * Uses the same field selection as per-customer queries.
 *
 * Note: This fetches ALL customers. The sync processor filters
 * to only those matching AccountSource tag rules.
 *
 * @param env - Environment object to check PII flag
 * @returns GraphQL mutation string for bulkOperationRunQuery
 */
export function getBulkCustomersQuery(env?: { CUSTOMER_PII_FIELDS?: string }): string {
  const fields = buildCustomerFieldSelection(env);
  return `
    mutation BulkCustomersExport {
      bulkOperationRunQuery(
        query: """
        {
          customers {
            edges {
              node {
                ${fields}
              }
            }
          }
        }
        """
      ) {
        bulkOperation {
          id
          status
          url
        }
        userErrors {
          field
          message
        }
      }
    }
  `;
}
