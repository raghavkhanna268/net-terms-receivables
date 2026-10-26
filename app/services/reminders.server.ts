/**
 * Payment Reminder Service (S18).
 *
 * Sends payment reminder emails via Resend for invoices at configured
 * offsets from their due date. Enforces:
 * - RESEND_API_KEY gate (no sends without key, acks without consuming slot)
 * - CUSTOMER_PII_FIELDS gate (skip if buyer has no email due to PII off)
 * - Global daily cap (100/day per Resend account)
 * - Global monthly cap (3,000/month per Resend account)
 * - Idempotency via ReminderLog unique index on (ruleId, invoiceId)
 * - Invoice status re-check (no reminders for paid/closed invoices)
 * - Shop timezone for day math (from Shop.timezone, S7)
 * - Send window (09:00-19:00 in shop's local time)
 *
 * Resend Free Tier Limits (verified at https://resend.com/pricing on 2026-10-25):
 *   - 100 emails/day per account (GLOBAL) - "The Free plan is limited to 100 emails per day."
 *   - 3,000 emails/month per account (GLOBAL) - "Free: 3,000 [emails/mo]"
 *
 * Cap behavior:
 *   - Caps are enforced GLOBALLY across all shops sharing the same Resend API key
 *   - Daily cap resets at midnight UTC
 *   - Monthly cap resets on the 1st of each month UTC
 *   - Atomic increment with cap check prevents race conditions
 *
 * DPDP Compliance:
 *   - Only email and displayName are used (no phone, no address)
 *   - PII is not stored in reminder logs (only invoiceId and ruleId)
 *   - Customer email comes from CUSTOMER_PII_FIELDS mechanism (S8)
 */

import type { Sql } from "~/lib/db-light.server";
import { renderPaymentReminderEmail } from "~/emails/PaymentReminderEmail";
import { validateTimezone } from "~/lib/aging-dates.server";
import { DateTime } from "luxon";
import { safeLog, toErrorCode } from "~/lib/log.server";
import {
  isBuyerOptedOut,
  recordSkippedOptedOut,
  transitionDelayedToOptedOut,
} from "./reminder-optout.server";
import {
  buildUnsubscribeHeaders,
  canGenerateUnsubscribeHeaders,
} from "./reminder-headers.server";
import {
  parseRecipientAllowlist,
  isRecipientAllowed,
} from "./recipient-allowlist.server";
import { sendViaResend } from "./resend-client.server";

/**
 * Check if plan gating enforcement is enabled.
 * Reads PLAN_GATING_ENFORCED from environment variable.
 * 
 * NOTE: SQL enqueue does NOT filter gated accounts. TS is the sole gating point.
 * This prevents SQL and TS from disagreeing on gating policy. A gated invoice
 * may be re-enqueued on its due day or within D+1..D+3, but TS drops it before
 * any Resend call. The re-enqueue is bounded by the catch-up window.
 */
function isGatingEnforced(): boolean {
  const env = process.env.PLAN_GATING_ENFORCED as string | undefined;
  return env === "1" || env === "true";
}

/**
 * Check if a buyer account is active (not gated) for reminder purposes.
 * @param gatedAt - The gated_at timestamp from BuyerAccount
 */
function isAccountActive(gatedAt: Date | null): boolean {
  if (!isGatingEnforced()) {
    return true;
  }
  return gatedAt === null;
}

/**
 * Daily send cap (Resend free tier: 100 emails/day).
 * @see https://resend.com/pricing
 */
export const DAILY_SEND_CAP = 100;

/**
 * Monthly send cap (Resend free tier: 3,000 emails/month).
 * @see https://resend.com/pricing
 */
export const MONTHLY_SEND_CAP = 3000;

/**
 * Global key for cap tracking (Resend limits are per account, not per shop).
 */
const GLOBAL_SEND_KEY = "global";

/**
 * Send window hours (09:00-19:00 in shop's local time).
 */
const SEND_WINDOW_START = 9;
const SEND_WINDOW_END = 19;

/**
 * Check if reminder sending is enabled.
 * Requires BOTH RESEND_API_KEY AND RESEND_FROM to be set.
 */
export function isReminderSendingEnabled(
  env: { RESEND_API_KEY?: string; RESEND_FROM?: string } = {}
): boolean {
  const key = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  const from = env.RESEND_FROM ?? process.env.RESEND_FROM;
  const hasKey = typeof key === "string" && key.trim().length > 0;
  const hasFrom = typeof from === "string" && from.trim().length > 0;
  return hasKey && hasFrom;
}

/**
 * Get the sender email address from environment.
 * Returns null if not configured.
 */
export function getResendFrom(
  env: { RESEND_FROM?: string } = {}
): string | null {
  const from = env.RESEND_FROM ?? process.env.RESEND_FROM;
  return typeof from === "string" && from.trim().length > 0 ? from.trim() : null;
}

/**
 * Check if current time is within the send window for a shop.
 * Send window: 09:00-19:00 in shop's local time.
 */
export function isWithinSendWindow(timezone: string): boolean {
  const validTz = validateTimezone(timezone);
  const now = DateTime.now().setZone(validTz);
  const hour = now.hour;
  return hour >= SEND_WINDOW_START && hour < SEND_WINDOW_END;
}

/**
 * Check if today (in shop's timezone) is the right day for a reminder.
 */
export function isReminderDueToday(
  dueAt: Date,
  offsetDays: number,
  timezone: string
): boolean {
  const validTz = validateTimezone(timezone);
  const today = DateTime.now().setZone(validTz).startOf("day");
  const dueDate = DateTime.fromJSDate(dueAt, { zone: validTz }).startOf("day");
  const reminderDate = dueDate.plus({ days: offsetDays });
  return reminderDate.hasSame(today, "day");
}

/**
 * Invoice data needed for sending a reminder.
 */
export interface ReminderInvoiceData {
  invoiceId: string;
  shopId: string;
  shopDomain: string;
  shopName: string;
  shopTimezone: string;
  invoiceName: string;
  total: string;
  outstanding: string;
  currency: string;
  dueAt: Date;
  status: "open" | "paid" | "cancelled";
  buyerEmail: string | null;
  buyerName: string | null;
  buyerAccountGatedAt: Date | null;
  shopUninstalledAt: Date | null;
}

/**
 * Result of a reminder send attempt.
 */
export interface ReminderSendResult {
  success: boolean;
  action: "sent" | "skipped" | "capped" | "disabled" | "outside_window";
  skipReason?: string;
  resendId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
}

/**
 * Get invoice data needed for sending a reminder.
 * 
 * Recipient resolution by account type:
 * - COMPANY (B2B): uses mainContactEmail and mainContactName from BuyerAccount
 * - TAGGED_CUSTOMER: uses email and displayName from s8_tagged_customers
 * 
 * Both require CUSTOMER_PII_FIELDS=1 for PII fields to be populated.
 */
