/**
 * Aging bucket calculations for receivables.
 *
 * All amounts are in integer minor units (paise for INR, cents for USD, etc.)
 * to avoid floating-point issues. Never sum across currencies.
 *
 * Bucket definitions (days past due from "as of" date in Asia/Kolkata):
 * - Current: not yet due (dueAt >= asOf)
 * - 1-30: 1 to 30 days past due
 * - 31-60: 31 to 60 days past due
 * - 61-90: 61 to 90 days past due
 * - 90+: 91 or more days past due
 *
 * Due-date boundary rule: due today counts as Current (days past due = 0).
 * 1 day after due = 1-30 bucket.
 *
 * NOTE: Date calculations using luxon are in aging-dates.server.ts to keep
 * luxon out of the client bundle. This module only contains client-safe code.
 */

/** Bucket key names for aging buckets */
export type AgingBucketKey = "current" | "1-30" | "31-60" | "61-90" | "90+";

/** All bucket keys in order from newest to oldest */
export const AGING_BUCKET_KEYS: readonly AgingBucketKey[] = [
  "current",
  "1-30",
  "31-60",
  "61-90",
  "90+",
] as const;

/** Open invoice data needed for aging calculations */
export interface OpenInvoice {
  /** Invoice ID for reference */
  id: string;
  /** Outstanding amount in integer minor units (paise) */
  outstandingPaise: bigint;
  /** Due date (null if no due date set - treated as Current) */
  dueAt: Date | null;
  /** ISO 4217 currency code (e.g., "INR", "USD") */
  currency: string;
  /** Buyer account ID */
  buyerAccountId: string;
}

/** Amount totals per currency for a single bucket */
export interface BucketAmounts {
  /** Map of currency code to total amount in paise (bigint as string for serialization) */
  byCurrency: Map<string, bigint>;
}

/** Aging totals for a single entity (buyer or shop) */
export interface AgingTotals {
  /** Total outstanding amount per currency across all buckets */
  totalByCurrency: Map<string, bigint>;
  /** Amount per bucket */
  buckets: Record<AgingBucketKey, BucketAmounts>;
  /** Total overdue amount per currency (1-30 + 31-60 + 61-90 + 90+) */
  overdueByCurrency: Map<string, bigint>;
  /** Days past due for oldest overdue invoice (null if none overdue) */
  oldestOverdueDays: number | null;
}

/** Result for a single buyer account */
export interface BuyerAgingResult {
  buyerAccountId: string;
  totals: AgingTotals;
}

/** Complete aging result for a shop */
export interface ShopAgingResult {
  /** Shop-wide totals by currency */
  shopTotals: AgingTotals;
  /** Per-buyer aging data */
  byBuyer: Map<string, AgingTotals>;
}

/**
 * Determine which bucket an invoice falls into based on days past due.
 *
 * Bucket boundaries:
 * - Current: daysPastDue <= 0 (not yet due or due today)
 * - 1-30: 1 <= daysPastDue <= 30
 * - 31-60: 31 <= daysPastDue <= 60
 * - 61-90: 61 <= daysPastDue <= 90
 * - 90+: daysPastDue >= 91
 */
export function getBucketForDaysPastDue(daysPastDue: number): AgingBucketKey {
  if (daysPastDue <= 0) return "current";
  if (daysPastDue <= 30) return "1-30";
  if (daysPastDue <= 60) return "31-60";
  if (daysPastDue <= 90) return "61-90";
  return "90+";
}

/** Serializable version of BucketAmounts for JSON transport */
export interface SerializableBucketAmounts {
  byCurrency: Record<string, string>;
}

/** Serializable version of AgingTotals for JSON transport */
export interface SerializableAgingTotals {
  totalByCurrency: Record<string, string>;
  buckets: Record<AgingBucketKey, SerializableBucketAmounts>;
  overdueByCurrency: Record<string, string>;
  oldestOverdueDays: number | null;
}

/**
 * Convert a currency map (Map<string, bigint>) to a serializable record.
 * BigInts are converted to strings for JSON serialization.
 */
export function serializeCurrencyMap(
  map: Map<string, bigint>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [currency, amount] of map) {
    result[currency] = amount.toString();
  }
  return result;
}

/**
 * Convert a serializable record back to a currency map.
 */
