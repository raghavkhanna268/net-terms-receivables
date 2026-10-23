/**
 * SQL queries for aging dashboard.
 *
 * These queries aggregate invoice aging data in SQL to avoid loading all
 * invoices into JavaScript. This is critical for the Cloudflare Workers Free
 * tier's 10ms CPU budget.
 *
 * All amounts are returned as bigint strings (paise) for exact arithmetic.
 * Currency grouping is done in SQL - amounts are never summed across currencies.
 *
 * Bucket boundaries match app/lib/aging.ts:
 * - Current: days_past_due <= 0
 * - 1-30: 1 <= days_past_due <= 30
 * - 31-60: 31 <= days_past_due <= 60
 * - 61-90: 61 <= days_past_due <= 90
 * - 90+: days_past_due >= 91
 */

import type { Sql } from "~/lib/db-light.server";
import { activeAccountFragment } from "~/services/gating.server";
import type {
  AgingBucketKey,
  SerializableAgingTotals,
  BuyerLedgerRow,
  BuyerInvoiceRow,
} from "./aging";

export type { BuyerLedgerRow, BuyerInvoiceRow };

/** Row returned by shop totals query */
interface ShopTotalRow {
  currency: string;
  bucket: string;
  total_paise: string;
}

/**
 * Get shop-wide aging totals aggregated by currency and bucket.
 *
 * Returns one row per currency per bucket with the total outstanding amount.
 * Empty buckets are not returned (filter them client-side).
 *
 * When gating is enforced (PLAN_GATING_ENFORCED=true), invoices for gated
 * accounts are excluded from the totals.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID to query
 * @param asOf - "As of" date for aging calculation
 * @returns Serializable aging totals structure
 */
export async function getShopAgingTotals(
  sql: Sql,
  shopId: string,
  asOf: Date
): Promise<SerializableAgingTotals> {
  // Query aggregates invoices by currency and bucket
  // Uses DATE_TRUNC for IST timezone day boundaries to match TS implementation
  const rows = await sql<ShopTotalRow[]>`
    WITH invoice_buckets AS (
      SELECT
        s.currency,
        (ROUND(i.outstanding * 100))::bigint AS outstanding_paise,
        CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END AS days_past_due
      FROM "Invoice" i
      JOIN "Shop" s ON s.id = i."shopId"
      JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
      WHERE i."shopId" = ${shopId}
        AND i.status = 'open'
        AND i.outstanding > 0
        AND ${activeAccountFragment(sql)}
    )
    SELECT
      currency,
      CASE
        WHEN days_past_due <= 0 THEN 'current'
        WHEN days_past_due <= 30 THEN '1-30'
        WHEN days_past_due <= 60 THEN '31-60'
        WHEN days_past_due <= 90 THEN '61-90'
        ELSE '90+'
      END AS bucket,
      SUM(outstanding_paise)::text AS total_paise
    FROM invoice_buckets
    GROUP BY currency, 
      CASE
        WHEN days_past_due <= 0 THEN 'current'
        WHEN days_past_due <= 30 THEN '1-30'
        WHEN days_past_due <= 60 THEN '31-60'
        WHEN days_past_due <= 90 THEN '61-90'
        ELSE '90+'
      END
  `;

  // Build the result structure
  const result: SerializableAgingTotals = {
    totalByCurrency: {},
    buckets: {
      current: { byCurrency: {} },
      "1-30": { byCurrency: {} },
      "31-60": { byCurrency: {} },
      "61-90": { byCurrency: {} },
      "90+": { byCurrency: {} },
    },
    overdueByCurrency: {},
    oldestOverdueDays: null,
  };

  for (const row of rows) {
    const bucket = row.bucket as AgingBucketKey;
    const currency = row.currency;
    const amount = row.total_paise;

    // Add to bucket
    result.buckets[bucket].byCurrency[currency] = amount;

    // Add to totals
    const existingTotal = BigInt(result.totalByCurrency[currency] ?? "0");
    result.totalByCurrency[currency] = (
      existingTotal + BigInt(amount)
    ).toString();

    // Add to overdue if not current
    if (bucket !== "current") {
      const existingOverdue = BigInt(result.overdueByCurrency[currency] ?? "0");
      result.overdueByCurrency[currency] = (
        existingOverdue + BigInt(amount)
      ).toString();
    }
  }

  // Get oldest overdue days in a separate query (more efficient than including in aggregation)
  const [oldestRow] = await sql<{ oldest_days: number | null }[]>`
    SELECT MAX(
      CASE
        WHEN i."dueAt" IS NULL THEN 0
        ELSE EXTRACT(DAY FROM (
          DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
          DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
        ))::int
      END
    ) FILTER (WHERE 
      CASE
        WHEN i."dueAt" IS NULL THEN 0
        ELSE EXTRACT(DAY FROM (
          DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
          DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
        ))::int
      END > 0
    ) AS oldest_days
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ${activeAccountFragment(sql)}
  `;

  result.oldestOverdueDays = oldestRow?.oldest_days ?? null;

  return result;
}

