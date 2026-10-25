/**
 * Order sync processor for S6 (S9 Refs).
 *
 * Maps Shopify Orders to Invoices based on eligibility rules.
 *
 * Eligibility: An order becomes an Invoice when displayFinancialStatus is
 * PENDING, PARTIALLY_PAID, or AUTHORIZED, AND any of:
 *   (a) Order has Shopify paymentTerms
 *   (b) purchasingEntity is a Company whose CompanyLocation maps to an active
 *       BuyerAccount with explicit defaultTermsDays
 *   (c) Customer matches a configured tag rule (AccountSource)
 *
 * Order -> Invoice mapping:
 * - orderId: Order GID
 * - buyerAccountId: From eligibility check
 * - total: From totalPriceSet
 * - outstanding: Same as total on create; updated on payment
 * - dueAt: From S9 inference (schedule > override > account > tag > shop)
 * - dueSource/dueBasis: From S9 inference result
 *
 * Idempotent: Uses upsert with ON CONFLICT on orderId.
 * 
 * S20 ordering: No explicit ordering guard needed because:
 * - The drain re-fetches the order from Shopify Admin API
 * - Re-fetched data is always the latest Shopify state
 * - Terminal states (paid/cancelled) are protected in the upsert
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyOrder, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import {
  checkOrderEligibility,
  getEligibilityContextByDomain,
  type EligibilityResult,
} from "~/lib/invoice-eligibility";
import { incrementOrderOutstandingMissing } from "../drain/reconcile-handlers.server";
import { enqueueRecomputeForInvoice } from "../credit-status-recompute.server";
import { captureExceptionWithTags } from "~/lib/sentry";
import { safeLog, toErrorCode, shopHash } from "~/lib/log.server";
import { SUPPORTED_SHOP_CURRENCY } from "~/lib/shop-currency.server";

/**
 * Process an Order webhook event.
 *
 * CREATE: Creates Invoice if order passes eligibility check
 * UPDATED: Updates Invoice amounts, status, due date
 * CANCELLED: Marks Invoice as cancelled
 * PAID: Marks Invoice as paid, sets outstanding to 0
 *
 * Eligibility (S9): Order becomes Invoice when status is PENDING/PARTIALLY_PAID/AUTHORIZED
 * AND any of: (a) has Shopify paymentTerms, (b) company account has explicit terms,
 * (c) customer matches a tag rule.
 *
 * S20: triggeredAt parameter kept for API compatibility but not used for ordering.
 * The drain re-fetches from Shopify, so we always have the latest state.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic
 * @param order - Order data from webhook
 * @param webhookId - Webhook ID for idempotency
 * @param _triggeredAt - Unused, kept for API compatibility
 * @returns Sync result
 */
