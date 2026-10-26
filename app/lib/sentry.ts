import {
  withSentry as sentryWithSentry,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  type SeverityLevel,
  type Event as SentryEvent,
  type ErrorEvent,
  type EventHint,
} from "@sentry/cloudflare";
import type { TransactionEvent, DataCollection } from "@sentry/core";
import { redactString, toErrorCode } from "./log.server";

/**
 * Restrictive data collection settings per #174 PII rules.
 * @sentry/core 11.8.0 replaced sendDefaultPii with dataCollection.
 * Defaults are permissive, so we explicitly disable all data collection.
 * beforeSend/beforeSendTransaction hooks provide defense-in-depth.
 */
export const RESTRICTIVE_DATA_COLLECTION: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
};

/**
 * Allowlisted tag/extra keys that are safe to send to Sentry.
 * Only these keys pass through; all others are removed.
 */
const ALLOWED_SENTRY_KEYS = new Set([
  "shopId",
  "code",
  "requestId",
  "jobId",
  "topic",
  "status",
  "errorCode",
]);

/**
 * Environment variables for Sentry configuration.
 * These are optional - Sentry is a no-op when DSN is not set.
 */
export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

/**
 * Scrub a record to only keep allowlisted keys.
 */
function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ALLOWED_SENTRY_KEYS.has(key)) {
      // Keep only safe string values
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Scrub sensitive data from a Sentry event.
 *
 * Security rules per #174:
 * - Deletes request.headers, cookies, query_string
 * - Strips query string from request.url
 * - Replaces exception values with error code (not raw messages)
 * - Scrubs tags, extra, contexts to only allowlisted keys
 * - Removes breadcrumbs entirely (can contain sensitive data)
 */
function scrubEvent(event: SentryEvent): SentryEvent {
  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.query_string;

    if (event.request.url) {
      const urlParts = event.request.url.split("?");
      event.request.url = urlParts[0];
    }

    // Delete request body entirely
    delete event.request.data;
  }

  // Replace exception values with error code (P1b)
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        // Replace raw error message with error code
        const errorCode = toErrorCode(new Error(exception.value));
        exception.value = errorCode;
      }
    }
  }

  // Replace message with redacted version
  if (event.message) {
    event.message = redactString(event.message);
  }

  // Remove breadcrumbs entirely (can contain sensitive logs/navigation)
  delete event.breadcrumbs;

  // Scrub extra to only allowlisted keys
  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubRecord(event.extra as Record<string, unknown>);
  }

  // Scrub tags to only allowlisted keys
  if (event.tags && typeof event.tags === "object") {
    event.tags = scrubRecord(event.tags as Record<string, unknown>) as Record<string, string>;
  }

  // Scrub contexts to only allowlisted keys per context
  if (event.contexts && typeof event.contexts === "object") {
    for (const [contextName, context] of Object.entries(event.contexts)) {
      if (context && typeof context === "object") {
        event.contexts[contextName] = scrubRecord(context as Record<string, unknown>);
      }
    }
  }

  return event;
}

/**
 * beforeSend hook for scrubbing PII from Sentry events.
 */
function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  return scrubEvent(event) as ErrorEvent;
}

/**
 * beforeSendTransaction hook for scrubbing PII from transaction events.
 */
function beforeSendTransaction(event: TransactionEvent, _hint: EventHint): TransactionEvent | null {
  return scrubEvent(event) as TransactionEvent;
}

/**
 * Wrap a Cloudflare Workers handler with Sentry error monitoring.
 *
 * This is a no-op when SENTRY_DSN is not set, allowing local dev and CI
 * to run without Sentry credentials.
 *
 * Usage in workers/app.ts:
 *
 *   import { wrapWithSentry } from "~/lib/sentry";
 *
 *   const handler = { async fetch(request, env, ctx) { ... } };
 *   export default wrapWithSentry(handler);
 *
 * Mind Cloudflare Workers Free limits:
 * - 10ms CPU time per request
 * - 3MB compressed bundle size
 *
 * We disable tracing by default (tracesSampleRate: 0) to minimize CPU overhead.
 * Set SENTRY_TRACES_SAMPLE_RATE env var to enable (e.g., 0.1 for 10%).
 */
export function wrapWithSentry<E extends SentryEnv>(
  handler: ExportedHandler<E>
): ExportedHandler<E> {
  return sentryWithSentry(
    (env: E) => {
      const dsn = env.SENTRY_DSN;
      if (!dsn) {
        return undefined;
      }
      return {
        dsn,
        tracesSampleRate: parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
        // A1: Disable all automatic data collection. @sentry/core 11.8.0 replaced
        // sendDefaultPii with dataCollection, which defaults to permissive settings.
        // Shopify request URLs carry shop/host/hmac query params, so we must disable
        // urlQueryParams, cookies, httpHeaders, httpBodies, and all other collection.
        // beforeSend/beforeSendTransaction hooks provide defense-in-depth scrubbing.
        dataCollection: RESTRICTIVE_DATA_COLLECTION,
        // Disable fetch error hostname enrichment (e.g. "Failed to fetch (example.com)").
        // The hostname could be a shop domain, which is PII per #174.
        enhanceFetchErrorMessages: false,
        beforeSend,
        beforeSendTransaction,
      };
    },
    handler
  );
}

/**
 * Manually capture an exception in Sentry.
 * No-op if Sentry is not initialized (no DSN).
 */
export function captureException(error: unknown): void {
  sentryCaptureException(error);
}

/**
 * Tags for exception context.
 */
export interface ExceptionTags {
  shopId?: string;
  code?: string;
}

/**
 * Capture an exception with safe tags (shopId and error code only).
 *
 * Use this instead of raw captureException when you have context.
 * The error is mapped through toErrorCode to avoid raw messages.
 *
 * @param error - The error to capture
 * @param tags - Safe tags (shopId and code only)
 */
export function captureExceptionWithTags(
  error: unknown,
  tags: ExceptionTags
): void {
  const code = tags.code ?? toErrorCode(error);

  sentryCaptureException(error, {
    tags: {
      ...(tags.shopId && { shopId: tags.shopId }),
      code,
    },
  });
}

/**
 * Manually capture a message in Sentry.
 * No-op if Sentry is not initialized (no DSN).
 */
export function captureMessage(message: string, level?: SeverityLevel): void {
  sentryCaptureMessage(message, level);
}
