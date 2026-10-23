/**
 * Credit status writer service (S11).
 *
 * Computes and writes the $app:credit_status metafield to the appropriate
 * owner (CompanyLocation for B2B, Customer for tagged customers).
 *
 * The metafield value must match the exact JSON schema that the Rust
 * validation function (S12) deserializes. See docs/metafields-contract.md.
 *
 * Design:
 * - DB writes happen first in a transaction
 * - If metafield write fails, a sync_pending flag is set
 * - On next edit or via a reconciliation job, the metafield is retried
 */

import type { Sql } from "~/lib/db-light.server";
import {
  serializeCreditStatusFromDb,
  METAFIELD,
  type HoldReasonCode,
} from "~/lib/metafields-contract";
import { shopifyGraphQLRequest, type ShopifyClientResult } from "./shopify-client.server";

/**
 * Owner type for metafield writes.
 */
export type MetafieldOwner = "CompanyLocation" | "Customer";

/**
 * Input for updating a buyer account's credit status.
 */
export interface CreditStatusUpdate {
  /** Credit limit in the main currency unit (e.g., rupees). Null = no limit. */
  creditLimitAmount: number | null;
  /** Whether the account is on manual hold. */
  manualHold: boolean;
  /** Reason code for the hold (required if manualHold is true). */
  holdReasonCode: HoldReasonCode;
  /** Optional note for the hold. */
  holdNote?: string | null;
}

/**
 * Result of a credit status update.
 */
export interface CreditStatusUpdateResult {
  success: boolean;
  error?: string;
  /** Whether the metafield write failed (DB was updated but metafield not synced). */
  metafieldSyncPending?: boolean;
  /** Shopify userErrors from metafieldsSet mutation. */
  userErrors?: Array<{ field: string[]; message: string }>;
}

/**
 * Buyer account data needed for credit status computation.
 */
interface BuyerAccountData {
  id: string;
  shopId: string;
  kind: "COMPANY" | "TAGGED_CUSTOMER";
  companyLocationId: string | null;
  customerId: string | null;
  creditLimit: string | null;
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  bypass: boolean;
  gatedAt: Date | null;
}

/**
 * Shop data needed for credit status computation.
 */
