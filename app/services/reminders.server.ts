/**
 * Payment Reminder Service (S18).
 *
 * Sends payment reminder emails via Resend for invoices at configured
 * offsets from their due date. Enforces:
 * - RESEND_API_KEY gate (no sends without key)
 * - Daily send cap (100/day per Resend free tier)
 * - Idempotency via ReminderLog unique index on (ruleId, invoiceId)
 * - Invoice status re-check (no reminders for paid/closed invoices)
 *
 * Resend Free Tier Limits (https://resend.com/pricing):
 *   - 100 emails/day per account
 *   - 3,000 emails/month per account
 *
 * DPDP Compliance:
 *   - Only email and displayName are used (no phone, no address)
 *   - PII is not stored in reminder logs (only invoiceId and ruleId)
 */

import type { Sql } from "~/lib/db-light.server";
import { renderPaymentReminderEmail } from "~/emails/PaymentReminderEmail";

/**
 * Daily send cap per shop (Resend free tier: 100 emails/day).
 * @see https://resend.com/pricing
 */
export const DAILY_SEND_CAP = 100;

/**
 * Check if reminder sending is enabled.
 * Returns true only if RESEND_API_KEY is a non-empty string.
 */
export function isReminderSendingEnabled(
  env: { RESEND_API_KEY?: string } = {}
): boolean {
  const key = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;
  return typeof key === "string" && key.trim().length > 0;
}

/**
 * Invoice data needed for sending a reminder.
 */
export interface ReminderInvoiceData {
  invoiceId: string;
  shopId: string;
  shopDomain: string;
  shopName: string;
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
  action: "sent" | "skipped" | "capped" | "disabled";
  skipReason?: string;
  resendId?: string;
  error?: string;
  retryable?: boolean;
}

/**
 * Get invoice data needed for sending a reminder.
 * Joins Invoice with Shop and tagged customer (for email/name).
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

  return {
    invoiceId: row.invoiceId,
    shopId: row.shopId,
    shopDomain: row.shopDomain,
    shopName,
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
 * Remove a claimed reminder slot (on send failure).
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
 * Get current daily send count for a shop.
 */
export async function getDailySendCount(
  sql: Sql,
  shopId: string,
  date: Date = new Date()
): Promise<number> {
  const dateStr = date.toISOString().split("T")[0];
  const [row] = await sql<{ count: number }[]>`
    SELECT count FROM s18_daily_sends
    WHERE shop_id = ${shopId} AND send_date = ${dateStr}::DATE
  `;
  return row?.count ?? 0;
}

/**
 * Increment daily send count for a shop.
 * Uses UPSERT to create or increment.
 */
