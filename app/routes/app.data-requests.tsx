import type { LoaderFunctionArgs, HeadersFunction } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import { getPendingDataRequests, purgeExpiredDataRequests } from "~/services/compliance";
import { recordAccess, getActorFromSessionToken } from "~/services/access-log.server";
import { useState } from "react";

/**
 * S22 Admin route for GDPR/CCPA data request downloads.
 *
 * Delivery path: In-admin download + email notification to shop owner.
 *
 * This route allows merchants to:
 * 1. View pending customer data requests
 * 2. Download JSON exports for each request via authenticated fetch
 *
 * Download flow:
 * 1. Client clicks download button
 * 2. Client fetches the resource route (app.data-requests.$id.download.tsx)
 *    using App Bridge authenticated fetch
 * 3. Client creates a Blob from the response and triggers download
 * 4. Resource route marks the request as downloaded after successful delivery
 *
 * Authentication: Uses Shopify admin authentication via shopify.authenticate.admin.
 */

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session, sessionToken } = await shopify.authenticate.admin(request);

  const sql = getRequestSql();

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${session.shop}
  `;

  if (!shop) {
    return {
      dataRequests: [],
      expiresInDays: 30,
      error: "Shop not found. Please ensure the app is properly installed.",
    };
  }

  // #292: GDPR data-request list is EXEMPT from currency gating.
  // This is a compliance view for customers/data_request webhooks.

  // Purge expired data requests on access (in-app purge for databases without pg_cron)
  await purgeExpiredDataRequests(sql, shop.id);

  const dataRequests = await getPendingDataRequests(sql, shop.id);

  recordAccess(sql, {
    shopId: shop.id,
    actor: getActorFromSessionToken(sessionToken, session),
    action: "data_requests_list",
    recordType: "DataRequest",
    count: dataRequests.length,
  });

  return {
    dataRequests: dataRequests.map((dr) => ({
      id: dr.id,
      customerGid: dr.customerGid,
      requestId: dr.requestId,
      receivedAt: dr.receivedAt.toISOString(),
      status: dr.status,
      expiresAt: dr.expiresAt?.toISOString() ?? null,
    })),
    expiresInDays: 30,
    error: null,
  };
};

export default function DataRequestsPage() {
  const { dataRequests, expiresInDays, error } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownload = async (requestId: string) => {
    setDownloadingId(requestId);
    setDownloadError(null);

    try {
      const response = await fetch(`/app/data-requests/${requestId}/download`);

      if (!response.ok) {
        const errorData = (await response.json()) as { error?: string };
        throw new Error(errorData.error || "Download failed");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer-data-${requestId}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("Download failed. Please try again.");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <s-page heading="Customer Data Requests">
      <s-section heading="GDPR/CCPA Data Requests">
        <s-paragraph>
          When a customer requests their data under GDPR or CCPA, Shopify
          notifies Termwise and we prepare an export here. This page shows
          pending requests and allows you to download the data exports.
        </s-paragraph>

        {error && (
          <s-paragraph>
            <s-text>{error}</s-text>
          </s-paragraph>
        )}

        {downloadError && (
          <s-paragraph>
            <s-text>{downloadError}</s-text>
          </s-paragraph>
        )}

        {dataRequests.length === 0 ? (
          <s-paragraph>
            <s-text>No pending data requests.</s-text>
          </s-paragraph>
        ) : (
          <s-stack>
            {dataRequests.map((dr) => (
              <s-box key={dr.id}>
                <s-stack>
                  <s-paragraph>
                    <s-text type="strong">Request ID:</s-text>{" "}
                    <s-text>{dr.requestId}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text type="strong">Received:</s-text>{" "}
                    <s-text>{new Date(dr.receivedAt).toLocaleString()}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text type="strong">Status:</s-text>{" "}
                    <s-text>{dr.status}</s-text>
                  </s-paragraph>
                  {dr.expiresAt && (
                    <s-paragraph>
                      <s-text type="strong">Expires:</s-text>{" "}
                      <s-text>{new Date(dr.expiresAt).toLocaleString()}</s-text>
                    </s-paragraph>
                  )}
                  <s-button
                    onClick={() => handleDownload(dr.requestId)}
                    disabled={downloadingId === dr.requestId || navigation.state !== "idle"}
                  >
                    {downloadingId === dr.requestId ? "Downloading..." : "Download Export"}
                  </s-button>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="About Data Requests">
        <s-paragraph>
          Under GDPR and CCPA, customers have the right to request a copy of
          their personal data. When a customer makes this request through
          Shopify, we generate an export of their data stored in this app.
        </s-paragraph>
        <s-paragraph>
          <s-text type="strong">Data included:</s-text>
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Tagged customer records (tags, status, email, name)</s-list-item>
          <s-list-item>Draft orders</s-list-item>
          <s-list-item>Buyer account details</s-list-item>
          <s-list-item>Invoice history</s-list-item>
          <s-list-item>Payment matches</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          <s-text type="strong">Data NOT included:</s-text>
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Phone numbers (never stored)</s-list-item>
          <s-list-item>Addresses (never stored)</s-list-item>
          <s-list-item>Bank statement details (PII redacted)</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          <s-text type="strong">Delivery:</s-text>
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>In-admin download from this page</s-list-item>
          <s-list-item>Email notification sent to shop owner (if configured)</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          <s-text>
            Exports are retained for {expiresInDays} days, after which they are automatically
            purged per data minimisation requirements.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
