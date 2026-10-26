/**
 * Gap 14: webhookId is allowed in non-logging contexts (#332).
 * These patterns SHOULD PASS the logging guard.
 */

import { safeLog } from "~/lib/log.server";

// SHOULD PASS: Destructuring webhookId from an object
export function destructureWebhookId(data: { webhookId: string; topic: string }) {
  const { webhookId, topic } = data;
  return { webhookId, topic };
}

// SHOULD PASS: Function that uses webhookId for DB operations (not logged)
export async function recordWebhookReceipt(
  _tx: unknown,
  _shop: string,
  _webhookId: string,
  _topic: string,
  _triggeredAt: Date
): Promise<boolean> {
  return true;
}

// SHOULD PASS: Function call passing webhookId to DB function
export async function processWebhook(webhookId: string) {
  const result = await recordWebhookReceipt(null, "shop", webhookId, "ORDERS_CREATE", new Date());
  // Log without webhookId - this is safe
  safeLog("info", "webhook_processed", { success: result });
  return result;
}

// SHOULD PASS: Object containing webhookId for queue message (not a log call)
export function buildQueueMessage(webhookId: string, payload: unknown) {
  return {
    webhookId,
    payload,
    timestamp: Date.now(),
  };
}

// SHOULD PASS: Type definition containing webhookId
interface WebhookMessage {
  webhookId: string;
  topic: string;
  payload: unknown;
}

// SHOULD PASS: Function parameter named webhookId
export function handleWebhook(_webhookId: string): void {
  // No logging of webhookId here
}

// SHOULD PASS: Using webhookId in a non-log call expression
export function sendBulkMessage(msg: { webhookId: string; data: unknown }) {
  return fetch("/api/queue", {
    method: "POST",
    body: JSON.stringify(msg),
  });
}

// SHOULD PASS: Accessing .webhookId but not in a log context
export function extractWebhookId(msg: WebhookMessage): string {
  return msg.webhookId;
}
