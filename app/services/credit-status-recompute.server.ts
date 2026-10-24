/**
 * Credit Status Recompute Service.
 *
 * Handles both event-driven and time-driven credit status recomputation.
 *
 * Event-driven triggers:
 * - Invoice created (order webhook)
 * - Invoice paid (payment match or ORDERS_PAID webhook)
 * - Invoice cancelled/voided
 * - Outstanding amount changed
 *
 * Time-driven triggers:
 * - Daily pg_cron job enqueues CREDIT_STATUS_RECOMPUTE messages for accounts
 *   with invoices that crossed the overdue threshold (dueAt < NOW() - 1 day)
 *
 * Design:
 * - ONE code path: both event-driven and cron-driven use recomputeCreditStatus()
 * - Idempotent: only writes metafield when hold value actually changes
 * - No new scopes: uses existing metafieldsSet on CompanyLocation/Customer
 * - Worker-friendly: designed for 10ms CPU budget
 */

import type { Sql } from "~/lib/db-light.server";
import { hasOverdueInvoices } from "./overdue.server";
import {
  computeHoldState,
  type ComputeHoldStateInput,
  type HoldReasonCode,
} from "./credit-status.server";
import {
  serializeCreditStatusFromDb,
  METAFIELD,
} from "~/lib/metafields-contract";
import { shopifyGraphQLRequest } from "./shopify-client.server";

/**
 * Result of a credit status recompute.
 */
export interface RecomputeResult {
  success: boolean;
  /** Whether the hold value changed and metafield was written */
  metafieldWritten: boolean;
  /** Previous hold value (before recompute) */
  previousHold: boolean;
  /** New hold value (after recompute) */
  newHold: boolean;
  /** Error message if failed */
  error?: string;
  /** Whether the error is retryable */
  retryable?: boolean;
}

/**
 * Buyer account data needed for recompute.
 */
interface BuyerAccountForRecompute {
  id: string;
  shopId: string;
  kind: "COMPANY" | "TAGGED_CUSTOMER";
  companyLocationId: string | null;
  customerId: string | null;
  creditLimit: string | null;
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  bypass: boolean;
  manualHold: boolean;
  holdReasonCode: string | null;
  gatedAt: Date | null;
}

/**
 * Shop data needed for recompute.
 */
interface ShopForRecompute {
  domain: string;
  currency: string;
}

/**
 * metafieldsSet mutation response shape.
 */
interface MetafieldsSetResponse {
  metafieldsSet: {
    metafields: Array<{
      id: string;
      namespace: string;
      key: string;
    }> | null;
    userErrors: Array<{
      field: string[];
      message: string;
    }>;
  };
}

/**
 * Static GraphQL mutation for metafieldsSet.
 */
