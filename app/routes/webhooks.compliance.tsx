import type { ActionFunctionArgs } from "react-router";

/**
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * HMAC verification is handled by authenticate.webhook(), which returns
 * 401 Unauthorized for invalid signatures.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Prisma client and Shopify app are injected per-request via loadContext in workers/app.ts
  const { shopify, prisma } = context;

  const { shop, topic, webhookId } = await shopify.authenticate.webhook(request);

  console.log(
    `[Compliance] Received ${topic} webhook for shop=${shop}, webhook_id=${webhookId}`
  );

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // TODO(S22): When customer data is stored, respond with data export.
      // Currently the app stores no customer data, so this is a no-op.
      console.log(
        `[Compliance] customers/data_request: No customer data stored for shop=${shop}`
      );
      break;

    case "CUSTOMERS_REDACT":
      // TODO(S22): When customer data is stored, delete it here.
      // Currently the app stores no customer data, so this is a no-op.
      console.log(
        `[Compliance] customers/redact: No customer data to delete for shop=${shop}`
      );
      break;

    case "SHOP_REDACT": {
      // Delete all session data for this shop directly by shop column.
      // This is idempotent: returns 200 even when no sessions exist.
      // Using deleteMany avoids the stale session ID issue from #10.
      const result = await prisma.session.deleteMany({
        where: { shop },
      });
      console.log(
        `[Compliance] shop/redact: Deleted ${result.count} session(s) for shop=${shop}`
      );
      break;
    }

    default:
      console.log(`[Compliance] Unhandled topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};
