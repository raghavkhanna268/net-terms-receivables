/**
 * Sentry scrubbing helpers - exported for testing.
 *
 * This module contains the PII scrubbing functions used by sentry.ts.
 * It's separated to keep test-only exports out of the production bundle
 * while still allowing comprehensive testing of the scrubbing logic.
 */

import { redactString, toErrorCode } from "./log.server";
import type { Event as SentryEvent, ErrorEvent, EventHint, Breadcrumb, BreadcrumbHint } from "@sentry/cloudflare";
import type { TransactionEvent, DataCollection } from "@sentry/core";

/**
 * Restrictive data collection settings per #174 PII rules.
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
 */
const ALLOWED_HEADERS = new Set([
  "content-type",
  "cf-ray",
]);

const SHOP_DOMAIN_PATTERN = /[a-z0-9][-a-z0-9]*\.myshopify\.com/gi;
const CUSTOM_DOMAIN_PATTERN = /(?:shop|store|www)\.[a-z0-9][-a-z0-9]*\.[a-z]{2,}/gi;

const SHOPIFY_GID_PATTERNS = [
  /gid:\/\/shopify\/Customer\/\d+/gi,
  /gid:\/\/shopify\/CompanyContact\/\d+/gi,
  /gid:\/\/shopify\/CompanyLocation\/\d+/gi,
  /gid:\/\/shopify\/Company\/\d+/gi,
  /gid:\/\/shopify\/Order\/\d+/gi,
  /gid:\/\/shopify\/DraftOrder\/\d+/gi,
  /gid:\/\/shopify\/BuyerIdentity\/\d+/gi,
];

const MONEY_PATTERNS = [
  /₹[\d,]+(?:\.\d{1,2})?/g,
  /\d+\s*(?:paise|paisa)/gi,
  /(?:creditLimit|credit_limit|balance|amount|total):\s*\d+/gi,
  /(?:creditLimit|credit_limit|balance|amount|total)"\s*:\s*\d+/gi,
];

const BANK_NARRATION_PATTERNS = [
  /NEFT[- ]?CR[-/]?[A-Z0-9]+[-/][^\s]+(?:[-/][A-Z0-9]+)?/gi,
  /RTGS[- ]?CR[-/]?[A-Z0-9]+[-/][^\s]+(?:[-/][A-Z0-9]+)?/gi,
  /IMPS[-/][A-Z0-9]+[-/][^\s]+/gi,
  /UPI[-/][A-Z0-9@]+[-/][^\s]*/gi,
  /UTR[- ]?[A-Z0-9]{16,22}/gi,
  /[A-Z]{4}N\d{10,}/gi,
];

/**
 * Scrub PII from a string value.
 */
export function scrubPiiFromString(str: string): string {
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

  result = result.replace(
    /(?<![a-z])(?:[A-Z][a-z]+\s+){1,3}(?:TRADERS|ENTERPRISES|PRIVATE|LIMITED|LTD|PVT|INC|LLC|CORP|& CO|INDUSTRIES|EXPORTS|IMPORTS|SOLUTIONS|SERVICES|CORPORATION)\b/g,
    "<name-redacted>"
  );

  result = result.replace(
    /\b[A-Z]{2,}(?:\s+[A-Z]{2,})+(?:\s+(?:TRADERS|ENTERPRISES|PRIVATE|LIMITED|LTD|PVT|INC|LLC|CORP|& CO|INDUSTRIES))\b/g,
    "<name-redacted>"
  );

  return result;
}

/**
 * Scrub headers to only keep allowlisted ones.
 */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
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
export function scrubRecord(record: Record<string, unknown>): Record<string, unknown> {
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
 */
export function scrubEvent(event: SentryEvent): SentryEvent {
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
export function beforeSend(event: ErrorEvent, _hint: EventHint): ErrorEvent | null {
  return scrubEvent(event) as ErrorEvent;
}

/**
 * beforeSendTransaction hook for scrubbing PII from transaction events.
 */
export function beforeSendTransaction(event: TransactionEvent, _hint: EventHint): TransactionEvent | null {
  return scrubEvent(event) as TransactionEvent;
}

/**
 * beforeBreadcrumb hook to filter out console breadcrumbs.
 */
export function beforeBreadcrumb(breadcrumb: Breadcrumb, _hint?: BreadcrumbHint): Breadcrumb | null {
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
