/**
 * F9: Catch-all route for unknown /app/* paths.
 *
 * Renders a 404 page inside the app layout so App Bridge and nav remain visible.
 * The layout in app.tsx authenticates the session, so this route only handles
 * rendering the not-found content.
 */

import type { LoaderFunctionArgs } from "react-router";
import { Link, data } from "react-router";

export const loader = async (_args: LoaderFunctionArgs) => {
  throw data(null, { status: 404 });
};

export function ErrorBoundary() {
  return (
    <s-page heading="Page not found">
      <s-section>
        <s-empty-state heading="Page not found">
          <s-text slot="subheading">
            The page you are looking for could not be found.
          </s-text>
          <Link to="/app">
            <s-button variant="primary">Go to app home</s-button>
          </Link>
        </s-empty-state>
      </s-section>
    </s-page>
  );
}

export default function NotFoundPage() {
  return null;
}