export async function getInvoiceForReminder(
  sql: Sql,
  shopId: string,
  invoiceId: string
): Promise<ReminderInvoiceData | null> {
  const [row] = await sql<
    {
      invoiceId: string;
      shopId: string;
      shopDomain: string;
      shopTimezone: string;
      invoiceName: string;
      total: string;
      outstanding: string;
      currency: string;
      dueAt: Date | null;
      status: string;
      buyerAccountId: string;
      accountKind: string;
      customerId: string | null;
      mainContactEmail: string | null;
      mainContactDisplayName: string | null;
      buyerAccountGatedAt: Date | null;
      shopUninstalledAt: Date | null;
    }[]
  >`
    SELECT
      i.id AS "invoiceId",
      i."shopId",
      s.domain AS "shopDomain",
      s.timezone AS "shopTimezone",
      i.name AS "invoiceName",
      i.total::TEXT,
      i.outstanding::TEXT,
      s.currency,
      i."dueAt",
      i.status,
      i."buyerAccountId",
      ba.kind::TEXT AS "accountKind",
      ba."customerId",
      ba."mainContactEmail",
      ba."mainContactName" AS "mainContactDisplayName",
      ba.gated_at AS "buyerAccountGatedAt",
      s."uninstalledAt" AS "shopUninstalledAt"
    FROM "Invoice" i
    INNER JOIN "Shop" s ON s.id = i."shopId"
    INNER JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i.id = ${invoiceId}
      AND i."shopId" = ${shopId}
  `;

  if (!row || !row.dueAt) {
    return null;
  }

  // Resolve recipient email and name by account type
  let buyerEmail: string | null = null;
  let buyerDisplayName: string | null = null;

  if (row.accountKind === "COMPANY") {
    // B2B: use mainContactEmail and mainContactName from BuyerAccount
    buyerEmail = row.mainContactEmail;
    buyerDisplayName = row.mainContactDisplayName;
  } else if (row.customerId) {
    // Tagged customer: get email/displayName from s8_tagged_customers
    // This data is only present when CUSTOMER_PII_FIELDS=1 (S8)
    const [customer] = await sql<{ email: string | null; displayName: string | null }[]>`
      SELECT email, display_name AS "displayName"
      FROM s8_tagged_customers
      WHERE shop_id = ${shopId}
        AND customer_id = ${row.customerId}
    `;
    if (customer) {
      buyerEmail = customer.email;
      buyerDisplayName = customer.displayName;
    }
  }

  const shopLabel = row.shopDomain.replace(".myshopify.com", "");
  const shopTimezone = validateTimezone(row.shopTimezone);

  return {
    invoiceId: row.invoiceId,
    shopId: row.shopId,
    shopDomain: row.shopDomain,
    shopName: shopLabel,
    shopTimezone,
    invoiceName: row.invoiceName,
    total: row.total,
    outstanding: row.outstanding,
    currency: row.currency,
    dueAt: row.dueAt,
    status: row.status as "open" | "paid" | "cancelled",
    buyerEmail,
    buyerName: buyerDisplayName,
    buyerAccountGatedAt: row.buyerAccountGatedAt,
    shopUninstalledAt: row.shopUninstalledAt,
  };
}

/**
 * Get the buyer account ID for an invoice.
 * Used for opt-out check before sending reminders.
 */
export async function getBuyerAccountId(
  sql: Sql,
  shopId: string,
  invoiceId: string
): Promise<string | null> {
  const [row] = await sql<{ buyerAccountId: string }[]>`
    SELECT "buyerAccountId"
    FROM "Invoice"
    WHERE id = ${invoiceId} AND "shopId" = ${shopId}
  `;
  return row?.buyerAccountId ?? null;
}

/**
 * Check if reminder was already sent for this invoice/rule combination.
 * Returns true if a ReminderLog entry exists.
 */
export async function isReminderAlreadySent(
  sql: Sql,
  ruleId: string,
  invoiceId: string
): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM "ReminderLog"
      WHERE "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
    ) AS exists
  `;
  return row?.exists ?? false;
}

/**
 * Claim a reminder slot in ReminderLog before sending.
 * Uses INSERT ... ON CONFLICT DO NOTHING to ensure idempotency.
 * Returns true if the slot was claimed (we should send).
 */
export async function claimReminderSlot(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<boolean> {
  const result = await sql`
    INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
    VALUES (gen_random_uuid()::TEXT, ${shopId}, ${ruleId}, ${invoiceId}, NOW(), 'sent'::"ReminderLogStatus")
    ON CONFLICT ("ruleId", "invoiceId") DO NOTHING
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Upsert a delayed reminder log entry when the send is capped.
 * - If no entry exists, create one with status='delayed' and firstCappedAt=NOW()
 * - If an entry already exists with status='delayed', keep it (do nothing)
 * - If an entry already exists with status='sent', keep it (do nothing - already sent)
 */
