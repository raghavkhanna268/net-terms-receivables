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
 * Resend Free Tier Limits (https://resend.com/pricing):
 *   - 100 emails/day per account (GLOBAL)
 *   - 3,000 emails/month per account (GLOBAL)
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
  currency: string;
  dueAt: Date;
  status: "open" | "paid" | "cancelled";
  buyerEmail: string | null;
  buyerName: string | null;
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
  retryable?: boolean;
}

/**
 * Get invoice data needed for sending a reminder.
 * Joins Invoice with Shop and tagged customer (for email/name via CUSTOMER_PII_FIELDS).
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
      currency: string;
      dueAt: Date | null;
      status: string;
      buyerAccountId: string;
      customerId: string | null;
    }[]
  >`
    SELECT
      i.id AS "invoiceId",
      i."shopId",
      s.domain AS "shopDomain",
      s.timezone AS "shopTimezone",
      i.name AS "invoiceName",
      i.total::TEXT,
      s.currency,
      i."dueAt",
      i.status,
      i."buyerAccountId",
      ba."customerId"
    FROM "Invoice" i
    INNER JOIN "Shop" s ON s.id = i."shopId"
    INNER JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i.id = ${invoiceId}
      AND i."shopId" = ${shopId}
  `;

  if (!row || !row.dueAt) {
    return null;
  }

  // Get customer email/displayName from s8_tagged_customers
  // This data is only present when CUSTOMER_PII_FIELDS=1 (S8)
  let buyerEmail: string | null = null;
  let buyerName: string | null = null;

  if (row.customerId) {
    const [customer] = await sql<{ email: string | null; displayName: string | null }[]>`
      SELECT email, display_name AS "displayName"
      FROM s8_tagged_customers
      WHERE shop_id = ${shopId}
        AND customer_id = ${row.customerId}
    `;
    if (customer) {
      buyerEmail = customer.email;
      buyerName = customer.displayName;
    }
  }

  const shopName = row.shopDomain.replace(".myshopify.com", "");
  const shopTimezone = validateTimezone(row.shopTimezone);

  return {
    invoiceId: row.invoiceId,
    shopId: row.shopId,
    shopDomain: row.shopDomain,
    shopName,
    shopTimezone,
    invoiceName: row.invoiceName,
    total: row.total,
    currency: row.currency,
    dueAt: row.dueAt,
    status: row.status as "open" | "paid" | "cancelled",
    buyerEmail,
    buyerName,
  };
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
    INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt")
    VALUES (gen_random_uuid()::TEXT, ${shopId}, ${ruleId}, ${invoiceId}, NOW())
    ON CONFLICT ("ruleId", "invoiceId") DO NOTHING
    RETURNING id
  `;
  return result.length > 0;
}

/**
 * Remove a claimed reminder slot (on send failure, to allow retry).
 */
export async function releaseReminderSlot(
  sql: Sql,
  ruleId: string,
  invoiceId: string
): Promise<void> {
  await sql`
    DELETE FROM "ReminderLog"
    WHERE "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
  `;
}

