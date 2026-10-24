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
 * - DB writes happen in a transaction with FOR UPDATE locking
 * - If metafield write fails, syncPending flag is set in DB
 * - On next edit or via a reconciliation job, the metafield is retried
 */

import type { Sql } from "~/lib/db-light.server";
import {
  serializeCreditStatusFromDb,
  METAFIELD,
  type HoldReasonCode,
} from "~/lib/metafields-contract";
import { shopifyGraphQLRequest, type ShopifyClientResult } from "./shopify-client.server";
import { hasOverdueInvoices } from "./overdue.server";
import { safeLog, toErrorCode } from "~/lib/log.server";

// Re-export HoldReasonCode for use by credit-status-recompute.server.ts
export type { HoldReasonCode };

/**
 * Valid sources of a credit status change (for audit trail).
 * Exported const so processor.server.ts can validate message.source against it.
 */
export const CREDIT_STATUS_SOURCES = [
  "invoice_change",
  "daily_sweep",
  "manual",
  "sync",
  "unknown",
] as const;

/**
 * Source of a credit status change (for audit trail).
 * Derived from CREDIT_STATUS_SOURCES const.
 */
export type CreditStatusSource = (typeof CREDIT_STATUS_SOURCES)[number];

/**
 * Valid hold reason codes - used for validation.
 */
export const VALID_HOLD_REASON_CODES: readonly HoldReasonCode[] = [
  "MANUAL_HOLD",
  "PAYMENT_OVERDUE",
  "CREDIT_REVIEW",
  "NEW_ACCOUNT",
  "FRAUD_SUSPECTED",
] as const;

/**
 * Threshold for NEAR_LIMIT state (80% of credit limit).
 * When exposure/limit >= this value, holdState transitions to NEAR_LIMIT
 * (unless already HELD or BYPASS).
 */
export const NEAR_LIMIT_THRESHOLD = 0.8;

/**
 * Maximum credit limit in paise that fits safely in BigInt.
 * 999,999,999,999,999 paise = 9,999,999,999,999.99 currency units (~10 trillion)
 */
export const MAX_CREDIT_LIMIT_PAISE = 999_999_999_999_999n;
export const MAX_CREDIT_LIMIT_AMOUNT = 9_999_999_999_999.99;

/**
 * Owner type for metafield writes.
 */
export type MetafieldOwner = "CompanyLocation" | "Customer";

/**
 * Input for updating a buyer account's credit status.
 */
