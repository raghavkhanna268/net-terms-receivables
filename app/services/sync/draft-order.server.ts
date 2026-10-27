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
 * - UPDATE: Update amount, status, or buyer account; includes completion
 * - DELETE: Remove the draft order record
 *
 * When a draft order is completed (becomes an Order), Shopify sends a
 * draft_orders/update webhook with status=completed, then an orders/create
 * webhook. The Invoice is created by the order processor, and the draft
 * record is excluded from pending exposure (status=completed).
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyDraftOrder, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { SUPPORTED_SHOP_CURRENCY } from "~/lib/shop-currency.server";
import { safeLog, shopHash } from "~/lib/log.server";
import { flagAccountsForRecompute } from "~/services/credit-status-recompute.server";
import { captureExceptionWithTags } from "~/lib/sentry";

/**
 * Normalize a decimal amount string to exactly 2 decimal places for comparison.
 * Used for D3 total comparison: Shopify GraphQL may return "1000", "1000.0", or "1000.00"
 * but the DB stores Decimal(14,2) which always has 2dp as text.
 * This is a string-safe normalization with no float math.
 */
function normalizeAmountTo2dp(amount: string): string {
  const [whole, frac = ""] = amount.split(".");
  const paddedFrac = (frac + "00").slice(0, 2);
  return `${whole}.${paddedFrac}`;
}

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
  // Currency guard not needed for delete - we want to remove records regardless of currency
  if (topic === "DRAFT_ORDERS_DELETE") {
    const deleteResult = await deleteDraftOrder(sql, shopId, draftOrder.id);

    // Flag the deleted buyer for recompute (D3: delete flags the previous buyer)
    if (deleteResult.deletedBuyerAccountId) {
      try {
        await flagAccountsForRecompute(sql, shopDomain, [deleteResult.deletedBuyerAccountId]);
      } catch (err) {
        captureExceptionWithTags(err, {});
      }
    }

    await markWebhookProcessed(sql, webhookId, "DRAFT_ORDERS_DELETE", draftOrder.id);
    return deleteResult;
  }

  // #292: Per-draft-order currency guard - skip drafts with missing or non-INR currency
  // Draft orders created before the shop switched to INR should not be stored as INR amounts
  const draftCurrency = draftOrder.totalPriceSet?.shopMoney?.currencyCode;
  if (!draftCurrency || draftCurrency !== SUPPORTED_SHOP_CURRENCY) {
    const hash = await shopHash(shopDomain);
    safeLog("info", "drain_skip_non_inr_draft_order", { shopHash: hash, count: 1 });
    await markWebhookProcessed(sql, webhookId, topic, draftOrder.id);
    return {
      success: true,
      action: "skipped",
      skipReason: draftCurrency ? "draft_order_currency_not_supported" : "draft_order_currency_missing",
    };
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

  // Flag accounts for recompute after commit (D3: only on real change)
  const accountsToFlag = getAccountsToFlag(result, draftOrder);
  if (accountsToFlag.length > 0) {
    try {
      await flagAccountsForRecompute(sql, shopDomain, accountsToFlag);
    } catch (err) {
      captureExceptionWithTags(err, {});
    }
  }

  await markWebhookProcessed(sql, webhookId, topic, draftOrder.id);

  return result;
}

/**
 * Determine which accounts to flag for recompute after a draft upsert.
 * D3: Flag only on a REAL change to buyer_account_id, status, total or has_payment_terms.
 * A move from buyer A to B flags both. Completed status flags the buyer.
 * Null-buyer drafts flag nothing.
 */
function getAccountsToFlag(
  result: { oldRow: OldDraftRow | null; newBuyerAccountId: string | null; action: string },
  draftOrder: ShopifyDraftOrder
): string[] {
  const accounts: (string | null)[] = [];
  const newData = mapDraftOrder("", draftOrder, result.newBuyerAccountId);

  if (result.action === "created") {
    // New draft: flag the new buyer (if any)
    accounts.push(result.newBuyerAccountId);
  } else if (result.oldRow) {
    // Update: check if relevant fields changed
    const buyerChanged = result.oldRow.buyer_account_id !== result.newBuyerAccountId;
    // D3: Compare totals at 2dp scale - Shopify may send "1000" or "1000.0" but DB has "1000.00"
    const totalChanged = normalizeAmountTo2dp(result.oldRow.total) !== normalizeAmountTo2dp(newData.total);
    const statusChanged = result.oldRow.status !== newData.status;
    const termsChanged = result.oldRow.has_payment_terms !== newData.hasPaymentTerms;

    if (buyerChanged || totalChanged || statusChanged || termsChanged) {
      // Flag old buyer (if any)
      accounts.push(result.oldRow.buyer_account_id);
      // Flag new buyer (if any)
      accounts.push(result.newBuyerAccountId);
    }
  }

  // Filter out nulls and duplicates
  return [...new Set(accounts.filter((id): id is string => id !== null))];
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

  // Normalize status to lowercase for DB storage
  // GraphQL returns UPPERCASE enum (OPEN, INVOICE_SENT, COMPLETED)
  // but exposure queries use lowercase ('open', 'invoice_sent')
  const normalizedStatus = (draftOrder.status ?? "open").toLowerCase();

  return {
    shopId,
    draftOrderId: draftOrder.id,
    buyerAccountId,
    name: draftOrder.name,
    total,
    hasPaymentTerms: !!draftOrder.paymentTerms,
    status: normalizedStatus,
    createdAt: new Date(draftOrder.createdAt),
  };
}

