/**
 * Gap 13: webhookId is banned in logging contexts (#332).
 * These patterns SHOULD FAIL the logging guard.
 */

import { safeLog } from "~/lib/log.server";
import * as Sentry from "@sentry/cloudflare";

// SHOULD FAIL: safeLog with webhookId key
export function logWithWebhookId(webhookId: string) {
  safeLog("info", "webhook_received", { webhookId });
}

// SHOULD FAIL: safeLog with webhookId property assignment
export function logWebhookExplicit(wh: string) {
  safeLog("info", "webhook_processed", { webhookId: wh });
}

// SHOULD FAIL: console.log with webhookId
export function consoleLogWebhookId(webhookId: string) {
  console.log("Webhook received", { webhookId });
}

// SHOULD FAIL: console.error with wh= template
export function consoleLogWhEquals(webhookId: string) {
  console.error(`Processing wh=${webhookId}`);
}

// SHOULD FAIL: Sentry setExtra with webhookId key
export function sentryExtraWebhookId(webhookId: string) {
  Sentry.setExtra("webhookId", webhookId);
}

// SHOULD FAIL: Sentry setContext with webhookId key
export function sentryContextWebhookId(webhookId: string) {
  Sentry.setContext("webhook", { webhookId });
}

// SHOULD FAIL: Template literal with webhookId interpolation
export function templateWebhookId(data: { webhookId: string }) {
  console.log(`Received webhook: ${data.webhookId}`);
}

// SHOULD FAIL: String with wh= prefix
export function stringWhEquals() {
  console.log("wh=abc123");
}
