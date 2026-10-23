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
 *
 * DPDP note: Only billingAddress.company is fetched (name fallback for BuyerAccount).
 * No PII fields (names, addresses, phones) are requested.
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
 * Filters to orders with outstanding payment terms:
 * - pending: Orders awaiting full payment (typical for net-terms)
 * - partially_paid: Orders with partial payment received
 *
 * Per Shopify Admin API OrderDisplayFinancialStatus enum (2026-10):
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/enums/OrderDisplayFinancialStatus
 *
 * Valid values: AUTHORIZED, EXPIRED, PAID, PARTIALLY_PAID, PARTIALLY_REFUNDED,
 * PENDING, REFUNDED, VOIDED. For net-terms orders:
 * - PENDING: Created with payment terms, awaiting full payment
 * - PARTIALLY_PAID: Partial payment manually captured
 * - AUTHORIZED does not apply to net-terms (for payment card auth holds only)
 *
 * Without read_all_orders scope, order access is limited to the last 60 days
 * (Shopify default). Once read_all_orders is approved, all historical orders
 * matching the filter will be included.
 *
 * DPDP note: Only customer.id is fetched (for BuyerAccount lookup).
 * No PII fields (email, names, tags) are requested.
 */
export const BULK_ORDERS_QUERY = `
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
              processedAt
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
 * Bulk operation type for tracking.
 * S8 adds "customers" for tagged customer backfill.
 */
export type BulkOperationType = "companies" | "orders" | "customers";

/**
 * Origin of a bulk operation.
 */
export type BulkOperationOrigin = "reconcile" | "webhook" | "manual";

/**
 * Reconcile stage for sequential processing.
 */
export type ReconcileStage = "companies" | "orders";

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

// Re-export customer bulk query and env type from the centralized field module
export {
  getBulkCustomersQuery as getCustomersExportMutation,
  type PiiEnv,
} from "./customer-fields.server";

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

/**
 * Register a bulk operation in the tracking table.
 *
 * Call this after successfully starting a bulk operation to record its type.
 * The finish webhook will look up the type to route the JSONL to the correct
 * processor.
 *
 * @param sql - postgres.js SQL client
 * @param bulkOperationId - The bulk operation GID from Shopify
 * @param shop - Shop domain
 * @param bulkType - Type of bulk operation (companies or orders)
 * @param origin - Source of the bulk operation (reconcile, webhook, manual)
 * @param reconcileStage - For reconcile origin, which stage (companies, orders)
 */
export async function registerBulkOperation(
  sql: import("~/lib/db-light.server").Sql,
  bulkOperationId: string,
  shop: string,
  bulkType: BulkOperationType,
  origin: BulkOperationOrigin = "webhook",
  reconcileStage?: ReconcileStage
): Promise<void> {
  await sql`
    INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, origin, reconcile_stage)
    VALUES (${bulkOperationId}, ${shop}, ${bulkType}, ${origin}, ${reconcileStage ?? null})
    ON CONFLICT (bulk_operation_id) DO UPDATE SET
      shop = EXCLUDED.shop,
      bulk_type = EXCLUDED.bulk_type,
      origin = EXCLUDED.origin,
      reconcile_stage = EXCLUDED.reconcile_stage
  `;
}

/**
 * Get bulk operation metadata including origin and stage.
 */
export async function getBulkOperationMetadata(
  sql: import("~/lib/db-light.server").Sql,
  bulkOperationId: string
): Promise<{
  shop: string;
  bulkType: BulkOperationType;
  origin: BulkOperationOrigin;
  reconcileStage: ReconcileStage | null;
  failureCount: number;
  chunkSize: number;
} | null> {
  const [row] = await sql<{
    shop: string;
    bulk_type: string;
    origin: string;
    reconcile_stage: string | null;
    failure_count: number;
    chunk_size: number;
  }[]>`
    SELECT shop, bulk_type, origin, reconcile_stage, failure_count, chunk_size
    FROM s6_bulk_operations
    WHERE bulk_operation_id = ${bulkOperationId}
  `;

  if (!row) return null;

  return {
    shop: row.shop,
    bulkType: row.bulk_type as BulkOperationType,
    origin: row.origin as BulkOperationOrigin,
    reconcileStage: row.reconcile_stage as ReconcileStage | null,
    failureCount: row.failure_count,
    chunkSize: row.chunk_size,
  };
}

/**
 * Increment failure count for a bulk operation.
 */
export async function incrementBulkOperationFailureCount(
  sql: import("~/lib/db-light.server").Sql,
  bulkOperationId: string
): Promise<number> {
  const [row] = await sql<{ failure_count: number }[]>`
    UPDATE s6_bulk_operations
    SET failure_count = failure_count + 1
    WHERE bulk_operation_id = ${bulkOperationId}
    RETURNING failure_count
  `;
  return row?.failure_count ?? 0;
}

/**
 * Update chunk size for a bulk operation (for growing range window).
 */
export async function updateBulkOperationChunkSize(
  sql: import("~/lib/db-light.server").Sql,
  bulkOperationId: string,
  chunkSize: number
): Promise<void> {
  await sql`
    UPDATE s6_bulk_operations
    SET chunk_size = ${chunkSize}
    WHERE bulk_operation_id = ${bulkOperationId}
  `;
}
