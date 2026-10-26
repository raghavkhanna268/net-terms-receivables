import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { sendBulkMessage } from "~/lib/pgmq.server";
import { recordWebhookReceipt, parseTriggeredAt } from "~/lib/webhook-receipts.server";
import { safeLog, shopHash } from "~/lib/log.server";

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
 * 2. Edge idempotency: record receipt, skip if duplicate (S20)
 * 3. Look up bulk operation type from s6_bulk_operations tracking table
 * 4. Enqueue to s6_bulk for async JSONL download/processing
 * 5. Return 200 immediately (within 10ms CPU budget)
 *
 * The JSONL download and parsing happens in the drain (S10), not here.
 * This keeps the webhook handler lightweight and within CPU budget.
 *
 * Bulk operation types (stored at launch time in s6_bulk_operations):
 * - companies: Company/CompanyLocation backfill
 * - orders: Orders with payment terms backfill
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shopify } = context;

  const triggeredAt = parseTriggeredAt(request);
  const { shop, topic, payload, webhookId } =
    await shopify.authenticate.webhook(request);

  const typedPayload = payload as {
    admin_graphql_api_id?: string;
    status?: string;
    type?: string;
  };

  const bulkOperationId = typedPayload.admin_graphql_api_id;
  const status = String(typedPayload.status ?? "").toUpperCase();

  if (!bulkOperationId) {
    console.warn(
      "[webhooks.bulk_operations.finish] Missing admin_graphql_api_id"
    );
    return new Response(null, { status: 200 });
  }

  if (status !== "COMPLETED") {
    const hash = await shopHash(shop);
    safeLog("info", "bulk_finish_ignored_status", {
      shopHash: hash,
      status,
    });
    return new Response(null, { status: 200 });
  }

  const sql = getRequestSql();

  // Look up bulk type from tracking table (set when operation was started)
  const bulkType = await lookupBulkOperationType(sql, bulkOperationId);

  if (!bulkType) {
    const hash = await shopHash(shop);
    safeLog("warn", "bulk_finish_unknown_op", {
      shopHash: hash,
    });
    return new Response(null, { status: 200 });
  }

  // S20: Edge idempotency + enqueue in ONE transaction
  const result = await sql.begin(async (tx) => {
    const isNew = await recordWebhookReceipt(tx, shop, webhookId, "BULK_OPERATIONS_FINISH", triggeredAt);
    if (!isNew) {
      return { duplicate: true };
    }

    await sendBulkMessage(tx, {
      topic,
      shop,
      webhookId,
      bulkOperationId,
      bulkType,
      enqueuedAt: new Date().toISOString(),
    });

    return { duplicate: false };
  });

  if (result.duplicate) {
    console.log("[webhooks.bulk_operations.finish] Duplicate, skipping");
    return new Response(null, { status: 200 });
  }

  console.log(
    `[webhooks.bulk_operations.finish] Enqueued ${bulkType} bulk operation: ${bulkOperationId}`
  );

  return new Response(null, { status: 200 });
};

/**
 * Look up the bulk operation type from the tracking table.
 * Returns null if the operation is not found (not started by our app).
 */
async function lookupBulkOperationType(
  sql: ReturnType<typeof getRequestSql>,
  bulkOperationId: string
): Promise<"companies" | "orders" | "customers" | null> {
  const [row] = await sql<{ bulk_type: string }[]>`
    SELECT bulk_type FROM s6_bulk_operations
    WHERE bulk_operation_id = ${bulkOperationId}
  `;

  if (!row) {
    return null;
  }

  return row.bulk_type as "companies" | "orders" | "customers";
}
