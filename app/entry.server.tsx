import type { EntryContext, AppLoadContext } from "react-router";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";
import { captureExceptionWithTags } from "./lib/sentry";
import { safeLog, toErrorCode } from "./lib/log.server";

function isExpectedResponse(e: unknown): boolean {
  if (isRouteErrorResponse(e)) {
    return e.status < 500;
  }
  if (e instanceof Response) {
    return e.status < 500;
  }
  return false;
}

export const streamTimeout = 5000;

/**
 * React Router error handler - reports uncaught errors to Sentry.
 * Skips aborted requests (user navigated away) and expected 4xx route responses.
 */
export function handleError(
  error: unknown,
  { request }: { request: Request }
): void {
  if (request.signal.aborted) {
    return;
  }
  if (isExpectedResponse(error)) {
    return;
  }
  const code = toErrorCode(error);
  captureExceptionWithTags(error, { code });
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
        if (isExpectedResponse(error)) {
          return;
        }
        safeLog("error", "ssr_render_error", { err: toErrorCode(error) });
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
