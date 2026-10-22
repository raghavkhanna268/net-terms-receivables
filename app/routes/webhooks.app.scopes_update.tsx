import type { ActionFunctionArgs } from "react-router";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify, sessionStorage } = context;

  const { shop, topic, payload } = await shopify.authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Update session scopes when the merchant changes app permissions.
  // The payload contains the current scopes granted to the app.
  // Uses updateScopeForShop which calls updateMany in a single query.
  try {
    const currentScopes = (payload as { current?: string[] })?.current?.join(",");

    if (currentScopes) {
      const count = await sessionStorage.updateScopeForShop(shop, currentScopes);
      console.log(`Updated scopes for ${count} session(s) to: ${currentScopes}`);
    }
  } catch (error) {
    console.error(`Error updating scopes for ${shop}:`, error);
    // Don't fail the webhook - Shopify will retry
  }

  return new Response();
};
