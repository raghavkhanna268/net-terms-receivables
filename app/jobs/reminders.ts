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
 * - When RESEND_API_KEY or RESEND_FROM is missing: ack as no-op
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
  sendCatchupReminder,
  getReminderRule,
} from "~/services/reminders.server";
import { getRequestEnv } from "~/lib/request-context.server";

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
 * Message payload for REMINDER_CATCHUP topic.
 */
export interface ReminderCatchupMessage {
  topic: "REMINDER_CATCHUP";
  shop: string;
  shopId: string;
  invoiceId: string;
  ruleId: string;
  logId: string;
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
 * Type guard for REMINDER_CATCHUP message.
 */
export function isReminderCatchupMessage(
  msg: unknown
): msg is ReminderCatchupMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.topic === "REMINDER_CATCHUP" &&
    typeof m.shop === "string" &&
    typeof m.shopId === "string" &&
    typeof m.invoiceId === "string" &&
    typeof m.ruleId === "string" &&
    typeof m.logId === "string" &&
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

  // Timezone is now derived from invoice.shopTimezone inside sendPaymentReminder
  // (validated via getInvoiceForReminder → validateTimezone)

  const env = getRequestEnv() ?? {};
  const result = await sendPaymentReminder(
    sql,
    shopId,
    invoiceId,
    ruleId,
    offsetDays,
    env as { RESEND_API_KEY?: string; RESEND_FROM?: string }
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
  // R1: Use errorCode (no raw provider message)
  return {
    success: false,
    action: "skipped",
    error: result.errorCode ?? result.error,
    retryable: result.retryable ?? false,
  };
}

/**
 * Handle REMINDER_CATCHUP message.
 *
 * This is the handler for delayed reminders being caught up.
 * Re-checks eligibility before sending.
 */
export async function handleReminderCatchup(
  sql: Sql,
  message: ReminderCatchupMessage
): Promise<SyncResult> {
  const { shopId, invoiceId, ruleId, logId } = message;

  // Get rule to determine offsetDays
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

  const offsetDays = message.offsetDays ?? rule.offsetDays;

  // Timezone is now derived from invoice.shopTimezone inside sendCatchupReminder
  // (validated via getInvoiceForReminder → validateTimezone)

  const env = getRequestEnv() ?? {};
  const result = await sendCatchupReminder(
    sql,
    shopId,
    invoiceId,
    ruleId,
    logId,
    offsetDays,
    env as { RESEND_API_KEY?: string; RESEND_FROM?: string }
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

  return {
    success: false,
    action: "skipped",
    error: result.errorCode ?? result.error,
    retryable: result.retryable ?? false,
  };
}
