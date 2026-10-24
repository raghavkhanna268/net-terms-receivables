/**
 * Payment Reminder Job Handler (S18).
 *
 * Handles REMINDER_SEND messages from the pg_cron enqueue job.
 * Registered with the drain processor via registerSyncHandler.
 *
 * Message format (from s18_enqueue_reminders() PL/pgSQL function):
 * {
 *   topic: "REMINDER_SEND",
 *   shop: "<shopDomain>",
 *   shopId: "<shopId>",
 *   invoiceId: "<invoiceId>",
 *   ruleId: "<ruleId>",
 *   offsetDays: <number>,
 *   timezone: "<IANA timezone>",
 *   webhookId: "s18_<invoiceId>_<ruleId>_<date>",
 *   enqueuedAt: "<ISO timestamp>"
 * }
 *
 * Gate behavior:
 * - When RESEND_API_KEY or RESEND_FROM_EMAIL is missing: ack as no-op
 *   (no retry, no ReminderLog). This allows the reminder to fire again
 *   once both keys are configured.
 * - When caps are reached: ack as no-op
 * - When invoice is paid/cancelled: ack as no-op
 * - When buyer has no email (CUSTOMER_PII_FIELDS off): ack as no-op
 *
 * Idempotency:
 * - ReminderLog unique index on (ruleId, invoiceId) prevents duplicate sends
 * - Slot is claimed before sending, released on failure to allow retry
 */

import type { Sql } from "~/lib/db-light.server";
import type { SyncResult } from "~/services/sync/types";
import {
  sendPaymentReminder,
  getReminderRule,
} from "~/services/reminders.server";
import { getRequestEnv } from "~/lib/request-context.server";
import { validateTimezone, DEFAULT_TIMEZONE } from "~/lib/aging-dates.server";

/**
 * Message payload for REMINDER_SEND topic.
 */
export interface ReminderSendMessage {
  topic: "REMINDER_SEND";
  shop: string;
  shopId: string;
  invoiceId: string;
  ruleId: string;
  offsetDays?: number;
  timezone?: string;
  webhookId: string;
  enqueuedAt: string;
}

/**
 * Type guard for REMINDER_SEND message.
 */
export function isReminderSendMessage(
  msg: unknown
): msg is ReminderSendMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.topic === "REMINDER_SEND" &&
    typeof m.shop === "string" &&
    typeof m.shopId === "string" &&
    typeof m.invoiceId === "string" &&
    typeof m.ruleId === "string" &&
    typeof m.webhookId === "string"
  );
}

/**
 * Handle REMINDER_SEND message.
 *
 * This is the main entry point called by the drain processor.
 */
export async function handleReminderSend(
  sql: Sql,
  message: ReminderSendMessage
): Promise<SyncResult> {
  const { shopId, invoiceId, ruleId } = message;

  // Get rule to determine offsetDays (may not be in message for backwards compat)
  const rule = await getReminderRule(sql, shopId, ruleId);
  if (!rule) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reminder rule not found",
    };
  }

  if (!rule.enabled) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Reminder rule is disabled",
    };
  }

  // Use offsetDays from message if present, otherwise from rule
  const offsetDays = message.offsetDays ?? rule.offsetDays;

  // Use timezone from message if present, otherwise default
  const timezone = message.timezone 
    ? validateTimezone(message.timezone) 
    : DEFAULT_TIMEZONE;

  const env = getRequestEnv() ?? {};
  const result = await sendPaymentReminder(
    sql,
    shopId,
    invoiceId,
    ruleId,
    offsetDays,
    timezone,
    env as { RESEND_API_KEY?: string; RESEND_FROM_EMAIL?: string }
  );

  if (result.success) {
    return {
      success: true,
      action: result.action === "sent" ? "created" : "skipped",
      skipReason:
        result.action !== "sent" ? result.skipReason : undefined,
      entityId: result.resendId,
    };
  }

  // Non-retryable errors should not silently archive
  return {
    success: false,
    action: "skipped",
    error: result.error,
    retryable: result.retryable ?? false,
  };
}

// Re-export DEFAULT_TIMEZONE for convenience
export { DEFAULT_TIMEZONE };
