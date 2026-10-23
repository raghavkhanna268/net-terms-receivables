/**
 * Draft order sync processor for S8.
 *
 * Tracks draft orders with payment terms for pending credit exposure.
 * Only draft orders with paymentTerms are stored; others are ignored.
 *
 * Draft orders represent uncommitted orders that may become Invoices.
 * Tracking them enables credit limit calculations to include pending exposure
 * before the draft is completed.
 *
 * Lifecycle:
 * - CREATE: Store draft if it has payment terms and a buyer account
 * - UPDATE: Update amount, status, or buyer account
 * - DELETE: Remove the draft order record
 *
 * When a draft order is completed (becomes an Order), Shopify sends an
 * orders/create webhook. The Invoice is created by the order processor,
 * and a draft_orders/delete webhook removes the draft record.
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyDraftOrder, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";

/**
 * Process a DraftOrder webhook event.
 *
 * CREATE/UPDATE: Store draft if it has payment terms and buyer account
 * DELETE: Remove the draft order record
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic
 * @param draftOrder - Draft order data
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result
 */
export async function processDraftOrderWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  draftOrder: ShopifyDraftOrder,
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

  // Handle DELETE: remove the draft order record
  if (topic === "DRAFT_ORDERS_DELETE") {
    return await deleteDraftOrder(sql, shopId, draftOrder.id, webhookId);
  }

  // Skip draft orders without payment terms
  if (!draftOrder.paymentTerms) {
    await markWebhookProcessed(sql, webhookId, topic, draftOrder.id);
    return {
      success: true,
      action: "skipped",
      skipReason: "Draft order has no payment terms",
    };
  }

  // Resolve buyer account from purchasing entity
  const buyerAccountId = await resolveBuyerAccount(sql, shopId, draftOrder);

  // Store the draft order (with or without buyer account)
  // A draft without a resolved buyer still counts for exposure if it has terms
  const result = await upsertDraftOrder(sql, shopId, draftOrder, buyerAccountId);

  await markWebhookProcessed(sql, webhookId, topic, draftOrder.id);

  return result;
}

/**
 * Resolve the BuyerAccount for a draft order.
 *
 * Order of resolution (same as orders):
 * 1. purchasingEntity.location (CompanyLocation) -> BuyerAccount by companyLocationId
 * 2. purchasingEntity.company -> BuyerAccount by companyId (first location)
 * 3. customer -> BuyerAccount by customerId (TAGGED_CUSTOMER)
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Our internal shop ID
 * @param draftOrder - Draft order data
 * @returns BuyerAccount ID or null if not found
 */
