/**
 * Admin GraphQL client for drain context.
 *
 * Uses getShopifyApp().unauthenticated.admin(shop) which handles:
 * - Loading offline session from storage
 * - Automatic token refresh for expiring offline tokens
 * - Proper error handling for auth failures
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

import { getShopifyApp } from "~/shopify.server";
import {
  HttpResponseError,
  HttpRetriableError,
  HttpThrottlingError,
  GraphqlQueryError,
  InvalidSession,
} from "@shopify/shopify-api";

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
 * GraphQL response shape from the Admin API.
 */
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: { code?: string };
  }>;
}

/**
 * Execute a GraphQL query against the Shopify Admin API.
 *
 * Uses unauthenticated.admin(shop) which:
 * 1. Loads the offline session (offline_{shop})
 * 2. Automatically refreshes expired tokens
 * 3. Persists refreshed tokens back to session storage
 *
 * Error handling uses instanceof checks on @shopify/shopify-api error types:
 * - HttpThrottlingError (429): retryable
 * - HttpRetriableError (5xx): retryable
 * - HttpResponseError (other HTTP errors): not retryable
 * - GraphqlQueryError: check for THROTTLED code
 * - InvalidSession: not retryable, shop needs reinstall
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
  try {
    const shopify = getShopifyApp();
    const { admin } = await shopify.unauthenticated.admin(shop);

    const response = await admin.graphql(query, { variables });
    const json = (await response.json()) as GraphQLResponse<T>;

    // Check for GraphQL-level errors
    if (json.errors && json.errors.length > 0) {
      const throttled = json.errors.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled) {
        return {
          success: false,
          error: "GraphQL THROTTLED. Will retry after visibility timeout.",
          retryable: true,
        };
      }

      return {
        success: false,
        error: `GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
        retryable: false,
      };
    }

    return {
      success: true,
      data: json.data as T,
      retryable: false,
    };
  } catch (err) {
    // Use instanceof checks on Shopify API error types

    // 429 rate limiting - retryable
    if (err instanceof HttpThrottlingError) {
      return {
        success: false,
        error: `Rate limited (429). Retry after ${err.response.retryAfter ?? "unknown"}s.`,
        retryable: true,
      };
    }

    // 5xx server errors - retryable (HttpRetriableError is parent of HttpThrottlingError and HttpInternalError)
    if (err instanceof HttpRetriableError) {
      return {
        success: false,
        error: `Server error (${err.response.code}). Will retry.`,
        retryable: true,
      };
    }

    // Other HTTP errors (4xx except 429) - not retryable
    if (err instanceof HttpResponseError) {
      const code = err.response.code;
      if (code === 401 || code === 403) {
        return {
          success: false,
          error: `Authentication failed for ${shop} (${code}). Token may be revoked.`,
          retryable: false,
        };
      }
      return {
        success: false,
        error: `HTTP error ${code}: ${err.message}`,
        retryable: false,
      };
    }

    // GraphQL query errors
    if (err instanceof GraphqlQueryError) {
      return {
        success: false,
        error: `GraphQL query error: ${err.message}`,
        retryable: false,
      };
    }

    // Session errors - shop needs to reinstall
    if (err instanceof InvalidSession) {
      return {
        success: false,
        error: `Invalid session for ${shop}. Shop may need to reinstall the app.`,
        retryable: false,
      };
    }

    // Fallback for unknown errors
    const message = err instanceof Error ? err.message : "Unknown error";

    // Check for session-related messages
    if (message.includes("No session found") || message.includes("offline_")) {
      return {
        success: false,
        error: `No offline session found for ${shop}. Shop may need to reinstall the app.`,
        retryable: false,
      };
    }

    // Network errors are retryable
    if (
      err instanceof TypeError ||
      message.includes("fetch") ||
      message.includes("network") ||
      message.includes("ECONNREFUSED")
    ) {
      return {
        success: false,
        error: `Network error: ${message}`,
        retryable: true,
      };
    }

    // Default: treat as non-retryable to avoid infinite loops
    return {
      success: false,
      error: message,
      retryable: false,
    };
  }
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