/**
 * Old row data for flagging logic (D3: detect real changes).
 */
interface OldDraftRow {
  buyer_account_id: string | null;
  total: string;
  status: string;
  has_payment_terms: boolean;
}

/**
 * Result of upsert including old row data for flagging.
 */
interface UpsertDraftResult extends SyncResult {
  oldRow: OldDraftRow | null;
  newBuyerAccountId: string | null;
}

/**
 * Upsert a draft order record.
 * Uses a transaction with SELECT FOR UPDATE to capture old row state.
 */
async function upsertDraftOrder(
  sql: Sql,
  shopId: string,
  draftOrder: ShopifyDraftOrder,
  buyerAccountId: string | null
): Promise<UpsertDraftResult> {
  const data = mapDraftOrder(shopId, draftOrder, buyerAccountId);

  const res = await sql.begin(async (tx) => {
    const [old] = await tx<OldDraftRow[]>`
      SELECT buyer_account_id, total::text AS total, status, has_payment_terms
      FROM s8_draft_orders
      WHERE shop_id = ${shopId} AND draft_order_id = ${draftOrder.id}
      FOR UPDATE
    `;

    const [row] = await tx<{ id: string; action: string }[]>`
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

    return { row, oldRow: old ?? null };
  });

  return {
    success: true,
    action: res.row.action === "true" ? "created" : "updated",
    entityId: res.row.id,
    oldRow: res.oldRow,
    newBuyerAccountId: buyerAccountId,
  };
}

/**
 * Result of delete including old buyer for flagging.
 */
interface DeleteDraftResult extends SyncResult {
  deletedBuyerAccountId: string | null;
}

/**
 * Delete a draft order record.
 * Returns the deleted buyer_account_id for flagging.
 */
async function deleteDraftOrder(
  sql: Sql,
  shopId: string,
  draftOrderId: string
): Promise<DeleteDraftResult> {
  const [deleted] = await sql<{ id: string; buyer_account_id: string | null }[]>`
    DELETE FROM s8_draft_orders
    WHERE shop_id = ${shopId} AND draft_order_id = ${draftOrderId}
    RETURNING id, buyer_account_id
  `;

  if (!deleted) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Draft order not found (may have been deleted or never tracked)",
      deletedBuyerAccountId: null,
    };
  }

  return {
    success: true,
    action: "deleted",
    entityId: deleted.id,
    deletedBuyerAccountId: deleted.buyer_account_id,
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
 * Result of bulk upsert including affected accounts for flagging.
 */
export interface BulkUpsertResult {
  count: number;
  affectedAccountIds: Set<string>;
}

/**
 * Bulk upsert draft orders.
 * Used by bulk operation processor for efficient batch inserts.
 * Returns affected accounts for credit-status recompute flagging.
 *
 * @param sql - postgres.js SQL client
 * @param draftOrders - Array of mapped draft order data
 * @returns Count and affected account IDs (old and new buyers where there was a real change)
 */
export async function bulkUpsertDraftOrders(
  sql: Sql,
  draftOrders: ReturnType<typeof mapDraftOrder>[]
): Promise<BulkUpsertResult> {
  if (draftOrders.length === 0) return { count: 0, affectedAccountIds: new Set() };

  const affectedAccountIds = new Set<string>();

  // Get all draft_order_ids to pre-fetch old rows
  const draftOrderIds = draftOrders.map((d) => d.draftOrderId);
  const shopId = draftOrders[0].shopId;

  // Pre-fetch old rows with FOR UPDATE in a transaction
  type OldRowWithId = OldDraftRow & { draft_order_id: string };
  const result = await sql.begin(async (tx) => {
    const oldRows = await tx<OldRowWithId[]>`
      SELECT draft_order_id, buyer_account_id, total::text AS total, status, has_payment_terms
      FROM s8_draft_orders
      WHERE shop_id = ${shopId} AND draft_order_id IN ${sql(draftOrderIds)}
      FOR UPDATE
    `;
    const oldRowMap = new Map<string, OldRowWithId>(oldRows.map((r) => [r.draft_order_id, r]));

    let upsertCount = 0;
    for (const d of draftOrders) {
      const oldRow = oldRowMap.get(d.draftOrderId);
      
      const upsertResult = await tx`
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
      upsertCount += upsertResult.count;

      // D3: Detect real changes and track affected accounts
      if (!oldRow) {
        // New insert: flag the new buyer (if any)
        if (d.buyerAccountId) affectedAccountIds.add(d.buyerAccountId);
      } else {
        // Update: check if relevant fields changed
        const buyerChanged = oldRow.buyer_account_id !== d.buyerAccountId;
        // D3: Compare totals at 2dp scale - Shopify may send "1000" or "1000.0" but DB has "1000.00"
        const totalChanged = normalizeAmountTo2dp(oldRow.total) !== normalizeAmountTo2dp(d.total);
        const statusChanged = oldRow.status !== d.status;
        const termsChanged = oldRow.has_payment_terms !== d.hasPaymentTerms;

        if (buyerChanged || totalChanged || statusChanged || termsChanged) {
          if (oldRow.buyer_account_id) affectedAccountIds.add(oldRow.buyer_account_id);
          if (d.buyerAccountId) affectedAccountIds.add(d.buyerAccountId);
        }
      }
    }
    return upsertCount;
  });

  return { count: result, affectedAccountIds };
}

