import {
  withSentry as sentryWithSentry,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  type SeverityLevel,
  type Event as SentryEvent,
  type ErrorEvent,
  type EventHint,
} from "@sentry/cloudflare";
import type { TransactionEvent, DataCollection, SpanJSON } from "@sentry/core";
import { toErrorCode } from "./log.server";

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
 * Safe replacement for free-text messages that could contain PII.
 * All message fields are replaced with this constant.
 */
const SAFE_MESSAGE_CODE = "[scrubbed]";

/**
 * Allowlisted constant messages that are safe to pass through.
 * Only exact matches pass; all other messages become SAFE_MESSAGE_CODE.
 */
const ALLOWLISTED_MESSAGES = new Set([
  "Unhandled error",
  "Unhandled rejection",
  "Network error",
  "Unknown error",
]);

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
 * Guards against undefined or non-object inputs.
 */
function scrubRecord(record: unknown): Record<string, unknown> {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    if (ALLOWED_SENTRY_KEYS.has(key)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Scrub a message, replacing with safe code unless allowlisted.
 * Free text must never pass through to Sentry.
 */
function scrubMessage(message: string | undefined): string {
  if (!message) return SAFE_MESSAGE_CODE;
  if (ALLOWLISTED_MESSAGES.has(message)) return message;
  return SAFE_MESSAGE_CODE;
}

/**
 * Allowlisted HTTP methods for span descriptions.
 */
const ALLOWED_HTTP_METHODS = new Set([
  "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS",
]);

/**
 * Known safe route segments (lowercase).
 * STRICT ALLOWLIST: Only these segments pass through.
 * Derived from app/routes/*.tsx and common API patterns.
 */
const SAFE_ROUTE_SEGMENTS = new Set([
  // App routes from app/routes/*.tsx
  "app", "api", "auth", "jobs", "webhooks", "privacy", "unsubscribe",
  // Route segments
  "accounts", "data-requests", "download", "imports", "onboarding",
  "plan", "reconcile", "settings", "reminders", "tag-rules",
  // Webhook topics
  "orders", "companies", "company_locations", "compliance",
  "customers", "draft_orders", "bulk_operations", "finish",
  "subscriptions_update", "scopes_update", "uninstalled",
  // API endpoints
  "web-vitals", "drain",
  // Common API versioning
  "v1", "v2", "v3",
  // Common route patterns
  "health", "ready", "live", "metrics", "graphql", "admin", "public",
  // Standard CRUD operations
  "list", "view", "edit", "create", "delete", "new", "update",
  // Action verbs
  "process", "verify", "confirm", "cancel", "refund", "status",
  // Resource types (generic)
  "invoices", "payments", "buyers", "exports", "callbacks",
  "home", "dashboard", "details", "index",
]);

/**
 * Convert a URL or transaction name to a safe route template.
 * STRICT ALLOWLIST: Only segments in SAFE_ROUTE_SEGMENTS pass through.
 * All other segments become :param placeholders.
 *
 * Examples:
 * - "/app/buyers/123" -> "/app/buyers/:id"
 * - "/app/orders/gid://shopify/Order/456" -> "/app/orders/:gid"
 * - "/app/buyers/asha" -> "/app/buyers/:param"
 * - "GET /app/buyers/asha" -> "GET /app/buyers/:param"
 */
function toRouteTemplate(value: string | undefined): string {
  if (!value) return SAFE_MESSAGE_CODE;

  let result = value;
  let httpMethodPrefix = "";

  // Extract HTTP method prefix if present (e.g., "GET /app/buyers")
  const methodMatch = result.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.*)$/i);
  if (methodMatch) {
    const method = methodMatch[1].toUpperCase();
    if (ALLOWED_HTTP_METHODS.has(method)) {
      httpMethodPrefix = method + " ";
    }
    result = methodMatch[2];
  }

  // Strip query strings entirely
  const queryIdx = result.indexOf("?");
  if (queryIdx !== -1) {
    result = result.slice(0, queryIdx);
  }

  // Strip fragments
  const fragIdx = result.indexOf("#");
  if (fragIdx !== -1) {
    result = result.slice(0, fragIdx);
  }

  // Replace UUIDs with :uuid (must come before segment processing)
  result = result.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ":uuid"
  );

  // Replace Shopify GIDs with :gid (gid://shopify/Type/123)
  result = result.replace(/gid:\/\/shopify\/\w+\/\d+/gi, ":gid");

  // Replace shop IDs (e.g., shp_abc123)
  result = result.replace(/shp_[a-z0-9]+/gi, ":shopId");

  // Split into segments and filter each one with STRICT ALLOWLIST
  const parts = result.split("/");
  const scrubbedParts = parts.map((segment) => {
    // Empty segments (from leading/trailing slashes)
    if (segment === "") return "";

    // Already a placeholder from earlier replacements
    if (segment.startsWith(":")) {
      return segment;
    }

    // Protocol prefixes
    if (segment === "http:" || segment === "https:" || segment === "gid:") {
      return segment;
    }

    // STRICT ALLOWLIST: Only safe segments pass through
    if (SAFE_ROUTE_SEGMENTS.has(segment.toLowerCase())) {
      return segment.toLowerCase();
    }

    // Purely numeric -> :id
    if (/^\d+$/.test(segment)) {
      return ":id";
    }

    // Everything else becomes :param (strict allowlist)
    return ":param";
  });

  return httpMethodPrefix + scrubbedParts.join("/");
}