async function resolveBuyerAccount(
  sql: Sql,
  shopId: string,
  draftOrder: ShopifyDraftOrder
): Promise<string | null> {
  const purchasingEntity = draftOrder.purchasingEntity;

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
  if (draftOrder.customer?.id) {
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId}
        AND "customerId" = ${draftOrder.customer.id}
    `;
    if (account) return account.id;
  }

  return null;
}

/**
 * Map DraftOrder to s8_draft_orders insert data.
 */
export function mapDraftOrder(
  shopId: string,
  draftOrder: ShopifyDraftOrder,
  buyerAccountId: string | null
): {
  shopId: string;
  draftOrderId: string;
  buyerAccountId: string | null;
  name: string;
  total: string;
  hasPaymentTerms: boolean;
  status: string;
  createdAt: Date;
} {
  const total = draftOrder.totalPriceSet?.shopMoney.amount ?? "0.00";

  return {
    shopId,
    draftOrderId: draftOrder.id,
    buyerAccountId,
    name: draftOrder.name,
    total,
    hasPaymentTerms: !!draftOrder.paymentTerms,
    status: draftOrder.status ?? "open",
    createdAt: new Date(draftOrder.createdAt),
  };
}

/**
 * Upsert a draft order record.
 */
async function upsertDraftOrder(
  sql: Sql,
  shopId: string,
  draftOrder: ShopifyDraftOrder,
  buyerAccountId: string | null
): Promise<SyncResult> {
  const data = mapDraftOrder(shopId, draftOrder, buyerAccountId);

  const [result] = await sql<{ id: string; action: string }[]>`
    INSERT INTO s8_draft_orders (
      shop_id,
      draft_order_id,
      buyer_account_id,
      name,
      total,
      has_payment_terms,
      status,
      created_at,
      updated_at
    ) VALUES (
      ${data.shopId},
      ${data.draftOrderId},
      ${data.buyerAccountId},
      ${data.name},
      ${data.total},
      ${data.hasPaymentTerms},
      ${data.status},
      ${data.createdAt},
      NOW()
    )
    ON CONFLICT (shop_id, draft_order_id)
    DO UPDATE SET
      buyer_account_id = ${data.buyerAccountId},
      name = ${data.name},
      total = ${data.total},
      has_payment_terms = ${data.hasPaymentTerms},
      status = ${data.status},
      updated_at = NOW()
    RETURNING id, (xmax = 0)::text as action
  `;

  return {
    success: true,
    action: result.action === "true" ? "created" : "updated",
    entityId: result.id,
  };
}

/**
 * Delete a draft order record.
 */
async function deleteDraftOrder(
  sql: Sql,
  shopId: string,
  draftOrderId: string,
  webhookId: string
): Promise<SyncResult> {
  const [deleted] = await sql<{ id: string }[]>`
    DELETE FROM s8_draft_orders
    WHERE shop_id = ${shopId} AND draft_order_id = ${draftOrderId}
    RETURNING id
  `;

  await markWebhookProcessed(sql, webhookId, "DRAFT_ORDERS_DELETE", draftOrderId);

  if (!deleted) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Draft order not found (may have been deleted or never tracked)",
    };
  }

  return {
    success: true,
    action: "deleted",
    entityId: deleted.id,
  };
}

/**
 * Get pending credit exposure for a buyer account.
 *
 * Returns the sum of all draft orders with payment terms for the account.
 * This is used by credit limit calculations to include uncommitted exposure.
 *
 * @param sql - postgres.js SQL client
 * @param buyerAccountId - BuyerAccount ID
 * @returns Total pending exposure amount
 */
export async function getPendingExposure(
  sql: Sql,
  buyerAccountId: string
): Promise<string> {
  const [result] = await sql<{ total: string | null }[]>`
    SELECT COALESCE(SUM(total), '0.00') as total
    FROM s8_draft_orders
    WHERE buyer_account_id = ${buyerAccountId}
      AND has_payment_terms = true
      AND status != 'completed'
  `;

  return result?.total ?? "0.00";
}

/**
 * Bulk upsert draft orders.
 * Used by bulk operation processor for efficient batch inserts.
 *
 * @param sql - postgres.js SQL client
 * @param draftOrders - Array of mapped draft order data
 * @returns Number of draft orders upserted
 */
export async function bulkUpsertDraftOrders(
  sql: Sql,
  draftOrders: ReturnType<typeof mapDraftOrder>[]
): Promise<number> {
  if (draftOrders.length === 0) return 0;

  let count = 0;
  for (const d of draftOrders) {
    const result = await sql`
      INSERT INTO s8_draft_orders (
        shop_id,
        draft_order_id,
        buyer_account_id,
        name,
        total,
        has_payment_terms,
        status,
        created_at,
        updated_at
      ) VALUES (
        ${d.shopId},
        ${d.draftOrderId},
        ${d.buyerAccountId},
        ${d.name},
        ${d.total},
        ${d.hasPaymentTerms},
        ${d.status},
        ${d.createdAt},
        NOW()
      )
      ON CONFLICT (shop_id, draft_order_id)
      DO UPDATE SET
        buyer_account_id = ${d.buyerAccountId},
        name = ${d.name},
        total = ${d.total},
        has_payment_terms = ${d.hasPaymentTerms},
        status = ${d.status},
        updated_at = NOW()
    `;
    count += result.count;
  }

  return count;
}
