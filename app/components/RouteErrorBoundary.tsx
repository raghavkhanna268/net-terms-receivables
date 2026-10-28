/**
 * Shared route-level error boundary for app child routes.
 *
 * Renders errors INSIDE the app layout so the navigation (s-app-nav) remains visible.
 * Shows user-friendly messages; never exposes raw error messages, stacks, or sensitive data.
 *
 * Auth redirects (200 status with HTML data) are re-thrown so app.tsx's boundary
 * can handle them with dangerouslySetInnerHTML.
 */

import { useRouteError, isRouteErrorResponse } from "react-router";

export function RouteErrorBoundary() {
  const error = useRouteError();

  if (
    isRouteErrorResponse(error) &&
    error.status === 200 &&
    typeof error.data === "string"
  ) {
    throw error;
  }

  let heading = "Something went wrong";
  let message = "Something went wrong loading this page.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 404) {
      heading = "Page not found";
      message = "The page you are looking for could not be found.";
    } else {
      heading = `Error ${error.status}`;
    }
  }

  return (
    <s-page heading={heading}>
      <s-section>
        <s-banner tone="critical" heading={heading}>
          <s-text>{message}</s-text>
        </s-banner>
        <s-link href="/app">Back to Dashboard</s-link>
      </s-section>
    </s-page>
  );
}
