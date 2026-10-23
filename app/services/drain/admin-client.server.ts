/**
 * Admin GraphQL client for drain context.
 *
 * Uses the S20 shopify-client wrapper which handles:
 * - THROTTLED responses with computed wait from throttleStatus
 * - HTTP 429 with Retry-After header or exponential backoff
 * - 5xx and network errors with bounded backoff
 * - Worker budget awareness (queue context allows longer waits)
 *
 * Per Shopify docs (https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/rotate-revoke-access-tokens):
 * - With expiringOfflineAccessTokens: true, tokens expire after ~1 hour of inactivity
 * - The library automatically refreshes tokens when they expire
 * - This requires the session storage to persist the refreshToken and refreshTokenExpires
 *
 * IMPORTANT: This must be called within the requestContext.run() ALS context
 * so session storage can access the SQL client. Both the scheduled() handler
 * and the /jobs/drain route set up this context.
 */

import { shopifyGraphQLQueue, type ShopifyClientResult } from "~/services/shopify-client.server";

export const API_VERSION = "2026-10";

/**
 * Result of an Admin API call.
 */
export interface AdminClientResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  retryable: boolean;
}

/**
 * Execute a GraphQL query against the Shopify Admin API.
 *
 * Uses the S20 shopify-client wrapper with queue context for automatic
 * rate limit handling with computed waits and retries.
 *
 * @param shop - Shop domain (e.g., "example.myshopify.com")
 * @param query - GraphQL query string
 * @param variables - Optional query variables
 * @returns Result with data or error
 */
export async function adminGraphQL<T = unknown>(
  shop: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<AdminClientResult<T>> {
  const result: ShopifyClientResult<T> = await shopifyGraphQLQueue<T>(shop, query, variables);

  return {
    success: result.success,
    data: result.data,
    error: result.error,
    retryable: result.retryable,
  };
}

// =============================================================================
// GRAPHQL QUERIES - S6 fields only, NO PII
// =============================================================================

/**
 * Fetch a Company by GID.
 * Only fetches id, name, externalId - no PII.
 */
export const COMPANY_QUERY = `
  query CompanyById($id: ID!) {
    node(id: $id) {
      ... on Company {
        id
        name
        externalId
      }
    }
  }
`;

/**
 * Fetch a CompanyLocation by GID.
 * Fetches id, name, company, billingAddress.company (name fallback), payment terms.
 * No PII fields.
 */
export const COMPANY_LOCATION_QUERY = `
  query CompanyLocationById($id: ID!) {
    node(id: $id) {
      ... on CompanyLocation {
        id
        name
        company {
          id
        }
        billingAddress {
          company
        }
        buyerExperienceConfiguration {
          paymentTermsTemplate {
            id
            name
            dueInDays
            paymentTermsType
          }
        }
      }
    }
  }
`;

/**
 * Fetch bulk operation status and result URL.
 * Used by bulk JSONL processor to get the download URL.
 */
export const BULK_OPERATION_STATUS_QUERY = `
  query BulkOperationStatus($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        fileSize
        url
        partialDataUrl
        createdAt
        completedAt
      }
    }
  }
`;

/**
 * Fetch an Order by GID.
 * Fetches ids, amounts, statuses, payment terms - no customer PII.
 */
export const ORDER_QUERY = `
  query OrderById($id: ID!) {
    node(id: $id) {
      ... on Order {
        id
        name
        createdAt
        processedAt
        cancelledAt
        closedAt
        displayFinancialStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        paymentTerms {
          id
          paymentTermsName
          paymentTermsType
          dueInDays
          paymentSchedules(first: 1) {
            edges {
              node {
                id
                dueAt
                issuedAt
                completedAt
                amount {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
        }
        purchasingEntity {
          ... on PurchasingCompany {
            company {
              id
            }
            location {
              id
            }
          }
        }
        customer {
          id
        }
      }
    }
  }
`;
