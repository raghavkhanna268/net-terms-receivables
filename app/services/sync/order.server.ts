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
  isTerminalFinancialStatus,
  type EligibilityContext,
  type EligibilityResult,
} from "~/lib/invoice-eligibility";

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
      error: `Shop not found: ${shopDomain}`,
    };
  }

  const { shopId, context } = contextResult;

  // Handle CANCELLED topic - updates existing invoices only
  if (topic === "ORDERS_CANCELLED") {
    return await cancelInvoice(sql, shopId, order.id, webhookId);
  }

  // Handle PAID topic - updates existing invoices only
  if (topic === "ORDERS_PAID") {
    return await markInvoicePaid(sql, shopId, order.id, webhookId);
  }

  // Check eligibility for Invoice creation
  const eligibility = await checkOrderEligibility(sql, order, context);

  if (!eligibility.eligible) {
    await markWebhookProcessed(sql, webhookId, topic, order.id, shopDomain);
    return {
      success: true,
      action: "skipped",
      skipReason: eligibility.explanation,
    };
  }

  // Eligible - create/update Invoice
  const invoiceData = mapOrderToInvoiceWithEligibility(
    shopId,
    eligibility.buyerAccountId!,
    order,
    eligibility
  );
  const result = await upsertInvoice(sql, invoiceData);

  await markWebhookProcessed(sql, webhookId, topic, order.id, shopDomain);

  return result;
}

/**
 * Process an order with pre-fetched eligibility context.
 * Used by bulk processing where context is fetched once for all orders.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Internal shop ID
 * @param order - Order data
 * @param context - Pre-fetched eligibility context
 */
export async function processOrderWithContext(
  sql: Sql,
  shopId: string,
  order: ShopifyOrder,
  context: EligibilityContext
): Promise<SyncResult> {
  // Handle terminal statuses (PAID, REFUNDED, etc.) - update existing invoice
  if (isTerminalFinancialStatus(order.displayFinancialStatus)) {
    if (order.displayFinancialStatus === "PAID") {
      // Try to mark existing invoice as paid
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM "Invoice" WHERE "orderId" = ${order.id}
      `;
      if (existing) {
        await sql`
          UPDATE "Invoice"
          SET status = 'paid', outstanding = '0.00', "updatedAt" = NOW()
          WHERE id = ${existing.id}
        `;
        return { success: true, action: "updated", entityId: existing.id };
      }
    }
    return {
      success: true,
      action: "skipped",
      skipReason: `Order has terminal status '${order.displayFinancialStatus}'`,
    };
  }

  // Check eligibility
  const eligibility = await checkOrderEligibility(sql, order, context);

  if (!eligibility.eligible) {
    return {
      success: true,
      action: "skipped",
      skipReason: eligibility.explanation,
    };
  }

  // Create/update Invoice
  const invoiceData = mapOrderToInvoiceWithEligibility(
    shopId,
    eligibility.buyerAccountId!,
    order,
    eligibility
  );

  return await upsertInvoice(sql, invoiceData);
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

/**
 * Map Order to Invoice data using eligibility result.
 * Uses S9 due date inference from the eligibility check.
 */
export function mapOrderToInvoiceWithEligibility(
  shopId: string,
  buyerAccountId: string,
  order: ShopifyOrder,
  eligibility: EligibilityResult
): InvoiceData {
  const total = order.totalPriceSet?.shopMoney.amount ?? "0.00";
  const issuedAt = new Date(order.processedAt ?? order.createdAt);

  // Use due date from S9 inference (eligibility result)
  const dueDate = eligibility.dueDate;

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
    dueAt: dueDate?.dueAt ?? null,
    dueSource: dueDate?.dueSource ?? "none",
    dueBasis: dueDate?.basis ?? null,
    dueReason: dueDate?.reason ?? null,
    status,
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
