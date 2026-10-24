import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * App Store compliance: Per Shopify requirement 2.3.1, App Store apps must not
 * request manual entry of a myshopify.com URL or shop domain during installation
 * or configuration. Install/login must start from the Shopify App Store or admin.
 *
 * This route handles OAuth redirects when shopify.login() receives a shop
 * parameter (from Shopify's managed installation flow). If a merchant lands
 * here without a shop parameter (e.g., direct URL access), we redirect to /app
 * which will trigger the appropriate authentication flow.
 *
 * @see https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
 */

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;

  // shopify.login() returns a redirect if shop is present (OAuth flow),
  // or returns an error object if shop is missing/invalid.
  // Since we don't show a form, a missing shop means the user should go to /app.
  const result = await shopify.login(request);

  // If login didn't throw a redirect (i.e., no valid shop), redirect to /app
  // which will handle embedded auth or prompt via Shopify's flow.
  if (result) {
    throw redirect("/app");
  }

  // This line is reached only if shopify.login() returned null/undefined
  // without redirecting, which shouldn't happen in normal flow.
  throw redirect("/app");
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  // Handle POST from Shopify's OAuth callback or internal redirects
  const result = await shopify.login(request);

  // If login didn't throw a redirect, send to /app
  if (result) {
    throw redirect("/app");
  }

  throw redirect("/app");
};

export default function Auth() {
  // No UI rendered - this route only handles redirects.
  // App Store apps use managed installation; merchants don't enter shop domains.
  return null;
}
