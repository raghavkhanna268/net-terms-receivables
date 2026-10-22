/**
 * Due Date Inference Logic for Net Terms Receivables
 *
 * This module determines invoice due dates based on multiple sources with
 * a defined precedence order:
 *
 * 1. Shopify PaymentSchedule with dueAt (source: "schedule") - highest priority
 *    - Uses the earliest non-completed schedule's dueAt
 *    - Falls back to the latest dueAt if all completed
 *    - RECEIPT terms: use Shopify's dueAt if provided, else EOD of order date
 *
 * 1b. NET/FIXED with dueInDays but no schedule dueAt (source: "schedule", basis: "paymentTermsDueInDays")
 *    - Computed from orderCreatedAt + dueInDays
 *
 * 2. FULFILLMENT terms without fulfillment date
 *    - Returns pending status, then falls through to override/inferred sources
 *    - Once fulfilled, calculates from fulfillment date
 *
 * 3. Merchant override (source: "override") - beats all INFERRED sources
 *    - Optional merchantOverrideDueAt input
 *    - IMPORTANT: Does NOT override a Shopify PaymentSchedule with dueAt, because
 *      for schedule-backed orders Shopify is the source of truth. In that case we
 *      keep 'schedule' and note in `reason` that the override was ignored.
 *    - CAN apply when FULFILLMENT has no date yet (no Shopify date to conflict with)
 *
 * 4-6. Inferred sources (configurable via INFERENCE_ORDER or inferenceOrder param):
 *    - "accountDefault": Account's EXPLICIT defaultTermsDays
 *    - "tagRule": Tag rule match OR tag-copied account default (more specific than shop)
 *      If multiple rules match, uses the LARGEST defaultTermsDays (conservative)
 *    - "shopDefault": Shop's default terms days (last resort before 'none')
 *
 * Special case: tag-copied account defaults
 *    If accountDefaultTermsSource is 'tag', the account's default was copied from
 *    a tag at sync time. We skip it at the account-default step. It participates
 *    at the tag-rule level: if a current tag rule matches, use it; otherwise fall
 *    back to the copied value (it's more specific than the shop default).
 *
 * 7. No source available (source: "none")
 *
 * Date arithmetic: adds N calendar days in the shop's IANA timezone
 * (default 'Asia/Kolkata') and returns end-of-day (23:59:59.999 local)
 * as a UTC Date. Handles DST correctly using iterative offset calculation.
 */

/**
 * Inferred-source precedence order.
 * PaymentSchedule and merchantOverride always come first (not in this list).
 * Default: account default beats tag rule beats shop default.
 * To flip account/tag: change to ['tagRule', 'accountDefault', 'shopDefault'].
 */
export const INFERENCE_ORDER = [
  "accountDefault",
  "tagRule",
  "shopDefault",
] as const;

/** Type for inferred source keys */
export type InferredSourceKey = (typeof INFERENCE_ORDER)[number];

/** Basis for the due date calculation */
export type DueDateBasis =
  | InferredSourceKey
  | "paymentTermsDueInDays"
  | null;

/** Shopify payment terms types */
export type PaymentTermsType = "NET" | "FIXED" | "FULFILLMENT" | "RECEIPT";

/** A single payment schedule entry from Shopify */
export interface PaymentSchedule {
  /** When the payment is due (null for unfulfilled FULFILLMENT terms) */
  dueAt: Date | null;
  /** When the payment was completed (null if not yet paid) */
  completedAt: Date | null;
}

/** Payment terms from a Shopify order */
export interface PaymentTerms {
  /** Type of payment terms */
  type: PaymentTermsType;
  /** Days until payment is due (for NET terms) */
  dueInDays: number | null;
  /** Payment schedule entries */
  schedules: PaymentSchedule[];
}

/** A tag-based rule for inferring default terms */
export interface TagRule {
  /** The tag to match (case-insensitive, trimmed) */
  tag: string;
  /** Default terms days when this tag matches (must be non-negative integer) */
  defaultTermsDays: number;
}

/**
 * Source of the account's default terms.
 * - 'explicit': Set directly on the account by the merchant
 * - 'tag': Copied from a tag rule at sync time
 *
 * TODO(S5): The DB column for this comes in S5 with the ledger schema.
 */
export type AccountDefaultTermsSource = "explicit" | "tag";

