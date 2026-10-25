import type { LoaderFunctionArgs } from "react-router";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

export const loader = async (_args: LoaderFunctionArgs) => {
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    isDevMode: import.meta.env.DEV,
  };
};

interface AppBridgeHeadProps {
  apiKey: string;
  isDevMode: boolean;
}

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

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <AppBridgeHead apiKey={apiKey} isDevMode={isDevMode} />
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

export function ErrorBoundary() {
  const error = useRouteError();
  const loaderData = useRouteLoaderData<typeof loader>("root");
  const apiKey = loaderData?.apiKey || "";
  const isDevMode = loaderData?.isDevMode ?? import.meta.env.DEV;

  let title = "Unexpected Error";
  let message = "An unexpected error occurred. Please try again.";

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    message =
      error.status === 404
        ? "The page you're looking for doesn't exist."
        : error.data?.message || message;
  } else if (error instanceof Error) {
    if (import.meta.env.DEV) {
      message = error.message;
      console.error(error);
    }
  }

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {apiKey && <AppBridgeHead apiKey={apiKey} isDevMode={isDevMode} />}
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
