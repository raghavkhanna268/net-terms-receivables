import type { ActionFunctionArgs } from "react-router";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify, sessionStorage } = context;

  const { shop, topic } = await shopify.authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete ALL sessions for this shop (DPDP compliance).
  // Uses deleteAllForShop which calls deleteMany internally, avoiding
  // the 25-session limit of findSessionsByShop.
  // Idempotent: returns count=0 if no sessions exist (already uninstalled).
  try {
    const count = await sessionStorage.deleteAllForShop(shop);
    console.log(`Deleted ${count} session(s) for ${shop}`);
  } catch (error) {
    // Log but don't fail - the shop is already uninstalled
    console.error(`Error deleting sessions for ${shop}:`, error);
  }

  return new Response();
};