/**
 * Get current GLOBAL daily and monthly send counts.
 * Uses UTC for date boundaries. Monthly count is computed as SUM of daily_count
 * for all days in the current month (not stored in monthly_count column for
 * consistency - that column is deprecated).
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
 * Atomically reserve a send slot (increment count) with cap enforcement.
 * Returns { reserved: true, daily, monthly } if reservation succeeded.
 * Returns { reserved: false, reason } if caps would be exceeded.
 *
 * Uses a single atomic INSERT ... ON CONFLICT DO UPDATE with WHERE clause
 * that checks BOTH daily AND monthly caps. No row returned = cap reached.
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

  // Single atomic query:
  // 1. Compute current monthly total
  // 2. Insert new row if none exists (with cap check via WHERE)
  // 3. Update existing row if under cap (with cap check via WHERE)
  // 4. Return nothing if either cap would be exceeded
  const result = await sql<{ dailyCount: number; monthlyTotal: number }[]>`
    WITH monthly_sum AS (
      SELECT COALESCE(SUM(daily_count), 0)::INT AS total
      FROM s18_global_sends
      WHERE send_key = ${GLOBAL_SEND_KEY} AND send_month = ${monthStr}
    ),
    current_row AS (
      SELECT daily_count FROM s18_global_sends
      WHERE send_key = ${GLOBAL_SEND_KEY} AND send_date = ${dateStr}::DATE
    ),
    upserted AS (
      INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
      SELECT ${GLOBAL_SEND_KEY}, ${dateStr}::DATE, ${monthStr}, 1, 0, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM current_row)
        AND (SELECT total FROM monthly_sum) < ${MONTHLY_SEND_CAP}
      ON CONFLICT (send_key, send_date) DO UPDATE
      SET 
        daily_count = s18_global_sends.daily_count + 1,
        updated_at = NOW()
      WHERE s18_global_sends.daily_count < ${DAILY_SEND_CAP}
        AND (SELECT total FROM monthly_sum) < ${MONTHLY_SEND_CAP}
      RETURNING daily_count
    )
    SELECT 
      COALESCE((SELECT daily_count FROM upserted), 0) AS "dailyCount",
      (SELECT total FROM monthly_sum) + CASE WHEN EXISTS (SELECT 1 FROM upserted) THEN 1 ELSE 0 END AS "monthlyTotal"
  `;

  if (!result.length || result[0].dailyCount === 0) {
    // No reservation made - check which cap was hit
    const counts = await getGlobalSendCounts(sql, date);
    if (counts.monthly >= MONTHLY_SEND_CAP) {
      return { reserved: false, reason: "monthly_cap" };
    }
    return { reserved: false, reason: "daily_cap" };
  }

  return {
    reserved: true,
    daily: result[0].dailyCount,
    monthly: result[0].monthlyTotal,
  };
}

/**
 * Release a previously reserved send slot (decrement count).
 * Used when send fails with non-retryable error to avoid wasting cap.
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
 * 3. Re-checks if reminder day matches today in shop's timezone
 * 4. Verifies invoice is still open
 * 5. Checks buyer has email (via CUSTOMER_PII_FIELDS mechanism)
 * 6. Claims the reminder slot (idempotency)
 * 7. Reserves global cap slot atomically
 * 8. Sends via Resend API with Idempotency-Key header
 * 9. On non-retryable error (401, 4xx): releases cap slot to avoid waste
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
  env: { RESEND_API_KEY?: string; RESEND_FROM?: string } = {}
): Promise<ReminderSendResult> {
  const resendKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  const fromEmail = getResendFrom(env);
  const validTz = validateTimezone(timezone);

  // Gate 1: Check provider config - if missing, ack WITHOUT consuming slot
  // This allows the reminder to fire again once both keys are configured
  if (!isReminderSendingEnabled(env)) {
    console.info("reminders disabled");
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

  // Gate 3: Re-check invoice status at send time
  if (invoice.status !== "open") {
    return {
      success: true,
      action: "skipped",
      skipReason: `Invoice status is ${invoice.status}`,
    };
  }

  // Gate 4: Re-check if this is the right day in shop's timezone
  if (!isReminderDueToday(invoice.dueAt, offsetDays, invoice.shopTimezone)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Not the reminder day in shop timezone",
    };
  }

  // Gate 5: Check buyer has email (via CUSTOMER_PII_FIELDS)
  // If PII field is off or email missing, skip without consuming slot or cap
  if (!invoice.buyerEmail) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer has no email (CUSTOMER_PII_FIELDS may be off)",
    };
  }

  // Gate 6: Claim the reminder slot (idempotency via unique index)
  const claimed = await claimReminderSlot(sql, shopId, ruleId, invoiceId);
  if (!claimed) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reminder already sent (idempotent)",
    };
  }

  // Gate 7: Reserve global cap slot atomically (checks both daily and monthly)
  const reservation = await reserveGlobalSendSlot(sql);
  if (!reservation.reserved) {
    // Release reminder slot so it can retry later
    await releaseReminderSlot(sql, ruleId, invoiceId);
    return {
      success: true,
      action: "capped",
      skipReason: reservation.reason === "daily_cap"
        ? `Daily send cap reached (${DAILY_SEND_CAP}/day)`
        : `Monthly send cap reached (${MONTHLY_SEND_CAP}/month)`,
    };
  }

  try {
    const emailHtml = renderPaymentReminderEmail({
      invoiceName: invoice.invoiceName,
      buyerName: invoice.buyerName ?? "Customer",
      amount: formatAmount(invoice.total, invoice.currency),
      dueDate: formatDate(invoice.dueAt, invoice.shopTimezone),
      merchantName: invoice.shopName,
      reminderType: getReminderLabel(offsetDays),
    });

    const subject = `${getReminderLabel(offsetDays)} - Invoice ${invoice.invoiceName}`;
    const idempotencyKey = `s18_${invoiceId}_${ruleId}`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [invoice.buyerEmail],
        subject,
        html: emailHtml,
      }),
    });

    if (!response.ok) {
      const _errorText = await response.text();
      const isAuthError = response.status === 401;
      const isRateLimited = response.status === 429;
      const isServerError = response.status >= 500;
      const isRetryable = isRateLimited || isServerError;

      if (isAuthError) {
        console.error("[reminders] Resend auth error (revoked key?)");
      }

      // Release reminder slot so it can retry
      await releaseReminderSlot(sql, ruleId, invoiceId);

      // Release cap slot on non-retryable errors to avoid wasting quota
      // (retryable errors like 429/5xx keep the reservation since we'll retry)
      if (!isRetryable) {
        await releaseGlobalSendSlot(sql);
      }

      return {
        success: false,
        action: "skipped",
        error: `Resend API error: ${response.status}`,
        retryable: isRetryable,
      };
    }

    const result = (await response.json()) as { id?: string };

    return {
      success: true,
      action: "sent",
      resendId: result.id,
    };
  } catch (err) {
    // Release slots so it can retry
    await releaseReminderSlot(sql, ruleId, invoiceId);
    // Network errors are retryable, keep the cap reservation
    // (it will be released if we hit cap on retry)

    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      action: "skipped",
      error: `Send failed: ${errorMsg}`,
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