/** Input for the inferDueDate function */
export interface InferDueDateInput {
  /** Payment terms from the Shopify order, if any */
  paymentTerms: PaymentTerms | null;
  /** When the order was created/issued */
  orderCreatedAt: Date;
  /** When the order was fulfilled (for FULFILLMENT terms) */
  fulfilledAt: Date | null;
  /** The buyer account's own default terms days */
  accountDefaultTermsDays: number | null;
  /**
   * Source of the account's default terms.
   * TODO(S5): Wire this from the DB column added in S5.
   */
  accountDefaultTermsSource: AccountDefaultTermsSource | null;
  /** Tag rules configured for the shop */
  tagRules: TagRule[];
  /** Tags on the customer */
  customerTags: string[];
  /** Shop's default terms days (last resort fallback) */
  shopDefaultTermsDays: number | null;
  /** Merchant override for this specific invoice's due date */
  merchantOverrideDueAt: Date | null;
  /** Shop's IANA timezone (default: 'Asia/Kolkata') */
  shopTimezone?: string;
  /** Override inferred-source precedence (default: INFERENCE_ORDER) */
  inferenceOrder?: readonly InferredSourceKey[];
}

/** Result of due date inference */
export interface InferDueDateResult {
  /** The calculated due date, or null if unavailable */
  dueAt: Date | null;
  /** Source of the due date */
  dueSource: "schedule" | "override" | "inferred" | "none";
  /** Which inferred source was used (null if dueSource is not 'inferred', or 'paymentTermsDueInDays' for computed NET) */
  basis: DueDateBasis;
  /** Human-readable explanation of how the due date was determined */
  reason: string;
}

const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Validate that a timezone is valid IANA timezone.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate that a Date is valid.
 */
function isValidDate(d: Date): boolean {
  return d instanceof Date && !isNaN(d.getTime());
}

/**
 * Get offset in milliseconds for a given UTC instant in a timezone.
 * Returns the difference: localTime - utcTime (positive for east of UTC).
 */
function getOffsetMs(utcInstant: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });

  const parts = formatter.formatToParts(utcInstant);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  const localYear = getPart("year");
  const localMonth = getPart("month");
  const localDay = getPart("day");
  const localHour = getPart("hour");
  const localMinute = getPart("minute");
  const localSecond = getPart("second");

  const localAsUtc = Date.UTC(
    localYear,
    localMonth - 1,
    localDay,
    localHour,
    localMinute,
    localSecond,
    utcInstant.getUTCMilliseconds()
  );

  return localAsUtc - utcInstant.getTime();
}

/**
 * Get the local date components for a UTC instant in a timezone.
 */
function getLocalDateParts(
  utcInstant: Date,
  timezone: string
): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });

  const parts = formatter.formatToParts(utcInstant);
  const getPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
  };
}

/**
 * Calculate end-of-day (23:59:59.999) for a given local date in a specific timezone,
 * returning the UTC instant.
 *
 * Uses iterative offset calculation to handle DST transitions correctly:
 * 1. Start with wall clock time 23:59:59.999 as if it were UTC
 * 2. Adjust by the offset at that instant
 * 3. Re-adjust by the offset at the corrected instant (handles DST edge)
 */
export function endOfLocalDay(
  year: number,
  month: number,
  day: number,
  timezone: string
): Date {
  // Wall clock time we want: 23:59:59.999 on the given date
  const wallMs = Date.UTC(year, month - 1, day, 23, 59, 59, 999);

  // First approximation: UTC instant = wall - offset(wall)
  let t = wallMs - getOffsetMs(new Date(wallMs), timezone);

  // Second iteration: refine with offset at the approximated instant
  // This handles DST transitions where the offset changes between wall and t
  t = wallMs - getOffsetMs(new Date(t), timezone);

  return new Date(t);
}

/**
 * Calculate end-of-day (23:59:59.999) for a given UTC instant's local date in a timezone.
 */
export function getEndOfDayInTimezone(utcInstant: Date, timezone: string): Date {
  const { year, month, day } = getLocalDateParts(utcInstant, timezone);
  return endOfLocalDay(year, month, day, timezone);
}

/**
 * Add calendar days to a date and return end-of-day in the specified timezone.
 */
export function addDaysAndGetEndOfDay(
  baseDate: Date,
  days: number,
  timezone: string
): Date {
  // Get the local date components
  const { year, month, day } = getLocalDateParts(baseDate, timezone);

  // Add days using UTC date arithmetic to get the target calendar date
  // This correctly handles month/year overflow
  const targetDate = new Date(Date.UTC(year, month - 1, day + days));

  // Return end of that target date in the timezone
  return endOfLocalDay(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth() + 1,
    targetDate.getUTCDate(),
    timezone
  );
}