export async function upsertDelayedReminder(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<void> {
  await sql`
    INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
    VALUES (gen_random_uuid()::TEXT, ${shopId}, ${ruleId}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
    ON CONFLICT ("ruleId", "invoiceId") DO NOTHING
  `;
}

/**
 * Mark a delayed reminder as sent.
 * Updates status to 'sent' and sets sentAt.
 * Preserves firstCappedAt for "sent late" tracking in the UI.
 * Returns true if the update succeeded.
 */
export async function markDelayedAsSent(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<boolean> {
  const result = await sql`
    UPDATE "ReminderLog"
    SET status = 'sent'::"ReminderLogStatus", "sentAt" = NOW()
    WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId} AND status = 'delayed'::"ReminderLogStatus"
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Delete a delayed reminder log entry.
 * Used when eligibility re-check fails before catch-up send.
 */
export async function deleteDelayedReminder(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<void> {
  await sql`
    DELETE FROM "ReminderLog"
    WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId} AND status = 'delayed'::"ReminderLogStatus"
  `;
}

/**
 * Get the reminder log status for a rule/invoice pair.
 */
export async function getReminderLogStatus(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<{ status: "sent" | "delayed" | "skipped_daily_limit"; firstCappedAt: Date | null } | null> {
  const [row] = await sql<{ status: string; firstCappedAt: Date | null }[]>`
    SELECT status, "firstCappedAt"
    FROM "ReminderLog"
    WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
  `;
  if (!row) return null;
  return {
    status: row.status as "sent" | "delayed" | "skipped_daily_limit",
    firstCappedAt: row.firstCappedAt,
  };
}

/**
 * Acquire a per-invoice advisory lock within a transaction.
 * Ensures at most one reminder per invoice per shop-local day.
 * The lock is released when the transaction commits/rolls back.
 */
export async function acquireInvoiceLock(
  tx: Sql,
  invoiceId: string
): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${INVOICE_LOCK_KEY_PREFIX + invoiceId}))`;
}

/**
 * Check if an invoice already has a reminder sent today (shop-local day).
 * Used to enforce at-most-one-per-invoice-per-day.
 */
export async function hasReminderSentToday(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  timezone: string
): Promise<boolean> {
  const validTz = validateTimezone(timezone);
  const [row] = await sql<{ sentToday: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM "ReminderLog"
      WHERE "shopId" = ${shopId}
        AND "invoiceId" = ${invoiceId}
        AND status = 'sent'::"ReminderLogStatus"
        AND ("sentAt" AT TIME ZONE ${validTz})::DATE = (NOW() AT TIME ZONE ${validTz})::DATE
    ) AS "sentToday"
  `;
  return row?.sentToday ?? false;
}

/**
 * Check if a newer stage (higher offsetDays) exists for this invoice.
 * A newer stage with ANY status (sent, delayed, or skipped) takes precedence.
 * Returns true if a newer stage exists, meaning this older delayed stage should be skipped.
 */
export async function hasNewerStageForInvoice(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  ruleId: string,
  offsetDays: number
): Promise<boolean> {
  const [row] = await sql<{ hasNewer: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM "ReminderLog" rl
      INNER JOIN "ReminderRule" r ON r.id = rl."ruleId"
      WHERE rl."shopId" = ${shopId}
        AND rl."invoiceId" = ${invoiceId}
        AND rl."ruleId" != ${ruleId}
        AND r."offsetDays" > ${offsetDays}
    ) AS "hasNewer"
  `;
  return row?.hasNewer ?? false;
}

/**
 * Check if a newer stage (higher offsetDays) is due TODAY for this invoice.
 * This catches the case where a newer stage has no log row yet but will be
 * enqueued by Part 3 of s18_enqueue_reminders() on the same day.
 * One reminder per invoice per day: newer stage wins.
 */
export async function hasNewerStageDueToday(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  offsetDays: number,
  timezone: string
): Promise<boolean> {
  const validTz = validateTimezone(timezone);
  const [row] = await sql<{ hasNewer: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM "ReminderRule" r
      INNER JOIN "Invoice" i ON i."shopId" = r."shopId" AND i.id = ${invoiceId}
      INNER JOIN s18_shop_reminder_settings srs ON srs.shop_id = r."shopId" AND srs.enabled = true
      WHERE r."shopId" = ${shopId}
        AND r.enabled = true
        AND r.channel = 'email'::"ReminderChannel"
        AND r."offsetDays" > ${offsetDays}
        AND i."dueAt" IS NOT NULL
        -- This rule is due today in shop's timezone
        AND (i."dueAt" AT TIME ZONE ${validTz})::DATE + r."offsetDays"
            = (NOW() AT TIME ZONE ${validTz})::DATE
    ) AS "hasNewer"
  `;
  return row?.hasNewer ?? false;
}

/**
 * Remove a claimed reminder slot (on send failure, to allow retry).
 */
export async function releaseReminderSlot(
  sql: Sql,
  shopId: string,
  ruleId: string,
  invoiceId: string
): Promise<void> {
  await sql`
    DELETE FROM "ReminderLog"
    WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
  `;
}

/**
 * Get current GLOBAL daily and monthly send counts.
 * Uses UTC day by design (resets at 05:30 IST). Monthly count is computed
 * as SUM of daily_count for all days in the current month (not stored in
 * monthly_count column for consistency - that column is deprecated).
 */
export async function getGlobalSendCounts(
  sql: Sql,
  date: Date = new Date()
): Promise<{ daily: number; monthly: number }> {
  const dateStr = date.toISOString().split("T")[0];
  const monthStr = dateStr.substring(0, 7); // YYYY-MM

  // Get daily count for today and monthly total (SUM of all daily_counts this month)
  const [row] = await sql<{ dailyCount: number; monthlyTotal: number }[]>`
    SELECT 
      COALESCE((
        SELECT daily_count FROM s18_global_sends 
        WHERE send_key = ${GLOBAL_SEND_KEY} AND send_date = ${dateStr}::DATE
      ), 0) AS "dailyCount",
      COALESCE((
        SELECT SUM(daily_count)::INT FROM s18_global_sends 
        WHERE send_key = ${GLOBAL_SEND_KEY} AND send_month = ${monthStr}
      ), 0) AS "monthlyTotal"
  `;

  return { daily: row?.dailyCount ?? 0, monthly: row?.monthlyTotal ?? 0 };
}

/**
 * Advisory lock key for global send cap reservation.
 *
 * This is a GLOBAL lock (not per-shop) because Resend limits are per-account,
 * not per-shop. All shops sharing the same RESEND_API_KEY share this cap.
 *
 * UNIQUENESS CHECK (2026-10-25): Searched app/, prisma/, supabase/, scripts/ for
 * pg_advisory and hashtext. Existing locks:
 * - hashtext(shop) for offline-token refresh (shop-scoped)
 * - hashtext('s18_rules_' || shopId) for ensureDefaultReminderRules (shop-scoped)
 *
 * This constant 's18_global_send_cap' is distinct from all existing lock keys.
 */
const GLOBAL_SEND_CAP_LOCK_KEY = "s18_global_send_cap";

/**
 * Advisory lock key prefix for per-invoice reminder locks.
 *
 * Ensures at most one reminder per invoice per shop-local day.
 * The full key is 's18_invoice_' || invoiceId.
 *
 * UNIQUENESS CHECK (2026-10-25): Distinct from:
 * - hashtext(shop) for offline-token refresh
 * - hashtext('s18_rules_' || shopId) for ensureDefaultReminderRules
 * - 's18_global_send_cap' for global cap
 */
const INVOICE_LOCK_KEY_PREFIX = "s18_invoice_";

/**
 * Catch-up window: D+1 to D+3 in shop-local days.
 * Reminders past D+3 are marked skipped_daily_limit.
 */
export const CATCHUP_WINDOW_DAYS = 3;

/**
 * Atomically reserve a send slot (increment count) with cap enforcement.
 * Returns { reserved: true, daily, monthly } if reservation succeeded.
 * Returns { reserved: false, reason } if caps would be exceeded.
 *
 * Uses UTC day by design (resets at 05:30 IST).
 *
 * Uses pg_advisory_xact_lock inside a transaction to serialize concurrent
 * reservations. The lock and all reads/writes happen on the same connection,
 * ensuring atomicity. This fixes the race condition in the previous CTE-based
 * approach where the INSERT ... SELECT would fail to fire ON CONFLICT DO UPDATE
 * once a row existed for today.
 *
 * The monthly cap is checked by computing SUM(daily_count) for the month
 * in the same transaction, ensuring consistency with daily rollover.
 */
export async function reserveGlobalSendSlot(
  sql: Sql,
  date: Date = new Date()
): Promise<
  | { reserved: true; daily: number; monthly: number }
  | { reserved: false; reason: "daily_cap" | "monthly_cap" }
> {
  const dateStr = date.toISOString().split("T")[0];
  const monthStr = dateStr.substring(0, 7); // YYYY-MM

  // The actual reservation logic
  const doReserve = async (tx: Sql): Promise<
    | { reserved: true; daily: number; monthly: number }
    | { reserved: false; reason: "daily_cap" | "monthly_cap" }
  > => {
    // Acquire advisory lock for the duration of the transaction.
    // This serializes all concurrent reservations across all shops.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${GLOBAL_SEND_CAP_LOCK_KEY}))`;

    // Read current counts for today and the month
    const [counts] = await tx<{ dailyCount: number; monthlyTotal: number }[]>`
      SELECT 
        COALESCE((
          SELECT daily_count FROM s18_global_sends 
          WHERE send_key = ${GLOBAL_SEND_KEY} AND send_date = ${dateStr}::DATE
        ), 0) AS "dailyCount",
        COALESCE((
          SELECT SUM(daily_count)::INT FROM s18_global_sends 
          WHERE send_key = ${GLOBAL_SEND_KEY} AND send_month = ${monthStr}
        ), 0) AS "monthlyTotal"
    `;

    const currentDaily = counts?.dailyCount ?? 0;
    const currentMonthly = counts?.monthlyTotal ?? 0;

    // Check monthly cap first (more restrictive over time)
    if (currentMonthly >= MONTHLY_SEND_CAP) {
      return { reserved: false, reason: "monthly_cap" as const };
    }

    // Check daily cap
    if (currentDaily >= DAILY_SEND_CAP) {
      return { reserved: false, reason: "daily_cap" as const };
    }

    // Reserve the slot by incrementing (or inserting) the row
    const [result] = await tx<{ dailyCount: number }[]>`
      INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
      VALUES (${GLOBAL_SEND_KEY}, ${dateStr}::DATE, ${monthStr}, 1, 0, NOW())
      ON CONFLICT (send_key, send_date) DO UPDATE
      SET 
        daily_count = s18_global_sends.daily_count + 1,
        updated_at = NOW()
      RETURNING daily_count AS "dailyCount"
    `;

    return {
      reserved: true,
      daily: result.dailyCount,
      monthly: currentMonthly + 1,
    };
  };

  // Check if sql has a begin method (i.e., it's a root sql, not a transaction)
  // If it does, start our own transaction. If not, we're already in one.
  if (typeof (sql as { begin?: unknown }).begin === "function") {
    return (sql as Sql & { begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T> }).begin(doReserve);
  }
  // Already in a transaction, use the tx directly
  return doReserve(sql);
}

/**
 * Release a previously reserved send slot (decrement count).
 * Used when send fails with non-retryable error to avoid wasting cap.
 * Uses UTC day by design (resets at 05:30 IST).
 */
export async function releaseGlobalSendSlot(
  sql: Sql,
  date: Date = new Date()
): Promise<void> {
  const dateStr = date.toISOString().split("T")[0];

  await sql`
    UPDATE s18_global_sends
    SET daily_count = GREATEST(0, daily_count - 1), updated_at = NOW()
    WHERE send_key = ${GLOBAL_SEND_KEY} AND send_date = ${dateStr}::DATE
  `;
}

/**
 * Format amount in the shop's currency for display.
 * Invoice.total is Decimal(14,2) in shop currency (e.g. rupees), NOT paise.
 */
function formatAmount(amount: string, currency: string): string {
  const numericAmount = Number(amount);
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
    }).format(numericAmount);
  } catch {
    return `${currency} ${numericAmount.toFixed(2)}`;
  }
}

