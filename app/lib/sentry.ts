import {
  withSentry as sentryWithSentry,
  captureException as sentryCaptureException,
  captureMessage as sentryCaptureMessage,
  type SeverityLevel,
  type Event as SentryEvent,
  type ErrorEvent,
  type EventHint,
  type Breadcrumb,
  type BreadcrumbHint,
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
  "webhookId",
  "jobId",
  "topic",
  "status",
  "errorCode",
]);

/**
 * Allowlisted HTTP headers that are safe to send to Sentry.
 * Only these headers pass through; all others are removed.
 */
const ALLOWED_HEADERS = new Set([
  "content-type",
  "user-agent",
  "cf-ray",
]);

/**
 * Patterns for detecting shop domains (custom domains and myshopify.com).
 */
const SHOP_DOMAIN_PATTERN = /[a-z0-9][-a-z0-9]*\.myshopify\.com/gi;
const CUSTOM_DOMAIN_PATTERN = /(?:shop|store|www)\.[a-z0-9][-a-z0-9]*\.[a-z]{2,}/gi;

/**
 * Patterns for Shopify GIDs that contain customer/buyer PII.
 * These are scrubbed to keep only the resource type (e.g., gid://shopify/Customer/<redacted>).
 */
const SHOPIFY_GID_PATTERNS = [
  /gid:\/\/shopify\/Customer\/\d+/gi,
  /gid:\/\/shopify\/CompanyContact\/\d+/gi,
  /gid:\/\/shopify\/CompanyLocation\/\d+/gi,
  /gid:\/\/shopify\/Company\/\d+/gi,
  /gid:\/\/shopify\/Order\/\d+/gi,
  /gid:\/\/shopify\/DraftOrder\/\d+/gi,
  /gid:\/\/shopify\/BuyerIdentity\/\d+/gi,
];

/**
 * Patterns for money/balance/credit values that may be PII.
 * Matches: ₹1,23,456.78, 12345678 paise, creditLimit: 500000, amount: 1234
 */
const MONEY_PATTERNS = [
  /₹[\d,]+(?:\.\d{1,2})?/g,
  /\d+\s*(?:paise|paisa)/gi,
  /(?:creditLimit|credit_limit|balance|amount|total):\s*\d+/gi,
  /(?:creditLimit|credit_limit|balance|amount|total)"\s*:\s*\d+/gi,
];

/**
 * Patterns for bank narration strings (NEFT/RTGS/IMPS/UPI).
 * These contain payer names, account details, and UTRs.
 */
const BANK_NARRATION_PATTERNS = [
  /NEFT[- ]?CR[-/]?[A-Z0-9]+[-/][^\s]+(?:[-/][A-Z0-9]+)?/gi,
  /RTGS[- ]?CR[-/]?[A-Z0-9]+[-/][^\s]+(?:[-/][A-Z0-9]+)?/gi,
  /IMPS[-/][A-Z0-9]+[-/][^\s]+/gi,
  /UPI[-/][A-Z0-9@]+[-/][^\s]*/gi,
  /UTR[- ]?[A-Z0-9]{16,22}/gi,
  /[A-Z]{4}N\d{10,}/gi, // HDFC/ICICI UTR pattern
];

/**
 * Environment variables for Sentry configuration.
 * These are optional - Sentry is a no-op when DSN is not set.
 */
export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
  SENTRY_RELEASE?: string;
  SENTRY_ENVIRONMENT?: string;
}

/**
 * Scrub PII from a string value.
 * Removes: shop domains, Shopify GIDs (preserving type), money values, bank narrations, emails.
 */