export function deserializeCurrencyMap(
  record: Record<string, string>
): Map<string, bigint> {
  const map = new Map<string, bigint>();
  for (const [currency, amountStr] of Object.entries(record)) {
    map.set(currency, BigInt(amountStr));
  }
  return map;
}

/**
 * Convert BucketAmounts to serializable form.
 */
export function serializeBucketAmounts(
  amounts: BucketAmounts
): SerializableBucketAmounts {
  return {
    byCurrency: serializeCurrencyMap(amounts.byCurrency),
  };
}

/**
 * Convert AgingTotals to serializable form.
 */
export function serializeAgingTotals(
  totals: AgingTotals
): SerializableAgingTotals {
  return {
    totalByCurrency: serializeCurrencyMap(totals.totalByCurrency),
    buckets: {
      current: serializeBucketAmounts(totals.buckets.current),
      "1-30": serializeBucketAmounts(totals.buckets["1-30"]),
      "31-60": serializeBucketAmounts(totals.buckets["31-60"]),
      "61-90": serializeBucketAmounts(totals.buckets["61-90"]),
      "90+": serializeBucketAmounts(totals.buckets["90+"]),
    },
    overdueByCurrency: serializeCurrencyMap(totals.overdueByCurrency),
    oldestOverdueDays: totals.oldestOverdueDays,
  };
}

/**
 * Convert serializable form back to AgingTotals.
 */
export function deserializeAgingTotals(
  serialized: SerializableAgingTotals
): AgingTotals {
  const deserializeBucket = (
    bucket: SerializableBucketAmounts
  ): BucketAmounts => ({
    byCurrency: deserializeCurrencyMap(bucket.byCurrency),
  });

  return {
    totalByCurrency: deserializeCurrencyMap(serialized.totalByCurrency),
    buckets: {
      current: deserializeBucket(serialized.buckets.current),
      "1-30": deserializeBucket(serialized.buckets["1-30"]),
      "31-60": deserializeBucket(serialized.buckets["31-60"]),
      "61-90": deserializeBucket(serialized.buckets["61-90"]),
      "90+": deserializeBucket(serialized.buckets["90+"]),
    },
    overdueByCurrency: deserializeCurrencyMap(serialized.overdueByCurrency),
    oldestOverdueDays: serialized.oldestOverdueDays,
  };
}

/**
 * Format an amount in paise to a display string (e.g., "₹1,00,000.00").
 * Uses Indian numbering system for INR.
 */
export function formatPaiseAmount(paise: bigint, currency: string): string {
  const amount = Number(paise) / 100;

  if (currency === "INR") {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Bucket boundary constants for use in SQL queries.
 * Ensures SQL and TS calculations use the same boundaries.
 */
export const BUCKET_BOUNDARIES = {
  current: { min: null, max: 0 },
  "1-30": { min: 1, max: 30 },
  "31-60": { min: 31, max: 60 },
  "61-90": { min: 61, max: 90 },
  "90+": { min: 91, max: null },
} as const;

/** Row returned by buyer ledger query */
export interface BuyerLedgerRow {
  buyer_account_id: string;
  buyer_name: string;
  credit_limit_paise: string | null;
  hold_state: string;
  currency: string;
  outstanding_paise: string;
  overdue_paise: string;
  oldest_overdue_days: number | null;
  is_gated: boolean;
}

/** Row returned by buyer invoices query */
export interface BuyerInvoiceRow {
  id: string;
  name: string;
  order_id: string | null;
  due_at: Date | null;
  outstanding_paise: string;
  currency: string;
  days_past_due: number;
}

/**
 * Extract the Shopify order admin ID from a GID.
 * e.g., "gid://shopify/Order/123456" -> "123456"
 */
export function extractOrderIdFromGid(gid: string | null): string | null {
  if (!gid) return null;
  const match = gid.match(/gid:\/\/shopify\/Order\/(\d+)/);
  return match ? match[1] : null;
}

/**
 * Build the Shopify admin URL for an order using the shopify: protocol.
 * This protocol navigates within the Admin context when used in embedded apps.
 */
export function buildOrderAdminUrl(orderId: string | null): string | null {
  if (!orderId) return null;
  const id = extractOrderIdFromGid(orderId);
  if (!id) return null;
  return `shopify:admin/orders/${id}`;
}
