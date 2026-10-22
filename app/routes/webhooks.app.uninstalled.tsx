import type { ActionFunctionArgs } from "react-router";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Prisma client and Shopify app are injected per-request via loadContext
  const { shopify, prisma } = context;

  const { shop, topic } = await shopify.authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Delete ALL sessions for this shop directly by shop column (DPDP compliance).
  // A shop may have multiple sessions: offline token + online tokens per user.
  // Using deleteMany avoids the 25-session limit of findSessionsByShop.
  // This is idempotent: returns count=0 if no sessions exist (already uninstalled).
  try {
    const result = await prisma.session.deleteMany({
      where: { shop },
    });
    console.log(`Deleted ${result.count} session(s) for ${shop}`);
  } catch (error) {
    // Log but don't fail - the shop is already uninstalled
    console.error(`Error deleting sessions for ${shop}:`, error);
  }

  return new Response();
};