export interface CreditStatusUpdate {
  /** 
   * Credit limit in the main currency unit (e.g., rupees). 
   * - undefined = leave unchanged (hold-only save)
   * - null = explicit no limit (requires noLimit flag)
   * - number = set specific limit
   */
  creditLimitAmount?: number | null;
  /** Whether to set no credit limit (explicit flag required for null). */
  noLimit?: boolean;
  /** Whether the account is on manual hold. */
  manualHold: boolean;
  /** Reason code for the hold (required if manualHold is true, ignored if false). */
  holdReasonCode?: HoldReasonCode | null;
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
  manualHold: boolean;
  holdReasonCode: string | null;
  holdNote: string | null;
  syncPending: boolean;
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

/**
 * Static GraphQL mutation for metafieldsSet.
 * Validated against Admin 2026-10 schema.
 */
export const METAFIELDS_SET_MUTATION = `
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
 * Input for computing hold state.
 */
export interface ComputeHoldStateInput {
  bypass: boolean;
  manualHold: boolean;
  isOverLimit: boolean;
  isOverdue: boolean;
  /** Exposure in paise (for NEAR_LIMIT calculation) */
  exposurePaise: bigint;
  /** Credit limit in paise (null = no limit, never NEAR_LIMIT) */
  limitPaise: bigint | null;
}

/**
 * Output of hold state computation.
 */
export interface ComputeHoldStateResult {
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  metafieldHold: boolean;
  holdReasonCode: HoldReasonCode;
}

/**
 * Pure function to compute hold state.
 * 
 * Precedence (first match wins):
 * 1. bypass = true → BYPASS state, hold: false (exempt at checkout)
 * 2. manualHold = true → HELD state, hold: true
 * 3. isOverLimit or isOverdue → auto-hold, HELD state, hold: true
 * 4. NEAR_LIMIT when limit > 0 AND exposure/limit >= NEAR_LIMIT_THRESHOLD (0.8)
 * 5. Otherwise → OK state, hold: false
 * 
 * A no-limit account (limitPaise === null) is never NEAR_LIMIT.
 */
export function computeHoldState(
  input: ComputeHoldStateInput,
  manualHoldReasonCode?: HoldReasonCode | null
): ComputeHoldStateResult {
  const { bypass, manualHold, isOverLimit, isOverdue, exposurePaise, limitPaise } = input;

  if (bypass) {
    return {
      holdState: "BYPASS",
      metafieldHold: false,
      holdReasonCode: null,
    };
  }

  if (manualHold) {
    return {
      holdState: "HELD",
      metafieldHold: true,
      holdReasonCode: manualHoldReasonCode ?? "MANUAL_HOLD",
    };
  }

  if (isOverLimit) {
    return {
      holdState: "HELD",
      metafieldHold: true,
      holdReasonCode: "CREDIT_REVIEW",
    };
  }

  if (isOverdue) {
    return {
      holdState: "HELD",
      metafieldHold: true,
      holdReasonCode: "PAYMENT_OVERDUE",
    };
  }

  // NEAR_LIMIT: only for accounts with a limit, when utilization >= threshold
  if (limitPaise !== null && limitPaise > 0n) {
    // Use integer math to avoid floating point: exposure * 100 >= limit * 80
    const utilizationScaled = exposurePaise * 100n;
    const thresholdScaled = limitPaise * BigInt(Math.round(NEAR_LIMIT_THRESHOLD * 100));
    if (utilizationScaled >= thresholdScaled) {
      return {
        holdState: "NEAR_LIMIT",
        metafieldHold: false,
        holdReasonCode: null,
      };
    }
  }

  return {
    holdState: "OK",
    metafieldHold: false,
    holdReasonCode: null,
  };
}

/**
 * Compute effective hold status taking bypass into account.
 * Returns true if the account is effectively held (HELD and not bypassed).
 */
function isEffectivelyHeld(
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS",
  bypass: boolean
): boolean {
  return holdState === "HELD" && !bypass;
}

/**
 * Record an audit event for a hold state transition.
 * Only call this when the effective hold actually changes.
 */
async function recordHoldTransitionAudit(
  tx: Sql,
  shopId: string,
  buyerAccountId: string,
  previousHoldState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS",
  newHoldState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS",
  holdReasonCode: HoldReasonCode | null,
  source: CreditStatusSource,
  isNowHeld: boolean,
): Promise<void> {
  const eventType = isNowHeld
    ? "credit_status.hold_applied"
    : "credit_status.hold_released";

  await tx`
    INSERT INTO "AuditEvent" ("shopId", actor, type, data, at)
    VALUES (
      ${shopId},
      'system',
      ${eventType},
      ${tx.json({
        buyerAccountId,
        holdReasonCode,
        source,
        previousHoldState,
        newHoldState,
      })},
      NOW()
    )
  `;
}

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
 * Includes open invoices and draft orders with payment terms (status 'open' or 'invoice_sent').
 */
async function computeExposure(
  sql: Sql,
  buyerAccountId: string,
  shopId: string
): Promise<{ exposurePaise: bigint; draftExposurePaise: bigint; currency: string }> {
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
      AND status IN ('open', 'invoice_sent')
  `;

  const invoicePaise = BigInt(invoiceResult?.total_paise ?? "0");
  const draftPaise = BigInt(draftResult?.total_paise ?? "0");