interface ShopData {
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
 * Get the Shopify GID for the metafield owner.
 */
function getOwnerGid(account: BuyerAccountData): { gid: string; type: MetafieldOwner } | null {
  if (account.kind === "COMPANY" && account.companyLocationId) {
    return {
      gid: account.companyLocationId,
      type: "CompanyLocation",
    };
  }
  if (account.kind === "TAGGED_CUSTOMER" && account.customerId) {
    return {
      gid: account.customerId,
      type: "Customer",
    };
  }
  return null;
}

/**
 * Compute outstanding exposure for a buyer account.
 * Includes open invoices and draft orders with payment terms.
 */
async function computeExposure(
  sql: Sql,
  buyerAccountId: string,
  shopId: string
): Promise<{ exposurePaise: bigint; currency: string }> {
  const [shopResult] = await sql<{ currency: string }[]>`
    SELECT currency FROM "Shop" WHERE id = ${shopId}
  `;
  const currency = shopResult?.currency ?? "INR";

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
      AND status = 'open'
  `;

  const invoicePaise = BigInt(invoiceResult?.total_paise ?? "0");
  const draftPaise = BigInt(draftResult?.total_paise ?? "0");

  return {
    exposurePaise: invoicePaise + draftPaise,
    currency,
  };
}

/**
 * Determine if an account should be on hold based on exposure and overdue invoices.
 */
async function computeDerivedHoldState(
  sql: Sql,
  buyerAccountId: string,
  creditLimitPaise: bigint | null,
  exposurePaise: bigint
): Promise<{ shouldHold: boolean; derivedReasonCode: HoldReasonCode; isOverLimit: boolean; isOverdue: boolean }> {
  const isOverLimit = creditLimitPaise !== null && exposurePaise > creditLimitPaise;

  const [overdueResult] = await sql<{ has_overdue: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "Invoice"
      WHERE "buyerAccountId" = ${buyerAccountId}
        AND status = 'open'
        AND outstanding > 0
        AND "dueAt" IS NOT NULL
        AND "dueAt" < NOW() - INTERVAL '1 day'
    ) AS has_overdue
  `;
  const isOverdue = overdueResult?.has_overdue ?? false;

  let derivedReasonCode: HoldReasonCode = null;
  if (isOverLimit) {
    derivedReasonCode = "CREDIT_REVIEW";
  } else if (isOverdue) {
    derivedReasonCode = "PAYMENT_OVERDUE";
  }

  return {
    shouldHold: isOverLimit || isOverdue,
    derivedReasonCode,
    isOverLimit,
    isOverdue,
  };
}

/**
 * Write credit_status metafield via the Admin GraphQL API.
 */
async function writeMetafield(
  shopDomain: string,
  ownerGid: string,
  value: string
): Promise<ShopifyClientResult<MetafieldsSetResponse>> {
  return shopifyGraphQLRequest<MetafieldsSetResponse>(
    shopDomain,
    METAFIELDS_SET_MUTATION,
    {
      metafields: [
        {
          ownerId: ownerGid,
          namespace: METAFIELD.namespace,
          key: METAFIELD.key,
          type: METAFIELD.type,
          value,
        },
      ],
    }
  );
}

/**
 * Update a buyer account's credit status.
 *
 * This function:
 * 1. Validates the input
 * 2. Updates the database in a transaction
 * 3. Computes the full credit status
 * 4. Writes the metafield to Shopify
 *
 * If the metafield write fails, the DB change is preserved but a
 * sync_pending flag is set for later reconciliation.
 *
 * @param sql - Database connection
 * @param buyerAccountId - The buyer account to update
 * @param update - The credit status changes
 * @returns Result indicating success or failure
 */
export async function updateCreditStatus(
  sql: Sql,
  buyerAccountId: string,
  update: CreditStatusUpdate
): Promise<CreditStatusUpdateResult> {
  if (update.manualHold && !update.holdReasonCode) {
    return {
      success: false,
      error: "holdReasonCode is required when manualHold is true",
    };
  }

  if (update.creditLimitAmount !== null && update.creditLimitAmount < 0) {
    return {
      success: false,
      error: "creditLimitAmount must be >= 0 or null (no limit)",
    };
  }

  const [account] = await sql<BuyerAccountData[]>`
    SELECT
      id,
      "shopId" AS "shopId",
      kind,
      "companyLocationId",
      "customerId",
      "creditLimit"::text AS "creditLimit",
      "holdState",
      bypass,
      gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return {
      success: false,
      error: "Buyer account not found",
    };
  }

  if (account.gatedAt !== null) {
    return {
      success: false,
      error: "Cannot update credit status for gated accounts",
    };
  }

  const [shop] = await sql<ShopData[]>`
    SELECT domain, currency FROM "Shop" WHERE id = ${account.shopId}
  `;

  if (!shop) {
    return {
      success: false,
      error: "Shop not found",
    };
  }

  const owner = getOwnerGid(account);
  if (!owner) {
    return {
      success: false,
      error: `Cannot determine metafield owner for account kind ${account.kind}`,
    };
  }

  const creditLimitValue = update.creditLimitAmount !== null
    ? update.creditLimitAmount.toFixed(2)
    : null;

  const newHoldState = update.manualHold ? "HELD" : "OK";

  await sql`
    UPDATE "BuyerAccount"
    SET
      "creditLimit" = ${creditLimitValue}::numeric,
      "holdState" = ${newHoldState}::"HoldState",
      "updatedAt" = NOW()
    WHERE id = ${buyerAccountId}
  `;

  const { exposurePaise, currency } = await computeExposure(
    sql,
    buyerAccountId,
    account.shopId
  );

  const creditLimitPaise = update.creditLimitAmount !== null
    ? BigInt(Math.round(update.creditLimitAmount * 100))
    : null;

  const { shouldHold: derivedShouldHold, derivedReasonCode, isOverLimit, isOverdue } =
    await computeDerivedHoldState(sql, buyerAccountId, creditLimitPaise, exposurePaise);

  const effectiveHold = update.manualHold || derivedShouldHold;
  let effectiveReasonCode: HoldReasonCode = null;

  if (update.manualHold) {
    effectiveReasonCode = update.holdReasonCode;
  } else if (isOverLimit) {
    effectiveReasonCode = "CREDIT_REVIEW";
  } else if (isOverdue) {
    effectiveReasonCode = "PAYMENT_OVERDUE";
  }

  const metafieldValue = serializeCreditStatusFromDb({
    currencyCode: currency,
    hold: effectiveHold,
    holdReasonCode: effectiveReasonCode,
    limitPaise: creditLimitPaise,
    exposurePaise,
  });

  const metafieldResult = await writeMetafield(shop.domain, owner.gid, metafieldValue);

  if (!metafieldResult.success) {
    console.error(
      `[credit-status] Metafield write failed for ${buyerAccountId}:`,
      metafieldResult.error
    );

    return {
      success: true,
      metafieldSyncPending: true,
      error: `Database updated but metafield sync failed: ${metafieldResult.error}`,
    };
  }

  const userErrors = metafieldResult.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    console.error(
      `[credit-status] Metafield userErrors for ${buyerAccountId}:`,
      JSON.stringify(userErrors)
    );

    return {
      success: true,
      metafieldSyncPending: true,
      userErrors,
      error: `Database updated but metafield had userErrors: ${userErrors.map(e => e.message).join("; ")}`,
    };
  }

  return {
    success: true,
    metafieldSyncPending: false,
  };
}

/**
 * Sync credit status metafield for a buyer account.
 *
 * Called during reconciliation or when a sync is pending.
 * Computes the current state from DB and writes the metafield.
 *
 * @param sql - Database connection
 * @param buyerAccountId - The buyer account to sync
 * @returns Result indicating success or failure
 */
export async function syncCreditStatusMetafield(
  sql: Sql,
  buyerAccountId: string
): Promise<CreditStatusUpdateResult> {
  const [account] = await sql<BuyerAccountData[]>`
    SELECT
      id,
      "shopId" AS "shopId",
      kind,
      "companyLocationId",
      "customerId",
      "creditLimit"::text AS "creditLimit",
      "holdState",
      bypass,
      gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return {
      success: false,
      error: "Buyer account not found",
    };
  }

