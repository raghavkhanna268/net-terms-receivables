/**
 * S22 Compliance service exports.
 */

export {
  deleteShop,
  deleteProcessedWebhooksViaReceipts,
  purgePgmqMessages,
  redactCustomer,
  generateCustomerDataExport,
  persistDataRequest,
  purgeExpiredDataRequests,
  getPendingDataRequests,
  getDataRequestExport,
  markDataRequestDownloaded,
  sendDataRequestNotification,
  minimiseInactiveCustomerPii,
  minimiseCustomerPiiIfInactive,
  markShopUninstalled,
} from "./compliance.server";

export type { DataRequestEmailResult } from "./compliance.server";

export {
  handleDataRequest,
  handleCustomerRedact,
  handleShopRedact,
} from "./compliance-jobs.server";

export type { ComplianceMessage } from "./compliance-jobs.server";
