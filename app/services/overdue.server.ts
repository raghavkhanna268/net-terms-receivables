/**
 * Shared overdue invoice predicate (Team Lead ruling: ONE overdue definition).
 *
 * Used by:
 * - credit-status.server.ts (holdState recompute)
 * - backstop.server.ts (S13 order-time hold check)
 * - credit-status-recompute.server.ts (event/cron-driven recompute)
 *
 * Overdue definition:
 * An invoice is overdue if:
 * - status = 'open'
 * - outstanding > 0
 * - dueAt IS NOT NULL
 * - dueAt < NOW() - INTERVAL '1 day' (1-day grace period after due date)
 *
 * This means an invoice due yesterday is NOT yet overdue. An invoice due
 * 2+ days ago IS overdue.
 */

import type { Sql } from "~/lib/db-light.server";

/**
 * Check if a buyer account has any overdue invoices.
 *
 * Uses a 1-day grace period: dueAt < NOW() - INTERVAL '1 day'
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

/**
 * SQL fragment for the overdue predicate (for use in larger queries).
 *
 * Returns the WHERE clause conditions as a template literal fragment.
 * Caller must provide the table alias or ensure "Invoice" columns are in scope.
 *
 * Example usage in a CTE or subquery:
 * ```sql
 * SELECT ... FROM "Invoice" i
 * WHERE i."buyerAccountId" = ${buyerAccountId}
 *   AND ${overdueInvoiceConditions(sql, 'i')}
 * ```
 */
export function overdueInvoiceConditionsSql(sql: Sql, tableAlias: string = ''): ReturnType<Sql> {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  return sql`
    ${sql.unsafe(`${prefix}status`)} = 'open'
    AND ${sql.unsafe(`${prefix}outstanding`)} > 0
    AND ${sql.unsafe(`${prefix}"dueAt"`)} IS NOT NULL
    AND ${sql.unsafe(`${prefix}"dueAt"`)} < NOW() - INTERVAL '1 day'
  `;
}
