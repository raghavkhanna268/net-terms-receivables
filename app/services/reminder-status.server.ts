/**
 * S18 Reminder Status Service
 *
 * Read-only queries for reminder status counts and delayed reminder details.
 * All queries are filtered by shopId for shop isolation.
 */
import type { Sql } from "postgres";

export interface ReminderStatusCounts {
  sent: number;
  delayed: number;
  skippedDailyLimit: number;
  skippedOptedOut: number;
}

export interface DelayedReminder {
  id: string;
  invoiceName: string;
  offsetDays: number;
  firstCappedAt: Date | null;
  catchUpBy: string;
}

/**
 * Get counts of reminders by status for a shop.
 * Returns zeros when there are no rows.
 * Uses the existing shopId index on ReminderLog (idx: ReminderLog_shopId_idx).
 */
export async function getReminderStatusCounts(
  sql: Sql,
  shopId: string
): Promise<ReminderStatusCounts> {
  const rows = await sql<{ status: string; count: string }[]>`
    SELECT status::TEXT, COUNT(*)::TEXT AS count
    FROM "ReminderLog"
    WHERE "shopId" = ${shopId}
    GROUP BY status
  `;

  const counts: ReminderStatusCounts = {
    sent: 0,
    delayed: 0,
    skippedDailyLimit: 0,
    skippedOptedOut: 0,
  };

  for (const row of rows) {
    const count = parseInt(row.count, 10);
    switch (row.status) {
      case "sent":
        counts.sent = count;
        break;
      case "delayed":
        counts.delayed = count;
        break;
      case "skipped_daily_limit":
        counts.skippedDailyLimit = count;
        break;
      case "skipped_opted_out":
        counts.skippedOptedOut = count;
        break;
    }
  }

  return counts;
}

/**
 * Get delayed reminders for a shop with catch-up-by date.
 *
 * catchUpBy is computed as:
 *   (i."dueAt" AT TIME ZONE s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3
 *
 * This matches the catch-up window expiry logic in the migration:
 *   prisma/migrations/20261112000000_s18_reminder_catchup/migration.sql
 *   Part 1, lines 103-104:
 *     AND (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE >
 *         ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3);
 *
 * Joins include shopId equality for proper index use.
 * Does NOT select buyer email, name, or any customer/buyer PII.
 * Orders by catchUpBy ascending (most urgent first).
 */
export async function getDelayedReminders(
  sql: Sql,
  shopId: string,
  limit: number = 50
): Promise<DelayedReminder[]> {
  const rows = await sql<{
    id: string;
    invoiceName: string;
    offsetDays: number;
    firstCappedAt: Date | null;
    catchUpBy: string;
  }[]>`
    SELECT
      rl.id,
      i.name AS "invoiceName",
      r."offsetDays",
      rl."firstCappedAt",
      ((i."dueAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE + r."offsetDays" + 3)::TEXT AS "catchUpBy"
    FROM "ReminderLog" rl
    INNER JOIN "Invoice" i ON i.id = rl."invoiceId" AND i."shopId" = rl."shopId"
    INNER JOIN "ReminderRule" r ON r.id = rl."ruleId" AND r."shopId" = rl."shopId"
    INNER JOIN "Shop" s ON s.id = rl."shopId"
    WHERE rl."shopId" = ${shopId}
      AND rl.status = 'delayed'
    ORDER BY "catchUpBy" ASC
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    invoiceName: row.invoiceName,
    offsetDays: row.offsetDays,
    firstCappedAt: row.firstCappedAt,
    catchUpBy: row.catchUpBy,
  }));
}

/**
 * Get count of reminders sent TODAY for a specific shop.
 * "Today" is determined using the shop's timezone via s18_safe_timezone.
 * Only counts reminders with status='sent' and sentAt on today's date in shop time.
 * Does not expose global or cross-shop counts.
 */
export async function getShopSentTodayCount(
  sql: Sql,
  shopId: string
): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::TEXT AS count
    FROM "ReminderLog" rl
    INNER JOIN "Shop" s ON s.id = rl."shopId"
    WHERE rl."shopId" = ${shopId}
      AND rl.status = 'sent'
      AND (rl."sentAt" AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
          = (NOW() AT TIME ZONE public.s18_safe_timezone(s.timezone))::DATE
  `;

  return parseInt(row?.count ?? "0", 10);
}
