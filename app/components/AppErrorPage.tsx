/**
 * Error page component for rendering route errors inside the /app layout.
 *
 * Renders a user-friendly error message using Polaris web components with:
 * - A friendly title per status (404 not found, 410 gone, 5xx something went wrong)
 * - A link back to the app home
 *
 * Never shows stack traces, error messages, IDs, request IDs, or shop data.
 */

interface AppErrorPageProps {
  status: number;
}

interface ErrorCopy {
  heading: string;
  subheading: string;
}

function getErrorCopy(status: number): ErrorCopy {
  if (status === 404) {
    return {
      heading: "Page not found",
      subheading: "The page you are looking for could not be found.",
    };
  }
  if (status === 410) {
    return {
      heading: "Page no longer available",
      subheading: "This page is no longer available.",
    };
  }
  return {
    heading: "Something went wrong",
    subheading: "An error occurred while loading this page. Please try again.",
  };
}

export function AppErrorPage({ status }: AppErrorPageProps) {
  const { heading, subheading } = getErrorCopy(status);

  return (
    <s-page heading={heading}>
      <s-section>
        <s-empty-state heading={heading}>
          <s-text slot="subheading">{subheading}</s-text>
          <s-button variant="primary" href="/app">
            Go to app home
          </s-button>
        </s-empty-state>
      </s-section>
    </s-page>
  );
}
