import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

/**
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * HMAC verification is handled by authenticate.webhook(), which returns
 * 401 Unauthorized for invalid signatures.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const env = context.cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(
    `[Compliance] Received ${topic} webhook for shop=${shop}, webhook_id=${payload?.webhook_id ?? "unknown"}`
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

    case "SHOP_REDACT":
      // Delete all session data for this shop.
      // NOTE: Session storage is being migrated from KV to Prisma in S2.
      // This uses the sessionStorage abstraction to remain compatible.
      await deleteShopSessions(shop);
      console.log(
        `[Compliance] shop/redact: Deleted all sessions for shop=${shop}`
      );
      break;

    default:
      console.log(`[Compliance] Unhandled topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};

/**
 * Delete all sessions for a shop via the session storage abstraction.
 * This goes through sessionStorage.findSessionsByShop + deleteSessions
 * rather than KV-specific calls to remain compatible with the S2 Prisma migration.
 */
async function deleteShopSessions(shop: string): Promise<void> {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (sessions.length === 0) {
    return;
  }

  const sessionIds = sessions.map((s) => s.id);
  await sessionStorage.deleteSessions(sessionIds);
}
