/**
 * Fulfillment Hold Backstop Service (S13)
 *
 * When an order is created from a held account, this service:
 * 1. Places fulfillment holds on all open MERCHANT-MANAGED fulfillment orders
 * 2. Tags the order with `ntr-credit-hold`
 * 3. Records an audit event for admin visibility
 *
 * This acts as a backstop to the checkout payment customization function.
 * If the payment customization fails to hide payment methods (e.g., timing issue,
 * missing metafield during checkout), this catches orders that shouldn't have
 * gone through and prevents fulfillment.
 *
 * IMPORTANT DESIGN DECISIONS:
 *
 * 1. PRE-ORDER HOLD STATE: The backstop judges whether the account was held
 *    BEFORE this order was placed. Controlled by USE_PRE_ORDER_HOLD_STATE.
 *
 *    - Manual holds (manualHold=true): Always held, regardless of this order.
 *    - PAYMENT_OVERDUE holds: Always held (overdue invoices exist independently).
 *    - CREDIT_REVIEW auto-holds (over limit): Only held if account was ALREADY
 *      over the limit BEFORE this order's invoice. An order that itself pushes
 *      the buyer over the limit is NOT held - it makes the account held for
 *      future orders.
 *
 * 2. MERCHANT-MANAGED ONLY: Our scope (write_merchant_managed_fulfillment_orders)
 *    only allows holding merchant-managed fulfillment orders. Third-party/app FOs
 *    are skipped with an audit note, not errored.
 *
 * 3. RETRYABLE FAILURES: 0 open FOs (may not exist yet), API failures, and partial
 *    successes throw RetryableBackstopError so pgmq redelivers with backoff.
 *
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderHold
 * @see https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/tagsAdd
 */

import type { Sql } from "~/lib/db-light.server";
import { shopifyGraphQLRequest } from "./shopify-client.server";

/**
 * Tag added to orders from held accounts.
 */
export const CREDIT_HOLD_TAG = "ntr-credit-hold";

/**
 * Handle for app-specific fulfillment holds.
 * Each app can have up to 10 holds per fulfillment order.
 */
const HOLD_HANDLE = "ntr-credit-hold";

/**
 * USE_PRE_ORDER_HOLD_STATE controls whether the backstop uses the hold state
 * from BEFORE this order was placed.
 *
 * When true (default):
 * - Manual holds and PAYMENT_OVERDUE: always held (not affected by this order)
 * - Over-limit (CREDIT_REVIEW): only held if ALREADY over limit before this order
 *
 * When false: Any order from a currently-held account is held.
 *
 * This is a named constant so the decision is easy to find and change.
 */
export const USE_PRE_ORDER_HOLD_STATE = true;

/**
 * Timeout for stale pending claims in seconds.
 * A pending claim older than this is considered stale (worker likely died)
 * and can be reclaimed by another worker.
 *
 * Set to 5 minutes - long enough for normal processing including retries,
 * but short enough to recover from crashed workers reasonably quickly.
 */
export const STALE_CLAIM_TIMEOUT_SECONDS = 300;

/**
 * Error thrown when backstop should be retried (e.g., 0 FOs, partial failure).
 */
export class RetryableBackstopError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "RetryableBackstopError";
  }
}

/**
 * Input for the backstop check.
 */
export interface BackstopInput {
  shopDomain: string;
  shopId: string;
  orderGid: string;
  buyerAccountId: string | null;
  /** Invoice ID for this order, used for pre-order hold state calculation */
  invoiceId?: string | null;
}

/**
 * Result of the backstop check.
 */
export interface BackstopResult {
  applied: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  fulfillmentOrdersHeld?: number;
  nonMerchantManagedSkipped?: number;
  tagged?: boolean;
  alertRecorded?: boolean;
}

interface FulfillmentOrdersQueryResult {
  order: {
    fulfillmentOrders: {
      edges: Array<{
        node: {
          id: string;
          status: string;
          assignedLocation: {
            location: {
              id: string;
            } | null;
          } | null;
          supportedActions: Array<{
            action: string;
          }>;
        };
      }>;
    };
  } | null;
}

