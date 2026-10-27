import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, isRouteErrorResponse, data } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "~/components/AppProvider";
import { runAfterAuth } from "~/lib/after-auth.server";
import { useEffect } from "react";
import { ServerTiming, readColdOnce } from "~/lib/server-timing.server";
import { getRequestSql } from "~/lib/request-context.server";
import { isPlanSelectionRedirectEnabled } from "~/services/gating.server";
import { resolvePlanWithStatus } from "~/services/plan.server";
import { getAppHandle, buildPlanSelectionUrl } from "~/lib/plan-url";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Read cold once for this request - index will get same value with same context object
  const cold = readColdOnce(context);
  const timing = new ServerTiming(cold);

  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify, cloudflare } = context;

  timing.startPhase("auth_layout");
  const { admin, session, redirect: shopifyRedirect } = await shopify.authenticate.admin(request);
  timing.endPhase("auth_layout");

  // Bind waitUntil to ctx to avoid "Illegal invocation" on workerd
  // Gap 1: runAfterAuth is now awaited so critical reinstall work (clearing
  // uninstalledAt and registration) completes BEFORE the page renders.
  // This ensures onboarding shows true state on the first load after reinstall.
  await runAfterAuth(session.shop, admin, (p) => cloudflare.ctx.waitUntil(p));

  // Plan selection redirect: when enabled, redirect merchants without an active
  // subscription to the Shopify-hosted plan selection page.
  if (isPlanSelectionRedirectEnabled()) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Skip redirect for /app/welcome - the welcome loader runs in parallel
    // and its forced refresh may not have completed yet.
    const isWelcomePath = pathname === "/app/welcome" || pathname.startsWith("/app/welcome/");

    // Check if plan_handle or charge_id key is PRESENT in URL (even if empty).
    // After picking a plan, merchants land on /app?plan_handle=&charge_id= or
    // /app/onboarding?plan_handle=&charge_id= with empty values. The presence of
    // these keys indicates a return from the plan selection flow.
    const hasPlanParams = url.searchParams.has("plan_handle") || url.searchParams.has("charge_id");

    if (!isWelcomePath) {
      const appHandle = getAppHandle();

      // Only proceed when APP_HANDLE is configured
      if (appHandle) {
        const sql = getRequestSql();

        if (hasPlanParams) {
          // Return from plan selection flow: force refresh to update cache.
          // Never redirect - the merchant just completed plan selection.
          await resolvePlanWithStatus(sql, session.shop, true);
        } else {
          // Normal navigation: check subscription status
          const { plan, status } = await resolvePlanWithStatus(sql, session.shop);

          // Only redirect when status is confirmed "none" (no active subscription).
          // Do NOT redirect on "error" (lookup failed) or "active" (has subscription).
          if (status === "none") {
            // If result came from cache, revalidate to avoid redirecting a subscribed
            // merchant whose webhook hasn't arrived yet.
            if (plan.fromCache) {
              const fresh = await resolvePlanWithStatus(sql, session.shop, true);
              // Only redirect if fresh lookup still confirms no subscription
              if (fresh.status === "none") {
                const pricingUrl = buildPlanSelectionUrl(session.shop, appHandle);
                if (pricingUrl) {
                  throw shopifyRedirect(pricingUrl, { target: "_top" });
                }
              }
            } else {
              // Fresh result already - redirect without second lookup
              const pricingUrl = buildPlanSelectionUrl(session.shop, appHandle);
              if (pricingUrl) {
                throw shopifyRedirect(pricingUrl, { target: "_top" });
              }
            }
          }
        }
      }
    }
  }

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
        {/* @ts-expect-error rel="home" is valid per Shopify App Bridge docs but not in @shopify/polaris-types */}
        <s-link href="/app" rel="home">Home</s-link>
        <s-link href="/app/reconcile">Reconcile</s-link>
        <s-link href="/app/imports">Imports</s-link>
        <s-link href="/app/settings/reminders">Reminders</s-link>
        <s-link href="/app/tag-rules">Tag Rules</s-link>
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
  const error = useRouteError();

  if (isRouteErrorResponse(error) && error.status === 401) {
    return boundary.error(error);
  }

  return (
    <s-page heading="Something went wrong">
      <s-section>
        <s-banner tone="critical" heading="Unexpected Error">
          <s-paragraph>
            We encountered an issue loading this page.
          </s-paragraph>
          <s-stack direction="inline" gap="base">
            <s-button href="/app">Go to Dashboard</s-button>
          </s-stack>
        </s-banner>
      </s-section>
    </s-page>
  );
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