export async function processOrderWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  order: ShopifyOrder,
  webhookId: string,
  _triggeredAt?: Date | null
): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, webhookId, shopDomain)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // Get shop and eligibility context
  const contextResult = await getEligibilityContextByDomain(sql, shopDomain);

  if (!contextResult) {
    return {
      success: false,
      action: "skipped",
      error: "shop_not_found",
      errorCode: "shop_not_found",
    };
  }

  const { shopId, context } = contextResult;

  // #292: Per-order currency guard - skip orders whose currency is not INR
  // Orders created before the shop switched to INR should not be stored as INR amounts
  const orderCurrency = order.totalPriceSet?.shopMoney?.currencyCode;
  if (orderCurrency && orderCurrency !== SUPPORTED_SHOP_CURRENCY) {
    // Log count-only with shopHash (no PII)
    const hash = await shopHash(shopDomain);
    safeLog("info", "drain_skip_non_inr_order", { shopHash: hash, count: 1 });
    return {
      success: true,
      action: "skipped",
      skipReason: "order_currency_not_supported",
    };
  }

  // Handle CANCELLED topic - updates existing invoices only
  if (topic === "ORDERS_CANCELLED") {
    return await cancelInvoice(sql, shopId, order.id, webhookId);
  }

  // Handle PAID topic - updates existing invoices only
  if (topic === "ORDERS_PAID") {
    return await markInvoicePaid(sql, shopId, order.id, webhookId);
  }

  // Check if Invoice already exists for this order
  // If it exists, ALWAYS update it regardless of eligibility (for status changes,
  // tag/terms changes, etc.) - eligibility only gates CREATION
  const [existingInvoice] = await sql<{
    id: string;
    buyerAccountId: string;
    outstanding: string;
    status: "open" | "paid" | "cancelled";
  }[]>`
    SELECT id, "buyerAccountId", outstanding::text, status::"InvoiceStatus"
    FROM "Invoice"
    WHERE "shopId" = ${shopId} AND "orderId" = ${order.id}
  `;

  if (existingInvoice) {
    // Invoice exists - update it with latest order data
    // Pass existing outstanding AND status for fallback when totalOutstandingSet is missing
    const eligibility = await checkOrderEligibility(sql, order, context);
    const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
      shopId,
      eligibility.buyerAccountId ?? existingInvoice.buyerAccountId,
      order,
      eligibility,
      { outstanding: existingInvoice.outstanding, status: existingInvoice.status }
    );
    const result = await upsertInvoice(sql, invoiceData);

    if (outstandingMissing) {
      try {
        await incrementOrderOutstandingMissing(sql, shopDomain);
      } catch (err) {
        safeLog("warn", "order_outstanding_missing_counter_failed", { shopId, err: toErrorCode(err) });
      }
    }

    if (result.entityId) {
      try {
        await enqueueRecomputeForInvoice(sql, result.entityId);
      } catch (err) {
        captureExceptionWithTags(err, { shopId });
      }
    }

    await markWebhookProcessed(sql, webhookId, topic, order.id, shopDomain);
    return result;
  }

  // No existing Invoice - check eligibility for CREATION
  const eligibility = await checkOrderEligibility(sql, order, context);

  if (!eligibility.eligible) {
    if (eligibility.retryable) {
      return {
        success: false,
        action: "skipped",
        error: eligibility.explanation,
        errorCode: eligibility.reason,
        retryable: true,
      };
    }

    await markWebhookProcessed(sql, webhookId, topic, order.id, shopDomain);
    return {
      success: true,
      action: "skipped",
      skipReason: eligibility.explanation,
    };
  }

  // Eligible - create Invoice
  const { invoiceData, outstandingMissing } = mapOrderToInvoiceWithEligibility(
    shopId,
    eligibility.buyerAccountId!,
    order,
    eligibility
  );
  const result = await upsertInvoice(sql, invoiceData);

  if (outstandingMissing) {
    try {
      await incrementOrderOutstandingMissing(sql, shopDomain);
    } catch (err) {
      safeLog("warn", "order_outstanding_missing_counter_failed", { shopId, err: toErrorCode(err) });
    }
  }

  if (result.entityId) {
    try {
      await enqueueRecomputeForInvoice(sql, result.entityId);
    } catch (err) {
      captureExceptionWithTags(err, { shopId });
    }
  }

  await markWebhookProcessed(sql, webhookId, topic, order.id, shopDomain);

  return result;
}

/**
 * Invoice data structure for upsert operations.
 */
export interface InvoiceData {
  shopId: string;
  buyerAccountId: string;
  orderId: string;
  name: string;
  total: string;
  outstanding: string;
  issuedAt: Date;
  dueAt: Date | null;
  dueSource: "schedule" | "override" | "inferred" | "none";
  dueBasis: string | null;
  dueReason: string | null;
  status: "open" | "paid" | "cancelled";
}

/** Diagnostic counter for missing totalOutstandingSet field */
let orderOutstandingMissingCounter = 0;

/** Get and reset the counter (for testing) */
export function getAndResetOutstandingMissingCounter(): number {
  const count = orderOutstandingMissingCounter;
  orderOutstandingMissingCounter = 0;
  return count;
}

/** Result of mapping order to invoice data */
export interface MapOrderResult {
  invoiceData: InvoiceData;
  outstandingMissing: boolean;
}

/** Existing invoice data for updates */
interface ExistingInvoiceData {
  outstanding: string;
  status: "open" | "paid" | "cancelled";
}

