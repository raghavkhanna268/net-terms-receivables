/**
 * Shared overdue invoice predicate (Team Lead ruling: ONE overdue definition).
 *
 * Used by:
 * - credit-status.server.ts (holdState recompute)
 * - backstop.server.ts (S13 order-time hold check)
 * - credit-status-recompute.server.ts (event/cron-driven recompute)
 *
 * Overdue definition:
 * Invoices become overdue 1 day after the due date (end of day, shop time).
 *
 * An invoice is overdue if:
 * - status = 'open'
 * - outstanding > 0
 * - dueAt IS NOT NULL
 * - dueAt < NOW() - INTERVAL '1 day'
 *
 * This means an invoice due yesterday is NOT yet overdue. An invoice due
 * 2+ days ago IS overdue.
 */

import type { Sql } from "~/lib/db-light.server";

/**
 * Check if a buyer account has any overdue invoices.
 *
 * Invoices become overdue 1 day after the due date (end of day, shop time).
 * Uses: dueAt < NOW() - INTERVAL '1 day'
 *
 * @param sql - Database connection
 * @param buyerAccountId - Buyer account ID
 * @returns true if any overdue invoices exist
 */
export async function hasOverdueInvoices(
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