/**
 * Get buyer ledger with aging summary, paginated.
 *
 * Returns one row per buyer per currency with their total outstanding,
 * overdue amounts, and oldest overdue days.
 *
 * When gating is enforced (PLAN_GATING_ENFORCED=true), gated accounts are
 * excluded from the results. When gating is not enforced, all accounts are
 * included and the is_gated flag indicates their status.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID to query
 * @param asOf - "As of" date for aging calculation
 * @param options - Pagination and sorting options
 * @returns Array of buyer ledger rows
 */
export async function getBuyerLedger(
  sql: Sql,
  shopId: string,
  asOf: Date,
  options: {
    limit: number;
    offset: number;
    sortBy: "outstanding" | "overdue" | "name";
    sortOrder: "asc" | "desc";
  }
): Promise<{ rows: BuyerLedgerRow[]; totalCount: number }> {
  const { limit, offset, sortBy, sortOrder } = options;

  // Build the query with dynamic sort
  // Note: We use separate queries for each sort option to avoid sql.unsafe for column names
  let rows: BuyerLedgerRow[];

  const baseQuery = (orderClause: ReturnType<Sql>) => sql<BuyerLedgerRow[]>`
    WITH buyer_invoices AS (
      SELECT
        i."buyerAccountId",
        s.currency,
        (ROUND(i.outstanding * 100))::bigint AS outstanding_paise,
        CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END AS days_past_due
      FROM "Invoice" i
      JOIN "Shop" s ON s.id = i."shopId"
      JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
      WHERE i."shopId" = ${shopId}
        AND i.status = 'open'
        AND i.outstanding > 0
        AND ${activeAccountFragment(sql)}
    ),
    buyer_totals AS (
      SELECT
        "buyerAccountId",
        currency,
        SUM(outstanding_paise) AS outstanding_paise,
        COALESCE(SUM(outstanding_paise) FILTER (WHERE days_past_due > 0), 0) AS overdue_paise,
        MAX(days_past_due) FILTER (WHERE days_past_due > 0) AS oldest_overdue_days
      FROM buyer_invoices
      GROUP BY "buyerAccountId", currency
    )
    SELECT
      ba.id AS buyer_account_id,
      ba.name AS buyer_name,
      CASE WHEN ba."creditLimit" IS NULL THEN NULL ELSE (ROUND(ba."creditLimit" * 100))::text END AS credit_limit_paise,
      ba."holdState" AS hold_state,
      bt.currency,
      bt.outstanding_paise::text AS outstanding_paise,
      bt.overdue_paise::text AS overdue_paise,
      bt.oldest_overdue_days,
      ba.gated_at IS NOT NULL AS is_gated
    FROM buyer_totals bt
    JOIN "BuyerAccount" ba ON ba.id = bt."buyerAccountId"
    ${orderClause}
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  // Execute query with appropriate sort order
  if (sortBy === "name") {
    rows =
      sortOrder === "asc"
        ? await baseQuery(sql`ORDER BY ba.name ASC, bt.outstanding_paise DESC`)
        : await baseQuery(sql`ORDER BY ba.name DESC, bt.outstanding_paise DESC`);
  } else if (sortBy === "overdue") {
    rows =
      sortOrder === "asc"
        ? await baseQuery(sql`ORDER BY bt.overdue_paise ASC, ba.name ASC`)
        : await baseQuery(sql`ORDER BY bt.overdue_paise DESC, ba.name ASC`);
  } else {
    // sortBy === "outstanding" (default)
    rows =
      sortOrder === "asc"
        ? await baseQuery(sql`ORDER BY bt.outstanding_paise ASC, ba.name ASC`)
        : await baseQuery(sql`ORDER BY bt.outstanding_paise DESC, ba.name ASC`);
  }

  // Count query for pagination
  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(DISTINCT i."buyerAccountId")::text AS count
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ${activeAccountFragment(sql)}
  `;

  return {
    rows,
    totalCount: parseInt(countRow?.count ?? "0", 10),
  };
}

