import type { ActionFunctionArgs } from "react-router";
import { getRequestSql } from "~/lib/request-context.server";
import { verifyWebhook, normalizeWebhookTopic } from "~/lib/webhook-verify.server";
import { parseTriggeredAt, recordAndEnqueueSync } from "~/lib/webhook-receipts.server";
import { safeLog } from "~/lib/log.server";

/**
 * Build a Shopify DraftOrder GID from a numeric id.
 * Returns null if the id is not a positive integer.
 */
export function buildDraftOrderGid(id: unknown): string | null {
  if (typeof id === "number") {
    if (!Number.isInteger(id) || id <= 0) {
      return null;
    }
    return `gid://shopify/DraftOrder/${id}`;
  }
  if (typeof id === "string") {
    const parsed = parseInt(id, 10);
    if (isNaN(parsed) || parsed <= 0 || String(parsed) !== id) {
      return null;
    }
    return `gid://shopify/DraftOrder/${parsed}`;
  }
  return null;
}

/**
 * Webhook handler for draft order lifecycle events (S8).
 *
 * Topics handled:
 * - draft_orders/create: New draft order created
 * - draft_orders/update: Draft order modified (payment terms, amounts, completion)
 * - draft_orders/delete: Draft order removed
 *
 * Processing:
 * 1. HMAC verification via verifyWebhook (returns 401 on failure)
 * 2. Edge idempotency: record receipt, skip if duplicate (S20)
 * 3. Topic guard: only process expected topics
 * 4. Extract minimal payload (draft order GID only)
 * 5. Enqueue to s6_sync for async processing
 * 6. Return 200 immediately (within 10ms CPU budget)
 *
 * OPTIMIZATION: Uses lightweight verifyWebhook() instead of authenticate.webhook()
 * to avoid unnecessary session lookups. Saves ~5-10ms DB round-trip per webhook.
 *
 * DPDP compliance:
 * - Only the draft order GID is extracted from the webhook payload
 * - The sync processor fetches only id, name, total, paymentTerms, purchasingEntity
 * - No customer PII is stored
 *
 * Draft orders are tracked when they have payment terms assigned to a buyer
 * account. This enables pending credit exposure calculation before the draft
 * order is completed.
 *
 * Note: When a draft order is completed (becomes an Order), Shopify sends
 * a draft_orders/update webhook with status=completed. The draft order record
 * is then removed from tracking (pending exposure becomes actual exposure).
 */

const ALLOWED_TOPICS = new Set([
  "DRAFT_ORDERS_CREATE",
  "DRAFT_ORDERS_UPDATE",
  "DRAFT_ORDERS_DELETE",
]);

export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    console.error("[webhooks.draft_orders] SHOPIFY_API_SECRET not configured");
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret);
  const triggeredAt = parseTriggeredAt(request);
  const normalizedTopic = normalizeWebhookTopic(topic);

  if (!ALLOWED_TOPICS.has(normalizedTopic)) {
    console.warn(
      `[webhooks.draft_orders] Unexpected topic ${normalizedTopic}, ignoring`
    );
    return new Response(null, { status: 200 });
  }

  const typedPayload = payload as { admin_graphql_api_id?: string; id?: unknown };
  let resourceGid = typedPayload.admin_graphql_api_id;

  if (!resourceGid) {
    const builtGid = buildDraftOrderGid(typedPayload.id);
    if (builtGid) {
      resourceGid = builtGid;
    } else {
      safeLog("warn", "draft_orders_webhook_no_gid", {
        topic: normalizedTopic,
        hasId: typedPayload.id !== undefined,
      });
      return new Response(null, { status: 200 });
    }
  }

  const sql = getRequestSql();

  // S20: Edge idempotency + enqueue in ONE transaction (via shared helper)
  const result = await recordAndEnqueueSync(sql, {
    shop,
    webhookId,
    topic: normalizedTopic,
    triggeredAt,
    resourceGid,
  });

  if (result.status === "duplicate") {
    console.log(`[webhooks.draft_orders] Duplicate ${normalizedTopic}, skipping`);
    return new Response(null, { status: 200 });
  }

  if (result.status === "error") {
    console.error("[webhooks.draft_orders] Enqueue failed");
    throw new Error(result.code);
  }

  console.log(`[webhooks.draft_orders] Enqueued ${normalizedTopic}`);

  return new Response(null, { status: 200 });
};
