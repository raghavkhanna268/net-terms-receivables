/**
 * S6 Sync Services
 *
 * Pure functions for mapping Shopify Company/CompanyLocation and Order
 * data to our BuyerAccount and Invoice tables.
 *
 * These are invoked by the queue drain (S10) when processing messages
 * from the s6_sync and s6_bulk queues.
 */

// Types
export type {
  ShopifyCompany,
  ShopifyCompanyLocation,
  ShopifyOrder,
  SyncResult,
  BulkCompanyLine,
  BulkCompanyLocationLine,
  BulkOrderLine,
  ParsedBulkResult,
} from "./types";

// Company sync (metadata tracking only)
export {
  processCompanyWebhook,
  mapCompany,
  isWebhookProcessed,
  markWebhookProcessed,
} from "./company.server";

// CompanyLocation sync (creates BuyerAccount)
export {
  processCompanyLocationWebhook,
  mapCompanyLocationToBuyerAccount,
  bulkUpsertBuyerAccounts,
} from "./company-location.server";

// Order sync (creates Invoice)
export {
  processOrderWebhook,
  mapOrderToInvoice,
  bulkUpsertInvoices,
} from "./order.server";

// Bulk JSONL parsing
export {
  parseJsonl,
  parseCompanyBulkJsonl,
  parseOrderBulkJsonl,
  bulkLocationToShopifyLocation,
  bulkOrderToShopifyOrder,
} from "./bulk-parser.server";

// Bulk operation queries and registration
export {
  getBulkCompaniesQuery,
  BULK_ORDERS_QUERY,
  BULK_OPERATION_STATUS_QUERY,
  getCompaniesExportMutation,
  getOrdersExportMutation,
  parseBulkOperationResult,
  registerBulkOperation,
} from "./bulk-operations.server";
export type { BulkOperationType } from "./bulk-operations.server";
