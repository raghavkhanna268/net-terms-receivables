import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  verifyPayloadShopMatch,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import { redactCustomerData, redactShopData } from "~/services/sync/customer.server";

/**
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Most compliance handlers don't need DB access
 * for session management, only for S8 data purges.
 *
 * CPU savings: ~5-10ms by avoiding session DB round-trip on every webhook.
 * HMAC verification uses Web Crypto (crypto.subtle) with constant-time comparison.
 *
 * S8 data handling:
 * - customers/redact: Deletes s8_tagged_customers and s8_draft_orders for the customer
 * - shop/redact: Deletes all s8_tagged_customers and s8_draft_orders for the shop
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
      // Verify payload shop_domain matches header shop for security.
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
      };
      const customerGid = typedPayload.customer?.id
        ? `gid://shopify/Customer/${typedPayload.customer.id}`
        : "unknown";

      // S8 stores customer GID, tags, email, and displayName.
      // Automated data export ships in S22 (#44); until then, export is out of band.
      console.log(
        `[Compliance] customers/data_request for shop=${payloadShop} customer=${customerGid}`
      );
      break;
    }

    case "CUSTOMERS_REDACT": {
      // Verify payload shop_domain matches header shop for security.
      // The shop to purge comes from the signed payload, not just the header.
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
      };

      // Missing customer.id is a safe no-op (return 200)
      if (!typedPayload.customer?.id) {
        console.log(
          `[Compliance] customers/redact: No customer ID in payload for shop=${payloadShop}`
        );
        break;
      }

      // Get shop ID for S8 data deletion using the verified payload shop
      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (shopRecord) {
        // Customer GID format: gid://shopify/Customer/123
        const customerGid = `gid://shopify/Customer/${typedPayload.customer.id}`;
        const counts = await redactCustomerData(sql, shopRecord.id, customerGid);
        console.log(
          `[Compliance] customers/redact: Deleted ${counts.taggedCustomers} tagged customer(s), ${counts.draftOrders} draft order(s) for customer=${customerGid} shop=${payloadShop}`
        );
      } else {
        console.log(
          `[Compliance] customers/redact: Shop not found for domain=${payloadShop}`
        );
      }
      break;
    }

    case "SHOP_REDACT": {
      // Verify payload shop_domain matches header shop for security.
      // The shop to purge comes from the signed payload, not just the header.
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      // Delete all session data for this shop via deleteAllForShop.
      // Idempotent: returns 200 even when no sessions exist.
      const { sessionStorage } = context;
      const count = await sessionStorage.deleteAllForShop(payloadShop);
      console.log(
        `[Compliance] shop/redact: Deleted ${count} session(s) for shop=${payloadShop}`
      );

      // S8: Delete all s8_tagged_customers and s8_draft_orders for this shop
      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (shopRecord) {
        const s8Counts = await redactShopData(sql, shopRecord.id);
        console.log(
          `[Compliance] shop/redact: Deleted ${s8Counts.taggedCustomers} tagged customer(s), ${s8Counts.draftOrders} draft order(s) for shop=${payloadShop}`
        );
      }
      break;
    }

    default:
      console.log(`[Compliance] Unhandled topic: ${normalizedTopic}`);
  }

  return new Response(null, { status: 200 });
};