interface FulfillmentOrderHoldResult {
  fulfillmentOrderHold: {
    fulfillmentOrder: {
      id: string;
      status: string;
    } | null;
    userErrors: Array<{
      field: string[];
      message: string;
      code?: string;
    }>;
  };
}

interface TagsAddResult {
  tagsAdd: {
    node: {
      id: string;
    } | null;
    userErrors: Array<{
      field: string[];
      message: string;
    }>;
  };
}

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query GetFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            status
            assignedLocation {
              location {
                id
              }
            }
            supportedActions {
              action
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_ORDER_HOLD_MUTATION = `#graphql
  mutation FulfillmentOrderHold($id: ID!, $reason: FulfillmentHoldReason!, $reasonNotes: String, $handle: String) {
    fulfillmentOrderHold(
      id: $id,
      fulfillmentHold: {
        reason: $reason,
        reasonNotes: $reasonNotes,
        handle: $handle
      }
    ) {
      fulfillmentOrder {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `#graphql
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Claim processing for this order atomically.
 * Uses INSERT...ON CONFLICT DO NOTHING RETURNING to atomically claim.
 *
 * Stale claim recovery: If a pending claim is older than STALE_CLAIM_TIMEOUT_SECONDS,
 * it's considered stale (worker likely died) and can be atomically reclaimed.
 *
 * Returns:
 * - { claimed: true } if we claimed it (new row or reclaimed stale)
 * - { claimed: false, existingAction: 'held'|'skipped' } if already completed
 * - { claimed: false, existingAction: 'pending', staleClaim: false } if fresh pending (should retry)
 */
async function claimBackstopProcessing(
  sql: Sql,
  shopId: string,
  orderGid: string,
): Promise<{ claimed: boolean; existingAction?: string; staleClaim?: boolean }> {
  // Try to insert with status='pending'. RETURNING gives us the row if inserted.
  const [inserted] = await sql<{ action: string }[]>`
    INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
    VALUES (${shopId}, ${orderGid}, 'pending', NULL, NOW())
    ON CONFLICT (shop_id, order_gid) DO NOTHING
    RETURNING action
  `;

  if (inserted) {
    // We inserted the row, we have the claim
    return { claimed: true };
  }

  // Row already exists - try to reclaim if it's a stale pending claim
  // Using make_interval for parameterized seconds since INTERVAL literals don't support parameters
  const [reclaimed] = await sql<{ action: string }[]>`
    UPDATE backstop_processed_orders
    SET processed_at = NOW()
    WHERE shop_id = ${shopId}
      AND order_gid = ${orderGid}
      AND action = 'pending'
      AND processed_at < NOW() - make_interval(secs => ${STALE_CLAIM_TIMEOUT_SECONDS})
    RETURNING action
  `;

  if (reclaimed) {
    // Successfully reclaimed a stale pending row
    return { claimed: true };
  }

  // Check what state the existing row is in
  const [existing] = await sql<{ action: string; processed_at: Date }[]>`
    SELECT action, processed_at FROM backstop_processed_orders
    WHERE shop_id = ${shopId} AND order_gid = ${orderGid}
  `;

  if (!existing) {
    // Rare race condition: row was deleted between our insert and select
    // Caller should retry
    return { claimed: false, existingAction: undefined };
  }

  if (existing.action === "pending") {
    // Fresh pending claim from another worker - caller should return retryable
    return { claimed: false, existingAction: "pending", staleClaim: false };
  }

  // Already completed (held or skipped)
  return { claimed: false, existingAction: existing.action };
}

/**
 * Mark backstop as completed (held or skipped).
 */
async function markBackstopCompleted(
  sql: Sql,
  shopId: string,
  orderGid: string,
  action: "held" | "skipped",
  reason: string | null,
): Promise<void> {
  await sql`
    UPDATE backstop_processed_orders
    SET action = ${action}, reason = ${reason}, processed_at = NOW()
    WHERE shop_id = ${shopId} AND order_gid = ${orderGid}
  `;
}

/**
 * Clear pending claim on failure (allows retry).
 */
async function clearBackstopClaim(
  sql: Sql,
  shopId: string,
  orderGid: string,
): Promise<void> {
  await sql`
    DELETE FROM backstop_processed_orders
    WHERE shop_id = ${shopId} AND order_gid = ${orderGid} AND action = 'pending'
  `;
}

/**
 * Record an audit event for the backstop action.
 */
async function recordBackstopAlert(
  sql: Sql,
  shopId: string,
  orderGid: string,
  buyerAccountId: string,
  fulfillmentOrdersHeld: number,
  nonMerchantManagedSkipped: number,
): Promise<void> {
  await sql`
    INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
    VALUES (
      ${shopId},
      'system',
      'backstop.hold_applied',
      ${sql.json({
        orderGid,
        buyerAccountId,
        fulfillmentOrdersHeld,
        nonMerchantManagedSkipped,
        tag: CREDIT_HOLD_TAG,
        reason: "Order placed from held account - backstop applied",
      })},
      NOW()
    )
  `;
}

/**
 * Record a failed backstop attempt for alerting (after max retries / DLQ).
 */
export async function recordBackstopFailure(
  sql: Sql,
  shopId: string,
  orderGid: string,
  buyerAccountId: string | null,
  error: string,
): Promise<void> {
  await sql`
    INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
    VALUES (
      ${shopId},
      'system',
      'backstop.failed',
      ${sql.json({
        orderGid,
        buyerAccountId,
        error,
        reason: "Backstop failed after all retries - manual intervention required",
      })},
      NOW()
    )
  `;
}

/**
 * Record that non-merchant-managed FOs were skipped.
 */
async function recordNonMerchantManagedSkipped(
  sql: Sql,
  shopId: string,
  orderGid: string,
  skippedFoIds: string[],
): Promise<void> {
  if (skippedFoIds.length === 0) return;

  await sql`
    INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
    VALUES (
      ${shopId},
      'system',
      'backstop.non_merchant_managed_skipped',
      ${sql.json({
        orderGid,
        skippedFulfillmentOrderIds: skippedFoIds,
        reason: "Skipped non-merchant-managed fulfillment orders (outside our scope)",
      })},
      NOW()
    )
  `;
}

/**
 * Compute exposure excluding a specific invoice (for pre-order hold state).
 * Uses the same logic as S11's computeExposure but excludes one invoice.
 *
 * @param sql Database connection
 * @param buyerAccountId Buyer account ID
 * @param excludeInvoiceId Invoice to exclude from exposure calculation
 * @returns Exposure in paise (smallest currency unit)
 */
async function computeExposureExcludingInvoice(
  sql: Sql,
  buyerAccountId: string,
  excludeInvoiceId: string,
): Promise<bigint> {
  // Sum outstanding amounts from open invoices, excluding the specified invoice
  // Uses ROUND(outstanding * 100) to convert rupees to paise, same as S11
  const [invoiceResult] = await sql<{ total_paise: string | null }[]>`
    SELECT COALESCE(SUM((ROUND(outstanding * 100))::bigint), 0)::text AS total_paise
    FROM "Invoice"
    WHERE "buyerAccountId" = ${buyerAccountId}
      AND id != ${excludeInvoiceId}
      AND status = 'open'
      AND outstanding > 0
  `;

  // Also include draft orders with payment terms (same as S11)
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
 * Check if there are overdue invoices for this buyer.
 * Same logic as S11's hasOverdueInvoices.
 */
async function hasOverdueInvoices(
  sql: Sql,
  buyerAccountId: string,
): Promise<boolean> {
  const [result] = await sql<{ has_overdue: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "Invoice"
      WHERE "buyerAccountId" = ${buyerAccountId}
        AND status = 'open'
        AND outstanding > 0
        AND "dueAt" IS NOT NULL
        AND "dueAt" < NOW() - INTERVAL '1 day'
    ) AS has_overdue
  `;
  return result?.has_overdue ?? false;
}

/**
 * Check if the buyer account was held BEFORE this order.
 *
 * Logic:
 * - Manual holds (manualHold=true): Always held
 * - PAYMENT_OVERDUE (overdue invoices exist): Always held
 * - Over-limit auto-holds: Only held if exposure BEFORE this order exceeded limit
 * - Bypass: Never held
 */
async function isBuyerHeldBeforeOrder(
  sql: Sql,
  buyerAccountId: string,
  invoiceId: string | null | undefined,
): Promise<{ held: boolean; bypass: boolean; holdState: string | null; reason: string }> {
  // Get the account's current state
  const [account] = await sql<{
    holdState: string;
    bypass: boolean;
    creditLimit: string | null;
    manualHold: boolean;
    holdReasonCode: string | null;
  }[]>`
    SELECT "holdState", bypass, "creditLimit"::text, "manualHold", "holdReasonCode"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return { held: false, bypass: false, holdState: null, reason: "Account not found" };
  }

  // If bypass is true, never held
  if (account.bypass) {
    return { held: false, bypass: true, holdState: "BYPASS", reason: "Bypass active" };
  }

  // If manual hold, always held (not affected by this order's amount)
  if (account.manualHold) {
    return { held: true, bypass: false, holdState: "HELD", reason: "Manual hold" };
  }

  // Check for overdue invoices - PAYMENT_OVERDUE holds always apply
  const isOverdue = await hasOverdueInvoices(sql, buyerAccountId);
  if (isOverdue) {
    return { held: true, bypass: false, holdState: "HELD", reason: "Payment overdue" };
  }

  // For auto-holds (over limit), check pre-order state
  if (!USE_PRE_ORDER_HOLD_STATE || !invoiceId) {
    // Use current holdState
    const isHeld = account.holdState === "HELD";
    return {
      held: isHeld,
      bypass: false,
      holdState: account.holdState,
      reason: isHeld ? "Over credit limit" : "Not held",
    };
  }

  // Compute exposure excluding this order's invoice
  const creditLimitPaise = account.creditLimit
    ? BigInt(Math.round(parseFloat(account.creditLimit) * 100))
    : null;

  if (creditLimitPaise === null) {
    // No limit = never over limit
    return { held: false, bypass: false, holdState: "OK", reason: "No credit limit" };
  }

  const exposureBeforeOrder = await computeExposureExcludingInvoice(
    sql,
    buyerAccountId,
    invoiceId,
  );

  // If exposure BEFORE this order was already over limit, account was held
  const wasAlreadyOverLimit = exposureBeforeOrder > creditLimitPaise;

  return {
    held: wasAlreadyOverLimit,
    bypass: false,
    holdState: wasAlreadyOverLimit ? "HELD" : "OK",
    reason: wasAlreadyOverLimit
      ? "Already over limit before this order"
      : "This order pushed account over limit (not held)",
  };
}

/**
 * Check if a fulfillment order can be held by this app.
 * We can only hold merchant-managed FOs with our scope.
 */
function canHoldFulfillmentOrder(fo: {
  supportedActions: Array<{ action: string }>;
}): boolean {
  // If HOLD is in supported actions, we can hold it
  return fo.supportedActions.some((a) => a.action === "HOLD");
}

/**
 * Place fulfillment holds on all open merchant-managed fulfillment orders.
 * Throws RetryableBackstopError if 0 holdable FOs (may not exist yet) or partial failure.
 */
async function holdFulfillmentOrders(
  sql: Sql,
  shopId: string,
  shopDomain: string,
  orderGid: string,
): Promise<{ heldCount: number; nonMerchantManagedSkipped: number }> {
  // Get all fulfillment orders for this order
  const queryResult = await shopifyGraphQLRequest<FulfillmentOrdersQueryResult>(
    shopDomain,
    FULFILLMENT_ORDERS_QUERY,
    { orderId: orderGid },
  );

  if (!queryResult.success) {
    throw new RetryableBackstopError(
      `Failed to query fulfillment orders: ${queryResult.error}`,
      "api_error",
    );
  }

  const fulfillmentOrders = queryResult.data?.order?.fulfillmentOrders?.edges ?? [];

  // Filter to only open fulfillment orders
  const openFulfillmentOrders = fulfillmentOrders.filter(
    (edge) => edge.node.status === "OPEN" || edge.node.status === "SCHEDULED",
  );

  // Separate merchant-managed (holdable) from non-merchant-managed
  const holdableFOs = openFulfillmentOrders.filter((edge) =>
    canHoldFulfillmentOrder(edge.node),
  );
  const nonHoldableFOs = openFulfillmentOrders.filter(
    (edge) => !canHoldFulfillmentOrder(edge.node),
  );

  // Record skipped non-merchant-managed FOs
  if (nonHoldableFOs.length > 0) {
    await recordNonMerchantManagedSkipped(
      sql,
      shopId,
      orderGid,
      nonHoldableFOs.map((e) => e.node.id),
    );
  }

  // If no holdable FOs, check if order has any FOs at all
  if (holdableFOs.length === 0) {
    if (openFulfillmentOrders.length === 0 && fulfillmentOrders.length === 0) {
      // No FOs at all - they may not have been created yet. RETRY.
      throw new RetryableBackstopError(
        "No fulfillment orders found - may not be created yet",
        "no_fulfillment_orders",
      );
    }
    // FOs exist but none are holdable (all non-merchant-managed or already closed)
    return { heldCount: 0, nonMerchantManagedSkipped: nonHoldableFOs.length };
  }

  let heldCount = 0;
  const errors: string[] = [];

  for (const edge of holdableFOs) {
    const holdResult = await shopifyGraphQLRequest<FulfillmentOrderHoldResult>(
      shopDomain,
      FULFILLMENT_ORDER_HOLD_MUTATION,
      {
        id: edge.node.id,
        reason: "OTHER",
        reasonNotes:
          "Account on credit hold. Contact buyer to resolve outstanding balance before fulfilling.",
        handle: HOLD_HANDLE,
      },
    );

    if (!holdResult.success) {
      errors.push(`${edge.node.id}: API error - ${holdResult.error}`);
      continue;
    }

    const userErrors = holdResult.data?.fulfillmentOrderHold?.userErrors ?? [];
    if (userErrors.length > 0) {
      // Check if it's already on hold (idempotent - treat as success)
      const alreadyHeld = userErrors.some(
        (e) =>
          e.code === "ALREADY_EXISTS" ||
          e.code === "DUPLICATE_FULFILLMENT_HOLD_HANDLE" ||
          e.message.toLowerCase().includes("already"),
      );
      if (alreadyHeld) {
        heldCount++;
        continue;
      }
      errors.push(
        `${edge.node.id}: ${userErrors.map((e) => `${e.code ?? "ERROR"}: ${e.message}`).join(", ")}`,
      );
      continue;
    }

    heldCount++;
  }

  // Partial failure - some succeeded, some failed. Don't mark processed, allow retry.
  if (errors.length > 0 && heldCount < holdableFOs.length) {
    throw new RetryableBackstopError(
      `Partial failure: held ${heldCount}/${holdableFOs.length} FOs. Errors: ${errors.join("; ")}`,
      "partial_failure",
    );
  }

  // Total failure
  if (errors.length > 0 && heldCount === 0) {
    throw new RetryableBackstopError(
      `Failed to hold all FOs: ${errors.join("; ")}`,
      "all_holds_failed",
    );
  }

  return { heldCount, nonMerchantManagedSkipped: nonHoldableFOs.length };
}

/**
 * Add the credit hold tag to the order.
 */
async function tagOrder(
  shopDomain: string,
  orderGid: string,
): Promise<{ success: boolean; error?: string }> {
  const result = await shopifyGraphQLRequest<TagsAddResult>(
    shopDomain,
    TAGS_ADD_MUTATION,
    {
      id: orderGid,
      tags: [CREDIT_HOLD_TAG],
    },
  );

  if (!result.success) {
    return { success: false, error: result.error };
  }

  const userErrors = result.data?.tagsAdd?.userErrors ?? [];
  if (userErrors.length > 0) {
    return { success: false, error: userErrors.map((e) => e.message).join(", ") };
  }

  return { success: true };
}

/**
 * Resolve invoice and buyer account for an order, independently of webhook result.
 * This allows backstop to run on retries even when webhook is already processed.
 *
 * @param sql Database connection
 * @param shopDomain Shop domain (e.g., "store.myshopify.com")
 * @param orderGid Shopify order GID (e.g., "gid://shopify/Order/123")
 * @returns Invoice info or null if not found
 */
export async function resolveInvoiceForOrder(
  sql: Sql,
  shopDomain: string,
  orderGid: string,
): Promise<{ shopId: string; invoiceId: string; buyerAccountId: string | null } | null> {
  const [invoice] = await sql<{ id: string; shopId: string; buyerAccountId: string | null }[]>`
    SELECT i.id, i."shopId", i."buyerAccountId"
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE s.domain = ${shopDomain} AND i."orderId" = ${orderGid}
    LIMIT 1
  `;
  if (!invoice) return null;
  return { shopId: invoice.shopId, invoiceId: invoice.id, buyerAccountId: invoice.buyerAccountId };
}

/**
 * Apply backstop holds to an order from a held account.
 *
 * This is called after order creation is processed. If the buyer account
 * was held BEFORE this order (and not bypassed), it places fulfillment
 * holds and tags the order.
 *
 * Throws RetryableBackstopError if the operation should be retried.
 *
 * @param sql - Database connection
 * @param input - Order and buyer information
 * @returns Result indicating what actions were taken
 * @throws RetryableBackstopError if retryable failure
 */
export async function applyBackstop(
  sql: Sql,
  input: BackstopInput,
): Promise<BackstopResult> {
  const { shopDomain, shopId, orderGid, buyerAccountId, invoiceId } = input;

  // No buyer account - not a net-terms order
  if (!buyerAccountId) {
    return {
      applied: false,
      skipped: true,
      skipReason: "No buyer account (not a net-terms order)",
    };
  }

  // Claim processing atomically
  const { claimed, existingAction, staleClaim } = await claimBackstopProcessing(sql, shopId, orderGid);

  if (!claimed) {
    // Already claimed or completed
    if (existingAction === "held" || existingAction === "skipped") {
      return {
        applied: false,
        skipped: true,
        skipReason: `Already processed (${existingAction})`,
      };
    }

    if (existingAction === "pending" && staleClaim === false) {
      // Fresh pending claim from another worker - should retry later
      throw new RetryableBackstopError(
        "Another worker is processing this order",
        "pending_claim",
      );
    }

    // Unknown state or race condition - retry
    throw new RetryableBackstopError(
      "Could not claim order for processing",
      "claim_race",
    );
  }

  try {
    // Check if buyer was held BEFORE this order
    const { held, bypass, holdState: _holdState, reason } = await isBuyerHeldBeforeOrder(
      sql,
      buyerAccountId,
      invoiceId,
    );

    if (!held) {
      await markBackstopCompleted(
        sql,
        shopId,
        orderGid,
        "skipped",
        reason,
      );
      return {
        applied: false,
        skipped: true,
        skipReason: reason,
      };
    }

    if (bypass) {
      await markBackstopCompleted(sql, shopId, orderGid, "skipped", "Bypass active");
      return {
        applied: false,
        skipped: true,
        skipReason: "Bypass active",
      };
    }

    // Account was held before this order - apply backstop
    console.warn(
      `[backstop] Applying holds for order ${orderGid} from held account ${buyerAccountId} (${reason})`,
    );

    // Hold fulfillment orders (throws on retryable failure)
    const { heldCount, nonMerchantManagedSkipped } = await holdFulfillmentOrders(
      sql,
      shopId,
      shopDomain,
      orderGid,
    );

    // Tag the order
    const tagResult = await tagOrder(shopDomain, orderGid);
    if (!tagResult.success) {
      console.error(`[backstop] Failed to tag order: ${tagResult.error}`);
      // Continue anyway - holds are more important than tags
    }

    // Record audit event
    await recordBackstopAlert(
      sql,
      shopId,
      orderGid,
      buyerAccountId,
      heldCount,
      nonMerchantManagedSkipped,
    );

    // Mark as completed
    await markBackstopCompleted(sql, shopId, orderGid, "held", null);

    return {
      applied: true,
      skipped: false,
      fulfillmentOrdersHeld: heldCount,
      nonMerchantManagedSkipped,
      tagged: tagResult.success,
      alertRecorded: true,
    };
  } catch (error) {
    // Clear the pending claim so retry can reclaim
    await clearBackstopClaim(sql, shopId, orderGid);

    // Re-throw retryable errors
    if (error instanceof RetryableBackstopError) {
      throw error;
    }

    // Wrap unexpected errors as retryable
    throw new RetryableBackstopError(
      `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      "unexpected_error",
    );
  }
}
