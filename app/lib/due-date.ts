/**
 * Due Date Inference Logic for Net Terms Receivables
 *
 * This module determines invoice due dates based on multiple sources with
 * a defined precedence order:
 *
 * 1. Shopify PaymentSchedule (source: "schedule") - highest priority, not configurable
 *    - Uses the earliest non-completed schedule's dueAt
 *    - Falls back to the last schedule if all are completed
 *    - FULFILLMENT terms without fulfillment date return null
 *    - RECEIPT means due on the issue date
 *
 * 2. Merchant override (source: "override") - beats all INFERRED sources
 *    - Optional merchantOverrideDueAt input
 *    - IMPORTANT: Does NOT override a Shopify PaymentSchedule dueAt, because for
 *      schedule-backed orders Shopify is the source of truth (its paymentReminderSend
 *      and overdue state use that date). In that case we keep 'schedule' and note
 *      in `reason` that the override was ignored and terms should be changed in Shopify.
 *
 * 3-5. Inferred sources (configurable via INFERENCE_ORDER or inferenceOrder param):
 *    - "accountDefault": Account's EXPLICIT defaultTermsDays (more specific than tag rules)
 *      If accountDefaultTermsSource is 'tag', this step is skipped (see below).
 *    - "tagRule": Tag rule match (case-insensitive, trimmed matching)
 *      If multiple rules match, uses the LARGEST defaultTermsDays
 *      (conservative: never flag overdue early)
 *    - "shopDefault": Shop's default terms days (last resort before 'none')
 *
 * Special case: tag-copied account defaults
 *    If accountDefaultTermsSource is 'tag', the account's default was copied from
 *    a tag at sync time. We skip it at the account-default step and let the tag-rule
 *    step decide. If no tag rule currently matches, we fall back to the copied value
 *    but report it as tag-derived in `reason`.
 *
 * 6. No source available (source: "none")
 *
 * The inferred-source precedence can be changed by:
 * - Modifying INFERENCE_ORDER constant (one-line change for product owner)
 * - Passing inferenceOrder option to inferDueDate()
 *
 * Date arithmetic: adds N calendar days in the shop's IANA timezone
 * (default 'Asia/Kolkata') and returns end-of-day (23:59:59.999 local)
 * as a UTC Date. Handles DST correctly using Intl APIs.
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
  /** Default terms days when this tag matches */
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
  /** Which inferred source was used (null if dueSource is not 'inferred') */
  basis: InferredSourceKey | null;
  /** Human-readable explanation of how the due date was determined */
  reason: string;
}

const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * Calculate end-of-day (23:59:59.999) for a given date in a specific timezone,
 * then convert back to UTC.
 *
 * Uses Intl.DateTimeFormat to get timezone offset, avoiding heavy date libraries.
 * Handles DST transitions correctly by working with the local date components.
 */
export function getEndOfDayInTimezone(date: Date, timezone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  const year = parseInt(getPart("year"), 10);
  const month = parseInt(getPart("month"), 10);
  const day = parseInt(getPart("day"), 10);

  // Create end of day in UTC first, then adjust for timezone
  const eodUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999);

  // Get the offset at this moment in the target timezone
  const testDate = new Date(eodUtc);
  const tzParts = formatter.formatToParts(testDate);
  const tzGetPart = (type: Intl.DateTimeFormatPartTypes): string =>
    tzParts.find((p) => p.type === type)?.value ?? "0";

  const tzYear = parseInt(tzGetPart("year"), 10);
  const tzMonth = parseInt(tzGetPart("month"), 10);
  const tzDay = parseInt(tzGetPart("day"), 10);
  const tzHour = parseInt(tzGetPart("hour"), 10);
  const tzMinute = parseInt(tzGetPart("minute"), 10);

  // Calculate offset: what's the difference between UTC and local?
  const localMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, 59, 999);
  const offsetMs = localMs - eodUtc;

  // Now create the actual end of day: start with the target date's EOD in UTC,
  // then subtract the offset to get when that local time occurs in UTC
  const result = new Date(eodUtc - offsetMs);

  return result;
}

/**
 * Add calendar days to a date and return end-of-day in the specified timezone.
 */
export function addDaysAndGetEndOfDay(
  baseDate: Date,
  days: number,
  timezone: string
): Date {
  // Get the date components in the target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(baseDate);
  const getPart = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "0";

  const year = parseInt(getPart("year"), 10);
  const month = parseInt(getPart("month"), 10);
  const day = parseInt(getPart("day"), 10);

  // Add days using UTC date arithmetic (avoids any DST issues during addition)
  const targetDate = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));

  // Now get end of day for that target date in the timezone
  return getEndOfDayInTimezone(targetDate, timezone);
}

