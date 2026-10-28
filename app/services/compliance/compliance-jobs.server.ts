/**
 * Compliance job handlers for the drain processor.
 *
 * These handlers process compliance webhooks (customers/data_request,
 * customers/redact, shop/redact) that were enqueued by the compliance
 * webhook route. Each handler is idempotent.
 *
 * The queue message carries ONLY: topic, requestId (data_request),
 * customerId or shopId - no payload, emails, phone numbers, or shop domains.
 */

import type { Sql } from "~/lib/db-light.server";
import type { SyncResult } from "~/services/sync/types";
import {
  deleteShop,
  redactCustomer,
  generateCustomerDataExport,
  persistDataRequest,
  purgeExpiredDataRequests,
  sendDataRequestNotification,
  purgePgmqMessages,
} from "./compliance.server";
import { getOfflineAdminContext } from "~/lib/offline-admin.server";
import { safeLog, shopHash, toErrorCode } from "~/lib/log.server";

/**
 * Compliance message shape for queue processing.
 * Contains only minimal identifiers - no PII.
 * All values are strings per SyncMessage interface.
 */
export interface ComplianceMessage {
  topic: string;
  shop: string;
  webhookId: string;
  enqueuedAt: string;
  requestId?: string;
  customerId?: string;
  shopId?: string;
}

/**
 * Fetch shop owner email using the offline session admin client.
 * Returns null if email cannot be fetched.
 */
async function fetchShopOwnerEmail(sql: Sql, shop: string): Promise<string | null> {
  try {
    const clientId = process.env.SHOPIFY_API_KEY;
    const clientSecret = process.env.SHOPIFY_API_SECRET;

    if (!clientId || !clientSecret) {
      return null;
    }

    const adminResult = await getOfflineAdminContext(sql, shop, clientId, clientSecret);

    if (!adminResult.success || !adminResult.admin) {
      return null;
    }

    const response = await adminResult.admin.graphql(`
      query {
        shop {
          email
          contactEmail
        }
      }
    `);

    const json = await response.json() as { data?: { shop?: { email?: string; contactEmail?: string } } };
    const shopData = json.data?.shop;

    return shopData?.email || shopData?.contactEmail || null;
  } catch {
    return null;
  }
}

/**
 * Handler for CUSTOMERS_DATA_REQUEST topic.
 *
 * Generates a data export for the customer, persists it, and sends an email
 * notification to the shop owner. The email is best-effort and never fails
 * the job.
 *
 * Idempotent: A unique violation on s22_data_requests.request_id counts as
 * a duplicate; the email is sent only for a new request.
 */
export async function handleDataRequest(
  sql: Sql,
  message: ComplianceMessage
): Promise<SyncResult> {
  const { shop, requestId, customerId } = message;

  if (!requestId || !customerId) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Missing requestId or customerId in message",
    };
  }

  const [shopRecord] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shop}
  `;

  if (!shopRecord) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Shop not found",
    };
  }

  await purgeExpiredDataRequests(sql, shopRecord.id);

  const customerGid = `gid://shopify/Customer/${customerId}`;

  const exportData = await generateCustomerDataExport(
    sql,
    shopRecord.id,
    customerGid,
    String(requestId)
  );

  const { alreadyExists } = await persistDataRequest(
    sql,
    shopRecord.id,
    customerGid,
    requestId,
    exportData
  );

  if (alreadyExists) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Duplicate data request",
    };
  }

  const shopOwnerEmail = await fetchShopOwnerEmail(sql, shop);

  if (shopOwnerEmail) {
    try {
      await sendDataRequestNotification(shop, shopOwnerEmail, requestId);
    } catch (err) {
      const hash = await shopHash(shop);
      safeLog("warn", "data_request_email_failed", {
        shopHash: hash,
        requestId,
        err: toErrorCode(err),
      });
    }
  }

  return {
    success: true,
    action: "created",
  };
}

/**
 * Handler for CUSTOMERS_REDACT topic.
 *
 * Deletes all customer data for the given customer.
 *
 * Idempotent: Running twice is a no-op.
 */
export async function handleCustomerRedact(
  sql: Sql,
  message: ComplianceMessage
): Promise<SyncResult> {
  const { shop, customerId } = message;

  if (!customerId) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Missing customerId in message",
    };
  }

  const [shopRecord] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shop}
  `;

  if (!shopRecord) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Shop not found",
    };
  }

  const customerGid = `gid://shopify/Customer/${customerId}`;
  const counts = await redactCustomer(sql, shopRecord.id, customerGid);

  const hash = await shopHash(shop);
  safeLog("info", "customers_redact_complete", {
    shopHash: hash,
    taggedCustomersDeleted: counts.taggedCustomersDeleted,
    draftOrdersDeleted: counts.draftOrdersDeleted,
    dataRequestsDeleted: counts.dataRequestsDeleted,
    payerAliasesDeleted: counts.payerAliasesDeleted,
    buyerAccountAnonymized: counts.buyerAccountAnonymized,
    paymentsRedacted: counts.paymentsRedacted,
    b2bMainContactsRedacted: counts.b2bMainContactsRedacted,
  });

  return {
    success: true,
    action: "skipped",
    skipReason: "Customer redacted",
  };
}

/**
 * Handler for SHOP_REDACT topic.
 *
 * Deletes the shop and all its data. Also deletes the shop's webhook_receipts
 * rows so no shop domain remains after a successful shop/redact.
 *
 * Idempotent: Running twice is a no-op. A retry arriving after deletion
 * reruns as a no-op and deletes its own new receipt too.
 */
export async function handleShopRedact(
  sql: Sql,
  message: ComplianceMessage
): Promise<SyncResult> {
  const { shop } = message;

  const pgmqResult = await purgePgmqMessages(sql, shop);
  const hash = await shopHash(shop);

  const result = await deleteShop(sql, shop);

  if (result.skippedReinstalled) {
    safeLog("info", "shop_redact_skipped_reinstalled", {
      shopHash: hash,
    });
  } else if (result.deleted) {
    safeLog("info", "shop_redact_deleted", {
      shopHash: hash,
      sessionsDeleted: result.sessionsDeleted,
      refetchNullPurged: result.refetchNullPurged,
      bulkOperationsPurged: result.bulkOperationsPurged,
      orderGapPurged: result.orderGapPurged,
      piiFallbackPurged: result.piiFallbackPurged,
      pgmqSyncQueuePurged: result.pgmqSyncQueuePurged,
      pgmqBulkQueuePurged: result.pgmqBulkQueuePurged,
      pgmqSyncArchivePurged: result.pgmqSyncArchivePurged,
      pgmqBulkArchivePurged: result.pgmqBulkArchivePurged,
      deadLetterPurged: result.deadLetterPurged,
      processedWebhooksPurged: result.processedWebhooksPurged,
      webhookReceiptsPurged: result.webhookReceiptsPurged,
    });
  } else {
    safeLog("info", "shop_redact_not_found", {
      shopHash: hash,
    });
  }

  return {
    success: true,
    action: result.deleted ? "skipped" : "skipped",
    skipReason: result.deleted ? "Shop deleted" : result.skippedReinstalled ? "Shop reinstalled" : "Shop not found",
  };
}
