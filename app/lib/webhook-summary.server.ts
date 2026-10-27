/**
 * Webhook handled summary logging.
 *
 * Wraps a webhook route action so that EXACTLY ONE counts-only summary line is
 * emitted on EVERY exit path: success, duplicate/skip, graceful 200s (unexpected
 * topic, missing resource id), auth rejects (401), bad-request rejects (400),
 * enqueue failures, and thrown errors (logged as 500, then rethrown).
 *
 * The summary carries only three fields and never any shop/domain/id/payload:
 * - topic:      the normalized topic if it is in the route's declared topic
 *               list, otherwise the literal "unexpected". Raw header input is
 *               never logged.
 * - status:     the HTTP status the route actually returns, as an integer.
 * - durationMs: wall-clock duration in whole milliseconds.
 *
 * Wrapping the action (rather than calling the logger at each return) guarantees
 * no exit path is missed.
 *
 * @module
 */

import type { ActionFunctionArgs } from "react-router";
import { safeLog } from "./log.server";

/**
 * The one approved log code for the webhook handled summary.
 */
const WEBHOOK_HANDLED_EVENT = "webhook_handled";

/**
 * Normalize a Shopify webhook topic header (e.g. "orders/create") to the
 * enum-style form used by the route topic lists (e.g. "ORDERS_CREATE").
 *
 * Kept local so the summary helper is self-contained and does not depend on
 * other modules that routes mock in tests.
 */
function normalizeTopicHeader(topic: string): string {
  return topic.replace(/\//g, "_").toUpperCase();
}

/**
 * Resolve the safe topic value for the summary line.
 *
 * Reads the topic header directly (both traditional and event-style names) so
 * the value is available even on auth rejects, before the handler parses
 * anything. Only a value that normalizes into the route's declared topic list
 * is logged; anything else becomes "unexpected" so untrusted input is never
 * emitted verbatim.
 */
function resolveTopic(request: Request, allowedTopics: ReadonlySet<string>): string {
  const raw =
    request.headers.get("shopify-topic") ?? request.headers.get("x-shopify-topic");
  if (!raw) {
    return "unexpected";
  }
  const normalized = normalizeTopicHeader(raw);
  return allowedTopics.has(normalized) ? normalized : "unexpected";
}

/**
 * Emit the single summary line.
 */
function emitSummary(topic: string, status: number, startMs: number): void {
  const durationMs = Math.max(0, Math.round(Date.now() - startMs));
  safeLog("info", WEBHOOK_HANDLED_EVENT, { topic, status, durationMs });
}

/**
 * Wrap a webhook route action so it emits exactly one `webhook_handled` summary
 * on every exit path.
 *
 * @param allowedTopics - The route's declared topic list (normalized form).
 * @param handler - The underlying webhook action.
 * @returns A wrapped action with identical return/throw behavior.
 */
export function withWebhookSummary(
  allowedTopics: Iterable<string>,
  handler: (args: ActionFunctionArgs) => Promise<Response>
): (args: ActionFunctionArgs) => Promise<Response> {
  const topicSet = new Set(allowedTopics);

  return async (args: ActionFunctionArgs): Promise<Response> => {
    const startMs = Date.now();
    const topic = resolveTopic(args.request, topicSet);

    try {
      const response = await handler(args);
      emitSummary(topic, response.status, startMs);
      return response;
    } catch (thrown) {
      if (thrown instanceof Response) {
        emitSummary(topic, thrown.status, startMs);
        throw thrown;
      }
      emitSummary(topic, 500, startMs);
      throw thrown;
    }
  };
}
