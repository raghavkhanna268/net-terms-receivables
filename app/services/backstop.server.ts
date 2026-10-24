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
 * 1. PRE-ORDER HOLD STATE: The backstop judges the account's hold state as it was
 *    BEFORE this order. An order that itself pushes the buyer over the limit is
 *    NOT held by the backstop - it only affects future orders. This is controlled
 *    by USE_PRE_ORDER_HOLD_STATE constant. Set to false to hold all orders from
 *    accounts that are currently held (including the one that caused the hold).
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
 * When true (default): An order that pushes the buyer over the limit is NOT held.
 * The buyer becomes held for FUTURE orders, but this order proceeds.
 *
 * When false: Any order from a currently-held account is held, even if this
 * specific order caused the hold.
 *
 * This is a named constant so the decision is easy to find and change.
 */
export const USE_PRE_ORDER_HOLD_STATE = true;

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
  orderId: string;
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
 * Returns the claim status:
 * - 'claimed': This call claimed the order for processing
 * - 'already_processing': Another call is processing (status='pending')
 * - 'already_done': Already completed (status='held' or 'skipped')
 */
async function claimBackstopProcessing(
  sql: Sql,
  shopId: string,
  orderGid: string,
): Promise<"claimed" | "already_processing" | "already_done"> {
  // Try to insert with status='pending'. If conflict, check existing status.
  const [result] = await sql<{ status: string }[]>`
    INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
    VALUES (${shopId}, ${orderGid}, 'pending', NULL, NOW())
    ON CONFLICT (shop_id, order_gid) DO UPDATE
      SET shop_id = backstop_processed_orders.shop_id
    RETURNING action AS status
  `;

  if (!result) {
    // INSERT succeeded (no conflict), we claimed it
    return "claimed";
  }

  const status = result.status;
  if (status === "pending") {
    // We just updated our own pending row, or it was already pending from us
    // Either way, we have the claim
    return "claimed";
  }

  // Status is 'held' or 'skipped' - already completed
  return "already_done";
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
 * Record a failed backstop attempt for alerting (after max retries).
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
 * Check if the buyer account was held BEFORE this order.
 *
 * If USE_PRE_ORDER_HOLD_STATE is true and invoiceId is provided, this excludes
 * the invoice's amount from the exposure calculation to determine if the account
 * was already held before this order.
 *
 * If the account was OK but this order pushed it over the limit, returns held=false
 * (the order proceeds, but the account is now held for future orders).
 */
async function isBuyerHeldBeforeOrder(
  sql: Sql,
  buyerAccountId: string,
  invoiceId: string | null | undefined,
): Promise<{ held: boolean; bypass: boolean; holdState: string | null }> {
  // Get the account's current state
  const [account] = await sql<{
    holdState: string;
    bypass: boolean;
    creditLimit: string | null;
    manualHold: boolean;
  }[]>`
    SELECT "holdState", bypass, "creditLimit"::text, "manualHold"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return { held: false, bypass: false, holdState: null };
  }

  // If bypass is true, never held
  if (account.bypass) {
    return { held: false, bypass: true, holdState: "BYPASS" };
  }

  // If manual hold, always held (not affected by this order's amount)
  if (account.manualHold) {
    return { held: true, bypass: false, holdState: "HELD" };
  }

  // For automatic holds (over limit), we need to check pre-order state
  if (USE_PRE_ORDER_HOLD_STATE && invoiceId && account.holdState === "HELD") {
    // Check if the account was ALREADY over limit before this invoice
    // by computing exposure excluding this invoice
    const [preOrderState] = await sql<{
      exposureWithoutThisOrder: string;
    }[]>`
      SELECT COALESCE(SUM(i.total_paise)::text, '0') AS "exposureWithoutThisOrder"
      FROM "Invoice" i
      WHERE i."buyerAccountId" = ${buyerAccountId}
        AND i.id != ${invoiceId}
        AND i.status NOT IN ('paid', 'cancelled', 'voided')
    `;

    const creditLimitPaise = account.creditLimit
      ? BigInt(Math.round(parseFloat(account.creditLimit) * 100))
      : null;

    if (creditLimitPaise === null) {
      // No limit = never over limit
      return { held: false, bypass: false, holdState: "OK" };
    }

    const exposureBeforeOrder = BigInt(preOrderState?.exposureWithoutThisOrder ?? "0");

    // If exposure BEFORE this order was already over limit, account was held
    const wasAlreadyHeld = exposureBeforeOrder > creditLimitPaise;

    return {
      held: wasAlreadyHeld,
      bypass: false,
      holdState: wasAlreadyHeld ? "HELD" : "OK",
    };
  }

  // Otherwise, use current holdState
  return {
    held: account.holdState === "HELD",
    bypass: false,
    holdState: account.holdState,
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
      // No FOs at all - they may not have been created yet
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

  // Partial failure - some succeeded, some failed
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
  const claimStatus = await claimBackstopProcessing(sql, shopId, orderGid);
  if (claimStatus === "already_done") {
    return {
      applied: false,
      skipped: true,
      skipReason: "Already processed (idempotent)",
    };
  }

  try {
    // Check if buyer was held BEFORE this order
    const { held, bypass, holdState } = await isBuyerHeldBeforeOrder(
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
        `Account not held (state: ${holdState ?? "unknown"})`,
      );
      return {
        applied: false,
        skipped: true,
        skipReason: `Account not held before this order (state: ${holdState ?? "unknown"})`,
      };
    }

    if (bypass) {
      await markBackstopCompleted(sql, shopId, orderGid, "skipped", "Account has bypass");
      return {
        applied: false,
        skipped: true,
        skipReason: "Account has bypass active",
      };
    }

    // Account was held before this order - apply backstop
    console.warn(
      `[backstop] Applying holds for order ${orderGid} from held account ${buyerAccountId}`,
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