  return {
    exposurePaise: invoicePaise + draftPaise,
    draftExposurePaise: draftPaise,
    currency,
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
 * Validate credit limit amount.
 */
function validateCreditLimit(amount: number | null | undefined, noLimit: boolean): 
  { valid: true; value: number | null } | { valid: false; error: string } {
  
  if (noLimit) {
    return { valid: true, value: null };
  }

  if (amount === undefined) {
    return { valid: true, value: undefined as unknown as number | null };
  }

  if (amount === null) {
    return { 
      valid: false, 
      error: "Credit limit cannot be empty. Check 'No credit limit' to allow unlimited credit." 
    };
  }

  if (!Number.isFinite(amount)) {
    return { 
      valid: false, 
      error: "Credit limit must be a valid number (not Infinity or NaN)" 
    };
  }

  if (amount < 0) {
    return { 
      valid: false, 
      error: "Credit limit must be >= 0" 
    };
  }

  if (amount > MAX_CREDIT_LIMIT_AMOUNT) {
    return { 
      valid: false, 
      error: `Credit limit cannot exceed ${MAX_CREDIT_LIMIT_AMOUNT.toLocaleString()}` 
    };
  }

  return { valid: true, value: amount };
}

/**
 * Validate hold reason code.
 */
function validateHoldReasonCode(code: HoldReasonCode | null | undefined, manualHold: boolean): 
  { valid: true } | { valid: false; error: string } {
  
  if (!manualHold) {
    return { valid: true };
  }

  if (!code) {
    return { 
      valid: false, 
      error: "holdReasonCode is required when manualHold is true" 
    };
  }

  if (!VALID_HOLD_REASON_CODES.includes(code)) {
    return { 
      valid: false, 
      error: `Invalid holdReasonCode: ${code}. Valid codes: ${VALID_HOLD_REASON_CODES.join(", ")}` 
    };
  }

  return { valid: true };
}

/**
 * Data needed to write the metafield after transaction commits.
 */
interface MetafieldWriteData {
  shopDomain: string;
  ownerGid: string;
  metafieldValue: string;
}

/**
 * Update a buyer account's credit status.
 *
 * This function:
 * 1. Validates the input
 * 2. In a transaction: locks the BuyerAccount row, computes state, writes DB with syncPending=true
 * 3. After transaction commits: writes the metafield to Shopify
 * 4. On metafield success: clears syncPending
 * 5. On metafield failure: leaves syncPending=true and logs
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
  const limitValidation = validateCreditLimit(update.creditLimitAmount, update.noLimit ?? false);
  if (!limitValidation.valid) {
    return { success: false, error: limitValidation.error };
  }

  const reasonValidation = validateHoldReasonCode(update.holdReasonCode, update.manualHold);
  if (!reasonValidation.valid) {
    return { success: false, error: reasonValidation.error };
  }

  type TxSuccess = { success: true; metafieldWriteData: MetafieldWriteData; syncVersion: number };
  type TxError = { success: false; error: string };
  type TxResult = TxSuccess | TxError;

  const txResult: TxResult = await sql.begin(async (tx) => {
    const [account] = await tx<BuyerAccountData[]>`
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
        "holdNote",
        "syncPending",
        gated_at AS "gatedAt"
      FROM "BuyerAccount"
      WHERE id = ${buyerAccountId}
      FOR UPDATE
    `;

    if (!account) {
      return { success: false, error: "Buyer account not found" } as const;
    }

    const [shop] = await tx<ShopData[]>`
      SELECT domain, currency FROM "Shop" WHERE id = ${account.shopId}
    `;

    if (!shop) {
      return { success: false, error: "Shop not found" } as const;
    }

    const owner = getOwnerGid(account);
    if (!owner) {
      return { 
        success: false, 
        error: `Cannot determine metafield owner for account kind ${account.kind}` 
      } as const;
    }

    const newCreditLimit = limitValidation.value !== undefined 
      ? limitValidation.value 
      : (account.creditLimit ? parseFloat(account.creditLimit) : null);

    const creditLimitPaise = newCreditLimit !== null
      ? BigInt(Math.round(newCreditLimit * 100))
      : null;

    const { exposurePaise, currency } = await computeExposure(tx, buyerAccountId, account.shopId);
    const isOverdue = await hasOverdueInvoices(tx, buyerAccountId);
    const isOverLimit = creditLimitPaise !== null && exposurePaise > creditLimitPaise;

    const holdStateResult = computeHoldState(
      {
        bypass: account.bypass,
        manualHold: update.manualHold,
        isOverLimit,
        isOverdue,
        exposurePaise,
        limitPaise: creditLimitPaise,
      },
      update.holdReasonCode
    );

    const creditLimitValue = newCreditLimit !== null
      ? newCreditLimit.toFixed(2)
      : null;

    const holdReasonCodeValue = update.manualHold ? (update.holdReasonCode ?? null) : null;
    const holdNoteValue = update.manualHold ? (update.holdNote ?? null) : null;

    // Capture previous effective hold state before update
    const wasHeld = isEffectivelyHeld(account.holdState, account.bypass);

    const [updatedRow] = await tx<{ syncVersion: number }[]>`
      UPDATE "BuyerAccount"
      SET
        "creditLimit" = ${creditLimitValue}::numeric,
        "holdState" = ${holdStateResult.holdState}::"HoldState",
        "manualHold" = ${update.manualHold},
        "holdReasonCode" = ${holdReasonCodeValue},
        "holdNote" = ${holdNoteValue},
        "syncPending" = true,
        "syncVersion" = "syncVersion" + 1,
        "updatedAt" = NOW()
      WHERE id = ${buyerAccountId}
      RETURNING "syncVersion"
    `;

    const syncVersion = updatedRow?.syncVersion ?? 0;

    // Check if effective hold changed and record audit event in same transaction
    const isNowHeld = isEffectivelyHeld(holdStateResult.holdState, account.bypass);
    if (wasHeld !== isNowHeld) {
      await recordHoldTransitionAudit(
        tx,
        account.shopId,
        buyerAccountId,
        account.holdState,
        holdStateResult.holdState,
        holdStateResult.holdReasonCode,
        "manual",
        isNowHeld,
      );
    }

    const metafieldValue = serializeCreditStatusFromDb({
      currencyCode: currency,
      hold: holdStateResult.metafieldHold,
      holdReasonCode: holdStateResult.holdReasonCode,
      limitPaise: creditLimitPaise,
      exposurePaise,
    });

    return { 
      success: true, 
      metafieldWriteData: {
        shopDomain: shop.domain,
        ownerGid: owner.gid,
        metafieldValue,
      },
      syncVersion,
    } as TxSuccess;
  });

  if (!txResult.success) {
    return txResult;
  }

  const metafieldResult = await writeMetafield(
    txResult.metafieldWriteData.shopDomain,
    txResult.metafieldWriteData.ownerGid,
    txResult.metafieldWriteData.metafieldValue
  );

  if (!metafieldResult.success) {
    safeLog("error", "credit_status_metafield_write_failed", {
      buyerAccountId,
      err: toErrorCode(metafieldResult.error),
    });
    return {
      success: true,
      metafieldSyncPending: true,
      error: `metafield_sync_failed`,
    };
  }

  const userErrors = metafieldResult.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    safeLog("error", "credit_status_metafield_user_errors", {
      buyerAccountId,
      errorCount: userErrors.length,
    });
    return {
      success: true,
      metafieldSyncPending: true,
      userErrors,
      error: `metafield_user_errors`,
    };
  }

  // Clear syncPending and set metafieldSyncedAt only if syncVersion matches (no newer write occurred)
  const clearResult = await sql<{ id: string }[]>`
    UPDATE "BuyerAccount"
    SET "syncPending" = false, "metafieldSyncedAt" = NOW()
    WHERE id = ${buyerAccountId}
      AND "syncVersion" = ${txResult.syncVersion}
    RETURNING id
  `;

  // If 0 rows updated, a newer write owns syncPending; leave it true
  const cleared = clearResult.length > 0;

  return { success: true, metafieldSyncPending: !cleared };
}

/**
 * Sync credit status metafield for a buyer account.
 *
 * Called during reconciliation or when a sync is pending.
 * Computes the current state from DB and writes the metafield.
 * Reads bypass flag and uses computeHoldState for consistency.
 *
 * Structure:
 * 1. In transaction: lock, compute, update holdState with syncPending=true
 * 2. After commit: write metafield
 * 3. On success: clear syncPending
 * 4. On failure: leave syncPending=true and log
 *
 * @param sql - Database connection
 * @param buyerAccountId - The buyer account to sync
 * @param source - Source of the sync (for audit trail), defaults to 'sync'
 * @returns Result indicating success or failure
 */
export async function syncCreditStatusMetafield(
  sql: Sql,
  buyerAccountId: string,
  source: CreditStatusSource = "sync"
): Promise<CreditStatusUpdateResult> {
  type SyncTxSuccess = { success: true; metafieldWriteData: MetafieldWriteData; syncVersion: number };
  type SyncTxSkip = { success: true; skipMetafield: true };
  type SyncTxError = { success: false; error: string };
  type SyncTxResult = SyncTxSuccess | SyncTxSkip | SyncTxError;

  const txResult: SyncTxResult = await sql.begin(async (tx) => {
    const [account] = await tx<BuyerAccountData[]>`
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
        "holdNote",
        "syncPending",
        gated_at AS "gatedAt"
      FROM "BuyerAccount"
      WHERE id = ${buyerAccountId}
      FOR UPDATE
    `;

    if (!account) {
      return { success: false, error: "Buyer account not found" } as const;
    }

    const [shop] = await tx<ShopData[]>`
      SELECT domain, currency FROM "Shop" WHERE id = ${account.shopId}
    `;

    if (!shop) {
      return { success: false, error: "Shop not found" } as const;
    }

    const owner = getOwnerGid(account);
    if (!owner) {
      await tx`UPDATE "BuyerAccount" SET "syncPending" = false, "metafieldSyncedAt" = NOW() WHERE id = ${buyerAccountId}`;
      return { success: true, skipMetafield: true } as const;
    }

    const { exposurePaise, currency } = await computeExposure(tx, buyerAccountId, account.shopId);
    const creditLimitPaise = account.creditLimit
      ? BigInt(Math.round(parseFloat(account.creditLimit) * 100))
      : null;

    const isOverdue = await hasOverdueInvoices(tx, buyerAccountId);
    const isOverLimit = creditLimitPaise !== null && exposurePaise > creditLimitPaise;

    const holdStateResult = computeHoldState(
      {
        bypass: account.bypass,
        manualHold: account.manualHold,
        isOverLimit,
        isOverdue,
        exposurePaise,
        limitPaise: creditLimitPaise,
      },
      account.holdReasonCode as HoldReasonCode
    );

    // Capture previous effective hold state before update
    const wasHeld = isEffectivelyHeld(account.holdState, account.bypass);

    const [updatedRow] = await tx<{ syncVersion: number }[]>`
      UPDATE "BuyerAccount"
      SET 
        "holdState" = ${holdStateResult.holdState}::"HoldState",
        "syncPending" = true,
        "syncVersion" = "syncVersion" + 1
      WHERE id = ${buyerAccountId}
      RETURNING "syncVersion"
    `;

    const syncVersion = updatedRow?.syncVersion ?? 0;

    // Check if effective hold changed and record audit event in same transaction
    const isNowHeld = isEffectivelyHeld(holdStateResult.holdState, account.bypass);
    if (wasHeld !== isNowHeld) {
      await recordHoldTransitionAudit(
        tx,
        account.shopId,
        buyerAccountId,
        account.holdState,
        holdStateResult.holdState,
        holdStateResult.holdReasonCode,
        source,
        isNowHeld,
      );
    }

    const metafieldValue = serializeCreditStatusFromDb({
      currencyCode: currency,
      hold: holdStateResult.metafieldHold,
      holdReasonCode: holdStateResult.holdReasonCode,
      limitPaise: creditLimitPaise,
      exposurePaise,
    });

    return { 
      success: true,
      metafieldWriteData: {
        shopDomain: shop.domain,
        ownerGid: owner.gid,
        metafieldValue,
      },
      syncVersion,
    } as SyncTxSuccess;
  });

  if (!txResult.success) {
    return { success: false, error: txResult.error };
  }

  if ('skipMetafield' in txResult) {
    return { success: true, metafieldSyncPending: false };
  }

  const metafieldResult = await writeMetafield(
    txResult.metafieldWriteData.shopDomain,
    txResult.metafieldWriteData.ownerGid,
    txResult.metafieldWriteData.metafieldValue
  );

  if (!metafieldResult.success) {
    safeLog("error", "credit_status_metafield_sync_failed", {
      buyerAccountId,
      err: toErrorCode(metafieldResult.error),
    });
    return {
      success: true,
      metafieldSyncPending: true,
      error: `metafield_sync_failed`,
    };
  }

  const userErrors = metafieldResult.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length > 0) {
    safeLog("error", "credit_status_metafield_user_errors", {
      buyerAccountId,
      errorCount: userErrors.length,
    });
    return {
      success: true,
      metafieldSyncPending: true,
      userErrors,
      error: `metafield_user_errors`,
    };
  }

  // Clear syncPending and set metafieldSyncedAt only if syncVersion matches
  const clearResult = await sql<{ id: string }[]>`
    UPDATE "BuyerAccount"
    SET "syncPending" = false, "metafieldSyncedAt" = NOW()
    WHERE id = ${buyerAccountId}
      AND "syncVersion" = ${txResult.syncVersion}
    RETURNING id
  `;

  // If 0 rows updated, a newer write owns syncPending; leave it true
  const cleared = clearResult.length > 0;

  return { success: true, metafieldSyncPending: !cleared };
}

/**
 * Company-level totals rolled up from all locations.
 * Display-only: no Company metafield is written.
 */
export interface CompanyTotals {
  locationCount: number;
  locationsOnHold: number;
  totalLimitPaise: bigint | null;
  totalExposurePaise: bigint;
  totalDraftExposurePaise: bigint;
  totalAvailablePaise: bigint | null;
  currency: string;
  hasMixedCurrencies: boolean;
  excludedLocationCount: number;
}

/**
 * Get company-level totals by rolling up all locations' BuyerAccounts.
 * Returns null for TAGGED_CUSTOMER accounts.
 *
 * Includes draft exposure (status 'open' or 'invoice_sent') in totals.
 */
export async function getCompanyTotals(
  sql: Sql,
  companyId: string,
  shopId: string
): Promise<CompanyTotals | null> {
  if (!companyId) {
    return null;
  }

  const locations = await sql<{
    id: string;
    creditLimit: string | null;
    holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  }[]>`
    SELECT
      id,
      "creditLimit"::text AS "creditLimit",
      "holdState"
    FROM "BuyerAccount"
    WHERE "companyId" = ${companyId}
      AND "shopId" = ${shopId}
      AND kind = 'COMPANY'
  `;

  if (locations.length === 0) {
    return null;
  }

  const [shopResult] = await sql<{ currency: string }[]>`
    SELECT currency FROM "Shop" WHERE id = ${shopId}
  `;
  const shopCurrency = shopResult?.currency ?? "INR";

  const locationIds = locations.map(l => l.id);

  const invoiceExposure = await sql<{
    buyerAccountId: string;
    totalPaise: string;
  }[]>`
    SELECT
      "buyerAccountId",
      COALESCE(SUM((ROUND(outstanding * 100))::bigint), 0)::text AS "totalPaise"
    FROM "Invoice"
    WHERE "buyerAccountId" IN ${sql(locationIds)}
      AND status = 'open'
      AND outstanding > 0
    GROUP BY "buyerAccountId"
  `;

  const draftExposure = await sql<{
    buyerAccountId: string;
    totalPaise: string;
  }[]>`
    SELECT
      buyer_account_id AS "buyerAccountId",
      COALESCE(SUM((ROUND(total * 100))::bigint), 0)::text AS "totalPaise"
    FROM "s8_draft_orders"
    WHERE buyer_account_id IN ${sql(locationIds)}
      AND has_payment_terms = true
      AND status IN ('open', 'invoice_sent')
    GROUP BY buyer_account_id
  `;

  const invoiceByAccount = new Map(
    invoiceExposure.map(r => [r.buyerAccountId, BigInt(r.totalPaise)])
  );
  const draftByAccount = new Map(
    draftExposure.map(r => [r.buyerAccountId, BigInt(r.totalPaise)])
  );

  let totalLimitPaise: bigint | null = 0n;
  let totalExposurePaise = 0n;
  let totalDraftExposurePaise = 0n;
  let locationsOnHold = 0;
  let hasAnyNoLimit = false;

  for (const loc of locations) {
    const invoiceExp = invoiceByAccount.get(loc.id) ?? 0n;
    const draftExp = draftByAccount.get(loc.id) ?? 0n;
    totalExposurePaise += invoiceExp + draftExp;
    totalDraftExposurePaise += draftExp;

    if (loc.creditLimit === null) {
      hasAnyNoLimit = true;
    } else if (totalLimitPaise !== null) {
      totalLimitPaise += BigInt(Math.round(parseFloat(loc.creditLimit) * 100));
    }

    if (loc.holdState === "HELD") {
      locationsOnHold++;
    }
  }

  if (hasAnyNoLimit) {
    totalLimitPaise = null;
  }

  const totalAvailablePaise = totalLimitPaise !== null
    ? totalLimitPaise - totalExposurePaise
    : null;

  return {
    locationCount: locations.length,
    locationsOnHold,
    totalLimitPaise,
    totalExposurePaise,
    totalDraftExposurePaise,
    totalAvailablePaise,
    currency: shopCurrency,
    hasMixedCurrencies: false,
    excludedLocationCount: 0,
  };
}

/**
 * Get credit status for display in the UI.
 */
export interface CreditStatusDisplay {
  creditLimitAmount: number | null;
  creditLimitPaise: bigint | null;
  exposurePaise: bigint;
  draftExposurePaise: bigint;
  availableCreditPaise: bigint | null;
  currency: string;
  holdState: "OK" | "NEAR_LIMIT" | "HELD" | "BYPASS";
  manualHold: boolean;
  holdReasonCode: string | null;
  holdNote: string | null;
  isOnHold: boolean;
  holdReasonDisplay: string | null;
  isOverLimit: boolean;
  isOverdue: boolean;
  utilizationPercent: number | null;
  syncPending: boolean;
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
      "manualHold",
      "holdReasonCode",
      "holdNote",
      "syncPending",
      gated_at AS "gatedAt"
    FROM "BuyerAccount"
    WHERE id = ${buyerAccountId}
  `;

  if (!account) {
    return null;
  }

  const { exposurePaise, draftExposurePaise, currency } = await computeExposure(
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

  const isOverdue = await hasOverdueInvoices(sql, buyerAccountId);
  const isOverLimit = creditLimitPaise !== null && exposurePaise > creditLimitPaise;

  const holdStateResult = computeHoldState(
    {
      bypass: account.bypass,
      manualHold: account.manualHold,
      isOverLimit,
      isOverdue,
      exposurePaise,
      limitPaise: creditLimitPaise,
    },
    account.holdReasonCode as HoldReasonCode
  );

  let holdReasonDisplay: string | null = null;
  if (account.bypass) {
    holdReasonDisplay = "Bypass active";
  } else if (account.manualHold) {
    holdReasonDisplay = "Manual hold";
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
    draftExposurePaise,
    availableCreditPaise,
    currency,
    holdState: holdStateResult.holdState,
    manualHold: account.manualHold,
    holdReasonCode: account.holdReasonCode,
    holdNote: account.holdNote,
    isOnHold: holdStateResult.metafieldHold,
    holdReasonDisplay,
    isOverLimit,
    isOverdue,
    utilizationPercent,
    syncPending: account.syncPending,
  };
}