/**
 * Validate tag rules: must have non-negative integer defaultTermsDays.
 * Returns valid rules and a list of invalid rules.
 */
function validateTagRules(rules: TagRule[]): {
  valid: TagRule[];
  invalid: TagRule[];
} {
  const valid: TagRule[] = [];
  const invalid: TagRule[] = [];

  for (const rule of rules) {
    if (
      typeof rule.defaultTermsDays === "number" &&
      Number.isInteger(rule.defaultTermsDays) &&
      rule.defaultTermsDays >= 0
    ) {
      valid.push(rule);
    } else {
      invalid.push(rule);
    }
  }

  return { valid, invalid };
}

/**
 * Infer the due date for an invoice based on available information.
 */
export function inferDueDate(input: InferDueDateInput): InferDueDateResult {
  // Validate orderCreatedAt
  if (!isValidDate(input.orderCreatedAt)) {
    return {
      dueAt: null,
      dueSource: "none",
      basis: null,
      reason: "Invalid order created date",
    };
  }

  // Validate and normalize timezone
  const requestedTz = input.shopTimezone ?? DEFAULT_TIMEZONE;
  const timezone = isValidTimezone(requestedTz) ? requestedTz : DEFAULT_TIMEZONE;
  const tzNote =
    timezone !== requestedTz
      ? ` (invalid timezone '${requestedTz}' replaced with '${DEFAULT_TIMEZONE}')`
      : "";

  const order = input.inferenceOrder ?? INFERENCE_ORDER;

  // 1. Try Shopify PaymentSchedule first (highest priority)
  if (input.paymentTerms) {
    const scheduleResult = inferFromPaymentTerms(
      input.paymentTerms,
      input.orderCreatedAt,
      input.fulfilledAt,
      timezone
    );

    if (scheduleResult) {
      // If we got a definite schedule result (not pending FULFILLMENT)
      if (scheduleResult.dueAt !== null || scheduleResult.dueSource === "schedule") {
        // If there's a merchant override but we have a schedule dueAt, note it
        if (input.merchantOverrideDueAt && scheduleResult.dueAt) {
          return {
            ...scheduleResult,
            reason:
              scheduleResult.reason +
              " (merchant override ignored; change terms in Shopify for schedule-backed orders)" +
              tzNote,
          };
        }
        // For FULFILLMENT pending (null dueAt), fall through to try override
        if (scheduleResult.dueAt !== null) {
          return {
            ...scheduleResult,
            reason: scheduleResult.reason + tzNote,
          };
        }
      }
    }
  }

  // Check for pending FULFILLMENT - can use override or inferred sources
  const isPendingFulfillment =
    input.paymentTerms?.type === "FULFILLMENT" && !input.fulfilledAt;
  const fulfillmentNote = isPendingFulfillment
    ? " (FULFILLMENT pending: no fulfillment date yet)"
    : "";

  // 2. Merchant override beats all inferred sources
  if (input.merchantOverrideDueAt) {
    if (!isValidDate(input.merchantOverrideDueAt)) {
      return {
        dueAt: null,
        dueSource: "none",
        basis: null,
        reason: "Invalid merchant override date" + fulfillmentNote + tzNote,
      };
    }
    return {
      dueAt: input.merchantOverrideDueAt,
      dueSource: "override",
      basis: null,
      reason: "Merchant override for this invoice" + fulfillmentNote + tzNote,
    };
  }

  // 3-5. Try inferred sources in configured order
  for (const source of order) {
    const result = tryInferredSource(source, input, timezone);
    if (result) {
      return {
        ...result,
        reason: result.reason + fulfillmentNote + tzNote,
      };
    }
  }

  // 6. Nothing available
  return {
    dueAt: null,
    dueSource: "none",
    basis: null,
    reason:
      "No payment terms, merchant override, account default, tag rule, or shop default found" +
      fulfillmentNote +
      tzNote,
  };
}

/**
 * Try a single inferred source.
 */
function tryInferredSource(
  source: InferredSourceKey,
  input: InferDueDateInput,
  timezone: string
): InferDueDateResult | null {
  switch (source) {
    case "accountDefault":
      return tryAccountDefault(input, timezone);
    case "tagRule":
      return tryTagRulesWithCopiedFallback(input, timezone);
    case "shopDefault":
      return tryShopDefault(input, timezone);
  }
}

/**
 * Try account default terms.
 * Skipped if the account's default was copied from a tag ('tag' source).
 */