/**
 * Process a draft order from bulk JSONL export.
 *
 * Resolves the buyer account and maps the draft order data for upsert.
 * Only processes draft orders with payment terms.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param draftOrder - Draft order data from bulk export
 * @returns Mapped draft order data or null if should be skipped
 */
export async function processBulkDraftOrder(
  sql: Sql,
  shopDomain: string,
  draftOrder: ShopifyDraftOrder
): Promise<ReturnType<typeof mapDraftOrder> | null> {
  if (!draftOrder.paymentTerms) {
    return null;
  }

  // #292: Per-draft-order currency guard - skip drafts with missing or non-INR currency
  // Same guard as the webhook path to maintain parity
  const draftCurrency = draftOrder.totalPriceSet?.shopMoney?.currencyCode;
  if (!draftCurrency || draftCurrency !== SUPPORTED_SHOP_CURRENCY) {
    return null;
  }

  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return null;
  }

  const buyerAccountId = await resolveBuyerAccount(sql, shop.id, draftOrder);
  return mapDraftOrder(shop.id, draftOrder, buyerAccountId);
}

/**
 * Get all buyer account IDs with draft exposure for a shop.
 * Used by initial sync completion to flag all affected accounts at once (D6).
 *
 * Returns accounts that have drafts with:
 * - has_payment_terms = true
 * - status in ('open', 'invoice_sent') - i.e., not 'completed'
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Set of buyer account IDs with draft exposure
 */
export async function getAccountsWithDraftExposure(
  sql: Sql,
  shopDomain: string
): Promise<Set<string>> {
  const rows = await sql<{ buyer_account_id: string }[]>`
    SELECT DISTINCT d.buyer_account_id
    FROM s8_draft_orders d
    JOIN "Shop" s ON s.id = d.shop_id
    WHERE s.domain = ${shopDomain}
      AND d.buyer_account_id IS NOT NULL
      AND d.has_payment_terms = true
      AND d.status IN ('open', 'invoice_sent')
  `;
  return new Set(rows.map((r) => r.buyer_account_id));
}

/**
 * Close draft orders that were not seen during a COMPLETE reconcile run.
 *
 * v1.1 delete-missing: After a complete RECONCILE_DRAFT_ORDERS bulk operation,
 * mark local s8_draft_orders rows with status 'open' or 'invoice_sent' that were
 * NOT seen (updated_at < started_at) as 'closed'.
 *
 * Safety guards:
 * - Only runs when the bulk operation has completed_at set
 * - Scoped to the specific shop (shop_id in WHERE)
 * - Soft close only: sets status='closed', never deletes
 * - Excludes redacted rows (buyer_account_id links to a redacted BuyerAccount)
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param bulkOperationId - The completed bulk operation ID
 * @returns Count of draft orders closed and array of affected buyer account IDs
 */
export async function closeMissingDraftOrders(
  sql: Sql,
  shopDomain: string,
  bulkOperationId: string
): Promise<{ closedCount: number; affectedAccountIds: string[] }> {
  const [shopRow] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;
  if (!shopRow) return { closedCount: 0, affectedAccountIds: [] };

  const shopId = shopRow.id;

  const [opRow] = await sql<{ started_at: Date; completed_at: Date | null }[]>`
    SELECT started_at, completed_at FROM s6_bulk_operations
    WHERE bulk_operation_id = ${bulkOperationId}
  `;
  if (!opRow || !opRow.completed_at) return { closedCount: 0, affectedAccountIds: [] };

  const startedAt = opRow.started_at;
  const redactedInfix = "_redacted_";

  const closedRows = await sql<{ id: string; buyer_account_id: string | null }[]>`
    UPDATE s8_draft_orders d
    SET status = 'closed'
    WHERE d.shop_id = ${shopId}
      AND d.status IN ('open', 'invoice_sent')
      AND d.updated_at < ${startedAt}
      AND NOT EXISTS (
        SELECT 1 FROM "BuyerAccount" ba
        WHERE ba.id = d.buyer_account_id
          AND ba."customerId" LIKE '%' || ${redactedInfix} || '%'
      )
    RETURNING d.id, d.buyer_account_id
  `;

  const affectedAccountIds = [
    ...new Set(
      closedRows
        .map((r) => r.buyer_account_id)
        .filter((id): id is string => id !== null)
    ),
  ];

  return { closedCount: closedRows.count, affectedAccountIds };
}
