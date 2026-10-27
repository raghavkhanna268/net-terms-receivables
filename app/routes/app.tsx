import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError, data, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "~/components/AppProvider";
import { runAfterAuth } from "~/lib/after-auth.server";
import { useEffect, useState } from "react";
import { ServerTiming, readColdOnce } from "~/lib/server-timing.server";

const RELOAD_GUARD_KEY_PREFIX = "auth_bounce_reload_";
const RELOAD_GUARD_WINDOW_MS = 30_000;

export function isAppBridgeOnlyOrEmptyResponse(errorData: unknown): boolean {
  if (errorData === null || errorData === undefined || errorData === "") {
    return true;
  }
  if (typeof errorData !== "string") {
    return false;
  }
  const stripped = errorData.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (stripped === "") {
    return true;
  }
  const withoutAppBridge = stripped
    .replace(/<script[^>]*src="[^"]*app-bridge[^"]*"[^>]*><\/script>/gi, "")
    .replace(/<script[^>]*src="[^"]*app-bridge[^"]*"[^>]*\/>/gi, "")
    .replace(/<script[^>]*data-api-key="[^"]*"[^>]*src="[^"]*app-bridge[^"]*"[^>]*><\/script>/gi, "")
    .replace(/<script[^>]*data-api-key="[^"]*"[^>]*><\/script>/gi, "")
    .trim();
  if (withoutAppBridge === "") {
    return true;
  }
  const withoutWhitespace = withoutAppBridge.replace(/\s+/g, "");
  return withoutWhitespace === "";
}

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
  // Gap 1: runAfterAuth is now awaited so critical reinstall work (clearing
  // uninstalledAt and registration) completes BEFORE the page renders.
  // This ensures onboarding shows true state on the first load after reinstall.
  await runAfterAuth(session.shop, admin, (p) => cloudflare.ctx.waitUntil(p));

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

function AuthBounceReloadFallback({ onReload }: { onReload: () => void }) {
  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <p>Something went wrong. Please try again.</p>
      <s-button onClick={onReload}>Reload</s-button>
    </div>
  );
}

function ReloadingSpinner() {
  return (
    <div style={{ padding: "2rem", textAlign: "center" }}>
      <s-spinner />
      <p>Reloading…</p>
    </div>
  );
}

export function ErrorBoundary() {
  const routeError = useRouteError();
  const [showFallback, setShowFallback] = useState(false);
  const [isReloading, setIsReloading] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (!isRouteErrorResponse(routeError)) {
      return;
    }
    if (!isAppBridgeOnlyOrEmptyResponse(routeError.data)) {
      return;
    }

    const pathname = window.location.pathname;
    const guardKey = `${RELOAD_GUARD_KEY_PREFIX}${pathname}`;
    let lastReload: number | null = null;

    try {
      const stored = sessionStorage.getItem(guardKey);
      if (stored) {
        lastReload = parseInt(stored, 10);
      }
    } catch {
      setShowFallback(true);
      return;
    }

    const now = Date.now();
    if (lastReload !== null && now - lastReload < RELOAD_GUARD_WINDOW_MS) {
      setShowFallback(true);
      return;
    }

    try {
      sessionStorage.setItem(guardKey, String(now));
    } catch {
      setShowFallback(true);
      return;
    }

    setIsReloading(true);
    window.location.reload();
  }, [routeError]);

  if (typeof window !== "undefined" && isRouteErrorResponse(routeError)) {
    if (isAppBridgeOnlyOrEmptyResponse(routeError.data)) {
      if (isReloading) {
        return <ReloadingSpinner />;
      }
      if (showFallback) {
        const handleReload = () => {
          const pathname = window.location.pathname;
          const guardKey = `${RELOAD_GUARD_KEY_PREFIX}${pathname}`;
          try {
            sessionStorage.removeItem(guardKey);
          } catch {
            // Ignore
          }
          window.location.reload();
        };
        return <AuthBounceReloadFallback onReload={handleReload} />;
      }
      return <ReloadingSpinner />;
    }
  }

  return boundary.error(routeError);
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
