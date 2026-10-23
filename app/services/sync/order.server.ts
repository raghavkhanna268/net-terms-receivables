/**
 * Order sync processor for S6.
 *
 * Maps Shopify Orders with payment terms to Invoices.
 * Only orders with paymentTerms are processed; others are skipped.
 *
 * Order -> Invoice mapping:
 * - orderId: Order GID
 * - buyerAccountId: From purchasingEntity (Company) or customer tags
 * - total: From totalPriceSet
 * - outstanding: Same as total on create; updated on payment
 * - dueAt: From paymentTerms schedule
 * - dueSource: 'schedule' if from Shopify payment schedule
 *
 * Idempotent: Uses upsert with ON CONFLICT on orderId.
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyOrder, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";

/**
 * Process an Order webhook event.
 *
 * CREATE: Creates Invoice if order has payment terms
 * UPDATED: Updates Invoice amounts, status, due date
 * CANCELLED: Marks Invoice as cancelled
 * PAID: Marks Invoice as paid, sets outstanding to 0
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic
 * @param order - Order data from webhook
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result
 */
export async function processOrderWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  order: ShopifyOrder,
  webhookId: string
): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // Skip orders without payment terms
  if (!order.paymentTerms) {
    await markWebhookProcessed(sql, webhookId, topic, order.id);
    return {
      success: true,
      action: "skipped",
      skipReason: "Order has no payment terms",
    };
  }

  // Get shop
  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      success: false,
      action: "skipped",
      error: `Shop not found: ${shopDomain}`,
    };
  }

  const shopId = shop.id;

  // Handle CANCELLED and PAID topics first - they update existing invoices
  // and don't need buyer account resolution
  if (topic === "ORDERS_CANCELLED") {
    return await cancelInvoice(sql, shopId, order.id, webhookId);
  }

  if (topic === "ORDERS_PAID") {
    return await markInvoicePaid(sql, shopId, order.id, webhookId);
  }

  // Resolve buyer account from purchasing entity
  const buyerAccountId = await resolveBuyerAccount(sql, shopId, order);

  if (!buyerAccountId) {
    // Order has payment terms but we can't find a buyer account
    // This can happen if the company hasn't been synced yet
    // Return a failure so the message can be retried
    return {
      success: false,
      action: "skipped",
      error: `Buyer account not found for order ${order.id}. Company may not be synced yet.`,
    };
  }

  // CREATE or UPDATED: Upsert invoice
  const invoiceData = mapOrderToInvoice(shopId, buyerAccountId, order);
  const result = await upsertInvoice(sql, invoiceData);

  await markWebhookProcessed(sql, webhookId, topic, order.id);

  return result;
}

/**
 * Resolve the BuyerAccount for an order.
 *
 * Order of resolution:
 * 1. purchasingEntity.location (CompanyLocation) -> BuyerAccount by companyLocationId
 * 2. purchasingEntity.company -> BuyerAccount by companyId (first location)
 * 3. customer with tags -> BuyerAccount by customerId (TAGGED_CUSTOMER)
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Our internal shop ID
 * @param order - Order data
 * @returns BuyerAccount ID or null if not found
 */
