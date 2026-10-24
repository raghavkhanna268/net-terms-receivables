import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

/**
 * App Store compliance: Per Shopify requirement 2.3.1, App Store apps must not
 * request manual entry of a myshopify.com URL or shop domain during installation
 * or configuration. Install/login must start from the Shopify App Store or admin.
 *
 * This route handles OAuth redirects when shopify.login() receives a shop
 * parameter (from Shopify's managed installation flow). If a merchant lands
 * here without a shop parameter (e.g., direct URL access), we redirect to /
 * (landing page) to avoid a redirect loop with /app.
 *
 * Why redirect to / instead of /app:
 * When /app receives a request without shop/host params, authenticate.admin()
 * calls validateShopAndHostParams() which throws renderAppBridge(). Outside of
 * Shopify admin context, App Bridge cannot retrieve the shop and may bounce
 * back to /auth/login, creating a loop. The landing page (/) is safe because
 * it only redirects to /app when a shop param IS present.
 *
 * @see https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements
 * @see node_modules/@shopify/shopify-app-react-router/src/server/authenticate/login/login.ts
 * @see node_modules/@shopify/shopify-app-react-router/src/server/authenticate/admin/helpers/validate-shop-and-host-params.ts
 */

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;

  // shopify.login() behavior (from login.ts in @shopify/shopify-app-react-router):
  // - GET without shop param: returns {} (empty object)
  // - POST/GET with missing shop in form/params: returns {shop: LoginErrorType.MissingShop}
  // - Invalid shop: returns {shop: LoginErrorType.InvalidShop}
  // - Valid shop: throws redirect to OAuth install URL
  const result = await shopify.login(request);

  // If login didn't throw a redirect (i.e., no valid shop), redirect to /
  // (landing page). Redirecting to /app would cause a loop because /app's
  // authenticate.admin() -> validateShopAndHostParams() -> renderAppBridge()
  // can bounce back here when not in Shopify admin context.
  if (result) {
    throw redirect("/");
  }

  // This line is reached only if shopify.login() returned null/undefined
  // without redirecting, which shouldn't happen in normal flow.
  throw redirect("/");
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  // Handle POST - shopify.login() will redirect if valid shop in form data
  const result = await shopify.login(request);

  // If login didn't throw a redirect, send to / (landing page)
  if (result) {
    throw redirect("/");
  }

  throw redirect("/");
};

export default function Auth() {
  // No UI rendered - this route only handles redirects.
  // App Store apps use managed installation; merchants don't enter shop domains.
  return null;
}
