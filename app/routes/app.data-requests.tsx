import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  HeadersFunction,
} from "react-router";
import { useLoaderData, useSubmit } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  getPendingDataRequests,
  getDataRequestExport,
} from "~/services/compliance";

/**
 * S22 Admin route for GDPR/CCPA data request downloads.
 *
 * Delivery path: In-admin download.
 * Email delivery requires a product decision and is not implemented.
 *
 * This route allows merchants to:
 * 1. View pending customer data requests
 * 2. Download JSON exports for each request
 *
 * Authentication: Uses Shopify admin authentication via shopify.authenticate.admin.
 * This ensures only authenticated merchants can access their shop's data requests.
 */

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);

  const sql = getRequestSql();

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${session.shop}
  `;

  if (!shop) {
    return {
      dataRequests: [],
      error: "Shop not found. Please ensure the app is properly installed.",
    };
  }

  const dataRequests = await getPendingDataRequests(sql, shop.id);

  return {
    dataRequests: dataRequests.map((dr) => ({
      id: dr.id,
      customerGid: dr.customerGid,
      requestId: dr.requestId,
      receivedAt: dr.receivedAt.toISOString(),
      status: dr.status,
    })),
    error: null,
  };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;
  const { session } = await shopify.authenticate.admin(request);

  const formData = await request.formData();
  const requestId = formData.get("requestId") as string;
  const actionType = formData.get("action") as string;

  if (actionType !== "download" || !requestId) {
    return { error: "Invalid action" };
  }

  const sql = getRequestSql();

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${session.shop}
  `;

  if (!shop) {
    return { error: "Shop not found" };
  }

  const exportData = await getDataRequestExport(sql, shop.id, requestId);

  if (!exportData) {
    return { error: "Data request not found" };
  }

  return new Response(JSON.stringify(exportData, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="customer-data-${requestId}.json"`,
    },
  });
};

export default function DataRequestsPage() {
  const { dataRequests, error } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const handleDownload = (requestId: string) => {
    submit({ action: "download", requestId }, { method: "POST" });
  };

  return (
    <s-page heading="Customer Data Requests">
      <s-section heading="GDPR/CCPA Data Requests">
        <s-paragraph>
          When customers request their data under GDPR or CCPA, Shopify sends a
          webhook to the app. This page shows pending requests and allows you to
          download the data exports.
        </s-paragraph>

        {error && (
          <s-paragraph>
            <s-text>{error}</s-text>
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
                    <s-text type="strong">Customer:</s-text>{" "}
                    <s-text>{dr.customerGid}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text type="strong">Received:</s-text>{" "}
                    <s-text>{new Date(dr.receivedAt).toLocaleString()}</s-text>
                  </s-paragraph>
                  <s-paragraph>
                    <s-text type="strong">Status:</s-text>{" "}
                    <s-text>{dr.status}</s-text>
                  </s-paragraph>
                  <s-button onClick={() => handleDownload(dr.requestId)}>
                    Download Export
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
          <s-list-item>Tagged customer records (tags, status)</s-list-item>
          <s-list-item>Draft orders</s-list-item>
          <s-list-item>Buyer account details</s-list-item>
          <s-list-item>Invoice history</s-list-item>
        </s-unordered-list>
        <s-paragraph>
          <s-text>
            Delivery: In-admin download only. Email delivery is not currently
            supported.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
