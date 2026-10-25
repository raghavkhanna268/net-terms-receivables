import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "~/components/AppProvider";
import { runAfterAuth } from "~/lib/after-auth.server";
import { useEffect } from "react";
import { ServerTiming, readColdOnce } from "~/lib/server-timing.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Read cold once for this request - index will get same value with same context object
  const cold = readColdOnce(context);
  const timing = new ServerTiming(cold);

  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify, cloudflare } = context;

  timing.startPhase("auth_layout");
  const { admin, session } = await shopify.authenticate.admin(request);
  timing.endPhase("auth_layout");

  // Bind waitUntil to ctx to avoid "Illegal invocation" on workerd
  runAfterAuth(session.shop, admin, (p) => cloudflare.ctx.waitUntil(p));

  // Log auth_layout timing
  timing.logAllPhases();

  const serverTiming = timing.toHeaderValue();
  const responseData = {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };

  const headers: HeadersInit = {};
  if (serverTiming) {
    headers["Server-Timing"] = serverTiming;
  }

  return data(responseData, { headers });
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
        <s-link href="/app/tag-rules">Tag Rules</s-link>
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
  const boundaryHeaders = boundary.headers(headersArgs);
  const resultHeaders = new Headers(boundaryHeaders);

  // Merge Server-Timing from layout loader
  const layoutTiming = headersArgs.loaderHeaders?.get("Server-Timing");
  if (layoutTiming) {
    resultHeaders.set("Server-Timing", layoutTiming);
  }

  return resultHeaders;
};
