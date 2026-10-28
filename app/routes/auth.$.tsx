import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  // Session storage is injected per-request via loadContext in workers/app.ts
  const { shopify } = context;

  await shopify.authenticate.admin(request);

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export function ErrorBoundary() {
  const error = useRouteError();

  if (
    isRouteErrorResponse(error) &&
    error.status === 200 &&
    typeof error.data === "string"
  ) {
    return (
      <div
        dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }}
      />
    );
  }

  throw error;
}