function scrubPiiFromString(str: string): string {
  let result = str;

  result = result.replace(SHOP_DOMAIN_PATTERN, "<shop-redacted>");
  result = result.replace(CUSTOM_DOMAIN_PATTERN, "<shop-redacted>");

  for (const pattern of SHOPIFY_GID_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const resourceType = match.match(/gid:\/\/shopify\/([A-Za-z]+)\//)?.[1] ?? "Unknown";
      return `gid://shopify/${resourceType}/<redacted>`;
    });
  }

  for (const pattern of MONEY_PATTERNS) {
    result = result.replace(pattern, "<money-redacted>");
  }

  for (const pattern of BANK_NARRATION_PATTERNS) {
    result = result.replace(pattern, "<narration-redacted>");
  }

  result = result.replace(/[^\s"'<>]+@[^\s"'<>]+\.[a-z]{2,}/gi, "<email-redacted>");

  result = result.replace(/[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+(?:\s+(?:TRADERS|ENTERPRISES|PRIVATE|LIMITED|LTD|PVT|INC|LLC|CORP))?/g, "<name-redacted>");

  return result;
}

/**
 * Scrub headers to only keep allowlisted ones.
 */
function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (ALLOWED_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Scrub a record to only keep allowlisted keys.
 */
function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (ALLOWED_SENTRY_KEYS.has(key)) {
      if (typeof value === "string") {
        result[key] = scrubPiiFromString(value);
      } else if (typeof value === "number" || typeof value === "boolean") {
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
 * - Keeps only allowlisted request.headers (content-type, user-agent, cf-ray)
 * - Deletes cookies, query_string, request body
 * - Strips query string from request.url
 * - Replaces exception values with error code (not raw messages)
 * - Scrubs tags, extra, contexts to only allowlisted keys
 * - Scrubs PII (shop domains, GIDs, money, bank narrations) from all string values
 * - Removes breadcrumbs entirely (can contain sensitive data)
 * - Removes user object entirely (contains PII)
 */
function scrubEvent(event: SentryEvent): SentryEvent {
  if (event.request) {
    if (event.request.headers && typeof event.request.headers === "object") {
      event.request.headers = scrubHeaders(event.request.headers as Record<string, string>);
    }
    delete event.request.cookies;
    delete event.request.query_string;

    if (event.request.url) {
      const urlParts = event.request.url.split("?");
      event.request.url = scrubPiiFromString(urlParts[0]);
    }

    delete event.request.data;
  }

  delete event.user;

  if (event.exception?.values) {
    for (const exception of event.exception.values) {
      if (exception.value) {
        const errorCode = toErrorCode(new Error(exception.value));
        exception.value = errorCode;
      }
    }
  }

  if (event.message) {
    event.message = scrubPiiFromString(redactString(event.message));
  }

  delete event.breadcrumbs;

  if (event.extra && typeof event.extra === "object") {
    event.extra = scrubRecord(event.extra as Record<string, unknown>);
  }

  if (event.tags && typeof event.tags === "object") {
    event.tags = scrubRecord(event.tags as Record<string, unknown>) as Record<string, string>;
  }

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
 * beforeBreadcrumb hook to filter out console breadcrumbs.
 * Console logs can contain PII; drop them entirely.
 * Other breadcrumbs (http, navigation) are allowed but scrubbed by scrubEvent.
 */
function beforeBreadcrumb(breadcrumb: Breadcrumb, _hint?: BreadcrumbHint): Breadcrumb | null {
  if (breadcrumb.category === "console") {
    return null;
  }
  if (breadcrumb.message) {
    breadcrumb.message = scrubPiiFromString(breadcrumb.message);
  }
  if (breadcrumb.data && typeof breadcrumb.data === "object") {
    for (const [key, value] of Object.entries(breadcrumb.data)) {
      if (typeof value === "string") {
        breadcrumb.data[key] = scrubPiiFromString(value);
      }
    }
  }
  return breadcrumb;
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
        release: env.SENTRY_RELEASE || undefined,
        environment: env.SENTRY_ENVIRONMENT || "development",
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
        beforeBreadcrumb,
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

/**
 * Test-only exports for leak testing.
 * These should not be used in production code.
 */
export const _testExports = {
  scrubPiiFromString,
  scrubHeaders,
  scrubRecord,
  scrubEvent,
  beforeSend,
  beforeSendTransaction,
  beforeBreadcrumb,
};