/**
 * Format date for display in the shop's timezone.
 */
function formatDate(date: Date, timezone: string): string {
  const validTz = validateTimezone(timezone);
  const dt = DateTime.fromJSDate(date, { zone: validTz });
  return dt.toLocaleString(DateTime.DATE_FULL);
}

/**
 * Get rule offset label for email subject.
 */
export function getReminderLabel(offsetDays: number): string {
  if (offsetDays < 0) {
    const days = Math.abs(offsetDays);
    return `Payment due in ${days} day${days !== 1 ? "s" : ""}`;
  } else if (offsetDays === 0) {
    return "Payment due today";
  } else {
    return `Payment ${offsetDays} day${offsetDays !== 1 ? "s" : ""} overdue`;
  }
}

/**
 * Send a payment reminder email via Resend.
 *
 * This function:
 * 1. Checks provider gate (RESEND_API_KEY + RESEND_FROM) - if missing, acks WITHOUT consuming slot/cap
 * 2. Checks send window (09:00-19:00 in shop's timezone)
 * 3. Checks if buyer account is gated (over plan limit) - skips when PLAN_GATING_ENFORCED=true
 * 4. Verifies invoice is still open
 * 5. Re-checks if reminder day matches today in shop's timezone
 * 6. Checks buyer has email (via CUSTOMER_PII_FIELDS mechanism)
 * 7. Claims the reminder slot (idempotency)
 * 8. Reserves global cap slot atomically
 * 9. Sends via Resend API with Idempotency-Key header
 * 10. On non-retryable error (401, 4xx): releases cap slot to avoid waste
 *
 * @param sql - Database connection
 * @param shopId - Shop ID
 * @param invoiceId - Invoice ID
 * @param ruleId - Reminder rule ID
 * @param offsetDays - Days offset from due date
 * @param timezone - Shop's IANA timezone
 * @param env - Environment variables (RESEND_API_KEY, RESEND_FROM)
 */
export async function sendPaymentReminder(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  ruleId: string,
  offsetDays: number,
  timezone: string,
  env: { RESEND_API_KEY?: string; RESEND_FROM?: string; REMINDER_UNSUBSCRIBE_SECRET?: string; SHOPIFY_APP_URL?: string; RESEND_TEST_RECIPIENTS?: string } = {},
  deps: { reserveGlobalSendSlot?: typeof reserveGlobalSendSlot } = {}
): Promise<ReminderSendResult> {
  const resendKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  const fromEmail = getResendFrom(env);
  const validTz = validateTimezone(timezone);

  // Gate 1: Check provider config - if missing, ack WITHOUT consuming slot
  // This allows the reminder to fire again once both keys are configured
  if (!isReminderSendingEnabled(env)) {
    safeLog("info", "reminders_disabled", { shopId });
    return {
      success: true, // Ack the message to prevent retry storm
      action: "disabled",
      skipReason: "reminders disabled: no provider config",
    };
  }

  // Gate 2: Check send window (09:00-19:00 in shop's timezone)
  if (!isWithinSendWindow(validTz)) {
    return {
      success: true, // Ack - the cron only enqueues in-window, but check again
      action: "outside_window",
      skipReason: "Outside send window (09:00-19:00 shop local time)",
    };
  }

  // Fetch invoice data
  const invoice = await getInvoiceForReminder(sql, shopId, invoiceId);
  if (!invoice) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice not found",
    };
  }

  // Gate 3: Check if shop was uninstalled (message queued before uninstall)
  // The SQL enqueue filters uninstalled shops, but messages already in queue need this check
  if (invoice.shopUninstalledAt !== null) {
    return {
      success: true,
      action: "skipped",
      skipReason: "shop_uninstalled",
    };
  }

  // Gate 4: Check if buyer account is gated (over plan limit)
  // When PLAN_GATING_ENFORCED=true, no reminders to gated accounts.
  // This check happens BEFORE any claim or reservation, writes no 'sent' row.
  // SQL enqueue does not filter gated accounts; TS is the sole gating point.
  if (!isAccountActive(invoice.buyerAccountGatedAt)) {
    safeLog("info", "reminders_gated_skip", { shopId, invoiceId, ruleId });
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer account is gated (over plan limit)",
    };
  }

  // Gate 5: Re-check invoice status at send time
  if (invoice.status !== "open") {
    return {
      success: true,
      action: "skipped",
      skipReason: `Invoice status is ${invoice.status}`,
    };
  }

  // Gate 6: Skip invoice if fully paid (outstanding <= 0, even if status is still 'open')
  if (Number(invoice.outstanding) <= 0) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice fully paid (outstanding is zero)",
    };
  }

  // Gate 7: Re-check if this is the right day in shop's timezone
  if (!isReminderDueToday(invoice.dueAt, offsetDays, invoice.shopTimezone)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Not the reminder day in shop timezone",
    };
  }

  // Gate 8: Check buyer has email (via CUSTOMER_PII_FIELDS)
  // If PII field is off or email missing, skip without consuming slot or cap
  if (!invoice.buyerEmail) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer has no email (CUSTOMER_PII_FIELDS may be off)",
    };
  }

  // Gate 9: Check unsubscribe secret is configured (fail closed)
  // If missing, skip all reminders and log count only (no PII)
  const unsubscribeSecret = env.REMINDER_UNSUBSCRIBE_SECRET ?? process.env.REMINDER_UNSUBSCRIBE_SECRET;
  if (!canGenerateUnsubscribeHeaders({ REMINDER_UNSUBSCRIBE_SECRET: unsubscribeSecret })) {
    safeLog("warn", "reminders_no_unsubscribe_secret", { shopId, invoiceCount: 1 });
    return {
      success: true,
      action: "skipped",
      skipReason: "REMINDER_UNSUBSCRIBE_SECRET not configured",
    };
  }

  // Gate 10: Get buyerAccountId - required for opt-out check and unsubscribe headers
  // If null, skip send entirely (count-only log, no slot claim or reservation)
  const buyerAccountId = await getBuyerAccountId(sql, shopId, invoiceId);
  if (!buyerAccountId) {
    safeLog("warn", "reminders_no_buyer_account", { shopId, invoiceId, ruleId, skipped: true });
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer account ID not found for invoice",
    };
  }

  // Gate 10b: Check if buyer has opted out of payment reminders
  // This check runs BEFORE any slot claim or cap reservation
  const optedOut = await isBuyerOptedOut(sql, shopId, buyerAccountId);
  if (optedOut) {
    // Record skipped_opted_out status (prevents re-enqueue, no slot consumed)
    await recordSkippedOptedOut(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer opted out of reminders",
    };
  }

  // Gate 10c: Check SHOPIFY_APP_URL is configured (fail closed)
  // Without it, we cannot build absolute unsubscribe URLs
  const appUrl = env.SHOPIFY_APP_URL ?? process.env.SHOPIFY_APP_URL;
  if (!appUrl || appUrl.trim().length === 0) {
    safeLog("warn", "reminders_no_app_url", { shopId, invoiceCount: 1 });
    return {
      success: true,
      action: "skipped",
      skipReason: "SHOPIFY_APP_URL not configured",
    };
  }

  // Gate 10d: Pre-launch recipient allowlist check (fail closed)
  // Check BEFORE claiming slot/cap so skipped sends don't consume resources
  const allowlist = parseRecipientAllowlist(
    env.RESEND_TEST_RECIPIENTS ?? process.env.RESEND_TEST_RECIPIENTS
  );
  if (allowlist.size === 0) {
    safeLog("info", "reminder_send_skipped", { shopId, reason: "recipient_allowlist_empty", skippedCount: 1, allowedCount: 0 });
    return {
      success: true,
      action: "skipped",
      skipReason: "Recipient allowlist is empty or not configured",
    };
  }
  if (!isRecipientAllowed(invoice.buyerEmail, allowlist)) {
    safeLog("info", "reminder_send_skipped", { shopId, reason: "recipient_not_allowlisted", skippedCount: 1, allowedCount: 0 });
    return {
      success: true,
      action: "skipped",
      skipReason: "Recipient not in pre-launch allowlist",
    };
  }

  // Phase A: Short transaction to claim slot with per-invoice lock
  // This ensures at most one reminder per invoice per day
  const claimResult = await sql.begin(async (tx) => {
    await acquireInvoiceLock(tx, invoiceId);

    // Gate 11: Check if already sent today (under the lock)
    const alreadySentToday = await hasReminderSentToday(tx, shopId, invoiceId, validTz);
    if (alreadySentToday) {
      return { claimed: false, reason: "already_sent" } as const;
    }

    // Gate 12: Claim the reminder slot (idempotency via unique index)
    const claimed = await claimReminderSlot(tx, shopId, ruleId, invoiceId);
    if (!claimed) {
      return { claimed: false, reason: "idempotent" } as const;
    }

    return { claimed: true } as const;
  });

  if (!claimResult.claimed) {
    return {
      success: true,
      action: "skipped",
      skipReason: claimResult.reason === "already_sent"
        ? "Reminder already sent today for this invoice"
        : "Reminder already sent (idempotent)",
    };
  }

  // Phase B: Short transaction to reserve global cap slot
  const reserveSlot = deps.reserveGlobalSendSlot ?? reserveGlobalSendSlot;
  const reservation = await reserveSlot(sql);
  if (!reservation.reserved) {
    // Release claim and upsert as 'delayed' in one transaction
    // This enables catch-up within D+1..D+3
    await sql.begin(async (tx) => {
      await releaseReminderSlot(tx, shopId, ruleId, invoiceId);
      await upsertDelayedReminder(tx, shopId, ruleId, invoiceId);
    });
    return {
      success: true,
      action: "capped",
      skipReason: reservation.reason === "daily_cap"
        ? `Daily send cap reached (${DAILY_SEND_CAP}/day)`
        : `Monthly send cap reached (${MONTHLY_SEND_CAP}/month)`,
    };
  }

  // Phase C: Send via Resend OUTSIDE any transaction
  // This avoids holding locks during network I/O.
  // Row is already 'sent' (claimed in Phase A). If send fails, we release.
  //
  // CRASH GAP: If the process crashes after the row is claimed as 'sent' but
  // before the Resend call succeeds, the row stays 'sent', nothing retries it,
  // so that stage's reminder is lost; the next enabled stage still sends normally.
  try {
    const emailHtml = renderPaymentReminderEmail({
      invoiceName: invoice.invoiceName,
      buyerName: invoice.buyerName ?? "Customer",
      amount: formatAmount(invoice.outstanding, invoice.currency),
      dueDate: formatDate(invoice.dueAt, invoice.shopTimezone),
      merchantName: invoice.shopName,
      reminderType: getReminderLabel(offsetDays),
    });

    const subject = `${getReminderLabel(offsetDays)} - Invoice ${invoice.invoiceName}`;
    const idempotencyKey = `s18_${invoiceId}_${ruleId}`;

    // Build RFC 8058 unsubscribe headers (appUrl validated in Gate 10c)
    const unsubscribeHeaders = buildUnsubscribeHeaders(
      appUrl,
      shopId,
      buyerAccountId,
      unsubscribeSecret
    );

    // Gate 10e: Defensive check for fromEmail (should be guaranteed by Gate 1)
    if (!fromEmail) {
      safeLog("error", "reminders_no_from_address", { shopId });
      await sql.begin(async (tx) => {
        await releaseReminderSlot(tx, shopId, ruleId, invoiceId);
        await releaseGlobalSendSlot(tx);
      });
      return {
        success: false,
        action: "skipped",
        errorCode: "resend_from_not_configured",
        retryable: false,
      };
    }

    const sendResult = await sendViaResend(
      {
        from: fromEmail,
        to: [invoice.buyerEmail],
        subject,
        html: emailHtml,
        headers: unsubscribeHeaders ?? undefined,
        idempotencyKey,
      },
      { RESEND_API_KEY: resendKey, RESEND_TEST_RECIPIENTS: env.RESEND_TEST_RECIPIENTS ?? process.env.RESEND_TEST_RECIPIENTS }
    );

    if (sendResult.sent) {
      return {
        success: true,
        action: "sent",
        resendId: sendResult.id,
      };
    }

    if (sendResult.skipped) {
      // This shouldn't happen as we already checked the allowlist, but handle defensively
      // Release slots since send was skipped
      await sql.begin(async (tx) => {
        await releaseReminderSlot(tx, shopId, ruleId, invoiceId);
        await releaseGlobalSendSlot(tx);
      });
      safeLog("info", "reminder_send_skipped", { shopId, reason: sendResult.reason, skippedCount: sendResult.skippedCount, allowedCount: sendResult.allowedCount });
      return {
        success: true,
        action: "skipped",
        skipReason: sendResult.reason === "recipient_allowlist_empty"
          ? "Recipient allowlist is empty or not configured"
          : "Recipient not in pre-launch allowlist",
      };
    }

    // Send failed with error
    if (sendResult.httpStatus === 401) {
      safeLog("error", "reminders_auth_error", { shopId, httpStatus: sendResult.httpStatus });
    }

    // Phase D failure: Release slots in one transaction
    await sql.begin(async (tx) => {
      await releaseReminderSlot(tx, shopId, ruleId, invoiceId);
      await releaseGlobalSendSlot(tx);
    });

    return {
      success: false,
      action: "skipped",
      errorCode: sendResult.error,
      retryable: sendResult.retryable,
    };
  } catch (err) {
    // Phase D failure: Release slots in one transaction
    await sql.begin(async (tx) => {
      await releaseReminderSlot(tx, shopId, ruleId, invoiceId);
      await releaseGlobalSendSlot(tx);
    });

    return {
      success: false,
      action: "skipped",
      errorCode: toErrorCode(err),
      retryable: true,
    };
  }
}

