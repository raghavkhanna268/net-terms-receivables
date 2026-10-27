import type { LoaderFunctionArgs } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useMatches,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

/**
 * Determines if the current route chain requires App Bridge.
 *
 * App Bridge is only loaded for embedded admin routes:
 * - /app or /app/...
 * - /auth or /auth/...
 *
 * Public routes (privacy, unsubscribe, landing) and near-misses
 * (/apple, /authors, etc.) do not load App Bridge.
 *
 * Routes can override this by setting `handle: { embedded: false }`.
 */
function useIsEmbeddedRoute(): boolean {
  const matches = useMatches();

  for (const match of matches) {
    const handle = match.handle as { embedded?: boolean } | undefined;
    if (handle?.embedded === false) {
      return false;
    }
  }

  const pathname = matches[matches.length - 1]?.pathname ?? "";
  const isAppRoute = pathname === "/app" || pathname.startsWith("/app/");
  const isAuthRoute = pathname === "/auth" || pathname.startsWith("/auth/");
  return isAppRoute || isAuthRoute;
}

export const loader = async (_args: LoaderFunctionArgs) => {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    isDevMode: import.meta.env.DEV,
  };
};

/**
 * Root loader data is static (env vars only), so skip revalidation on navigation.
 */
export const shouldRevalidate = () => false;

interface AppBridgeHeadProps {
  apiKey: string;
  isDevMode: boolean;
}

/**
 * Renders App Bridge script and debug meta tag in <head>.
 *
 * Per Shopify docs (https://shopify.dev/docs/apps/build/performance/admin-installation-oauth):
 * - The shopify-debug meta tag enables Web Vitals console logging
 * - It must appear BEFORE the app-bridge.js script
 * - Only recommended for development/staging, not production
 */
function AppBridgeHead({ apiKey, isDevMode }: AppBridgeHeadProps) {
  return (
    <>
      {isDevMode && <meta name="shopify-debug" content="web-vitals" />}
      <script
        src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
        data-api-key={apiKey}
      />
    </>
  );
}

export default function App() {
  const { apiKey, isDevMode } = useLoaderData<typeof loader>();
  const isEmbedded = useIsEmbeddedRoute();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {isEmbedded && <AppBridgeHead apiKey={apiKey} isDevMode={isDevMode} />}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

/**
 * Returns generic user-facing copy based on HTTP status code.
 * Never exposes error data, messages, or stacks.
 */
function getGenericErrorCopy(status: number): { title: string; message: string } {
  if (status === 404) {
    return { title: "404 Not Found", message: "Page not found" };
  }
  if (status === 401 || status === 403) {
    return { title: "Access denied", message: "You don't have access to this page" };
  }
  if (status >= 400 && status < 500) {
    return { title: `${status} Error`, message: "Something went wrong with this request" };
  }
  return { title: "Error", message: "Something went wrong. Please try again." };
}

export function ErrorBoundary() {
  const error = useRouteError();
  const loaderData = useRouteLoaderData<typeof loader>("root");
  const apiKey = loaderData?.apiKey || "";
  const isDevMode = loaderData?.isDevMode ?? import.meta.env.DEV;
  const isEmbedded = useIsEmbeddedRoute();

  let title = "Error";
  let message = "Something went wrong. Please try again.";

  if (isRouteErrorResponse(error)) {
    const copy = getGenericErrorCopy(error.status);
    title = copy.title;
    message = copy.message;
  } else if (error instanceof Error) {
    if (import.meta.env.DEV) {
      console.error(error);
    }
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {isEmbedded && apiKey && (
          <AppBridgeHead apiKey={apiKey} isDevMode={isDevMode} />
        )}
        <title>{title}</title>
        <Meta />
        <Links />
      </head>
      <body>
        <div
          style={{
            fontFamily: "system-ui, sans-serif",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <h1>{title}</h1>
          <p>{message}</p>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
