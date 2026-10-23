import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendBulkMessage } from "~/lib/pgmq.server";

/**
 * Webhook handler for bulk operation completion.
 *
 * Topic: bulk_operations/finish
 *
 * Triggered when a bulkOperationRunQuery completes. The payload contains
 * the bulk operation ID which can be used to fetch the JSONL result URL.
 *
 * Processing:
 * 1. HMAC verification via authenticate.webhook (returns 401 on failure)
 * 2. Extract bulk operation ID and infer type from admin_graphql_api_id pattern
 * 3. Enqueue to s6_bulk for async JSONL download/processing
 * 4. Return 200 immediately (within 10ms CPU budget)
 *
 * The JSONL download and parsing happens in the drain (S10), not here.
 * This keeps the webhook handler lightweight and within CPU budget.
 *
 * Bulk operation types (inferred from context):
 * - companies: Company/CompanyLocation backfill
 * - orders: Orders with payment terms backfill
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  const { shop, topic, payload, webhookId } =
    await shopify.authenticate.webhook(request);

  const typedPayload = payload as {
    admin_graphql_api_id?: string;
    status?: string;
    type?: string;
  };

  const bulkOperationId = typedPayload.admin_graphql_api_id;

  if (!bulkOperationId) {
    console.warn(
      `[webhooks.bulk_operations.finish] Missing admin_graphql_api_id for ${shop}`
    );
    return new Response(null, { status: 200 });
  }

  if (typedPayload.status !== "COMPLETED") {
    console.log(
      `[webhooks.bulk_operations.finish] Ignoring non-completed operation: ${typedPayload.status} for ${shop}`
    );
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  // Infer bulk type from the operation type field or default to 'companies'
  // The actual type is determined when processing the JSONL in the drain
  const bulkType =
    typedPayload.type === "query" ? inferBulkType(bulkOperationId) : "companies";

  await sendBulkMessage(sql, {
    topic,
    shop,
    webhookId,
    bulkOperationId,
    bulkType,
    enqueuedAt: new Date().toISOString(),
  });

  console.log(
    `[webhooks.bulk_operations.finish] Enqueued ${bulkType} bulk operation for ${shop}: ${bulkOperationId}`
  );

  return new Response(null, { status: 200 });
};

/**
 * Infer bulk operation type from the operation ID or other context.
 * In practice, the drain will determine the actual type from the JSONL content.
 */
function inferBulkType(
  _bulkOperationId: string
): "companies" | "orders" {
  // Default to companies; the drain will verify from JSONL content
  return "companies";
}
