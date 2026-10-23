/**
 * Server-only date calculations for aging buckets.
 *
 * Uses luxon for timezone-aware date math. This module is kept separate
 * from aging.ts to avoid bundling luxon in the client.
 */

import { DateTime } from "luxon";
import type {
  OpenInvoice,
  AgingTotals,
  BucketAmounts,
  ShopAgingResult,
} from "./aging";
import { getBucketForDaysPastDue } from "./aging";

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