async function resolveBuyerAccount(
  sql: Sql,
  shopId: string,
  order: ShopifyOrder
): Promise<string | null> {
  const purchasingEntity = order.purchasingEntity;

  // Try CompanyLocation first (most specific)
  if (purchasingEntity?.location?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "companyLocationId" = ${purchasingEntity.location.id}
    `;
    if (account) return account.id;
  }

  // Try Company (any location for that company)
  if (purchasingEntity?.company?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "companyId" = ${purchasingEntity.company.id}
      LIMIT 1
    `;
    if (account) return account.id;
  }

  // Try customer (for tagged customers)
  if (order.customer?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "customerId" = ${order.customer.id}
    `;
    if (account) return account.id;
  }

  return null;
}

/**
 * Map Order to Invoice insert data.
 */
export function mapOrderToInvoice(
  shopId: string,
  buyerAccountId: string,
  order: ShopifyOrder
): {
  shopId: string;
  buyerAccountId: string;
  orderId: string;
  name: string;
  total: string;
  outstanding: string;
  issuedAt: Date;
  dueAt: Date | null;
  dueSource: "schedule" | "none";
  dueBasis: string | null;
  dueReason: string | null;
  status: "open" | "paid" | "cancelled";
} {
  const total = order.totalPriceSet?.shopMoney.amount ?? "0.00";
  // Use processedAt if available (for backdated orders via orderCreate), else createdAt
  const issuedAt = new Date(order.processedAt ?? order.createdAt);

  // Extract due date from payment schedule
  let dueAt: Date | null = null;
  let dueSource: "schedule" | "none" = "none";
  let dueBasis: string | null = null;
  let dueReason: string | null = null;

  if (order.paymentTerms?.paymentSchedules?.edges?.length) {
    const schedule = order.paymentTerms.paymentSchedules.edges[0].node;
    if (schedule.dueAt) {
      dueAt = new Date(schedule.dueAt);
      dueSource = "schedule";
      dueBasis = null; // Schedule-derived, not inferred
      dueReason = `Payment schedule: ${order.paymentTerms.paymentTermsName}`;
    }
  } else if (order.paymentTerms?.dueInDays != null) {
    // Calculate due date from dueInDays
    dueAt = new Date(issuedAt);
    dueAt.setDate(dueAt.getDate() + order.paymentTerms.dueInDays);
    dueSource = "schedule";
    dueBasis = "paymentTermsDueInDays";
    dueReason = `${order.paymentTerms.paymentTermsName}: Net ${order.paymentTerms.dueInDays} days`;
  }

  // Determine status
  let status: "open" | "paid" | "cancelled" = "open";
  if (order.cancelledAt) {
    status = "cancelled";
  } else if (order.displayFinancialStatus === "PAID") {
    status = "paid";
  }

  return {
    shopId,
    buyerAccountId,
    orderId: order.id,
    name: order.name,
    total,
    outstanding: status === "paid" ? "0.00" : total,
    issuedAt,
    dueAt,
    dueSource,
    dueBasis,
    dueReason,
    status,
  };
}

/**
 * Upsert an Invoice from order data.
 */
async function upsertInvoice(
  sql: Sql,
  data: ReturnType<typeof mapOrderToInvoice>
): Promise<SyncResult> {
  const [result] = await sql<{ id: string; action: string }[]>`
    INSERT INTO "Invoice" (
      "shopId",
      "buyerAccountId",
      "orderId",
      name,
      total,
      outstanding,
      "issuedAt",
      "dueAt",
      "dueSource",
      "dueBasis",
      "dueReason",
      status,
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${data.shopId},
      ${data.buyerAccountId},
      ${data.orderId},
      ${data.name},
      ${data.total},
      ${data.outstanding},
      ${data.issuedAt},
      ${data.dueAt},
      ${data.dueSource},
      ${data.dueBasis},
      ${data.dueReason},
      ${data.status},
      NOW(),
      NOW()
    )
    ON CONFLICT ("orderId")
    DO UPDATE SET
      "buyerAccountId" = EXCLUDED."buyerAccountId",
      name = EXCLUDED.name,
      total = EXCLUDED.total,
      outstanding = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice".outstanding
        ELSE EXCLUDED.outstanding
      END,
      "dueAt" = COALESCE(EXCLUDED."dueAt", "Invoice"."dueAt"),
      "dueSource" = CASE
        WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueSource"
        ELSE "Invoice"."dueSource"
      END,
      "dueBasis" = CASE
        WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueBasis"
        ELSE "Invoice"."dueBasis"
      END,
      "dueReason" = CASE
        WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueReason"
        ELSE "Invoice"."dueReason"
      END,
      -- Never downgrade terminal states (paid/cancelled)
      status = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice".status
        ELSE EXCLUDED.status
      END,
      "updatedAt" = NOW()
    RETURNING id, (xmax = 0)::text as action
  `;

  return {
    success: true,
    action: result.action === "true" ? "created" : "updated",
    entityId: result.id,
  };
}

/**
 * Cancel an invoice when order is cancelled.
 */
async function cancelInvoice(
  sql: Sql,
  shopId: string,
  orderId: string,
  webhookId: string
): Promise<SyncResult> {
  const [result] = await sql<{ id: string }[]>`
    UPDATE "Invoice"
    SET status = 'cancelled', "updatedAt" = NOW()
    WHERE "shopId" = ${shopId} AND "orderId" = ${orderId}
    RETURNING id
  `;

  await markWebhookProcessed(sql, webhookId, "ORDERS_CANCELLED", orderId);

  if (!result) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice not found for cancelled order",
    };
  }

  return {
    success: true,
    action: "updated",
    entityId: result.id,
  };
}

/**
 * Mark an invoice as paid when order is paid.
 */
async function markInvoicePaid(
  sql: Sql,
  shopId: string,
  orderId: string,
  webhookId: string
): Promise<SyncResult> {
  const [result] = await sql<{ id: string }[]>`
    UPDATE "Invoice"
    SET status = 'paid', outstanding = '0.00', "updatedAt" = NOW()
    WHERE "shopId" = ${shopId} AND "orderId" = ${orderId}
    RETURNING id
  `;

  await markWebhookProcessed(sql, webhookId, "ORDERS_PAID", orderId);

  if (!result) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice not found for paid order",
    };
  }

  return {
    success: true,
    action: "updated",
    entityId: result.id,
  };
}

/**
 * Bulk upsert Invoices from orders.
 * Used by bulk operation processor for efficient batch inserts.
 *
 * @param sql - postgres.js SQL client
 * @param invoices - Array of mapped Invoice data
 * @returns Number of invoices upserted
 */
export async function bulkUpsertInvoices(
  sql: Sql,
  invoices: ReturnType<typeof mapOrderToInvoice>[]
): Promise<number> {
  if (invoices.length === 0) return 0;

  let count = 0;
  for (const i of invoices) {
    const result = await sql`
      INSERT INTO "Invoice" (
        "shopId",
        "buyerAccountId",
        "orderId",
        name,
        total,
        outstanding,
        "issuedAt",
        "dueAt",
        "dueSource",
        "dueBasis",
        "dueReason",
        status,
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${i.shopId},
        ${i.buyerAccountId},
        ${i.orderId},
        ${i.name},
        ${i.total},
        ${i.outstanding},
        ${i.issuedAt},
        ${i.dueAt},
        ${i.dueSource},
        ${i.dueBasis},
        ${i.dueReason},
        ${i.status},
        NOW(),
        NOW()
      )
      ON CONFLICT ("orderId")
      DO UPDATE SET
        "buyerAccountId" = EXCLUDED."buyerAccountId",
        name = EXCLUDED.name,
        total = EXCLUDED.total,
        outstanding = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice".outstanding
          ELSE EXCLUDED.outstanding
        END,
        "dueAt" = COALESCE(EXCLUDED."dueAt", "Invoice"."dueAt"),
        "dueSource" = CASE
          WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueSource"
          ELSE "Invoice"."dueSource"
        END,
        "dueBasis" = CASE
          WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueBasis"
          ELSE "Invoice"."dueBasis"
        END,
        "dueReason" = CASE
          WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueReason"
          ELSE "Invoice"."dueReason"
        END,
        -- Never downgrade terminal states (paid/cancelled)
        status = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice".status
          ELSE EXCLUDED.status
        END,
        "updatedAt" = NOW()
    `;
    count += result.count;
  }

  return count;
}
