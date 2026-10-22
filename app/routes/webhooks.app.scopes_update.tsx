import type { ActionFunctionArgs } from "react-router";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify, sessionStorage } = context;

  const { shop, topic, payload } = await shopify.authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Update session scopes when the merchant changes app permissions.
  // The payload contains the current scopes granted to the app.
  // We need to update all sessions for this shop to reflect the new scopes.
  try {
    const sessions = await sessionStorage.findSessionsByShop(shop);
    const currentScopes = (payload as { current?: string[] })?.current?.join(",");

    if (currentScopes && sessions.length > 0) {
      for (const session of sessions) {
        // Only update if scopes actually changed
        if (session.scope !== currentScopes) {
          session.scope = currentScopes;
          await sessionStorage.storeSession(session);
          console.log(`Updated scopes for session ${session.id} to: ${currentScopes}`);
        }
      }
    }
  } catch (error) {
    console.error(`Error updating scopes for ${shop}:`, error);
    // Don't fail the webhook - Shopify will retry
  }

  return new Response();
};