/**
 * Get open invoices for a specific buyer, sorted by due date.
 *
 * When gating is enforced (PLAN_GATING_ENFORCED=true), invoices for gated
 * accounts are excluded. This prevents viewing invoices for gated buyers.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID to query
 * @param buyerAccountId - Buyer account ID
 * @param asOf - "As of" date for days past due calculation
 * @param options - Pagination options
 * @returns Array of invoice rows
 */
export async function getBuyerInvoices(
  sql: Sql,
  shopId: string,
  buyerAccountId: string,
  asOf: Date,
  options: {
    limit: number;
    offset: number;
  }
): Promise<{ rows: BuyerInvoiceRow[]; totalCount: number }> {
  const { limit, offset } = options;

  const rows = await sql<BuyerInvoiceRow[]>`
    SELECT
      i.id,
      i.name,
      i."orderId" AS order_id,
      i."dueAt" AS due_at,
      (ROUND(i.outstanding * 100))::text AS outstanding_paise,
      s.currency,
      CASE
        WHEN i."dueAt" IS NULL THEN 0
        ELSE EXTRACT(DAY FROM (
          DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
          DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
        ))::int
      END AS days_past_due
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i."buyerAccountId" = ${buyerAccountId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ${activeAccountFragment(sql)}
    ORDER BY i."dueAt" ASC NULLS LAST, i.name ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  const [countRow] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM "Invoice" i
    JOIN "BuyerAccount" ba ON ba.id = i."buyerAccountId"
    WHERE i."shopId" = ${shopId}
      AND i."buyerAccountId" = ${buyerAccountId}
      AND i.status = 'open'
      AND i.outstanding > 0
      AND ${activeAccountFragment(sql)}
  `;

  return {
    rows,
    totalCount: parseInt(countRow?.count ?? "0", 10),
  };
}

/**
 * Get aggregated bucket totals that match the TS calculation.
 * Used by parity tests to verify SQL and TS produce the same results.
 */
export async function getAgingBucketsForParity(
  sql: Sql,
  shopId: string,
  asOf: Date
): Promise<
  Array<{
    id: string;
    currency: string;
    outstanding_paise: string;
    days_past_due: number;
    bucket: AgingBucketKey;
  }>
> {
  const rows = await sql<
    Array<{
      id: string;
      currency: string;
      outstanding_paise: string;
      days_past_due: number;
      bucket: string;
    }>
  >`
    SELECT
      i.id,
      s.currency,
      (ROUND(i.outstanding * 100))::text AS outstanding_paise,
      CASE
        WHEN i."dueAt" IS NULL THEN 0
        ELSE EXTRACT(DAY FROM (
          DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
          DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
        ))::int
      END AS days_past_due,
      CASE
        WHEN CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END <= 0 THEN 'current'
        WHEN CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END <= 30 THEN '1-30'
        WHEN CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END <= 60 THEN '31-60'
        WHEN CASE
          WHEN i."dueAt" IS NULL THEN 0
          ELSE EXTRACT(DAY FROM (
            DATE_TRUNC('day', ${asOf}::timestamptz AT TIME ZONE 'Asia/Kolkata') -
            DATE_TRUNC('day', i."dueAt" AT TIME ZONE 'Asia/Kolkata')
          ))::int
        END <= 90 THEN '61-90'
        ELSE '90+'
      END AS bucket
    FROM "Invoice" i
    JOIN "Shop" s ON s.id = i."shopId"
    WHERE i."shopId" = ${shopId}
      AND i.status = 'open'
      AND i.outstanding > 0
    ORDER BY i.id
  `;

  return rows.map((r) => ({
    ...r,
    bucket: r.bucket as AgingBucketKey,
  }));
}