export async function incrementDailySendCount(
  sql: Sql,
  shopId: string,
  date: Date = new Date()
): Promise<number> {
  const dateStr = date.toISOString().split("T")[0];
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO s18_daily_sends (shop_id, send_date, count)
    VALUES (${shopId}, ${dateStr}::DATE, 1)
    ON CONFLICT (shop_id, send_date)
    DO UPDATE SET count = s18_daily_sends.count + 1
    RETURNING count
  `;
  return row?.count ?? 1;
}

/**
 * Format amount in the shop's currency for display.
 */
function formatAmount(amountPaise: string, currency: string): string {
  const amount = Number(amountPaise) / 100;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

/**
 * Format date for display in Asia/Kolkata timezone.
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Get rule offset label for email subject.
 */
export function getReminderLabel(offsetDays: number): string {
  if (offsetDays < 0) {
    return `Payment due in ${Math.abs(offsetDays)} days`;
  } else if (offsetDays === 0) {
    return "Payment due today";
  } else {
    return `Payment ${offsetDays} days overdue`;
  }
}

/**
 * Send a payment reminder email via Resend.
 *
 * This function:
 * 1. Checks RESEND_API_KEY gate
 * 2. Checks daily send cap
 * 3. Verifies invoice is still open
 * 4. Claims the reminder slot (idempotency)
 * 5. Sends via Resend API
 * 6. Increments daily counter on success
 *
 * @param sql - Database connection
 * @param shopId - Shop ID
 * @param invoiceId - Invoice ID
 * @param ruleId - Reminder rule ID
 * @param offsetDays - Days offset from due date
 * @param env - Environment variables (for RESEND_API_KEY)
 */
export async function sendPaymentReminder(
  sql: Sql,
  shopId: string,
  invoiceId: string,
  ruleId: string,
  offsetDays: number,
  env: { RESEND_API_KEY?: string } = {}
): Promise<ReminderSendResult> {
  const resendKey = env.RESEND_API_KEY ?? process.env.RESEND_API_KEY;

  if (!isReminderSendingEnabled(env)) {
    console.info("reminders disabled");
    return {
      success: true,
      action: "disabled",
      skipReason: "reminders disabled: no provider key",
    };
  }

  const currentCount = await getDailySendCount(sql, shopId);
  if (currentCount >= DAILY_SEND_CAP) {
    return {
      success: true,
      action: "capped",
      skipReason: `Daily send cap reached (${DAILY_SEND_CAP}/day)`,
    };
  }

  const invoice = await getInvoiceForReminder(sql, shopId, invoiceId);
  if (!invoice) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Invoice not found",
    };
  }

  if (invoice.status !== "open") {
    return {
      success: true,
      action: "skipped",
      skipReason: `Invoice status is ${invoice.status}`,
    };
  }

  if (!invoice.buyerEmail) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Buyer has no email",
    };
  }

  const claimed = await claimReminderSlot(sql, shopId, ruleId, invoiceId);
  if (!claimed) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reminder already sent (idempotent)",
    };
  }

  try {
    const emailHtml = renderPaymentReminderEmail({
      invoiceName: invoice.invoiceName,
      buyerName: invoice.buyerName ?? "Customer",
      amount: formatAmount(invoice.total, invoice.currency),
      dueDate: formatDate(invoice.dueAt),
      merchantName: invoice.shopName,
      reminderType: getReminderLabel(offsetDays),
    });

    const subject = `${getReminderLabel(offsetDays)} - Invoice ${invoice.invoiceName}`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${invoice.shopName} <noreply@resend.dev>`,
        to: [invoice.buyerEmail],
        subject,
        html: emailHtml,
        headers: {
          "X-Idempotency-Key": `s18_${invoiceId}_${ruleId}`,
        },
      }),
    });

    if (!response.ok) {
      const _errorText = await response.text();
      const isAuthError = response.status === 401;
      const isRateLimited = response.status === 429;
      const isServerError = response.status >= 500;

      if (isAuthError) {
        console.error("[reminders] Resend auth error (revoked key?)");
      }

      await releaseReminderSlot(sql, ruleId, invoiceId);

      return {
        success: false,
        action: "skipped",
        error: `Resend API error: ${response.status}`,
        retryable: isRateLimited || isServerError,
      };
    }

    const result = (await response.json()) as { id?: string };
    await incrementDailySendCount(sql, shopId);

    return {
      success: true,
      action: "sent",
      resendId: result.id,
    };
  } catch (err) {
    await releaseReminderSlot(sql, ruleId, invoiceId);

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
 * Update a reminder rule.
 */
export async function updateReminderRule(
  sql: Sql,
  shopId: string,
  ruleId: string,
  updates: { offsetDays?: number; enabled?: boolean }
): Promise<boolean> {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.offsetDays !== undefined) {
    setClauses.push(`"offsetDays" = $${values.length + 1}`);
    values.push(updates.offsetDays);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = $${values.length + 1}`);
    values.push(updates.enabled);
  }

  if (setClauses.length === 0) {
    return false;
  }

  const result = await sql`
    UPDATE "ReminderRule"
    SET ${sql.unsafe(setClauses.join(", "))}, "updatedAt" = NOW()
    WHERE id = ${ruleId} AND "shopId" = ${shopId}
    RETURNING id
  `;
  return result.length > 0;
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
