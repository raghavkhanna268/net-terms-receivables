/**
 * Server-only date calculations for aging buckets.
 *
 * Uses luxon for timezone-aware date math. This module is kept separate
 * from aging.ts to avoid bundling luxon in the client.
 *
 * Timezone handling:
 * All aging calculations use the shop's IANA timezone (stored in Shop.timezone)
 * to determine calendar-day boundaries. This ensures accurate aging buckets
 * for shops in different timezones (e.g., "America/New_York", "Europe/London").
 */

import { DateTime, IANAZone } from "luxon";
import type {
  OpenInvoice,
  AgingTotals,
  BucketAmounts,
  ShopAgingResult,
} from "./aging";
import { getBucketForDaysPastDue } from "./aging";

/** Default timezone for backward compatibility */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Validate an IANA timezone string.
 *
 * Uses luxon's IANAZone.isValidZone() for validation.
 * Returns the timezone if valid, otherwise returns DEFAULT_TIMEZONE.
 *
 * This MUST be called:
 * - When writing Shop.timezone to the database
 * - When reading Shop.timezone before passing to luxon or Postgres AT TIME ZONE
 *
 * @param timezone - The timezone string to validate (may be null/undefined)
 * @returns A valid IANA timezone string (either the input or DEFAULT_TIMEZONE)
 */
export function validateTimezone(timezone: string | null | undefined): string {
  if (!timezone) {
    return DEFAULT_TIMEZONE;
  }

  // luxon's IANAZone.isValidZone is the authoritative check
  if (IANAZone.isValidZone(timezone)) {
    return timezone;
  }

  // Log invalid timezone for observability but don't throw
  console.warn(
    `[aging-dates] Invalid timezone "${timezone}", falling back to ${DEFAULT_TIMEZONE}`
  );
  return DEFAULT_TIMEZONE;
}

/**
 * Get the local date at start of day in the specified timezone.
 * Used to calculate "as of" date for consistent day boundaries.
 *
 * IMPORTANT: Always pass a validated timezone from validateTimezone().
 *
 * @param asOf - The "as of" date
 * @param timezone - Validated IANA timezone (e.g., "America/New_York")
 */
export function getAsOfDate(asOf: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(asOf, { zone: timezone }).startOf("day");
}

/**
 * @deprecated Use getAsOfDate(asOf, timezone) instead
 */
export function getAsOfDateIST(asOf: Date): DateTime {
  return getAsOfDate(asOf, DEFAULT_TIMEZONE);
}

/**
 * Get the local date at start of day for a due date in the specified timezone.
 * Null due dates are handled by the caller.
 *
 * IMPORTANT: Always pass a validated timezone from validateTimezone().
 *
 * @param dueAt - The due date
 * @param timezone - Validated IANA timezone (e.g., "America/New_York")
 */
function getDueDate(dueAt: Date, timezone: string): DateTime {
  return DateTime.fromJSDate(dueAt, { zone: timezone }).startOf("day");
}

/**
 * Calculate days past due for an invoice.
 *
 * IMPORTANT: The timezone parameter is required. Always pass shop.timezone
 * validated through validateTimezone() to ensure accurate calculations.
 *
 * @param dueAt - Invoice due date (null = not yet due, returns 0)
 * @param asOf - "As of" date for calculation
 * @param timezone - Validated IANA timezone for day boundary calculations (REQUIRED)
 * @returns Days past due (0 or negative means not yet due)
 */
export function calculateDaysPastDue(
  dueAt: Date | null,
  asOf: Date,
  timezone: string
): number {
  if (dueAt === null) {
    return 0;
  }

  // Validate timezone at runtime as a safety net
  const validTz = validateTimezone(timezone);
  const asOfLocal = getAsOfDate(asOf, validTz);
  const dueLocal = getDueDate(dueAt, validTz);

  const diffDays = Math.floor(asOfLocal.diff(dueLocal, "days").days);
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
 * IMPORTANT: The timezone parameter is required. Always pass shop.timezone
 * validated through validateTimezone() to ensure accurate calculations.
 *
 * @param invoices - List of open invoices with outstanding amounts
 * @param asOf - "As of" date for calculating days past due
 * @param timezone - Validated IANA timezone for day boundary calculations (REQUIRED)
 * @returns Shop-wide totals and per-buyer breakdown
 */
export function calculateAging(
  invoices: OpenInvoice[],
  asOf: Date,
  timezone: string
): ShopAgingResult {
  // Validate timezone at runtime as a safety net
  const validTz = validateTimezone(timezone);
  const shopTotals = emptyAgingTotals();
  const byBuyer = new Map<string, AgingTotals>();

  for (const invoice of invoices) {
    const { outstandingPaise, dueAt, currency, buyerAccountId } = invoice;

    if (outstandingPaise <= 0n) {
      continue;
    }

    const daysPastDue = calculateDaysPastDue(dueAt, asOf, validTz);
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
