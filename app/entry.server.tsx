import type { EntryContext, AppLoadContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";
import { addDocumentResponseHeaders, sessionStorage } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
  loadContext: AppLoadContext
) {
  // Inject the KV namespace into session storage for this request
  const cloudflare = (loadContext as { cloudflare?: { env?: Env } }).cloudflare;
  const env = cloudflare?.env;
  if (env?.SESSIONS) {
    sessionStorage.setNamespace(env.SESSIONS);
  }

  addDocumentResponseHeaders(request, responseHeaders);
  
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
