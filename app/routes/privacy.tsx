import type { LoaderFunctionArgs } from "react-router";

import privacyMarkdown from "../../docs/privacy.md?raw";
import {
  markdownToHtml,
  LEGAL_PAGE_CSS,
  LEGAL_PAGE_HEADERS,
} from "../lib/legal-page.server";

/**
 * Public /privacy RESOURCE route - renders docs/privacy.md as HTML.
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
  const htmlContent = markdownToHtml(privacyMarkdown);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — Termwise: Net Terms & Credit</title>
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
