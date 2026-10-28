import type { ActionFunctionArgs } from "react-router";
import {
  verifyWebhook,
  verifyPayloadShopMatch,
  normalizeWebhookTopic,
} from "~/lib/webhook-verify.server";
import { getRequestSql } from "~/lib/request-context.server";
import {
  recordWebhookReceipt,
  parseTriggeredAt,
} from "~/lib/webhook-receipts.server";
import { sendSyncMessage } from "~/lib/pgmq.server";
import { safeLog, toErrorCode } from "~/lib/log.server";
import type { Sql } from "~/lib/db-light.server";

/**
 * Build a minimal compliance queue message.
 * Contains only topic, identifiers - no PII.
 * All values are strings per SyncMessage interface.
 */
function buildComplianceMessage(
  topic: string,
  shop: string,
  webhookId: string,
  payload: {
    customer?: { id?: number };
    data_request?: { id?: number };
    shop_id?: number;
  }
): {
  topic: string;
  shop: string;
  webhookId: string;
  resourceGid: string;
  enqueuedAt: string;
  requestId?: string;
  customerId?: string;
  shopId?: string;
} {
  const base = {
    topic,
    shop,
    webhookId,
    resourceGid: `compliance:${topic}`,
    enqueuedAt: new Date().toISOString(),
  };

  if (topic === "CUSTOMERS_DATA_REQUEST") {
    return {
      ...base,
      requestId: payload.data_request?.id ? String(payload.data_request.id) : undefined,
      customerId: payload.customer?.id ? String(payload.customer.id) : undefined,
    };
  }

  if (topic === "CUSTOMERS_REDACT") {
    return {
      ...base,
      customerId: payload.customer?.id ? String(payload.customer.id) : undefined,
    };
  }

  if (topic === "SHOP_REDACT") {
    return {
      ...base,
      shopId: payload.shop_id ? String(payload.shop_id) : undefined,
    };
  }

  return base;
}

/**
 * Record receipt and enqueue in one transaction.
 * Returns { enqueued: true } on success, { duplicate: true } if already received,
 * or throws on error.
 */
async function recordAndEnqueueCompliance(
  sql: Sql,
  shop: string,
  webhookId: string,
  topic: string,
  triggeredAt: Date | null,
  message: ReturnType<typeof buildComplianceMessage>
): Promise<{ enqueued: true; msgId: string } | { duplicate: true }> {
  return sql.begin(async (tx) => {
    const isNew = await recordWebhookReceipt(tx, shop, webhookId, topic, triggeredAt);
    if (!isNew) {
      return { duplicate: true };
    }

    const sendResult = await sendSyncMessage(tx, message);
    return { enqueued: true, msgId: sendResult.msgId };
  });
}

/**
 * Compliance webhook handler for GDPR/CCPA mandatory webhooks.
 * Handles: customers/data_request, customers/redact, shop/redact
 *
 * FLOW:
 * 1. Verify HMAC (401 on failure with no SQL and no enqueue)
 * 2. Validate shop match and payload (400 cases enqueue nothing)
 * 3. In one transaction: record receipt + enqueue to s6_sync
 * 4. Return 200 fast
 *
 * The drain processor handles the actual work (data export, redaction, deletion).
 * Queue message carries ONLY topic, request_id, customer_id or shop_id - no PII.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiSecret) {
    safeLog("error", "compliance_secret_missing", {});
    return new Response(null, { status: 500 });
  }

  const { shop, topic, webhookId, payload } = await verifyWebhook(request, apiSecret, {
    requireValidJson: true,
  });
  const normalizedTopic = normalizeWebhookTopic(topic);
  const triggeredAt = parseTriggeredAt(request);

  const sql = getRequestSql();

  switch (normalizedTopic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
        data_request?: { id?: number };
      };

      if (!typedPayload.customer?.id) {
        safeLog("info", "compliance_missing_customer_id", { topic: normalizedTopic });
        return new Response(null, { status: 200 });
      }

      if (!typedPayload.data_request?.id) {
        safeLog("info", "compliance_missing_request_id", { topic: normalizedTopic });
        return new Response(null, { status: 200 });
      }

      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (!shopRecord) {
        safeLog("info", "compliance_shop_not_found", { topic: normalizedTopic });
        return new Response(null, { status: 200 });
      }

      const message = buildComplianceMessage(
        normalizedTopic,
        shop,
        webhookId,
        typedPayload
      );

      try {
        const result = await recordAndEnqueueCompliance(
          sql,
          shop,
          webhookId,
          normalizedTopic,
          triggeredAt,
          message
        );

        if ("duplicate" in result) {
          safeLog("info", "compliance_duplicate", { topic: normalizedTopic });
        }
      } catch (err) {
        safeLog("error", "compliance_enqueue_failed", {
          topic: normalizedTopic,
          err: toErrorCode(err),
        });
        return new Response(null, { status: 500 });
      }

      return new Response(null, { status: 200 });
    }

    case "CUSTOMERS_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        customer?: { id?: number };
      };

      if (!typedPayload.customer?.id) {
        safeLog("info", "compliance_missing_customer_id", { topic: normalizedTopic });
        return new Response(null, { status: 200 });
      }

      const [shopRecord] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE domain = ${payloadShop}
      `;

      if (!shopRecord) {
        safeLog("info", "compliance_shop_not_found", { topic: normalizedTopic });
        return new Response(null, { status: 200 });
      }

      const message = buildComplianceMessage(
        normalizedTopic,
        shop,
        webhookId,
        typedPayload
      );

      try {
        const result = await recordAndEnqueueCompliance(
          sql,
          shop,
          webhookId,
          normalizedTopic,
          triggeredAt,
          message
        );

        if ("duplicate" in result) {
          safeLog("info", "compliance_duplicate", { topic: normalizedTopic });
        }
      } catch (err) {
        safeLog("error", "compliance_enqueue_failed", {
          topic: normalizedTopic,
          err: toErrorCode(err),
        });
        return new Response(null, { status: 500 });
      }

      return new Response(null, { status: 200 });
    }

    case "SHOP_REDACT": {
      const payloadShop = verifyPayloadShopMatch(shop, payload);

      const typedPayload = payload as {
        shop_id?: number;
      };

      const message = buildComplianceMessage(
        normalizedTopic,
        shop,
        webhookId,
        typedPayload
      );

      try {
        const result = await recordAndEnqueueCompliance(
          sql,
          shop,
          webhookId,
          normalizedTopic,
          triggeredAt,
          message
        );

        if ("duplicate" in result) {
          safeLog("info", "compliance_duplicate", { topic: normalizedTopic });
        }
      } catch (err) {
        safeLog("error", "compliance_enqueue_failed", {
          topic: normalizedTopic,
          err: toErrorCode(err),
        });
        return new Response(null, { status: 500 });
      }

      return new Response(null, { status: 200 });
    }

    default:
      safeLog("info", "compliance_unhandled_topic", { topic: normalizedTopic });
      return new Response(null, { status: 200 });
  }
};