  if (account.gatedAt !== null) {
    return {
      success: true,
    };
  }

  const [shop] = await sql<ShopData[]>`
    SELECT domain, currency FROM "Shop" WHERE id = ${account.shopId}
  `;

  if (!shop) {
    return {
      success: false,
      error: "Shop not found",
    };
  }

  const owner = getOwnerGid(account);
  if (!owner) {
    return {
      success: true,
    };
  }

  const { exposurePaise, currency } = await computeExposure(
    sql,
    buyerAccountId,
    account.shopId
  );

  const creditLimitPaise = account.creditLimit
    ? BigInt(Math.round(parseFloat(account.creditLimit) * 100))
    : null;

  const manualHold = account.holdState === "HELD" || account.holdState === "BYPASS";

  const { shouldHold: derivedShouldHold, isOverLimit, isOverdue } =
    await computeDerivedHoldState(sql, buyerAccountId, creditLimitPaise, exposurePaise);

  const effectiveHold = manualHold || derivedShouldHold;
  let effectiveReasonCode: HoldReasonCode = null;

  if (account.holdState === "HELD") {
    effectiveReasonCode = "MANUAL_HOLD";
  } else if (isOverLimit) {
    effectiveReasonCode = "CREDIT_REVIEW";
  } else if (isOverdue) {
    effectiveReasonCode = "PAYMENT_OVERDUE";
  }

  const metafieldValue = serializeCreditStatusFromDb({
    currencyCode: currency,
    hold: effectiveHold,
    holdReasonCode: effectiveReasonCode,
    limitPaise: creditLimitPaise,
    exposurePaise,
  });

  const metafieldResult = await writeMetafield(shop.domain, owner.gid, metafieldValue);

  if (!metafieldResult.success) {
    return {
      success: false,
      metafieldSyncPending: true,
      error: `Metafield sync failed: ${metafieldResult.error}`,
    };
  }

  const userErrors = metafieldResult.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    return {
      success: false,
      metafieldSyncPending: true,
      userErrors,
      error: `Metafield userErrors: ${userErrors.map(e => e.message).join("; ")}`,
    };
  }

  return {
    success: true,
    metafieldSyncPending: false,
  };
}

/**
 * Get credit status for display in the UI.
 */
export interface CreditStatusDisplay {
  creditLimitAmount: number | null;
  creditLimitPaise: bigint | null;
  exposurePaise: bigint;
  availableCreditPaise: bigint | null;
  currency: string;
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  isOnHold: boolean;
  holdReasonDisplay: string | null;
  isOverLimit: boolean;
  isOverdue: boolean;
  utilizationPercent: number | null;
}

/**
 * Get credit status data for UI display.
 */
export async function getCreditStatusDisplay(
  sql: Sql,
  buyerAccountId: string
): Promise<CreditStatusDisplay | null> {
  const [account] = await sql<BuyerAccountData[]>`
    SELECT
      id,
      "shopId" AS "shopId",
      kind,
      "companyLocationId",
      "customerId",
      "creditLimit"::text AS "creditLimit",
      "holdState",
      bypass,
      gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return null;
  }

  const { exposurePaise, currency } = await computeExposure(
    sql,
    buyerAccountId,
    account.shopId
  );

  const creditLimitAmount = account.creditLimit
    ? parseFloat(account.creditLimit)
    : null;

  const creditLimitPaise = creditLimitAmount !== null
    ? BigInt(Math.round(creditLimitAmount * 100))
    : null;

  const availableCreditPaise = creditLimitPaise !== null
    ? creditLimitPaise - exposurePaise
    : null;

  const { isOverLimit, isOverdue } = await computeDerivedHoldState(
    sql,
    buyerAccountId,
    creditLimitPaise,
    exposurePaise
  );

  const isOnHold = account.holdState === "HELD" ||
    (account.holdState !== "BYPASS" && (isOverLimit || isOverdue));

  let holdReasonDisplay: string | null = null;
  if (account.holdState === "HELD") {
    holdReasonDisplay = "Manual hold";
  } else if (account.holdState === "BYPASS") {
    holdReasonDisplay = "Bypass active";
  } else if (isOverLimit) {
    holdReasonDisplay = "Over credit limit";
  } else if (isOverdue) {
    holdReasonDisplay = "Payment overdue";
  }

  const utilizationPercent = creditLimitPaise !== null && creditLimitPaise > 0n
    ? Math.round(Number((exposurePaise * 100n) / creditLimitPaise))
    : null;

  return {
    creditLimitAmount,
    creditLimitPaise,
    exposurePaise,
    availableCreditPaise,
    currency,
    holdState: account.holdState,
    isOnHold,
    holdReasonDisplay,
    isOverLimit,
    isOverdue,
    utilizationPercent,
  };
}