/**
 * Send a catch-up reminder for a delayed log entry.
 *
 * This function handles the REMINDER_CATCHUP message from the enqueue job.
 * It re-checks eligibility before sending:
 * - Invoice is still open and has outstanding balance
 * - Shop reminders toggle is on
 * - Rule is enabled
 * - Buyer account is not gated
 * - Shop not uninstalled
 * - Within D+1..D+3 catch-up window
 * - No newer stage exists or is due today
 *
 * If any check fails, the delayed row is deleted or marked skipped.
 * If the cap is still reached, the row stays delayed for another catch-up attempt.
 * Uses per-invoice advisory lock to ensure at most one reminder per invoice per day.
 *
 * @param sql - Database connection
 * @param shopId - Shop ID
 * @param invoiceId - Invoice ID
 * @param ruleId - Reminder rule ID
 * @param _logId - Unused, kept for API compatibility (verification uses shopId/ruleId/invoiceId)
 * @param offsetDays - Days offset from due date
 * @param timezone - Shop's IANA timezone
 * @param env - Environment variables (RESEND_API_KEY, RESEND_FROM)
 */
export async function sendCatchupReminder(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  ruleId: string,
  _logId: string,
  offsetDays: number,
  timezone: string,
  env: { RESEND_API_KEY?: string; RESEND_FROM?: string; REMINDER_UNSUBSCRIBE_SECRET?: string; SHOPIFY_APP_URL?: string; RESEND_TEST_RECIPIENTS?: string } = {}
): Promise<ReminderSendResult> {
  const resendKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  const fromEmail = getResendFrom(env);
  const validTz = validateTimezone(timezone);

  // Gate 1: Check provider config
  if (!isReminderSendingEnabled(env)) {
    safeLog("info", "reminders_disabled", { shopId });
    return {
      success: true,
      action: "disabled",
      skipReason: "reminders disabled: no provider config",
    };
  }

  // Gate 2: Check send window (09:00-19:00 in shop's timezone)
  if (!isWithinSendWindow(validTz)) {
    return {
      success: true,
      action: "outside_window",
      skipReason: "Outside send window (09:00-19:00 shop local time)",
    };
  }

  // Gate 3: Re-check that the log entry is still delayed
  const logStatus = await getReminderLogStatus(sql, shopId, ruleId, invoiceId);
  if (!logStatus || logStatus.status !== "delayed") {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reminder not in delayed state",
    };
  }

  // Fetch invoice data (also checks eligibility)
  const invoice = await getInvoiceForReminder(sql, shopId, invoiceId);
  if (!invoice) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice not found",
    };
  }

  // Gate 3b: Verify catch-up is within D+1..D+3 window
  // SQL enqueue enforces this, but TS re-checks for defense in depth
  if (invoice.dueAt) {
    const reminderDate = DateTime.fromJSDate(invoice.dueAt, { zone: validTz })
      .plus({ days: offsetDays })
      .startOf("day");
    const today = DateTime.now().setZone(validTz).startOf("day");
    const daysSinceReminder = today.diff(reminderDate, "days").days;
    if (daysSinceReminder < 1 || daysSinceReminder > CATCHUP_WINDOW_DAYS) {
      await sql`
        UPDATE "ReminderLog"
        SET status = 'skipped_daily_limit'::"ReminderLogStatus"
        WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId} AND status = 'delayed'::"ReminderLogStatus"
      `;
      return {
        success: true,
        action: "skipped",
        skipReason: `Outside catch-up window (D+1..D+${CATCHUP_WINDOW_DAYS})`,
      };
    }
  }

  // Gate 4: Check if shop was uninstalled (message queued before uninstall)
  if (invoice.shopUninstalledAt !== null) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "shop_uninstalled",
    };
  }

  // Gate 5: Check if buyer account is gated
  // When PLAN_GATING_ENFORCED=true, no reminders to gated accounts.
  // This check happens BEFORE any claim or cap reservation.
  // SQL enqueue does not filter gated accounts; TS is the sole gating point.
  if (!isAccountActive(invoice.buyerAccountGatedAt)) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    safeLog("info", "reminders_catchup_gated_skip", { shopId, invoiceId, ruleId });
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer account is gated (over plan limit)",
    };
  }

  // Gate 6: Re-check invoice status
  if (invoice.status !== "open") {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: `Invoice status is ${invoice.status}`,
    };
  }

  // Gate 7: Skip invoice if fully paid (outstanding <= 0, even if status is still 'open')
  if (Number(invoice.outstanding) <= 0) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice fully paid (outstanding is zero)",
    };
  }

  // Gate 8: Check buyer has email
  if (!invoice.buyerEmail) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer has no email (CUSTOMER_PII_FIELDS may be off)",
    };
  }

  // Gate 8b: Check unsubscribe secret is configured (fail closed)
  const unsubscribeSecret = env.REMINDER_UNSUBSCRIBE_SECRET ?? process.env.REMINDER_UNSUBSCRIBE_SECRET;
  if (!canGenerateUnsubscribeHeaders({ REMINDER_UNSUBSCRIBE_SECRET: unsubscribeSecret })) {
    // Don't delete the delayed row - wait for secret to be configured
    safeLog("warn", "reminders_catchup_no_unsubscribe_secret", { shopId, invoiceCount: 1 });
    return {
      success: true,
      action: "skipped",
      skipReason: "REMINDER_UNSUBSCRIBE_SECRET not configured",
    };
  }

  // Gate 8c: Get buyerAccountId - required for opt-out check and unsubscribe headers
  // If null, skip send entirely (count-only log)
  const buyerAccountId = await getBuyerAccountId(sql, shopId, invoiceId);
  if (!buyerAccountId) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    safeLog("warn", "reminders_catchup_no_buyer_account", { shopId, invoiceId, ruleId, skipped: true });
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer account ID not found for invoice",
    };
  }

  // Gate 8d: Check if buyer has opted out of payment reminders
  // For catch-up, transition delayed row to skipped_opted_out
  const optedOut = await isBuyerOptedOut(sql, shopId, buyerAccountId);
  if (optedOut) {
    // Transition delayed row to skipped_opted_out (prevents resend after re-enable)
    await transitionDelayedToOptedOut(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer opted out of reminders",
    };
  }

  // Gate 8e: Check SHOPIFY_APP_URL is configured (fail closed)
  // Without it, we cannot build absolute unsubscribe URLs
  const appUrl = env.SHOPIFY_APP_URL ?? process.env.SHOPIFY_APP_URL;
  if (!appUrl || appUrl.trim().length === 0) {
    // Don't delete the delayed row - wait for URL to be configured
    safeLog("warn", "reminders_catchup_no_app_url", { shopId, invoiceCount: 1 });
    return {
      success: true,
      action: "skipped",
      skipReason: "SHOPIFY_APP_URL not configured",
    };
  }

  // Gate 9: Check shop reminders are enabled
  const settings = await getShopReminderSettings(sql, shopId);
  if (!settings?.enabled) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Shop reminders disabled",
    };
  }

  // Gate 10: Check rule is still enabled
  const rule = await getReminderRule(sql, shopId, ruleId);
  if (!rule?.enabled) {
    await deleteDelayedReminder(sql, shopId, ruleId, invoiceId);
    return {
      success: true,
      action: "skipped",
      skipReason: "Reminder rule disabled",
    };
  }

  // Gate 11: Check if a newer stage exists (latest-stage-wins)
  const newerStageExists = await hasNewerStageForInvoice(sql, shopId, invoiceId, ruleId, offsetDays);
  if (newerStageExists) {
    await sql`
      UPDATE "ReminderLog"
      SET status = 'skipped_daily_limit'::"ReminderLogStatus"
      WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId} AND status = 'delayed'::"ReminderLogStatus"
    `;
    return {
      success: true,
      action: "skipped",
      skipReason: "Newer stage exists for this invoice",
    };
  }

  // Gate 11b: Check if a newer stage is due TODAY (no log row yet, but Part 3 will enqueue it)
  // One reminder per invoice per day: newer stage wins
  const newerStageDueToday = await hasNewerStageDueToday(sql, shopId, invoiceId, offsetDays, validTz);
  if (newerStageDueToday) {
    await sql`
      UPDATE "ReminderLog"
      SET status = 'skipped_daily_limit'::"ReminderLogStatus"
      WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId} AND status = 'delayed'::"ReminderLogStatus"
    `;
    return {
      success: true,
      action: "skipped",
      skipReason: "Newer stage due today",
    };
  }

  // Gate 11c: Pre-launch recipient allowlist check (fail closed)
  // Check AFTER gates 9/10/11/11b so we skip for valid business reasons first,
  // but BEFORE claiming slot/cap so skipped sends don't consume resources.
  // Don't delete the delayed row - wait for allowlist to be configured or recipient added.
  const allowlist = parseRecipientAllowlist(
    env.RESEND_TEST_RECIPIENTS ?? process.env.RESEND_TEST_RECIPIENTS
  );
  if (allowlist.size === 0) {
    safeLog("info", "reminder_send_skipped", { shopId, reason: "recipient_allowlist_empty", skippedCount: 1, allowedCount: 0 });
    return {
      success: true,
      action: "skipped",
      skipReason: "Recipient allowlist is empty or not configured",
    };
  }
  if (!isRecipientAllowed(invoice.buyerEmail, allowlist)) {
    safeLog("info", "reminder_send_skipped", { shopId, reason: "recipient_not_allowlisted", skippedCount: 1, allowedCount: 0 });
    return {
      success: true,
      action: "skipped",
      skipReason: "Recipient not in pre-launch allowlist",
    };
  }

  // Phase A: Claim under per-invoice lock (same-day check + claim in one tx)
  // This prevents a same-day new-stage send and catch-up from both going out.
  // On send failure, we revert the claim.
  const claimResult = await sql.begin(async (tx) => {
    await acquireInvoiceLock(tx, invoiceId);

    // Gate 12: Re-read status under the lock to handle duplicate catch-up messages
    // (enqueue runs hourly, so multiple REMINDER_CATCHUP messages may exist)
    const statusUnderLock = await getReminderLogStatus(tx, shopId, ruleId, invoiceId);
    if (!statusUnderLock || statusUnderLock.status !== "delayed") {
      return { claimed: false, reason: "not_delayed" } as const;
    }

    // Gate 13: Check if already sent today (any rule for this invoice)
    const alreadySentToday = await hasReminderSentToday(tx, shopId, invoiceId, validTz);
    if (alreadySentToday) {
      return { claimed: false, reason: "already_sent" } as const;
    }

    // CLAIM: Update delayed to sent under the lock (prevents concurrent send)
    // firstCappedAt is preserved for "sent late" tracking.
    // If send fails, we revert this in Phase D.
    await tx`
      UPDATE "ReminderLog"
      SET status = 'sent'::"ReminderLogStatus", "sentAt" = NOW()
      WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
        AND status = 'delayed'::"ReminderLogStatus"
    `;

    return { claimed: true } as const;
  });

  if (!claimResult.claimed) {
    return {
      success: true,
      action: "skipped",
      skipReason: claimResult.reason === "not_delayed"
        ? "Reminder no longer in delayed state (duplicate catch-up message)"
        : "Reminder already sent today for this invoice",
    };
  }

  // Phase B: Reserve global cap slot
  const reservation = await reserveGlobalSendSlot(sql);
  if (!reservation.reserved) {
    // Revert claim: mark back as delayed in one transaction
    await sql.begin(async (tx) => {
      await tx`
        UPDATE "ReminderLog"
        SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
        WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
          AND status = 'sent'::"ReminderLogStatus"
      `;
    });
    return {
      success: true,
      action: "capped",
      skipReason: reservation.reason === "daily_cap"
        ? `Daily send cap reached (${DAILY_SEND_CAP}/day)`
        : `Monthly send cap reached (${MONTHLY_SEND_CAP}/month)`,
    };
  }

  // Phase C: Send via Resend OUTSIDE any transaction
  // This avoids holding locks during network I/O.
  // Row is already 'sent' (claimed in Phase A). If send fails, we revert.
  //
  // CRASH GAP: If the process crashes after the row is claimed as 'sent' but
  // before the Resend call succeeds, the row stays 'sent', nothing retries it,
  // so that stage's reminder is lost; the next enabled stage still sends normally.
  try {
    const emailHtml = renderPaymentReminderEmail({
      invoiceName: invoice.invoiceName,
      buyerName: invoice.buyerName ?? "Customer",
      amount: formatAmount(invoice.outstanding, invoice.currency),
      dueDate: formatDate(invoice.dueAt, invoice.shopTimezone),
      merchantName: invoice.shopName,
      reminderType: getReminderLabel(offsetDays),
    });

    const subject = `${getReminderLabel(offsetDays)} - Invoice ${invoice.invoiceName}`;
    const idempotencyKey = `s18_catchup_${invoiceId}_${ruleId}`;

    // Build RFC 8058 unsubscribe headers (appUrl validated in Gate 8e)
    const unsubscribeHeaders = buildUnsubscribeHeaders(
      appUrl,
      shopId,
      buyerAccountId,
      unsubscribeSecret
    );

    // Gate 8f: Defensive check for fromEmail (should be guaranteed by Gate 1)
    if (!fromEmail) {
      safeLog("error", "reminders_catchup_no_from_address", { shopId });
      await sql.begin(async (tx) => {
        await tx`
          UPDATE "ReminderLog"
          SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
          WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
            AND status = 'sent'::"ReminderLogStatus"
        `;
        await releaseGlobalSendSlot(tx);
      });
      return {
        success: false,
        action: "skipped",
        errorCode: "resend_from_not_configured",
        retryable: false,
      };
    }

    const sendResult = await sendViaResend(
      {
        from: fromEmail,
        to: [invoice.buyerEmail],
        subject,
        html: emailHtml,
        headers: unsubscribeHeaders ?? undefined,
        idempotencyKey,
      },
      { RESEND_API_KEY: resendKey, RESEND_TEST_RECIPIENTS: env.RESEND_TEST_RECIPIENTS ?? process.env.RESEND_TEST_RECIPIENTS }
    );

    if (sendResult.sent) {
      return {
        success: true,
        action: "sent",
        resendId: sendResult.id,
      };
    }

    if (sendResult.skipped) {
      // This shouldn't happen as we already checked the allowlist, but handle defensively
      // Revert claim and release cap since send was skipped
      await sql.begin(async (tx) => {
        await tx`
          UPDATE "ReminderLog"
          SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
          WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
            AND status = 'sent'::"ReminderLogStatus"
        `;
        await releaseGlobalSendSlot(tx);
      });
      safeLog("info", "reminder_send_skipped", { shopId, reason: sendResult.reason, skippedCount: sendResult.skippedCount, allowedCount: sendResult.allowedCount });
      return {
        success: true,
        action: "skipped",
        skipReason: sendResult.reason === "recipient_allowlist_empty"
          ? "Recipient allowlist is empty or not configured"
          : "Recipient not in pre-launch allowlist",
      };
    }

    // Send failed with error
    if (sendResult.httpStatus === 401) {
      safeLog("error", "reminders_catchup_auth_error", { shopId, httpStatus: sendResult.httpStatus });
    }

    // Phase D failure: Revert claim and release cap in one transaction
    await sql.begin(async (tx) => {
      await tx`
        UPDATE "ReminderLog"
        SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
        WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
          AND status = 'sent'::"ReminderLogStatus"
      `;
      await releaseGlobalSendSlot(tx);
    });

    return {
      success: false,
      action: "skipped",
      errorCode: sendResult.error,
      retryable: sendResult.retryable,
    };
  } catch (err) {
    // Phase D failure: Revert claim and release cap in one transaction
    await sql.begin(async (tx) => {
      await tx`
        UPDATE "ReminderLog"
        SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
        WHERE "shopId" = ${shopId} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
          AND status = 'sent'::"ReminderLogStatus"
      `;
      await releaseGlobalSendSlot(tx);
    });

    return {
      success: false,
      action: "skipped",
      errorCode: toErrorCode(err),
      retryable: true,
    };
  }
}

