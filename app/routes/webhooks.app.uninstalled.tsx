import type { ActionFunctionArgs } from "react-router";
import type { Session } from "@shopify/shopify-api";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify, sessionStorage } = context;

  const { shop, topic } = await shopify.authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete ALL sessions for this shop (DPDP data minimization compliance).
  // A shop may have multiple sessions: offline token + online tokens per user.
  // The webhook can fire multiple times or after the app is already uninstalled,
  // so handle gracefully if sessions don't exist.
  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    if (sessions.length > 0) {
      const sessionIds = sessions.map((s: Session) => s.id);
      await sessionStorage.deleteSessions(sessionIds);
      console.log(`Deleted ${sessionIds.length} session(s) for ${shop}`);
    }
  } catch (error) {
    // Log but don't fail - the shop is already uninstalled
    console.error(`Error deleting sessions for ${shop}:`, error);
  }

  return new Response();
};
