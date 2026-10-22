import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  // Inject KV namespace for session storage
  const env = context.cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await sessionStorage.deleteSession(session.id);
  }

  return new Response();
};
