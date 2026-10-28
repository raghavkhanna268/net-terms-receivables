import type { LoaderFunctionArgs } from "react-router";

import termsMarkdown from "../../docs/legal/merchant-terms.md?raw";
import {
  markdownToHtml,
  LEGAL_PAGE_CSS,
  LEGAL_PAGE_HEADERS,
} from "../lib/legal-page.server";

/**
 * Public /terms RESOURCE route - renders docs/legal/merchant-terms.md as HTML.
 *
 * This is a RESOURCE ROUTE (no default export), so the loader's Response
 * is returned directly to the client, not decoded as loader data.
 *
 * NO AUTHENTICATION REQUIRED. This route:
 * - Does not call authenticate.admin
 * - Does not read any session
 * - Does not use any shop data
 *
 * The markdown is imported at build time via Vite's `?raw` suffix and
 * converted to HTML server-side with a simple, Worker-safe converter.
 */

export const loader = async (_args: LoaderFunctionArgs) => {
  const htmlContent = markdownToHtml(termsMarkdown);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Merchant Terms of Service &amp; Data Processing Addendum — Termwise: Net Terms &amp; Credit</title>
  <style>${LEGAL_PAGE_CSS}</style>
</head>
<body>
${htmlContent}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: LEGAL_PAGE_HEADERS,
  });
};
