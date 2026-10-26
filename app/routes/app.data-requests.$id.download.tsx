import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  getDataRequestExport,
  markDataRequestDownloaded,
} from "~/services/compliance";
import { recordAccess, getActorFromSessionToken } from "~/services/access-log.server";

/**
 * S22 Resource route for downloading data request exports.
 *
 * This is a resource route (no default export) that returns JSON directly
 * with Content-Disposition for file download.
 *
 * The download is marked as complete only after the response is prepared
 * and returned successfully. The client (app.data-requests.tsx) fetches
 * this route using App Bridge authenticated fetch, then creates a Blob URL
 * for the user to download.
 *
 * Authentication: Uses Shopify admin authentication via shopify.authenticate.admin.
 */

export const loader = async ({ request, params, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, sessionToken } = await shopify.authenticate.admin(request);

  const requestId = params.id;
  if (!requestId) {
    return new Response(JSON.stringify({ error: "Missing request ID" }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const sql = getRequestSql();

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${session.shop}
  `;

  if (!shop) {
    return new Response(JSON.stringify({ error: "Shop not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // #292: GDPR data-request export is EXEMPT from currency gating.
  // This is a compliance export of stored rows for customers/data_request webhooks.
  // It must return whatever data exists regardless of shop currency.

  const result = await getDataRequestExport(sql, shop.id, requestId);

  if (!result) {
    return new Response(JSON.stringify({ error: "Data request not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  recordAccess(sql, {
    shopId: shop.id,
    actor: getActorFromSessionToken(sessionToken, session),
    action: "data_requests_download",
    recordType: "DataRequest",
    recordId: requestId,
  });

  await markDataRequestDownloaded(sql, shop.id, requestId);

  return new Response(JSON.stringify(result.exportData, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="customer-data-${result.id}.json"`,
      "Cache-Control": "no-store",
    },
  });
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