/**
 * Get rule by ID for a shop.
 */
export async function getReminderRule(
  sql: Sql,
  shopId: string,
  ruleId: string
): Promise<{ id: string; offsetDays: number; channel: string; enabled: boolean } | null> {
  const [row] = await sql<
    { id: string; offsetDays: number; channel: string; enabled: boolean }[]
  >`
    SELECT id, "offsetDays", channel, enabled
    FROM "ReminderRule"
    WHERE id = ${ruleId} AND "shopId" = ${shopId}
  `;
  return row ?? null;
}

/**
 * Get reminder settings for a shop.
 * Returns null if shop has no settings row (defaults to disabled).
 */
export async function getShopReminderSettings(
  sql: Sql,
  shopId: string
): Promise<{ enabled: boolean } | null> {
  const [row] = await sql<{ enabled: boolean }[]>`
    SELECT enabled FROM s18_shop_reminder_settings
    WHERE shop_id = ${shopId}
  `;
  return row ?? null;
}

/**
 * Update or create reminder settings for a shop.
 */
export async function updateShopReminderSettings(
  sql: Sql,
  shopId: string,
  enabled: boolean
): Promise<void> {
  await sql`
    INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
    VALUES (${shopId}, ${enabled}, NOW(), NOW())
    ON CONFLICT (shop_id)
    DO UPDATE SET enabled = ${enabled}, updated_at = NOW()
  `;
}

