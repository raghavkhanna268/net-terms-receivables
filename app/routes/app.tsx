import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { runAfterAuth } from "~/lib/after-auth.server";
import { useEffect } from "react";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify, cloudflare } = context;

  const { admin, session } = await shopify.authenticate.admin(request);

  // Bind waitUntil to ctx to avoid "Illegal invocation" on workerd
  runAfterAuth(session.shop, admin, (p) => cloudflare.ctx.waitUntil(p));

  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  useEffect(() => {
    let cleanup: (() => void) | undefined;

    import("~/lib/web-vitals.client").then(({ registerWebVitalsReporter }) => {
      cleanup = registerWebVitalsReporter();
    }).catch(() => {
      // Silently ignore - Web Vitals reporting is optional
    });

    return () => {
      cleanup?.();
    };
  }, []);

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/reconcile">Reconcile</s-link>
        <s-link href="/app/plan">Plan</s-link>
        <s-link href="/app/onboarding">Setup Guide</s-link>
        {/* Future navigation items for B2B features */}
        {/* <s-link href="/app/buyers">Buyers</s-link> */}
        {/* <s-link href="/app/invoices">Invoices</s-link> */}
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