function tryAccountDefault(
  input: InferDueDateInput,
  timezone: string
): InferDueDateResult | null {
  // Skip if the account default was copied from a tag
  if (input.accountDefaultTermsSource === "tag") {
    return null;
  }

  if (
    input.accountDefaultTermsDays !== null &&
    Number.isInteger(input.accountDefaultTermsDays) &&
    input.accountDefaultTermsDays >= 0
  ) {
    const dueAt = addDaysAndGetEndOfDay(
      input.orderCreatedAt,
      input.accountDefaultTermsDays,
      timezone
    );
    return {
      dueAt,
      dueSource: "inferred",
      basis: "accountDefault",
      reason: `Account default: net ${input.accountDefaultTermsDays} days`,
    };
  }

  return null;
}

/**
 * Try tag rules, with fallback to tag-copied account default.
 *
 * ARCHITECTURE DECISION: When multiple rules match, we use the LARGEST
 * defaultTermsDays. This is a conservative choice that ensures we never
 * flag a buyer as overdue prematurely. The tradeoff is that some payments
 * may appear current for longer than intended if tags are misconfigured.
 *
 * Tag-copied account defaults participate at this level (more specific than
 * shop default). If a current tag rule matches, use it. Otherwise fall back
 * to the copied value.
 */
function tryTagRulesWithCopiedFallback(
  input: InferDueDateInput,
  timezone: string
): InferDueDateResult | null {
  // First try matching tag rules
  const tagRuleResult = tryTagRules(input, timezone);
  if (tagRuleResult) {
    return tagRuleResult;
  }

  // Fall back to tag-copied account default (more specific than shop default)
  if (
    input.accountDefaultTermsSource === "tag" &&
    input.accountDefaultTermsDays !== null &&
    Number.isInteger(input.accountDefaultTermsDays) &&
    input.accountDefaultTermsDays >= 0
  ) {
    const dueAt = addDaysAndGetEndOfDay(
      input.orderCreatedAt,
      input.accountDefaultTermsDays,
      timezone
    );
    return {
      dueAt,
      dueSource: "inferred",
      basis: "tagRule",
      reason: `Tag-derived account default: net ${input.accountDefaultTermsDays} days (no current tag rule matched)`,
    };
  }

  return null;
}

/**
 * Try tag rules only (no fallback).
 */
function tryTagRules(
  input: InferDueDateInput,
  timezone: string
): InferDueDateResult | null {
  if (input.tagRules.length === 0 || input.customerTags.length === 0) {
    return null;
  }

  // Validate tag rules
  const { valid: validRules, invalid: invalidRules } = validateTagRules(
    input.tagRules
  );

  if (validRules.length === 0) {
    if (invalidRules.length > 0) {
      // All rules were invalid - this shouldn't block, just skip
      return null;
    }
    return null;
  }

  // Normalize customer tags: lowercase and trim
  const normalizedCustomerTags = input.customerTags.map((t) =>
    t.toLowerCase().trim()
  );

  // Find all matching rules
  const matchingRules = validRules.filter((rule) =>
    normalizedCustomerTags.includes(rule.tag.toLowerCase().trim())
  );

  if (matchingRules.length === 0) {
    return null;
  }

  // CONSERVATIVE CHOICE: Pick the largest defaultTermsDays when multiple match
  // This ensures we never flag a buyer overdue early.
  const bestRule = matchingRules.reduce((max, rule) =>
    rule.defaultTermsDays > max.defaultTermsDays ? rule : max
  );

  const dueAt = addDaysAndGetEndOfDay(
    input.orderCreatedAt,
    bestRule.defaultTermsDays,
    timezone
  );

  let reason: string;
  if (matchingRules.length > 1) {
    const matchedTags = matchingRules.map((r) => r.tag).join(", ");
    reason = `Tag rule '${bestRule.tag}': net ${bestRule.defaultTermsDays} days (${matchingRules.length} rules matched: ${matchedTags}; using largest)`;
  } else {
    reason = `Tag rule '${bestRule.tag}': net ${bestRule.defaultTermsDays} days`;
  }

  // Note if any rules were invalid
  if (invalidRules.length > 0) {
    reason += ` (${invalidRules.length} invalid rule(s) ignored)`;
  }

  return {
    dueAt,
    dueSource: "inferred",
    basis: "tagRule",
    reason,
  };
}

/**
 * Try shop default terms (last resort before 'none').
 */