/**
 * Get all reminder rules for a shop.
 */
export async function getShopReminderRules(
  sql: Sql,
  shopId: string
): Promise<
  { id: string; offsetDays: number; channel: string; enabled: boolean }[]
> {
  return sql<
    { id: string; offsetDays: number; channel: string; enabled: boolean }[]
  >`
    SELECT id, "offsetDays", channel, enabled
    FROM "ReminderRule"
    WHERE "shopId" = ${shopId}
    ORDER BY "offsetDays" ASC
  `;
}

/**
 * Reminder log entry for UI display.
 */
export interface ReminderLogEntry {
  id: string;
  invoiceName: string;
  offsetDays: number;
  status: "sent" | "delayed" | "skipped_daily_limit" | "skipped_opted_out";
  date: Date;
}

/**
 * Get reminder logs for a shop for display in the settings page.
 * Returns invoice name, stage (offsetDays), status, and date.
 * Ordered by date descending (most recent first).
 * Limited to 100 entries for performance.
 */
export async function getShopReminderLogs(
  sql: Sql,
  shopId: string,
  limit: number = 100
): Promise<ReminderLogEntry[]> {
  const rows = await sql<{
    id: string;
    invoiceName: string;
    offsetDays: number;
    status: string;
    date: Date;
  }[]>`
    SELECT 
      rl.id,
      i.name AS "invoiceName",
      r."offsetDays",
      rl.status::TEXT,
      COALESCE(rl."sentAt", rl."firstCappedAt", NOW()) AS date
    FROM "ReminderLog" rl
    INNER JOIN "Invoice" i ON i.id = rl."invoiceId"
    INNER JOIN "ReminderRule" r ON r.id = rl."ruleId"
    WHERE rl."shopId" = ${shopId}
    ORDER BY date DESC
    LIMIT ${limit}
  `;
  
  return rows.map((row) => ({
    id: row.id,
    invoiceName: row.invoiceName,
    offsetDays: row.offsetDays,
    status: row.status as "sent" | "delayed" | "skipped_daily_limit",
    date: row.date,
  }));
}

