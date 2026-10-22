import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate, sessionStorage } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Inject KV namespace for session storage on each request
  const env = context.cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  await authenticate.admin(request);

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        {/* Future navigation items for B2B features */}
        {/* <s-link href="/app/buyers">Buyers</s-link> */}
        {/* <s-link href="/app/invoices">Invoices</s-link> */}
        {/* <s-link href="/app/payments">Payments</s-link> */}
        {/* <s-link href="/app/settings">Settings</s-link> */}
      </s-app-nav>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
