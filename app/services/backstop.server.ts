/**
 * Fulfillment Hold Backstop Service (S13)
 *
 * When an order is created from a held account, this service:
 * 1. Places fulfillment holds on all open fulfillment orders
 * 2. Tags the order with `ntr-credit-hold`
 * 3. Records an audit event for admin visibility
 *
 * This acts as a backstop to the checkout payment customization function.
 * If the payment customization fails to hide payment methods (e.g., timing issue,
 * missing metafield during checkout), this catches orders that shouldn't have
 * gone through and prevents fulfillment.
 *
 * Design:
 * - Idempotent: Uses backstop_processed_orders table to prevent duplicate holds
 * - Non-blocking: Errors are logged but don't fail the webhook
 * - Audit trail: Records alerts in AuditEvent table
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
 * Input for the backstop check.
 */
export interface BackstopInput {
  shopDomain: string;
  shopId: string;
  orderId: string;
  orderGid: string;
  buyerAccountId: string | null;
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
 * Check if backstop has already been processed for this order.
 * This ensures idempotency on webhook redelivery.
 */
async function isBackstopProcessed(
  sql: Sql,
  shopId: string,
  orderGid: string,
): Promise<boolean> {
  const [result] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM backstop_processed_orders
      WHERE shop_id = ${shopId} AND order_gid = ${orderGid}
    ) AS exists
  `;
  return result?.exists ?? false;
}

/**
 * Mark backstop as processed for this order.
 */
async function markBackstopProcessed(
  sql: Sql,
  shopId: string,
  orderGid: string,
  action: "held" | "skipped",
  reason: string | null,
): Promise<void> {
  await sql`
    INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
    VALUES (${shopId}, ${orderGid}, ${action}, ${reason}, NOW())
    ON CONFLICT (shop_id, order_gid) DO NOTHING
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
        tag: CREDIT_HOLD_TAG,
        reason: "Order placed from held account - backstop applied",
      })},
      NOW()
    )
  `;
}

/**
 * Check if the buyer account is held and not bypassed.
 */
async function isBuyerHeld(
  sql: Sql,
  buyerAccountId: string,
): Promise<{ held: boolean; bypass: boolean }> {
  const [account] = await sql<{ holdState: string; bypass: boolean }[]>`
    SELECT "holdState", bypass
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return { held: false, bypass: false };
  }

  return {
    held: account.holdState === "HELD",
    bypass: account.bypass,
  };
}

/**
 * Place fulfillment holds on all open fulfillment orders.
 */
async function holdFulfillmentOrders(
  shopDomain: string,
  orderGid: string,
): Promise<{ success: boolean; heldCount: number; error?: string }> {
  // Get all fulfillment orders for this order
  const queryResult = await shopifyGraphQLRequest<FulfillmentOrdersQueryResult>(
    shopDomain,
    FULFILLMENT_ORDERS_QUERY,
    { orderId: orderGid },
  );

  if (!queryResult.success) {
    return { success: false, heldCount: 0, error: queryResult.error };
  }

  const fulfillmentOrders = queryResult.data?.order?.fulfillmentOrders?.edges ?? [];
  
  // Filter to only open fulfillment orders
  const openFulfillmentOrders = fulfillmentOrders.filter(
    (edge) => edge.node.status === "OPEN" || edge.node.status === "SCHEDULED",
  );

  if (openFulfillmentOrders.length === 0) {
    return { success: true, heldCount: 0 };
  }

  let heldCount = 0;
  const errors: string[] = [];

  for (const edge of openFulfillmentOrders) {
    const holdResult = await shopifyGraphQLRequest<FulfillmentOrderHoldResult>(
      shopDomain,
      FULFILLMENT_ORDER_HOLD_MUTATION,
      {
        id: edge.node.id,
        reason: "OTHER",
        reasonNotes: "Account on credit hold. Contact buyer to resolve outstanding balance before fulfilling.",
        handle: HOLD_HANDLE,
      },
    );

    if (!holdResult.success) {
      errors.push(`${edge.node.id}: ${holdResult.error}`);
      continue;
    }

    const userErrors = holdResult.data?.fulfillmentOrderHold?.userErrors ?? [];
    if (userErrors.length > 0) {
      // Check if it's already on hold (idempotent)
      const alreadyHeld = userErrors.some(
        (e) => e.code === "ALREADY_EXISTS" || e.message.includes("already"),
      );
      if (!alreadyHeld) {
        errors.push(`${edge.node.id}: ${userErrors.map((e) => e.message).join(", ")}`);
        continue;
      }
    }

    heldCount++;
  }

  if (errors.length > 0 && heldCount === 0) {
    return { success: false, heldCount: 0, error: errors.join("; ") };
  }

  return { success: true, heldCount };
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
 * is held (and not bypassed), it places fulfillment holds and tags the order.
 *
 * @param sql - Database connection
 * @param input - Order and buyer information
 * @returns Result indicating what actions were taken
 */
export async function applyBackstop(
  sql: Sql,
  input: BackstopInput,
): Promise<BackstopResult> {
  const { shopDomain, shopId, orderGid, buyerAccountId } = input;

  // No buyer account - not a net-terms order
  if (!buyerAccountId) {
    return {
      applied: false,
      skipped: true,
      skipReason: "No buyer account (not a net-terms order)",
    };
  }

  // Check idempotency
  if (await isBackstopProcessed(sql, shopId, orderGid)) {
    return {
      applied: false,
      skipped: true,
      skipReason: "Already processed (idempotent)",
    };
  }

  // Check if buyer is held
  const { held, bypass } = await isBuyerHeld(sql, buyerAccountId);

  if (!held) {
    await markBackstopProcessed(sql, shopId, orderGid, "skipped", "Account not held");
    return {
      applied: false,
      skipped: true,
      skipReason: "Account not held",
    };
  }

  if (bypass) {
    await markBackstopProcessed(sql, shopId, orderGid, "skipped", "Account has bypass");
    return {
      applied: false,
      skipped: true,
      skipReason: "Account has bypass active",
    };
  }

  // Account is held and not bypassed - apply backstop
  console.warn(
    `[backstop] Applying holds for order ${orderGid} from held account ${buyerAccountId}`,
  );

  // Hold fulfillment orders
  const holdResult = await holdFulfillmentOrders(shopDomain, orderGid);
  if (!holdResult.success) {
    console.error(`[backstop] Failed to hold fulfillment orders: ${holdResult.error}`);
    return {
      applied: false,
      skipped: false,
      error: `Failed to hold fulfillment orders: ${holdResult.error}`,
    };
  }

  // Tag the order
  const tagResult = await tagOrder(shopDomain, orderGid);
  if (!tagResult.success) {
    console.error(`[backstop] Failed to tag order: ${tagResult.error}`);
    // Continue anyway - holds are more important than tags
  }

  // Record audit event
  try {
    await recordBackstopAlert(sql, shopId, orderGid, buyerAccountId, holdResult.heldCount);
  } catch (e) {
    console.error(`[backstop] Failed to record audit event:`, e);
    // Continue anyway - this is for admin visibility, not critical
  }

  // Mark as processed
  await markBackstopProcessed(sql, shopId, orderGid, "held", null);

  return {
    applied: true,
    skipped: false,
    fulfillmentOrdersHeld: holdResult.heldCount,
    tagged: tagResult.success,
    alertRecorded: true,
  };
}
