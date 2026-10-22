import type { EntryContext, AppLoadContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";
import { captureException } from "./lib/sentry";

export const streamTimeout = 5000;

/**
 * React Router error handler - reports uncaught errors to Sentry.
 * Skips aborted requests (user navigated away).
 */
export function handleError(
  error: unknown,
  { request }: { request: Request }
): void {
  if (request.signal.aborted) {
    return;
  }
  captureException(error);
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  loadContext: AppLoadContext
) {
  // Session storage and Shopify app are now injected per-request
  // via loadContext in workers/app.ts - no module-level mutation needed here.
  // This ensures proper isolation for concurrent requests in Workers.

  const { shopify } = loadContext;
  shopify.addDocumentResponseHeaders(request, responseHeaders);

  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={reactRouterContext} url={request.url} />,
    {
      signal: AbortSignal.timeout(streamTimeout),
      onError(error: unknown) {
        console.error(error);
        responseStatusCode = 500;
      },
    }
  );

  if (isbot(userAgent ?? "")) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
