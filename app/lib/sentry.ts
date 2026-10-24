import {
  withSentry as sentryWithSentry,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  type SeverityLevel,
  type Event as SentryEvent,
  type ErrorEvent,
  type EventHint,
} from "@sentry/cloudflare";
import type { TransactionEvent } from "@sentry/core";
import { redactString, toErrorCode } from "./log.server";

/**
 * Environment variables for Sentry configuration.
 * These are optional - Sentry is a no-op when DSN is not set.
 */
export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

/**
 * Scrub sensitive data from a Sentry event.
 *
 * - Deletes request.headers, cookies, query_string
 * - Strips query string from request.url
 * - Drops id_token, shop, host from anywhere in the event
 * - Redacts exception values and messages
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

    if (event.request.data && typeof event.request.data === "object") {
      const data = event.request.data as Record<string, unknown>;
      delete data.id_token;
      delete data.shop;
      delete data.host;
    }
  }

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        exception.value = redactString(exception.value);
      }
    }
  }

  if (event.message) {
    event.message = redactString(event.message);
  }

  if (event.breadcrumbs) {
    for (const breadcrumb of event.breadcrumbs) {
      if (breadcrumb.message) {
        breadcrumb.message = redactString(breadcrumb.message);
      }
      if (breadcrumb.data && typeof breadcrumb.data === "object") {
        const data = breadcrumb.data as Record<string, unknown>;
        delete data.id_token;
        delete data.shop;
        delete data.host;
        for (const key of Object.keys(data)) {
          if (typeof data[key] === "string") {
            data[key] = redactString(data[key] as string);
          }
        }
      }
    }
  }

  if (event.extra && typeof event.extra === "object") {
    const extra = event.extra as Record<string, unknown>;
    delete extra.id_token;
    delete extra.shop;
    delete extra.host;
  }

  if (event.contexts && typeof event.contexts === "object") {
    for (const context of Object.values(event.contexts)) {
      if (context && typeof context === "object") {
        const ctx = context as Record<string, unknown>;
        delete ctx.id_token;
        delete ctx.shop;
        delete ctx.host;
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
