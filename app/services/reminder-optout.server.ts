/**
 * Buyer reminder opt-out helpers (S18 #232).
 *
 * Provides shop-scoped functions for checking and handling buyer opt-out
 * for payment reminder emails. Implements RFC 8058 one-click unsubscribe.
 *
 * These helpers are called by the REMINDER_SEND and REMINDER_CATCHUP handlers
 * in the eligibility check phase, BEFORE any cap reservation or Resend call.
 *
 * Design principles:
 * - All queries are shop-scoped (WHERE shopId = X AND id = Y, never id alone)
 * - Small, focused functions that drop into #244's reworked handler structure
 * - No vi.mock of log.server.ts; uses real safeLog
 */

import type { Sql } from "~/lib/db-light.server";
import { safeLog } from "~/lib/log.server";

/**
 * Check if a buyer account has opted out of payment reminders.
 *
 * @param sql - Database connection (transaction or root)
 * @param shopId - Shop ID (required for shop-scoped query)
 * @param buyerAccountId - Buyer account ID
 * @returns true if buyer has opted out (reminder_opt_out_at IS NOT NULL)
 */
export async function isBuyerOptedOut(
  sql: Sql,
  shopId: string,
  buyerAccountId: string
): Promise<boolean> {
  const [row] = await sql<{ optedOut: boolean }[]>`
    SELECT (reminder_opt_out_at IS NOT NULL) AS "optedOut"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND id = ${buyerAccountId}
  `;
  return row?.optedOut ?? false;
}

/**
 * Record a skipped reminder due to buyer opt-out (for REMINDER_SEND handler).
 *
 * Inserts a ReminderLog row with status='skipped_opted_out' and sentAt=NULL.
 * This row prevents s18_enqueue_reminders() Part 3's NOT EXISTS from
 * re-enqueuing this stage.
 *
 * Uses INSERT ... ON CONFLICT DO NOTHING to handle duplicates gracefully.
 *
 * @param sql - Database connection (transaction or root)
 * @param shopId - Shop ID (required for shop-scoped insert)
 * @param ruleId - Reminder rule ID
 * @param invoiceId - Invoice ID
 */
export async function recordSkippedOptedOut(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<void> {
  await sql`
    INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
    VALUES (gen_random_uuid()::TEXT, ${shopId}, ${ruleId}, ${invoiceId}, 'skipped_opted_out'::"ReminderLogStatus", NULL)
    ON CONFLICT ("ruleId", "invoiceId") DO NOTHING
  `;

  safeLog("info", "reminder_skipped_opted_out", {
    shopId,
    ruleId,
    invoiceId,
    action: "recorded",
  });
}

/**
 * Transition a delayed reminder to skipped_opted_out (for REMINDER_CATCHUP handler).
 *
 * Updates an existing ReminderLog row from status='delayed' to 'skipped_opted_out'.
 * Only updates rows that are currently 'delayed' (idempotent).
 * Shop-scoped WHERE clause ensures cross-shop safety.
 *
 * @param sql - Database connection (transaction or root)
 * @param shopId - Shop ID (required for shop-scoped update)
 * @param ruleId - Reminder rule ID
 * @param invoiceId - Invoice ID
 * @returns true if a row was updated, false if no matching delayed row found
 */
export async function transitionDelayedToOptedOut(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE "ReminderLog"
    SET status = 'skipped_opted_out'::"ReminderLogStatus"
    WHERE "shopId" = ${shopId}
      AND "ruleId" = ${ruleId}
      AND "invoiceId" = ${invoiceId}
      AND status = 'delayed'::"ReminderLogStatus"
    RETURNING id
  `;

  const updated = result.length > 0;

  if (updated) {
    safeLog("info", "reminder_delayed_to_opted_out", {
      shopId,
      ruleId,
      invoiceId,
      action: "transitioned",
    });
  }

  return updated;
}

/**
 * Set buyer opt-out status (for unsubscribe link handler).
 *
 * Sets reminder_opt_out_at and reminder_opt_out_source on the buyer account.
 * Shop-scoped WHERE clause ensures cross-shop safety.
 * Idempotent: if already opted out, no change is made.
 *
 * @param sql - Database connection (transaction or root)
 * @param shopId - Shop ID (required for shop-scoped update)
 * @param buyerAccountId - Buyer account ID
 * @param source - Opt-out source: 'link' (unsubscribe) or 'merchant' (toggle)
 * @returns true if opt-out was set, false if already opted out or account not found
 */
export async function setBuyerOptOut(
  sql: Sql,
  shopId: string,
  buyerAccountId: string,
  source: "merchant" | "link"
): Promise<boolean> {
  const result = await sql`
    UPDATE "BuyerAccount"
    SET
      reminder_opt_out_at = NOW(),
      reminder_opt_out_source = ${source}::"ReminderOptOutSource",
      "updatedAt" = NOW()
    WHERE "shopId" = ${shopId}
      AND id = ${buyerAccountId}
      AND reminder_opt_out_at IS NULL
    RETURNING id
  `;

  const updated = result.length > 0;

  if (updated) {
    safeLog("info", "buyer_reminder_opt_out_set", {
      shopId,
      buyerAccountId,
      source,
    });
  }

  return updated;
}

/**
 * Clear buyer opt-out status (for merchant toggle re-enable).
 *
 * Clears reminder_opt_out_at and reminder_opt_out_source on the buyer account.
 * Shop-scoped WHERE clause ensures cross-shop safety.
 * Only merchants can re-enable; the unsubscribe link cannot clear opt-out.
 *
 * @param sql - Database connection (transaction or root)
 * @param shopId - Shop ID (required for shop-scoped update)
 * @param buyerAccountId - Buyer account ID
 * @returns true if opt-out was cleared, false if not opted out or account not found
 */
export async function clearBuyerOptOut(
  sql: Sql,
  shopId: string,
  buyerAccountId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE "BuyerAccount"
    SET
      reminder_opt_out_at = NULL,
      reminder_opt_out_source = NULL,
      "updatedAt" = NOW()
    WHERE "shopId" = ${shopId}
      AND id = ${buyerAccountId}
      AND reminder_opt_out_at IS NOT NULL
    RETURNING id
  `;

  const updated = result.length > 0;

  if (updated) {
    safeLog("info", "buyer_reminder_opt_out_cleared", {
      shopId,
      buyerAccountId,
      source: "merchant",
    });
  }

  return updated;
}

/**
 * Get buyer opt-out status with details.
 *
 * @param sql - Database connection (transaction or root)
 * @param shopId - Shop ID (required for shop-scoped query)
 * @param buyerAccountId - Buyer account ID
 * @returns Opt-out details or null if account not found
 */
export async function getBuyerOptOutStatus(
  sql: Sql,
  shopId: string,
  buyerAccountId: string
): Promise<{
  optedOut: boolean;
  optOutAt: Date | null;
  optOutSource: "merchant" | "link" | null;
} | null> {
  const [row] = await sql<{
    optOutAt: Date | null;
    optOutSource: "merchant" | "link" | null;
  }[]>`
    SELECT
      reminder_opt_out_at AS "optOutAt",
      reminder_opt_out_source AS "optOutSource"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND id = ${buyerAccountId}
  `;

  if (!row) {
    return null;
  }

  return {
    optedOut: row.optOutAt !== null,
    optOutAt: row.optOutAt,
    optOutSource: row.optOutSource,
  };
}