/**
 * Scrub a fingerprint value.
 * Allows "{{ default }}" through, converts URL-like values to route templates,
 * and replaces all other values with safe code.
 */
function scrubFingerprint(value: string): string {
  if (value === "{{ default }}") return value;
  if (value.startsWith("/") || value.startsWith("http")) {
    return toRouteTemplate(value);
  }
  return SAFE_MESSAGE_CODE;
}

/**
 * Scrub a span's description and data fields.
 * Guards against undefined data.
 */
function scrubSpan(span: SpanJSON): SpanJSON {
  return {
    ...span,
    description: span.description ? toRouteTemplate(span.description) : undefined,
    data: scrubRecord(span.data) as SpanJSON["data"],
  };
}

/**
 * Scrub sensitive data from a Sentry event.
 *
 * Security rules per #174:
 * - Deletes event.user entirely (can contain email, name, IP)
 * - Deletes request.headers, cookies, query_string, data, env
 * - Converts request.url to route template
 * - Replaces exception values with error code (not raw messages)
 * - Replaces exception types with safe codes
 * - Deletes exception.mechanism.data (can contain sensitive context)
 * - Deletes stacktrace.frames[].vars (can contain local variable values)
 * - Replaces event.message with safe code (no free text)
 * - Scrubs event.logentry (message, params)
 * - Scrubs event.transaction to route template
 * - Scrubs event.fingerprint strings
 * - Scrubs event.threads names
 * - Scrubs event.spans descriptions
 * - Scrubs tags, extra, contexts to only allowlisted keys
 * - Removes breadcrumbs entirely (can contain sensitive data)
 */
function scrubEvent(event: SentryEvent): SentryEvent {
  // Delete user data entirely (can contain email, name, IP)
  delete event.user;

  if (event.request) {
    delete event.request.headers;
    delete event.request.cookies;
    delete event.request.query_string;
    delete event.request.data;
    delete event.request.env;

    if (event.request.url) {
      event.request.url = toRouteTemplate(event.request.url);
    }
  }

  // Replace exception values and types with error codes (P1b)
  // Also delete mechanism.data and stacktrace frame vars as defense in depth
  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        const errorCode = toErrorCode(new Error(exception.value));
        exception.value = errorCode;
      }
      if (exception.type) {
        const typeName = exception.type;
        if (typeName !== "Error" && /^[A-Z][a-zA-Z0-9]*Error$/.test(typeName)) {
          // Keep well-formed error type names like "TypeError", "RangeError"
        } else if (typeName === "Error") {
          // Keep generic Error
        } else {
          // Scrub anything that doesn't look like a standard error type
          exception.type = "Error";
        }
      }
      // Delete mechanism.data (can contain sensitive context)
      if (exception.mechanism) {
        delete (exception.mechanism as unknown as Record<string, unknown>).data;
      }
      // Delete stacktrace frame vars (can contain local variable values)
      if (exception.stacktrace?.frames) {
        for (const frame of exception.stacktrace.frames) {
          delete (frame as unknown as Record<string, unknown>).vars;
        }
      }
    }
  }

  // Replace message with safe code - no free text allowed
  if (event.message !== undefined) {
    if (typeof event.message === "string") {
      event.message = scrubMessage(event.message);
    } else {
      // Message can be an object in some SDK versions
      event.message = SAFE_MESSAGE_CODE;
    }
  }

  // Scrub logentry (structured log messages)
  if (event.logentry) {
    event.logentry = {
      message: scrubMessage(event.logentry.message),
    };
  }

  // Scrub transaction name to route template
  if (event.transaction) {
    event.transaction = toRouteTemplate(event.transaction);
  }

  // Scrub fingerprint strings
  if (event.fingerprint) {
    event.fingerprint = event.fingerprint.map(scrubFingerprint);
  }

  // Scrub thread names
  if (event.threads?.values) {
    for (const thread of event.threads.values) {
      if (thread.name) {
        thread.name = scrubMessage(thread.name);
      }
    }
  }

  // Scrub span descriptions and data
  if (event.spans) {
    event.spans = event.spans.map(scrubSpan);
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
        // @sentry/core 11.8.0 defaults traceLifecycle to "stream", which ignores
        // beforeSendTransaction (so transaction PII scrubbing would be skipped if
        // tracing is enabled) and logs a console warning on every client init.
        // "static" keeps beforeSendTransaction in effect.
        traceLifecycle: "static",
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
