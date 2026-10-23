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
  sendDataRequestNotification,
} from "~/services/compliance";

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

  console.log(
    `[Compliance] Received ${normalizedTopic} webhook for shop=${shop}, webhook_id=${webhookId}`
  );

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
          `[Compliance] customers/data_request: No customer ID in payload for shop=${payloadShop}`
        );
        break;
      }

      if (!typedPayload.data_request?.id) {
        console.log(
          `[Compliance] customers/data_request: No data_request.id in payload for shop=${payloadShop}`
        );
        break;
      }

      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (!shopRecord) {
        console.log(
          `[Compliance] customers/data_request: Shop not found for domain=${payloadShop}`
        );
        break;
      }

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
          `data request id=${id} shop=${payloadShop}`
      );

      // Send email notification to shop owner (gated on RESEND_API_KEY)
      // Get access token from session storage for Admin API call
      const { sessionStorage } = context;
      const sessions = await sessionStorage.findSessionsByShop(payloadShop);
      const offlineSession = sessions.find(
        (s: { isOnline: boolean; accessToken?: string }) => !s.isOnline && s.accessToken
      );

      if (offlineSession?.accessToken) {
        const emailResult = await sendDataRequestNotification(
          payloadShop,
          offlineSession.accessToken,
          requestId
        );
        if (emailResult.sent) {
          console.log(
            `[Compliance] customers/data_request: Email notification sent for shop=${payloadShop}`
          );
        } else if (emailResult.error) {
          console.log(
            `[Compliance] customers/data_request: Email notification failed for shop=${payloadShop} error=${emailResult.error}`
          );
        }
        // Note: skipped emails are logged inside sendDataRequestNotification
      } else {
        console.log(
          `data_request_email_skipped shop=${payloadShop} request_id=${requestId} reason=no_access_token`
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
          `[Compliance] customers/redact: No customer ID in payload for shop=${payloadShop}`
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
          `[Compliance] customers/redact: Deleted ${counts.taggedCustomersDeleted} tagged customer(s), ` +
            `${counts.draftOrdersDeleted} draft order(s), ` +
            `anonymized account=${counts.buyerAccountAnonymized}, ` +
            `${counts.paymentsRedacted} payment(s) linked to buyer ` +
            `shop=${payloadShop}`
        );
      } else {
        console.log(
          `[Compliance] customers/redact: Shop not found for domain=${payloadShop}`
        );
      }
      break;
    }

    case "SHOP_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const { sessionStorage } = context;
      const sessionCount = await sessionStorage.deleteAllForShop(payloadShop);
      console.log(
        `[Compliance] shop/redact: Deleted ${sessionCount} session(s) for shop=${payloadShop}`
      );

      const pgmqResult = await purgePgmqMessages(sql, payloadShop);
      console.log(
        `[Compliance] shop/redact: pgmq purge - ${pgmqResult.reason}`
      );

      const { deleted, shopId } = await deleteShop(sql, payloadShop);

      if (deleted) {
        console.log(
          `[Compliance] shop/redact: Deleted Shop id=${shopId} domain=${payloadShop} ` +
            `(all data cascaded via FKs)`
        );
      } else {
        console.log(
          `[Compliance] shop/redact: Shop not found for domain=${payloadShop} ` +
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