function tryShopDefault(
  input: InferDueDateInput,
  timezone: string
): InferDueDateResult | null {
  if (
    input.shopDefaultTermsDays !== null &&
    Number.isInteger(input.shopDefaultTermsDays) &&
    input.shopDefaultTermsDays >= 0
  ) {
    const dueAt = addDaysAndGetEndOfDay(
      input.orderCreatedAt,
      input.shopDefaultTermsDays,
      timezone
    );
    return {
      dueAt,
      dueSource: "inferred",
      basis: "shopDefault",
      reason: `Shop default: net ${input.shopDefaultTermsDays} days`,
    };
  }

  return null;
}

/**
 * Infer due date from Shopify payment terms.
 * Returns null only if we should fall through to other sources.
 */
function inferFromPaymentTerms(
  terms: PaymentTerms,
  orderCreatedAt: Date,
  fulfilledAt: Date | null,
  timezone: string
): InferDueDateResult | null {
  const { type, schedules, dueInDays } = terms;

  // Handle RECEIPT type
  if (type === "RECEIPT") {
    // Check if any schedule has a dueAt set by Shopify - use it if so
    const scheduleWithDue = schedules.find((s) => s.dueAt !== null);
    if (scheduleWithDue?.dueAt) {
      return {
        dueAt: scheduleWithDue.dueAt,
        dueSource: "schedule",
        basis: null,
        reason: "Payment due on receipt (Shopify schedule)",
      };
    }
    // Otherwise use end of order date
    const dueAt = getEndOfDayInTimezone(orderCreatedAt, timezone);
    return {
      dueAt,
      dueSource: "schedule",
      basis: null,
      reason: "Payment due on receipt (issue date)",
    };
  }

  // Handle FULFILLMENT type
  if (type === "FULFILLMENT") {
    // Check if any schedule has a dueAt already set by Shopify
    const scheduleWithDue = schedules.find((s) => s.dueAt !== null);
    if (scheduleWithDue?.dueAt) {
      return {
        dueAt: scheduleWithDue.dueAt,
        dueSource: "schedule",
        basis: null,
        reason: "Payment due on fulfillment (schedule set by Shopify)",
      };
    }

    // No dueAt set yet - need fulfillment date
    if (!fulfilledAt) {
      // Return null to signal fall-through to override/inferred sources
      // The caller will add the fulfillment note
      return null;
    }

    // Calculate due date from fulfillment date
    const daysToAdd = dueInDays ?? 0;
    const dueAt = addDaysAndGetEndOfDay(fulfilledAt, daysToAdd, timezone);
    return {
      dueAt,
      dueSource: "schedule",
      basis: null,
      reason: `FULFILLMENT terms: net ${daysToAdd} days from fulfillment`,
    };
  }

  // For NET and FIXED types: find the appropriate schedule
  // First, try to find a schedule with dueAt
  const nonCompletedSchedules = schedules.filter((s) => s.completedAt === null);
  const completedSchedules = schedules.filter((s) => s.completedAt !== null);

  // Use the earliest non-completed schedule with dueAt
  if (nonCompletedSchedules.length > 0) {
    const withDueAt = nonCompletedSchedules.filter((s) => s.dueAt !== null);
    if (withDueAt.length > 0) {
      const earliest = withDueAt.reduce((min, s) =>
        s.dueAt!.getTime() < min.dueAt!.getTime() ? s : min
      );
      return {
        dueAt: earliest.dueAt,
        dueSource: "schedule",
        basis: null,
        reason:
          withDueAt.length > 1
            ? `Earliest of ${withDueAt.length} pending payment schedules`
            : "Payment schedule from Shopify",
      };
    }
  }

  // All schedules are completed - use the latest dueAt (not array-last)
  if (completedSchedules.length > 0) {
    const withDueAt = completedSchedules.filter((s) => s.dueAt !== null);
    if (withDueAt.length > 0) {
      const latest = withDueAt.reduce((max, s) =>
        s.dueAt!.getTime() > max.dueAt!.getTime() ? s : max
      );
      return {
        dueAt: latest.dueAt,
        dueSource: "schedule",
        basis: null,
        reason: "Latest payment schedule (all payments completed)",
      };
    }
  }

  // No schedule has dueAt, but we have dueInDays - compute from order date
  if (
    dueInDays !== null &&
    Number.isInteger(dueInDays) &&
    dueInDays >= 0 &&
    (type === "NET" || type === "FIXED")
  ) {
    const dueAt = addDaysAndGetEndOfDay(orderCreatedAt, dueInDays, timezone);
    return {
      dueAt,
      dueSource: "schedule",
      basis: "paymentTermsDueInDays",
      reason: `${type} terms: net ${dueInDays} days from order date (computed from dueInDays)`,
    };
  }

  // Nothing usable in payment terms
  return null;
}
