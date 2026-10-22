import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Inject KV namespace for session storage
  const env = context.cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Handle scope updates - the session will automatically reflect new scopes
  // Add any additional logic here if needed

  return new Response();
};
