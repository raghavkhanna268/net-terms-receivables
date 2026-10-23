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
 */

import { DateTime } from "luxon";

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
 * Get the local date at start of day in Asia/Kolkata for a given Date.
 * Used to calculate "as of" date for consistent day boundaries.
 */
export function getAsOfDateIST(asOf: Date): DateTime {
  return DateTime.fromJSDate(asOf, { zone: "Asia/Kolkata" }).startOf("day");
}

/**
 * Get the local date at start of day for a due date in Asia/Kolkata.
 * Null due dates are handled by the caller.
 */
function getDueDateIST(dueAt: Date): DateTime {
  return DateTime.fromJSDate(dueAt, { zone: "Asia/Kolkata" }).startOf("day");
}

/**
 * Calculate days past due for an invoice.
 *
 * @param dueAt - Invoice due date (null = not yet due, returns 0)
 * @param asOf - "As of" date for calculation
 * @returns Days past due (0 or negative means not yet due)
 */
export function calculateDaysPastDue(dueAt: Date | null, asOf: Date): number {
  if (dueAt === null) {
    return 0;
  }

  const asOfIST = getAsOfDateIST(asOf);
  const dueIST = getDueDateIST(dueAt);

  const diffDays = Math.floor(asOfIST.diff(dueIST, "days").days);
  return diffDays;
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

/**
 * Create empty bucket amounts.
 */
function emptyBucketAmounts(): BucketAmounts {
  return { byCurrency: new Map() };
}

/**
 * Create empty aging totals.
 */
function emptyAgingTotals(): AgingTotals {
  return {
    totalByCurrency: new Map(),
    buckets: {
      current: emptyBucketAmounts(),
      "1-30": emptyBucketAmounts(),
      "31-60": emptyBucketAmounts(),
      "61-90": emptyBucketAmounts(),
      "90+": emptyBucketAmounts(),
    },
    overdueByCurrency: new Map(),
    oldestOverdueDays: null,
  };
}

/**
 * Add an amount to a currency map.
 */
function addToCurrencyMap(
  map: Map<string, bigint>,
  currency: string,
  amount: bigint
): void {
  const existing = map.get(currency) ?? 0n;
  map.set(currency, existing + amount);
}

/**
 * Calculate aging buckets for a list of open invoices.
 *
 * All calculations use integer paise (minor units) to avoid floating-point issues.
 * Amounts are never summed across currencies - each currency is tracked separately.
 *
 * @param invoices - List of open invoices with outstanding amounts
 * @param asOf - "As of" date for calculating days past due (in Asia/Kolkata timezone)
 * @returns Shop-wide totals and per-buyer breakdown
 */
export function calculateAging(
  invoices: OpenInvoice[],
  asOf: Date
): ShopAgingResult {
  const shopTotals = emptyAgingTotals();
  const byBuyer = new Map<string, AgingTotals>();

  for (const invoice of invoices) {
    const { outstandingPaise, dueAt, currency, buyerAccountId } = invoice;

    if (outstandingPaise <= 0n) {
      continue;
    }

    const daysPastDue = calculateDaysPastDue(dueAt, asOf);
    const bucket = getBucketForDaysPastDue(daysPastDue);
    const isOverdue = daysPastDue > 0;

    // Get or create buyer totals
    let buyerTotals = byBuyer.get(buyerAccountId);
    if (!buyerTotals) {
      buyerTotals = emptyAgingTotals();
      byBuyer.set(buyerAccountId, buyerTotals);
    }

    // Add to bucket totals
    addToCurrencyMap(
      shopTotals.buckets[bucket].byCurrency,
      currency,
      outstandingPaise
    );
    addToCurrencyMap(
      buyerTotals.buckets[bucket].byCurrency,
      currency,
      outstandingPaise
    );

    // Add to total outstanding
    addToCurrencyMap(shopTotals.totalByCurrency, currency, outstandingPaise);
    addToCurrencyMap(buyerTotals.totalByCurrency, currency, outstandingPaise);

    // Add to overdue totals if overdue
    if (isOverdue) {
      addToCurrencyMap(shopTotals.overdueByCurrency, currency, outstandingPaise);
      addToCurrencyMap(
        buyerTotals.overdueByCurrency,
        currency,
        outstandingPaise
      );

      // Track oldest overdue days
      if (
        shopTotals.oldestOverdueDays === null ||
        daysPastDue > shopTotals.oldestOverdueDays
      ) {
        shopTotals.oldestOverdueDays = daysPastDue;
      }
      if (
        buyerTotals.oldestOverdueDays === null ||
        daysPastDue > buyerTotals.oldestOverdueDays
      ) {
        buyerTotals.oldestOverdueDays = daysPastDue;
      }
    }
  }

  return { shopTotals, byBuyer };
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
 * Build the Shopify admin URL for an order.
 */
export function buildOrderAdminUrl(
  shopDomain: string,
  orderId: string | null
): string | null {
  if (!orderId) return null;
  const id = extractOrderIdFromGid(orderId);
  if (!id) return null;
  const storeHandle = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${storeHandle}/orders/${id}`;
}
