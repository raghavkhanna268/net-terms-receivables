import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  verifyPayloadShopMatch,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";

/**
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Most compliance handlers don't need DB access:
 * - customers/data_request: No-op (no customer data stored)
 * - customers/redact: No-op (no customer data stored)
 * - shop/redact: Only needs deleteAllForShop (delete-only, no session loading)
 *
 * CPU savings: ~5-10ms by avoiding session DB round-trip on every webhook.
 * HMAC verification uses Web Crypto (crypto.subtle) with constant-time comparison.
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

  switch (normalizedTopic) {
    case "CUSTOMERS_DATA_REQUEST":
      // TODO(S22): When customer data is stored, respond with data export.
      // Currently the app stores no customer data, so this is a no-op.
      // S8 PR #32 will add a purge of s8_tagged_customers.
      console.log(
        `[Compliance] customers/data_request: No customer data stored for shop=${shop}`
      );
      break;

    case "CUSTOMERS_REDACT":
      // TODO(S22): When customer data is stored, delete it here.
      // Currently the app stores no customer data, so this is a no-op.
      // S8 PR #32 will add a purge of s8_tagged_customers.
      console.log(
        `[Compliance] customers/redact: No customer data to delete for shop=${shop}`
      );
      break;

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
      break;
    }

    default:
      console.log(`[Compliance] Unhandled topic: ${normalizedTopic}`);
  }

  return new Response(null, { status: 200 });
};