const METAFIELDS_SET_MUTATION = `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Compute exposure for a buyer account.
 */
async function computeExposure(
  sql: Sql,
  buyerAccountId: string,
): Promise<bigint> {
  const [invoiceResult] = await sql<{ total_paise: string | null }[]>`
    SELECT COALESCE(SUM((ROUND(outstanding * 100))::bigint), 0)::text AS total_paise
    FROM "Invoice"
    WHERE "buyerAccountId" = ${buyerAccountId}
      AND status = 'open'
      AND outstanding > 0
  `;

  const [draftResult] = await sql<{ total_paise: string | null }[]>`
    SELECT COALESCE(SUM((ROUND(total * 100))::bigint), 0)::text AS total_paise
    FROM "s8_draft_orders"
    WHERE buyer_account_id = ${buyerAccountId}
      AND has_payment_terms = true
      AND status IN ('open', 'invoice_sent')
  `;

  const invoicePaise = BigInt(invoiceResult?.total_paise ?? "0");
  const draftPaise = BigInt(draftResult?.total_paise ?? "0");

  return invoicePaise + draftPaise;
}

/**
 * Get the Shopify GID for the metafield owner.
 */
function getOwnerGid(account: BuyerAccountForRecompute): { gid: string; type: string } | null {
  if (account.kind === "COMPANY" && account.companyLocationId) {
    return { gid: account.companyLocationId, type: "CompanyLocation" };
  }
  if (account.kind === "TAGGED_CUSTOMER" && account.customerId) {
    return { gid: account.customerId, type: "Customer" };
  }
  return null;
}

/**
 * Recompute credit status for a buyer account.
 *
 * This is the ONE code path used by both:
 * - Event-driven recompute (after invoice changes)
 * - Time-driven recompute (daily cron via drain handler)
 *
 * Idempotent behavior:
 * - Only writes metafield when the hold value actually changes
 * - Safe to call multiple times for the same account
 *
 * @param sql - Database connection
 * @param buyerAccountId - Buyer account ID to recompute
 * @returns Result indicating success and whether metafield was written
 */
export async function recomputeCreditStatus(
  sql: Sql,
  buyerAccountId: string,
): Promise<RecomputeResult> {
  // Fetch account data
  const [account] = await sql<BuyerAccountForRecompute[]>`
    SELECT
      id,
      "shopId" AS "shopId",
      kind,
      "companyLocationId",
      "customerId",
      "creditLimit"::text AS "creditLimit",
      "holdState",
      bypass,
      "manualHold",
      "holdReasonCode",
      gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold: false,
      newHold: false,
      error: "Buyer account not found",
      retryable: false,
    };
  }

  // Skip gated accounts
  if (account.gatedAt !== null) {
    return {
      success: true,
      metafieldWritten: false,
      previousHold: false,
      newHold: false,
    };
  }

  // Get owner GID for metafield
  const owner = getOwnerGid(account);
  if (!owner) {
    return {
      success: true,
      metafieldWritten: false,
      previousHold: false,
      newHold: false,
    };
  }

  // Fetch shop data
  const [shop] = await sql<ShopForRecompute[]>`
    SELECT domain, currency FROM "Shop" WHERE id = ${account.shopId}
  `;

  if (!shop) {
    return {
      success: false,
      metafieldWritten: false,
      previousHold: false,
      newHold: false,
      error: "Shop not found",
      retryable: false,
    };
  }

  // Compute current state
  const exposurePaise = await computeExposure(sql, buyerAccountId);
  const isOverdue = await hasOverdueInvoices(sql, buyerAccountId);

  const creditLimitPaise = account.creditLimit
    ? BigInt(Math.round(parseFloat(account.creditLimit) * 100))
    : null;

  const isOverLimit = creditLimitPaise !== null && exposurePaise > creditLimitPaise;

  const holdStateInput: ComputeHoldStateInput = {
    bypass: account.bypass,
    manualHold: account.manualHold,
    isOverLimit,
    isOverdue,
    exposurePaise,
    limitPaise: creditLimitPaise,
  };

  const holdResult = computeHoldState(
    holdStateInput,
    account.holdReasonCode as HoldReasonCode,
  );

  // Determine previous hold value from holdState
  const previousHold = account.holdState === "HELD" && !account.bypass;
  const newHold = holdResult.metafieldHold;

  // Only write metafield if hold value changed
  if (previousHold === newHold) {
    // Still update holdState in DB if it changed (e.g., OK -> NEAR_LIMIT)
    if (account.holdState !== holdResult.holdState) {
      await sql`
        UPDATE "BuyerAccount"
        SET
          "holdState" = ${holdResult.holdState}::"HoldState",
          "holdReasonCode" = ${holdResult.holdReasonCode},
          "updatedAt" = NOW()
        WHERE id = ${buyerAccountId}
      `;
    }

    return {
      success: true,
      metafieldWritten: false,
      previousHold,
      newHold,
    };
  }

  // Update DB with new holdState
  await sql`
    UPDATE "BuyerAccount"
    SET
      "holdState" = ${holdResult.holdState}::"HoldState",
      "holdReasonCode" = ${holdResult.holdReasonCode},
      "syncPending" = true,
      "syncVersion" = "syncVersion" + 1,
      "updatedAt" = NOW()
    WHERE id = ${buyerAccountId}
  `;

  // Write metafield
  const metafieldValue = serializeCreditStatusFromDb({
    currencyCode: shop.currency,
    hold: holdResult.metafieldHold,
    holdReasonCode: holdResult.holdReasonCode,
    limitPaise: creditLimitPaise,
    exposurePaise,
  });

  const metafieldResult = await shopifyGraphQLRequest<MetafieldsSetResponse>(
    shop.domain,
    METAFIELDS_SET_MUTATION,
    {
      metafields: [
        {
          ownerId: owner.gid,
          namespace: METAFIELD.namespace,
          key: METAFIELD.key,
          type: METAFIELD.type,
          value: metafieldValue,
        },
      ],
    },
  );

  if (!metafieldResult.success) {
    console.error(
      `[credit-status-recompute] Metafield write failed for ${buyerAccountId}: ${metafieldResult.error}`,
    );
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold,
      error: `Metafield write failed: ${metafieldResult.error}`,
      retryable: true,
    };
  }

  const userErrors = metafieldResult.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error(
      `[credit-status-recompute] Metafield userErrors for ${buyerAccountId}: ${JSON.stringify(userErrors)}`,
    );
    return {
      success: false,
      metafieldWritten: false,
      previousHold,
      newHold,
      error: `Metafield userErrors: ${userErrors.map((e) => e.message).join("; ")}`,
      retryable: true,
    };
  }

  // Clear syncPending on success
  await sql`
    UPDATE "BuyerAccount"
    SET "syncPending" = false
    WHERE id = ${buyerAccountId}
  `;

  console.log(
    `[credit-status-recompute] Updated ${buyerAccountId}: hold ${previousHold} -> ${newHold}`,
  );

  return {
    success: true,
    metafieldWritten: true,
    previousHold,
    newHold,
  };
}

