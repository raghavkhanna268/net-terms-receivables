import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  verifyPayloadShopMatch,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  deleteShop,
  purgePgmqMessages,
  redactCustomer,
  generateCustomerDataExport,
  persistDataRequest,
  purgeExpiredDataRequests,
  sendDataRequestNotification,
} from "~/services/compliance";
import { getShopifyApp } from "~/shopify.server";
import { deleteWebhookReceiptsForShop } from "~/lib/webhook-receipts.server";

/**
 * Fetch shop owner email using the offline session admin client.
 * Returns null if email cannot be fetched (no session, API error, etc.)
 */
async function fetchShopOwnerEmail(shop: string): Promise<string | null> {
  try {
    const shopify = getShopifyApp();
    const { admin } = await shopify.unauthenticated.admin(shop);
    
    const response = await admin.graphql(`
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
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[Compliance] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret, {
    requireValidJson: true,
  });
  const normalizedTopic = normalizeWebhookTopic(topic);

  console.log(`[Compliance] Received ${normalizedTopic} wh=${webhookId}`);

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
          `[Compliance] customers/data_request: No customer ID in payload wh=${webhookId}`
        );
        break;
      }

      if (!typedPayload.data_request?.id) {
        console.log(
          `[Compliance] customers/data_request: No data_request.id in payload wh=${webhookId}`
        );
        break;
      }

      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (!shopRecord) {
        console.log(
          `[Compliance] customers/data_request: Shop not found wh=${webhookId}`
        );
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
          `data request id=${id} wh=${webhookId}`
      );

      // Send email notification to shop owner (gated on RESEND_API_KEY)
      // Fetch shop owner email via Admin API using offline session
      const shopOwnerEmail = await fetchShopOwnerEmail(payloadShop);

      if (shopOwnerEmail) {
        const emailResult = await sendDataRequestNotification(
          payloadShop,
          shopOwnerEmail,
          requestId
        );
        if (emailResult.sent) {
          console.log(
            `[Compliance] customers/data_request: Email notification sent wh=${webhookId}`
          );
        } else if (emailResult.error) {
          console.log(
            `[Compliance] customers/data_request: Email notification failed wh=${webhookId} error=email_send_failed`
          );
        }
        // Note: skipped emails are logged inside sendDataRequestNotification
      } else {
        console.log(
          `data_request_email_skipped wh=${webhookId} request_id=${requestId} reason=no_shop_email`
        );
      }
      break;
    }

    case "CUSTOMERS_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
      };

      if (!typedPayload.customer?.id) {
        console.log(
          `[Compliance] customers/redact: No customer ID in payload wh=${webhookId}`
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
            `redacted payments=${counts.paymentsRedacted} shop_id=${shopRecord.id} wh=${webhookId}`
        );
      } else {
        console.log(
          `[Compliance] customers/redact: Shop not found wh=${webhookId}`
        );
      }
      break;
    }

    case "SHOP_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const { sessionStorage } = context;
      const sessionCount = await sessionStorage.deleteAllForShop(payloadShop);
      console.log(
        `[Compliance] shop/redact: Deleted ${sessionCount} session(s) wh=${webhookId}`
      );

      const pgmqResult = await purgePgmqMessages(sql, payloadShop);
      console.log(
        `[Compliance] shop/redact: pgmq purge - ${pgmqResult.reason}`
      );

      // Purge webhook receipts for the shop (S20 compliance)
      const receiptsDeleted = await deleteWebhookReceiptsForShop(sql, payloadShop);
      console.log(
        `[Compliance] shop/redact: Deleted ${receiptsDeleted} webhook receipts wh=${webhookId}`
      );

      const { deleted, shopId } = await deleteShop(sql, payloadShop);

      if (deleted) {
        console.log(
          `[Compliance] shop/redact: Deleted Shop id=${shopId} wh=${webhookId} ` +
            `(all data cascaded via FKs)`
        );
      } else {
        console.log(
          `[Compliance] shop/redact: Shop not found wh=${webhookId} ` +
            `(may have been deleted already or never installed)`
        );
      }
      break;
    }

    default:
      console.log(`[Compliance] Unhandled topic: ${normalizedTopic}`);
  }

  return new Response(null, { status: 200 });
};
