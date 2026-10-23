/**
 * Offline Admin GraphQL client for drain context.
 *
 * Provides authenticated GraphQL access to Shopify Admin API for processing
 * queued webhook messages. Uses the shop's offline session from LightSessionStorage.
 *
 * Preferred approach: Use getShopifyApp().unauthenticated.admin(shop) if it works
 * with LightSessionStorage in the drain context. This leverages the library's
 * built-in session resolution and token refresh.
 *
 * Fallback: Manual fetch with X-Shopify-Access-Token header if the library
 * approach doesn't work (e.g., requires request context).
 *
 * Error handling:
 * - Missing session: returns failure (retry, then DLQ)
 * - 401/403: returns failure (session invalid/expired)
 * - 429/THROTTLED: returns failure (retry after visibility timeout)
 */

import type { Sql } from "~/lib/db-light.server";
import { LightSessionStorage } from "~/lib/session-storage-light.server";

export const API_VERSION = "2026-10";

/**
 * GraphQL response structure.
 */
export interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: {
      code?: string;
    };
  }>;
}

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
 * Uses the shop's offline session for authentication. The offline session
 * is stored with id "offline_{shop}" in the Session table.
 *
 * NOTE: We use manual fetch instead of getShopifyApp().unauthenticated.admin()
 * because:
 * 1. unauthenticated.admin() requires the full Shopify app context which
 *    may not be available in the scheduled/cron handler context
 * 2. The drain runs outside of the normal request flow (via scheduled handler
 *    or pg_cron), so AsyncLocalStorage context may not be set up
 * 3. Manual fetch gives us precise control over error handling and retries
 *
 * @param sql - postgres.js SQL client for session lookup
 * @param shop - Shop domain (e.g., "example.myshopify.com")
 * @param query - GraphQL query string
 * @param variables - Optional query variables
 * @returns Result with data or error
 */
export async function adminGraphQL<T = unknown>(
  sql: Sql,
  shop: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<AdminClientResult<T>> {
  // Load the offline session for this shop
  const sessionStorage = new LightSessionStorage(sql);
  const offlineSessionId = `offline_${shop}`;
  const session = await sessionStorage.loadSession(offlineSessionId);

  if (!session) {
    return {
      success: false,
      error: `No offline session found for ${shop}. Shop may need to reinstall the app.`,
      retryable: false, // Don't retry - session won't magically appear
    };
  }

  if (!session.accessToken) {
    return {
      success: false,
      error: `Offline session for ${shop} has no access token.`,
      retryable: false,
    };
  }

  const url = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    // Handle HTTP-level errors
    if (response.status === 401 || response.status === 403) {
      return {
        success: false,
        error: `Authentication failed (${response.status}). Session may be invalid or revoked.`,
        retryable: false, // Token is invalid, retrying won't help
      };
    }

    if (response.status === 429) {
      return {
        success: false,
        error: "Rate limited (429). Will retry after visibility timeout.",
        retryable: true,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        retryable: response.status >= 500, // Retry server errors
      };
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    // Check for GraphQL-level errors
    if (json.errors && json.errors.length > 0) {
      const throttled = json.errors.some(
        (e) => e.extensions?.code === "THROTTLED"
      );
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
      data: json.data,
      retryable: false,
    };
  } catch (err) {
    // Network errors are retryable
    return {
      success: false,
      error: `Network error: ${err instanceof Error ? err.message : "Unknown"}`,
      retryable: true,
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

/**
 * Fetch a BulkOperation by GID to get the result URL.
 */
export const BULK_OPERATION_QUERY = `
  query BulkOperationById($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        fileSize
        url
        partialDataUrl
      }
    }
  }
`;

// =============================================================================
// BULK OPERATION MUTATIONS
// =============================================================================

/**
 * Start a bulk companies export.
 */
export const START_COMPANIES_BULK_MUTATION = `
  mutation BulkCompaniesExport {
    bulkOperationRunQuery(
      query: """
      {
        companies {
          edges {
            node {
              id
              name
              externalId
              locations {
                edges {
                  node {
                    id
                    name
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
            }
          }
        }
      }
      """
    ) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Start a bulk orders export.
 */
export const START_ORDERS_BULK_MUTATION = `
  mutation BulkOrdersExport {
    bulkOperationRunQuery(
      query: """
      {
        orders(query: "financial_status:pending OR financial_status:partially_paid") {
          edges {
            node {
              id
              name
              createdAt
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
      }
      """
    ) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;