/**
 * Offset bounds for reminder rules: -30 (30 days before) to 90 (90 days overdue).
 * Prevents unreasonable values that would clutter the reminder queue.
 */
export const OFFSET_MIN = -30;
export const OFFSET_MAX = 90;

/**
 * Validate offsetDays is within allowed bounds.
 */
export function isValidOffset(offsetDays: number): boolean {
  return (
    Number.isInteger(offsetDays) &&
    offsetDays >= OFFSET_MIN &&
    offsetDays <= OFFSET_MAX
  );
}

/**
 * Update a reminder rule.
 * Uses postgres.js tagged template fragments for dynamic SET clauses.
 */
export async function updateReminderRule(
  sql: Sql,
  shopId: string,
  ruleId: string,
  updates: { offsetDays?: number; enabled?: boolean }
): Promise<boolean> {
  const { offsetDays, enabled } = updates;
  const hasOffsetDays = offsetDays !== undefined;
  const hasEnabled = enabled !== undefined;

  if (!hasOffsetDays && !hasEnabled) {
    return false;
  }

  // Validate offsetDays bounds
  if (hasOffsetDays && !isValidOffset(offsetDays)) {
    throw new Error(
      `offsetDays must be between ${OFFSET_MIN} and ${OFFSET_MAX}`
    );
  }

  // Build update using postgres.js conditional fragments
  // TypeScript narrowing: after the checks above, the values are defined in each branch
  if (hasOffsetDays && hasEnabled) {
    const result = await sql`
      UPDATE "ReminderRule"
      SET "offsetDays" = ${offsetDays}, enabled = ${enabled}, "updatedAt" = NOW()
      WHERE id = ${ruleId} AND "shopId" = ${shopId}
      RETURNING id
    `;
    return result.length > 0;
  } else if (hasOffsetDays) {
    const result = await sql`
      UPDATE "ReminderRule"
      SET "offsetDays" = ${offsetDays}, "updatedAt" = NOW()
      WHERE id = ${ruleId} AND "shopId" = ${shopId}
      RETURNING id
    `;
    return result.length > 0;
  } else {
    // hasEnabled must be true here (we already checked !hasOffsetDays && !hasEnabled above)
    const enabledValue = enabled!;
    const result = await sql`
      UPDATE "ReminderRule"
      SET enabled = ${enabledValue}, "updatedAt" = NOW()
      WHERE id = ${ruleId} AND "shopId" = ${shopId}
      RETURNING id
    `;
    return result.length > 0;
  }
}

/**
 * Create a new reminder rule for a shop.
 */
export async function createReminderRule(
  sql: Sql,
  shopId: string,
  offsetDays: number,
  channel: "email" | "native" = "email"
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::TEXT, ${shopId}, ${offsetDays}, ${channel}::"ReminderChannel", true, NOW(), NOW())
    RETURNING id
  `;
  return row.id;
}

/**
 * Delete a reminder rule.
 */
export async function deleteReminderRule(
  sql: Sql,
  shopId: string,
  ruleId: string
): Promise<boolean> {
  const result = await sql`
    DELETE FROM "ReminderRule"
    WHERE id = ${ruleId} AND "shopId" = ${shopId}
      AND NOT EXISTS (
        SELECT 1 FROM "ReminderLog" WHERE "ruleId" = ${ruleId}
      )
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Default reminder rule offsets.
 * - 3 days before due date (-3)
 * - On due date (0)
 * - 7 days overdue (+7)
 */
export const DEFAULT_RULE_OFFSETS = [-3, 0, 7] as const;

/**
 * Ensure default reminder rules exist for a shop on FIRST settings creation.
 *
 * Seeds the 3 default rules (offsets -3, 0, +7) ONLY when creating the
 * s18_shop_reminder_settings row for the first time. Uses INSERT ... ON CONFLICT
 * DO NOTHING with RETURNING to detect first-time creation atomically.
 *
 * After initial setup, a shop with zero rules stays at zero - no re-seeding.
 * If a merchant deletes all rules, they stay deleted on subsequent page loads.
 *
 * Skips seeding entirely if:
 * - Shop already has a settings row (not first visit)
 * - Shop has any ReminderLog history (has used reminders before)
 *
 * Concurrency-safe: Uses pg_advisory_xact_lock plus INSERT ... ON CONFLICT
 * to prevent duplicate inserts from concurrent requests.
 *
 * Does NOT enable reminders - they stay disabled (enabled=false) by default.
 * Does NOT send any emails.
 */
export async function ensureDefaultReminderRules(
  sql: Sql,
  shopId: string
): Promise<{ seeded: boolean; count: number }> {
  // Cheap EXISTS check before acquiring lock - skip early if already set up
  const [existsCheck] = await sql<{ hasSettings: boolean; hasHistory: boolean }[]>`
    SELECT
      EXISTS(SELECT 1 FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}) AS "hasSettings",
      EXISTS(SELECT 1 FROM "ReminderLog" WHERE "shopId" = ${shopId}) AS "hasHistory"
  `;

  if (existsCheck?.hasSettings || existsCheck?.hasHistory) {
    return { seeded: false, count: 0 };
  }

  const result = await sql.begin(async (tx) => {
    // Acquire advisory lock keyed on shop ID (released at end of transaction)
    await tx`SELECT pg_advisory_xact_lock(hashtext('s18_rules_' || ${shopId}))`;

    // Re-check ReminderLog inside transaction (may have changed since EXISTS check)
    const [historyCheck] = await tx<{ hasHistory: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM "ReminderLog" WHERE "shopId" = ${shopId}) AS "hasHistory"
    `;
    if (historyCheck?.hasHistory) {
      return { seeded: false, count: 0 };
    }

    // Try to insert settings row (enabled=false). ON CONFLICT DO NOTHING
    // returns empty if row already exists, returns the row if newly created.
    const inserted = await tx<{ shop_id: string }[]>`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${shopId}, false, NOW(), NOW())
      ON CONFLICT (shop_id) DO NOTHING
      RETURNING shop_id
    `;

    // Only seed rules if we just created the settings row for the first time
    if (inserted.length === 0) {
      return { seeded: false, count: 0 };
    }

    // Seed default rules (all enabled by default, but reminders setting stays disabled)
    let count = 0;
    for (const offset of DEFAULT_RULE_OFFSETS) {
      await tx`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (gen_random_uuid()::TEXT, ${shopId}, ${offset}, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;
      count++;
    }

    return { seeded: true, count };
  });

  return result;
}