/**
 * Map Order to Invoice data using eligibility result.
 * Uses S9 due date inference from the eligibility check.
 *
 * Outstanding amount logic:
 * - Uses totalOutstandingSet.shopMoney.amount from Shopify
 * - For non-terminal statuses (PENDING, AUTHORIZED, PARTIALLY_PAID, PARTIALLY_REFUNDED):
 *   - If outstanding is 0, status becomes "paid"
 *   - If outstanding > 0, status is "open"
 * - REFUNDED/VOIDED: status "cancelled", outstanding 0
 * - cancelledAt set: status "cancelled", outstanding 0
 * - If totalOutstandingSet is missing:
 *   - New invoice: uses total, status "open"
 *   - Existing invoice: keeps BOTH existing outstanding AND existing status
 *
 * @param existingInvoice - Pass existing invoice outstanding and status when updating
 * @returns Object with invoiceData and outstandingMissing flag
 */
export function mapOrderToInvoiceWithEligibility(
  shopId: string,
  buyerAccountId: string,
  order: ShopifyOrder,
  eligibility: EligibilityResult,
  existingInvoice?: ExistingInvoiceData
): MapOrderResult {
  const total = order.totalPriceSet?.shopMoney.amount ?? "0.00";
  const issuedAt = new Date(order.processedAt ?? order.createdAt);

  // Use due date from S9 inference (eligibility result)
  const dueDate = eligibility.dueDate;

  // Determine status and outstanding
  let status: "open" | "paid" | "cancelled" = "open";
  let outstanding: string;
  let outstandingMissing = false;

  // P3: cancelledAt takes precedence - cancelled with outstanding 0
  if (order.cancelledAt) {
    status = "cancelled";
    outstanding = "0.00";
  } else {
    switch (order.displayFinancialStatus) {
      case "REFUNDED":
      case "VOIDED":
        // Terminal: cancelled with outstanding 0
        status = "cancelled";
        outstanding = "0.00";
        break;

      case "PAID":
        // Explicit PAID status
        status = "paid";
        outstanding = "0.00";
        break;

      case "PENDING":
      case "AUTHORIZED":
      case "PARTIALLY_PAID":
      case "PARTIALLY_REFUNDED":
      default: {
        // Use totalOutstandingSet from Shopify
        const shopifyOutstanding = order.totalOutstandingSet?.shopMoney.amount;

        if (shopifyOutstanding !== undefined) {
          outstanding = shopifyOutstanding;
          // When outstanding is 0, order is effectively paid
          // (handles paid-then-partially-refunded case)
          if (parseFloat(outstanding) === 0) {
            status = "paid";
          } else {
            status = "open";
          }
        } else {
          outstandingMissing = true;
          orderOutstandingMissingCounter++;
          safeLog("warn", "order_total_outstanding_missing", {
            orderGid: order.id,
            status: order.displayFinancialStatus,
            usedFallback: existingInvoice !== undefined,
          });
          if (existingInvoice !== undefined) {
            outstanding = existingInvoice.outstanding;
            status = existingInvoice.status;
          } else {
            outstanding = total;
            status = "open";
          }
        }
        break;
      }
    }
  }

  return {
    invoiceData: {
      shopId,
      buyerAccountId,
      orderId: order.id,
      name: order.name,
      total,
      outstanding,
      issuedAt,
      dueAt: dueDate?.dueAt ?? null,
      dueSource: dueDate?.dueSource ?? "none",
      dueBasis: dueDate?.basis ?? null,
      dueReason: dueDate?.reason ?? null,
      status,
    },
    outstandingMissing,
  };
}

/**
 * Map Order to Invoice data (legacy, for orders with Shopify paymentTerms).
 * @deprecated Use mapOrderToInvoiceWithEligibility instead
 */
