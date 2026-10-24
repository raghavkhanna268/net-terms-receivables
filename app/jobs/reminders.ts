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
 *   webhookId: "s18_enqueue_<invoiceId>_<ruleId>_<date>",
 *   enqueuedAt: "<ISO timestamp>"
 * }
 *
 * The handler:
 * 1. Validates the message
 * 2. Looks up the rule to get offsetDays
 * 3. Calls sendPaymentReminder()
 * 4. Returns appropriate SyncResult
 */

import type { Sql } from "~/lib/db-light.server";
import type { SyncResult } from "~/services/sync/types";
import {
  sendPaymentReminder,
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

  const env = getRequestEnv() ?? {};
  const result = await sendPaymentReminder(
    sql,
    shopId,
    invoiceId,
    ruleId,
    rule.offsetDays,
    env as { RESEND_API_KEY?: string }
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
    error: result.error,
    retryable: result.retryable ?? false,
  };
}
