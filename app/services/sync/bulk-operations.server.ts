/**
 * Bulk operations for S6 backfill.
 *
 * Provides functions to start bulkOperationRunQuery for:
 * - Companies and CompanyLocations
 * - Orders with payment terms (within 60-day read_orders window)
 *
 * These are triggered:
 * - After app install (afterAuth hook)
 * - Via admin action (manual backfill)
 *
 * The bulk_operations/finish webhook handles completion; actual JSONL
 * download and processing happens in the drain (S10).
 *
 * Note on read_all_orders:
 * Without read_all_orders scope, the orders query is limited to the last
 * 60 days. Once read_all_orders is approved, the query filter can be
 * removed to backfill all historical orders with payment terms.
 */

/**
 * GraphQL mutation to start a bulk operation for companies and locations.
 *
 * This query exports all companies with their locations and payment terms
 * configuration. The JSONL output will contain Company and CompanyLocation
 * objects linked by __parentId.
 */
export const BULK_COMPANIES_QUERY = `
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
              note
              createdAt
              updatedAt
              locations {
                edges {
                  node {
                    id
                    name
                    createdAt
                    updatedAt
                    billingAddress {
                      firstName
                      lastName
                      company
                      address1
                      address2
                      city
                      province
                      provinceCode
                      country
                      countryCodeV2
                      zip
                      phone
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
        url
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL mutation to start a bulk operation for orders with payment terms.
 *
 * Filters to orders with payment terms within the read_orders window (60 days).
 * The query uses financial_status:unpaid to focus on open invoices.
 *
 * Once read_all_orders scope is approved:
 * - Remove the created_at filter to backfill all historical orders
 * - Or add a configurable date range parameter
 */
export const BULK_ORDERS_QUERY = `
  mutation BulkOrdersExport {
    bulkOperationRunQuery(
      query: """
      {
        orders(query: "financial_status:unpaid OR financial_status:partially_paid") {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
              cancelledAt
              closedAt
              displayFinancialStatus
              displayFulfillmentStatus
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
                ... on Customer {
                  id
                }
              }
              customer {
                id
                email
                firstName
                lastName
                tags
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
        url
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * GraphQL query to check bulk operation status and get result URL.
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
 * Result of starting a bulk operation.
 */
export interface BulkOperationResult {
  success: boolean;
  bulkOperationId?: string;
  status?: string;
  error?: string;
}

/**
 * Start a bulk companies export.
 *
 * This is meant to be called from afterAuth or an admin action.
 * The actual GraphQL call will be made by the caller with access
 * to the authenticated session.
 *
 * @returns The GraphQL mutation string to execute
 */
export function getCompaniesExportMutation(): string {
  return BULK_COMPANIES_QUERY;
}

/**
 * Start a bulk orders export.
 *
 * This is meant to be called from afterAuth or an admin action.
 * The actual GraphQL call will be made by the caller with access
 * to the authenticated session.
 *
 * Note: Without read_all_orders, results are limited to 60 days.
 *
 * @returns The GraphQL mutation string to execute
 */
export function getOrdersExportMutation(): string {
  return BULK_ORDERS_QUERY;
}

/**
 * Parse the result of a bulkOperationRunQuery mutation.
 *
 * @param response - GraphQL response data
 * @returns Parsed result with operation ID or error
 */
export function parseBulkOperationResult(
  response: {
    bulkOperationRunQuery?: {
      bulkOperation?: {
        id: string;
        status: string;
      } | null;
      userErrors?: Array<{ field: string[]; message: string }>;
    };
  } | null
): BulkOperationResult {
  if (!response?.bulkOperationRunQuery) {
    return {
      success: false,
      error: "No bulkOperationRunQuery in response",
    };
  }

  const { bulkOperation, userErrors } = response.bulkOperationRunQuery;

  if (userErrors && userErrors.length > 0) {
    return {
      success: false,
      error: userErrors.map((e) => e.message).join("; "),
    };
  }

  if (!bulkOperation) {
    return {
      success: false,
      error: "No bulk operation returned",
    };
  }

  return {
    success: true,
    bulkOperationId: bulkOperation.id,
    status: bulkOperation.status,
  };
}
