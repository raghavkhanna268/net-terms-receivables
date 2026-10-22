import type { ActionFunctionArgs } from "react-router";
import type { Session } from "@shopify/shopify-api";

/**
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * HMAC verification is handled by authenticate.webhook(), which returns
 * 401 Unauthorized for invalid signatures.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify, sessionStorage } = context;

  const { shop, topic, payload } = await shopify.authenticate.webhook(request);

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
      // Delete all session data for this shop (DPDP compliance).
      await deleteShopSessions(shop, sessionStorage);
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
 * to work with both KV (legacy) and Prisma (S2+) storage backends.
 */
async function deleteShopSessions(
  shop: string,
  sessionStorage: {
    findSessionsByShop: (shop: string) => Promise<Session[]>;
    deleteSessions: (ids: string[]) => Promise<boolean>;
  }
): Promise<void> {
  const sessions = await sessionStorage.findSessionsByShop(shop);
  if (sessions.length === 0) {
    return;
  }

  const sessionIds = sessions.map((s: Session) => s.id);
  await sessionStorage.deleteSessions(sessionIds);
}
