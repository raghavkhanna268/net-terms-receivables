/**
 * Bulk operations for S6 backfill.
 *
 * Provides functions to start bulkOperationRunQuery for:
 * - Companies and CompanyLocations
 * - Orders with payment terms (within 60-day window via write_orders which implies read_orders)
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

import { shouldIncludePiiFields, type PiiEnv } from "./customer-fields.server";

/**
 * Build a bulk companies export mutation dynamically based on PII flag.
 *
 * DPDP data minimization:
 * - When CUSTOMER_PII_FIELDS=1: requests mainContact.customer { id email displayName }
 * - When flag is off: requests mainContact.customer { id } only
 *
 * The B2B recipient is the COMPANY's main contact (mainContact is on Company, not Location).
 * Note: CompanyAddress.company was renamed to companyName in 2026-10.
 *
 * @param env - Environment for PII flag check (required, no default)
 * @returns GraphQL mutation string
 */
export function getBulkCompaniesQuery(env: PiiEnv): string {
  const piiEnabled = shouldIncludePiiFields(env);
  const customerFields = piiEnabled ? "id\n                  email\n                  displayName" : "id";
  
  return `
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
              mainContact {
                customer {
                  ${customerFields}
                }
              }
              locations {
                edges {
                  node {
                    id
                    name
                    createdAt
                    updatedAt
                    billingAddress {
                      companyName
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
}

/**
 * GraphQL mutation to start a bulk operation for orders with payment terms.
 *
 * Filters to orders relevant for net-terms invoice management:
 * - pending: Orders awaiting full payment (typical for net-terms)
 * - partially_paid: Orders with partial payment received
 * - partially_refunded: Refunded but still has outstanding amount
 * - authorized: Orders with payment authorized (can become net-terms)
 * - paid: To update (settle) existing invoices that became PAID
 * - refunded: To update existing invoices that were refunded
 * - voided: To update existing invoices that were voided
 * - expired: Payment authorization expired (can still have net-terms)
 *
 * Note: Eligibility rules still gate CREATION of new invoices.
 * This wider filter ensures reconcile can UPDATE existing invoices
 * when their status changes (e.g., an invoice that was PENDING becomes PAID).
 *
 * Per Shopify Admin API OrderDisplayFinancialStatus enum (2026-10):
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/enums/OrderDisplayFinancialStatus
 *
 * Without read_all_orders scope, order access is limited to the last 60 days
 * (Shopify default). Once read_all_orders is approved, all historical orders
 * matching the filter will be included.
 *
 * DPDP note: Customer tags are fetched for tag-rule eligibility (not PII).
 * No email, name, phone, or address fields are requested.
 */
export const BULK_ORDERS_QUERY = `
  mutation BulkOrdersExport {
    bulkOperationRunQuery(
      query: """
      {
        orders(query: "financial_status:pending OR financial_status:partially_paid OR financial_status:partially_refunded OR financial_status:authorized OR financial_status:paid OR financial_status:refunded OR financial_status:voided OR financial_status:expired") {
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
              totalOutstandingSet {
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
                        amount
                        currencyCode
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
 * Sequence: companies → customers → orders (→ draft_orders in PR-B)
 */
export type ReconcileStage = "companies" | "customers" | "orders";

/**
 * Start a bulk companies export.
 *
 * This is meant to be called from afterAuth or an admin action.
 * The actual GraphQL call will be made by the caller with access
 * to the authenticated session.
 *
 * DPDP data minimization: only requests email/displayName when CUSTOMER_PII_FIELDS=1.
 *
 * @param env - Environment for PII flag check (required, no default)
 * @returns The GraphQL mutation string to execute
 */
export function getCompaniesExportMutation(env: PiiEnv): string {
  return getBulkCompaniesQuery(env);
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
 *
 * #293: Only updates rows where closed_at IS NULL to prevent reopening closed rows.
 */
export async function incrementBulkOperationFailureCount(
  sql: import("~/lib/db-light.server").Sql,
  bulkOperationId: string
): Promise<number> {
  const [row] = await sql<{ failure_count: number }[]>`
    UPDATE s6_bulk_operations
    SET failure_count = failure_count + 1
    WHERE bulk_operation_id = ${bulkOperationId}
      AND closed_at IS NULL
    RETURNING failure_count
  `;
  return row?.failure_count ?? 0;
}

/**
 * Reset failure count to 0 after successful progress.
 * Called on successful progress to give the operation a clean slate.
 *
 * #293: Only updates rows where closed_at IS NULL to prevent reopening closed rows.
 */
export async function resetBulkOperationFailureCount(
  sql: import("~/lib/db-light.server").Sql,
  bulkOperationId: string
): Promise<void> {
  await sql`
    UPDATE s6_bulk_operations
    SET failure_count = 0
    WHERE bulk_operation_id = ${bulkOperationId}
      AND closed_at IS NULL
  `;
}

/**
 * Update chunk size for a bulk operation (for growing range window).
 *
 * #293: Only updates rows where closed_at IS NULL to prevent reopening closed rows.
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
      AND closed_at IS NULL
  `;
}