/**
 * Infer the due date for an invoice based on available information.
 *
 * Precedence (documented architecture decision):
 * 1. Shopify PaymentSchedule dueAt → source "schedule"
 * 2. Merchant override → source "override" (but not if schedule exists)
 * 3-5. Inferred sources per INFERENCE_ORDER → source "inferred"
 * 6. Nothing available → null with source "none"
 */
export function inferDueDate(input: InferDueDateInput): InferDueDateResult {
  const timezone = input.shopTimezone ?? DEFAULT_TIMEZONE;
  const order = input.inferenceOrder ?? INFERENCE_ORDER;

  // 1. Try Shopify PaymentSchedule first (highest priority)
  // RECEIPT type works even with empty schedules (due on order date)
  if (input.paymentTerms) {
    const scheduleResult = inferFromPaymentSchedule(
      input.paymentTerms,
      input.orderCreatedAt,
      input.fulfilledAt,
      timezone
    );
    if (scheduleResult) {
      // If there's a merchant override but schedule exists, note it in reason
      if (input.merchantOverrideDueAt && scheduleResult.dueAt) {
        return {
          ...scheduleResult,
          reason:
            scheduleResult.reason +
            " (merchant override ignored; change terms in Shopify for schedule-backed orders)",
        };
      }
      return scheduleResult;
    }
  }

  // 2. Merchant override beats all inferred sources
  if (input.merchantOverrideDueAt) {
    return {
      dueAt: input.merchantOverrideDueAt,
      dueSource: "override",
      basis: null,
      reason: "Merchant override for this invoice",
    };
  }

  // 3-5. Try inferred sources in configured order
  for (const source of order) {
    const result = tryInferredSource(source, input, timezone);
    if (result) return result;
  }

  // Special case: tag-copied account default as fallback when no tag rule matched
  if (
    input.accountDefaultTermsSource === "tag" &&
    input.accountDefaultTermsDays !== null &&
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

  // 6. Nothing available
  return {
    dueAt: null,
    dueSource: "none",
    basis: null,
    reason:
      "No payment terms, merchant override, account default, tag rule, or shop default found",
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
      return tryTagRules(input, timezone);
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
 * Try tag rules.
 *
 * ARCHITECTURE DECISION: When multiple rules match, we use the LARGEST
 * defaultTermsDays. This is a conservative choice that ensures we never
 * flag a buyer as overdue prematurely. The tradeoff is that some payments
 * may appear current for longer than intended if tags are misconfigured.
 */
function tryTagRules(
  input: InferDueDateInput,
  timezone: string
): InferDueDateResult | null {
  if (input.tagRules.length === 0 || input.customerTags.length === 0) {
    return null;
  }

  // Normalize customer tags: lowercase and trim
  const normalizedCustomerTags = input.customerTags.map((t) =>
    t.toLowerCase().trim()
  );

  // Find all matching rules
  const matchingRules = input.tagRules.filter((rule) =>
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
 * Infer due date from Shopify payment schedule.
 */
function inferFromPaymentSchedule(
  terms: PaymentTerms,
  orderCreatedAt: Date,
  fulfilledAt: Date | null,
  timezone: string
): InferDueDateResult | null {
  const { type, schedules } = terms;

  // Handle RECEIPT type: due immediately on issue date
  if (type === "RECEIPT") {
    const dueAt = getEndOfDayInTimezone(orderCreatedAt, timezone);
    return {
      dueAt,
      dueSource: "schedule",
      basis: null,
      reason: "Payment due on receipt (issue date)",
    };
  }

  // Handle FULFILLMENT type: due date depends on fulfillment
  if (type === "FULFILLMENT") {
    // Check if any schedule has a dueAt already set
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
      return {
        dueAt: null,
        dueSource: "schedule",
        basis: null,
        reason:
          "FULFILLMENT terms: due date unknown until order is fulfilled",
      };
    }

    // Calculate due date from fulfillment date
    const daysToAdd = terms.dueInDays ?? 0;
    const dueAt = addDaysAndGetEndOfDay(fulfilledAt, daysToAdd, timezone);
    return {
      dueAt,
      dueSource: "schedule",
      basis: null,
      reason: `FULFILLMENT terms: net ${daysToAdd} days from fulfillment`,
    };
  }

  // For NET and FIXED types: find the appropriate schedule
  // Use the earliest non-completed schedule; if all completed, use the last one
  const nonCompletedSchedules = schedules.filter((s) => s.completedAt === null);

  if (nonCompletedSchedules.length > 0) {
    // Find earliest dueAt among non-completed schedules
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

  // All schedules are completed - use the last one
  if (schedules.length > 0) {
    const lastSchedule = schedules[schedules.length - 1];
    if (lastSchedule.dueAt) {
      return {
        dueAt: lastSchedule.dueAt,
        dueSource: "schedule",
        basis: null,
        reason: "Last payment schedule (all payments completed)",
      };
    }
  }

  // Schedules exist but none have dueAt - shouldn't happen in practice
  return null;
}
