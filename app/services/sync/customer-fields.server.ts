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
 * Escape a tag value for use in Shopify's search query syntax.
 *
 * Shopify search uses backslash escaping for special characters.
 * @see https://shopify.dev/docs/api/usage/search-syntax#special-characters
 *
 * Special characters that need escaping: : \ ( )
 * When using single-quoted values like tag:'value', single quotes also need escaping.
 *
 * This function handles TWO levels of escaping:
 * 1. Shopify search syntax: ' → \' and \ → \\
 * 2. GraphQL string literal: \ → \\ (the result is embedded in a GraphQL string)
 *
 * Example: tag "buyer's" becomes "buyer\\'s" in the GraphQL string,
 * which GraphQL parses to "buyer\'s", which Shopify parses as "buyer's".
 *
 * @param tag - Raw tag value
 * @returns Escaped tag value safe for embedding in a GraphQL string containing a Shopify query
 */
export function escapeTagValue(tag: string): string {
  // First, escape for Shopify search syntax (backslash and single quote)
  // Then, escape backslashes again for the GraphQL string literal
  //
  // Order matters: escape backslashes first, then quotes
  // 1. \ → \\ (Shopify) → \\\\ (GraphQL)
  // 2. ' → \' (Shopify) → \\' (GraphQL)
  return tag
    .replace(/\\/g, "\\\\\\\\") // \ → \\\\ (one backslash becomes four)
    .replace(/'/g, "\\\\'");     // ' → \\' (quote becomes backslash-backslash-quote)
}

/**
 * Build a Shopify search query filter for tag rules.
 *
 * Creates a query like: tag:'net-terms' OR tag:'gold-tier'
 * Tags with spaces or special characters are properly quoted.
 *
 * @param tagRules - Array of tag rules from AccountSource
 * @returns Query filter string, or null if no tag rules
 */
export function buildTagFilterQuery(tagRules: Array<{ tag: string }>): string | null {
  if (tagRules.length === 0) {
    return null;
  }

  const tagConditions = tagRules.map((rule) => {
    const escaped = escapeTagValue(rule.tag);
    return `tag:'${escaped}'`;
  });

  return tagConditions.join(" OR ");
}

/**
 * GraphQL mutation for bulk customer export filtered by tag rules.
 *
 * Only exports customers matching the shop's configured tag rules.
 * This ensures we don't fetch data for customers we don't need.
 *
 * @param tagRules - Array of tag rules from AccountSource
 * @param env - Environment object to check PII flag
 * @returns GraphQL mutation string, or null if no tag rules (skip backfill)
 */
export function getBulkCustomersQuery(
  tagRules: Array<{ tag: string }>,
  env?: { CUSTOMER_PII_FIELDS?: string }
): string | null {
  const tagFilter = buildTagFilterQuery(tagRules);

  if (!tagFilter) {
    // No tag rules configured - skip customer backfill entirely
    return null;
  }

  const fields = buildCustomerFieldSelection(env);
  return `
    mutation BulkCustomersExport {
      bulkOperationRunQuery(
        query: """
        {
          customers(query: "${tagFilter}") {
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