/**
 * Enqueue a credit status recompute for a buyer account.
 *
 * Uses a deterministic dedupe key per account per day to prevent duplicate
 * messages from the daily cron job.
 *
 * @param sql - Database connection
 * @param shopDomain - Shop domain (e.g., "store.myshopify.com")
 * @param buyerAccountId - Buyer account ID to recompute
 * @param source - Source of the recompute (for audit)
 */
export async function enqueueCreditStatusRecompute(
  sql: Sql,
  shopDomain: string,
  buyerAccountId: string,
  source: "invoice_change" | "daily_sweep" | "manual",
): Promise<void> {
  // Deterministic dedupe key: account ID + date (for daily sweep deduplication)
  // For event-driven, use a unique key per event
  const today = new Date().toISOString().split("T")[0];
  const dedupeKey =
    source === "daily_sweep"
      ? `credit_recompute:${buyerAccountId}:${today}`
      : `credit_recompute:${buyerAccountId}:${Date.now()}`;

  const message = {
    topic: "CREDIT_STATUS_RECOMPUTE",
    shop: shopDomain,
    buyerAccountId,
    source,
    webhookId: dedupeKey,
    resourceGid: buyerAccountId,
  };

  await sql`
    SELECT pgmq.send('s6_sync', ${sql.json(message)})
  `;
}

/**
 * Enqueue credit status recompute for a buyer account after an invoice change.
 *
 * This is the event-driven entry point called after:
 * - Invoice created
 * - Invoice paid
 * - Invoice cancelled/voided
 * - Outstanding amount changed
 *
 * @param sql - Database connection
 * @param invoiceId - Invoice ID that changed
 */
export async function enqueueRecomputeForInvoice(
  sql: Sql,
  invoiceId: string,
): Promise<void> {
  // Look up the invoice to get shop domain and buyer account
  const [invoice] = await sql<{
    buyerAccountId: string | null;
    shopDomain: string;
  }[]>`
    SELECT i."buyerAccountId", s.domain AS "shopDomain"
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i.id = ${invoiceId}
  `;

  if (!invoice?.buyerAccountId) {
    return;
  }

  await enqueueCreditStatusRecompute(
    sql,
    invoice.shopDomain,
    invoice.buyerAccountId,
    "invoice_change",
  );
}