export function mapOrderToInvoice(
  shopId: string,
  buyerAccountId: string,
  order: ShopifyOrder
): InvoiceData {
  const total = order.totalPriceSet?.shopMoney.amount ?? "0.00";
  const issuedAt = new Date(order.processedAt ?? order.createdAt);

  let dueAt: Date | null = null;
  let dueSource: "schedule" | "override" | "inferred" | "none" = "none";
  let dueBasis: string | null = null;
  let dueReason: string | null = null;

  if (order.paymentTerms?.paymentSchedules?.edges?.length) {
    const schedule = order.paymentTerms.paymentSchedules.edges[0].node;
    if (schedule.dueAt) {
      dueAt = new Date(schedule.dueAt);
      dueSource = "schedule";
      dueBasis = null;
      dueReason = `Payment schedule: ${order.paymentTerms.paymentTermsName}`;
    }
  } else if (order.paymentTerms?.dueInDays != null) {
    dueAt = new Date(issuedAt);
    dueAt.setDate(dueAt.getDate() + order.paymentTerms.dueInDays);
    dueSource = "schedule";
    dueBasis = "paymentTermsDueInDays";
    dueReason = `${order.paymentTerms.paymentTermsName}: Net ${order.paymentTerms.dueInDays} days`;
  }

  // Determine status and outstanding
  let status: "open" | "paid" | "cancelled" = "open";
  let outstanding: string;

  // P3: cancelledAt takes precedence
  if (order.cancelledAt) {
    status = "cancelled";
    outstanding = "0.00";
  } else {
    switch (order.displayFinancialStatus) {
      case "REFUNDED":
      case "VOIDED":
        status = "cancelled";
        outstanding = "0.00";
        break;
      case "PAID":
        status = "paid";
        outstanding = "0.00";
        break;
      case "PENDING":
      case "AUTHORIZED":
      case "PARTIALLY_PAID":
      case "PARTIALLY_REFUNDED":
      default: {
        const shopifyOutstanding = order.totalOutstandingSet?.shopMoney.amount;
        if (shopifyOutstanding !== undefined) {
          outstanding = shopifyOutstanding;
          status = parseFloat(outstanding) === 0 ? "paid" : "open";
        } else {
          orderOutstandingMissingCounter++;
          safeLog("warn", "order_total_outstanding_missing", {
            orderGid: order.id,
            status: order.displayFinancialStatus,
            usedFallback: false,
          });
          outstanding = total;
          status = "open";
        }
        break;
      }
    }
  }

  return {
    shopId,
    buyerAccountId,
    orderId: order.id,
    name: order.name,
    total,
    outstanding,
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
 * 
 * S20: No ordering guard needed. The drain re-fetches from Shopify Admin API,
 * so the data is always the latest Shopify state. Terminal states (paid/cancelled)
 * are protected in the upsert's DO UPDATE clause.
 */
async function upsertInvoice(
  sql: Sql,
  data: InvoiceData
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
      -- issuedAt: only update for non-terminal invoices, never from null
      "issuedAt" = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."issuedAt"
        WHEN EXCLUDED."issuedAt" IS NULL THEN "Invoice"."issuedAt"
        ELSE EXCLUDED."issuedAt"
      END,
      -- dueAt: only update for non-terminal invoices, never from null
      "dueAt" = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueAt"
        WHEN EXCLUDED."dueAt" IS NULL THEN "Invoice"."dueAt"
        ELSE EXCLUDED."dueAt"
      END,
      "dueSource" = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueSource"
        WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueSource"
        ELSE "Invoice"."dueSource"
      END,
      "dueBasis" = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueBasis"
        WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueBasis"
        ELSE "Invoice"."dueBasis"
      END,
      "dueReason" = CASE
        WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueReason"
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

  try {
    await enqueueRecomputeForInvoice(sql, result.id);
  } catch (err) {
    captureExceptionWithTags(err, { shopId });
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

  try {
    await enqueueRecomputeForInvoice(sql, result.id);
  } catch (err) {
    captureExceptionWithTags(err, { shopId });
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
  invoices: InvoiceData[]
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
        -- issuedAt: only update for non-terminal invoices, never from null
        "issuedAt" = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."issuedAt"
          WHEN EXCLUDED."issuedAt" IS NULL THEN "Invoice"."issuedAt"
          ELSE EXCLUDED."issuedAt"
        END,
        -- dueAt: only update for non-terminal invoices, never from null
        "dueAt" = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueAt"
          WHEN EXCLUDED."dueAt" IS NULL THEN "Invoice"."dueAt"
          ELSE EXCLUDED."dueAt"
        END,
        "dueSource" = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueSource"
          WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueSource"
          ELSE "Invoice"."dueSource"
        END,
        "dueBasis" = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueBasis"
          WHEN EXCLUDED."dueAt" IS NOT NULL THEN EXCLUDED."dueBasis"
          ELSE "Invoice"."dueBasis"
        END,
        "dueReason" = CASE
          WHEN "Invoice".status IN ('paid', 'cancelled') THEN "Invoice"."dueReason"
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
