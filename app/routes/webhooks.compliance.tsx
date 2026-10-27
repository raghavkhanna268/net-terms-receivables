import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  verifyPayloadShopMatch,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql, getRequestWaitUntil } from "~/lib/request-context.server";
import {
  deleteShop,
  purgePgmqMessages,
  redactCustomer,
  generateCustomerDataExport,
  persistDataRequest,
  purgeExpiredDataRequests,
  sendDataRequestNotification,
} from "~/services/compliance";
import { getOfflineAdminContext } from "~/lib/offline-admin.server";
import { safeLog, shopHash, toErrorCode } from "~/lib/log.server";
import type { Sql } from "~/lib/db-light.server";

/**
 * Fetch shop owner email using the offline session admin client.
 * Uses getOfflineAdminContext for proper token refresh locking.
 * Returns null if email cannot be fetched (no session, API error, etc.)
 *
 * IMPORTANT: All errors are caught and return null. This ensures customers/data_request
 * never returns 500 after persistDataRequest succeeds - email is best-effort.
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
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Most compliance handlers don't need DB access
 * for session management, only for S8/S22 data operations.
 *
 * CPU savings: ~5-10ms by avoiding session DB round-trip on every webhook.
 * HMAC verification uses Web Crypto (crypto.subtle) with constant-time comparison.
 *
 * S22 data handling:
 * - customers/data_request: Generate data export, persist s22_data_requests row
 * - customers/redact: Deletes s8 data, anonymizes BuyerAccount/Invoice/Payment
 * - shop/redact: Deletes Shop row (CASCADE removes all shop data)
 *
 * Idempotency: No edge deduplication - handlers are fully idempotent:
 * - data_request: Regenerating export is safe (same data)
 * - customers/redact: Deleting already-deleted data is safe
 * - shop/redact: Deleting already-deleted shop is safe
 *
 * Security: All handlers verify payload shop_domain matches header shop.
 * This prevents attackers from forging payloads to delete wrong shop's data.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[Compliance] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic, payload } = await verifyWebhook(request, apiSecret, {
    requireValidJson: true,
  });
  const normalizedTopic = normalizeWebhookTopic(topic);

  console.log(`[Compliance] Received ${normalizedTopic}`);

  const sql = getRequestSql();

  switch (normalizedTopic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
        data_request?: { id?: number };
      };

      if (!typedPayload.customer?.id) {
        console.log(
          "[Compliance] customers/data_request: No customer ID in payload"
        );
        break;
      }

      if (!typedPayload.data_request?.id) {
        console.log(
          "[Compliance] customers/data_request: No data_request.id in payload"
        );
        break;
      }

      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (!shopRecord) {
        console.log("[Compliance] customers/data_request: Shop not found");
        break;
      }

      // Purge expired data requests on access (in-app purge for databases without pg_cron)
      await purgeExpiredDataRequests(sql, shopRecord.id);

      const customerGid = `gid://shopify/Customer/${typedPayload.customer.id}`;
      const requestId = String(typedPayload.data_request.id);

      const exportData = await generateCustomerDataExport(
        sql,
        shopRecord.id,
        customerGid,
        requestId
      );

      const { id, alreadyExists } = await persistDataRequest(
        sql,
        shopRecord.id,
        customerGid,
        requestId,
        exportData
      );

      console.log(
        `[Compliance] customers/data_request: ${alreadyExists ? "Duplicate" : "Created"} ` +
          `data request id=${id}`
      );

      // Email notification work: fetches shop owner email and sends notification.
      const emailWork = async () => {
        try {
          const shopOwnerEmail = await fetchShopOwnerEmail(sql, payloadShop);

          if (shopOwnerEmail) {
            const emailResult = await sendDataRequestNotification(
              payloadShop,
              shopOwnerEmail,
              requestId
            );
            if (emailResult.sent) {
              console.log(
                "[Compliance] customers/data_request: Email notification sent"
              );
            } else if (emailResult.error) {
              console.log(
                "[Compliance] customers/data_request: Email notification failed error=email_send_failed"
              );
            }
          } else {
            console.log(
              `data_request_email_skipped request_id=${requestId} reason=no_shop_email`
            );
          }
        } catch (err) {
          const hash = await shopHash(payloadShop);
          safeLog("error", "data_request_email_failed", {
            shopHash: hash,
            requestId,
            err: toErrorCode(err),
          });
        }
      };

      // If waitUntil is available, defer email work and return 200 immediately.
      // Otherwise, await the email work inline before returning.
      const waitUntil = getRequestWaitUntil();
      if (waitUntil) {
        waitUntil(emailWork());
        return new Response(null, { status: 200 });
      }

      // Fallback: waitUntil unavailable, run email work inline
      await emailWork();
      return new Response(null, { status: 200 });
    }

    case "CUSTOMERS_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
      };

      if (!typedPayload.customer?.id) {
        console.log(
          "[Compliance] customers/redact: No customer ID in payload"
        );
        break;
      }

      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (shopRecord) {
        const customerGid = `gid://shopify/Customer/${typedPayload.customer.id}`;
        const counts = await redactCustomer(sql, shopRecord.id, customerGid);
        console.log(
          `[Compliance] customers/redact: Deleted tagged=${counts.taggedCustomersDeleted} ` +
            `draft_orders=${counts.draftOrdersDeleted} data_requests=${counts.dataRequestsDeleted} ` +
            `payer_aliases=${counts.payerAliasesDeleted}, ` +
            `anonymized account=${counts.buyerAccountAnonymized}, ` +
            `redacted payments=${counts.paymentsRedacted} shop_id=${shopRecord.id}`
        );
      } else {
        console.log("[Compliance] customers/redact: Shop not found");
      }
      break;
    }

    case "SHOP_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const pgmqResult = await purgePgmqMessages(sql, payloadShop);
      console.log(
        `[Compliance] shop/redact: pgmq purge - ${pgmqResult.reason}`
      );

      // deleteShop handles sessions, webhook_receipts, and s6_processed_webhooks
      // internally within its transaction. Sessions are only deleted when the
      // shop is actually being erased (not skipped by reinstall guard). See #291.
      const result = await deleteShop(sql, payloadShop);
      const hash = await shopHash(payloadShop);

      if (result.skippedReinstalled) {
        // Shop reinstalled within the 48h window before shop/redact arrived (#291).
        // Skip deletion to preserve the reinstalled shop's data.
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
      break;
    }

    default:
      console.log(`[Compliance] Unhandled topic: ${normalizedTopic}`);
  }

  return new Response(null, { status: 200 });
};
