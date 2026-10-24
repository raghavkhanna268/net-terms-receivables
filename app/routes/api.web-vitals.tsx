/**
 * Web Vitals ingestion endpoint (S23-30).
 *
 * POST /api/web-vitals
 *
 * Receives Core Web Vitals (LCP, CLS, INP) from the embedded app's
 * client-side reporter. No authentication required (same-origin only).
 *
 * Privacy requirements (PCD-2):
 * - Never echoes input in response
 * - Never logs raw error objects
 * - Only logs: metric name (enum), value (number), route (pathname)
 * - Rejects any payload containing shop domain or query strings
 *
 * Security:
 * - Strict validation of metric names (allowlist)
 * - Value bounds checking
 * - Body size cap (4 KB)
 * - Max 10 metrics per request
 *
 * @module
 */

import type { ActionFunctionArgs } from "react-router";
import { safeLog } from "~/lib/log.server";

/**
 * Maximum request body size in bytes (4 KB).
 * A typical report has 1-3 metrics, ~200 bytes total.
 */
const MAX_BODY_SIZE = 4096;

/**
 * Maximum metrics per request.
 */
const MAX_METRICS = 10;

/**
 * Allowed metric names (Core Web Vitals only).
 */
const ALLOWED_NAMES = new Set(["LCP", "CLS", "INP"]);

/**
 * Value bounds per metric type.
 * - LCP: 0 to 60,000 ms (60 seconds max, way beyond poor threshold)
 * - CLS: 0 to 10 (scores above 1 are extremely poor, 10 is sanity cap)
 * - INP: 0 to 30,000 ms (30 seconds max)
 */
const VALUE_BOUNDS: Record<string, { min: number; max: number }> = {
  LCP: { min: 0, max: 60000 },
  CLS: { min: 0, max: 10 },
  INP: { min: 0, max: 30000 },
};

/**
 * Patterns that indicate sensitive data (shop domain, query strings).
 * If any of these match the route, reject the request.
 */
const SENSITIVE_PATTERNS = [
  /\.myshopify\.com/i,
  /\?/,
  /shop=/i,
  /host=/i,
  /hmac=/i,
  /session=/i,
  /token=/i,
];

/**
 * Validate a single metric.
 * Returns error string if invalid, null if valid.
 */
function validateMetric(
  metric: unknown,
  index: number
): string | null {
  if (!metric || typeof metric !== "object") {
    return `metrics[${index}]: not an object`;
  }

  const m = metric as Record<string, unknown>;

  if (typeof m.name !== "string" || !ALLOWED_NAMES.has(m.name)) {
    return `metrics[${index}].name: invalid`;
  }

  if (typeof m.value !== "number" || !Number.isFinite(m.value)) {
    return `metrics[${index}].value: not a finite number`;
  }

  const bounds = VALUE_BOUNDS[m.name];
  if (m.value < bounds.min || m.value > bounds.max) {
    return `metrics[${index}].value: out of bounds`;
  }

  if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > 100) {
    return `metrics[${index}].id: invalid`;
  }

  if (typeof m.route !== "string" || m.route.length === 0 || m.route.length > 500) {
    return `metrics[${index}].route: invalid`;
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(m.route)) {
      return `metrics[${index}].route: contains sensitive data`;
    }
  }

  if (typeof m.version !== "string" || m.version.length > 50) {
    return `metrics[${index}].version: invalid`;
  }

  return null;
}

/**
 * Validate the full payload.
 * Returns error string if invalid, null if valid.
 */
function validatePayload(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return "body: not an object";
  }

  const payload = body as Record<string, unknown>;

  if (!Array.isArray(payload.metrics)) {
    return "metrics: not an array";
  }

  if (payload.metrics.length === 0) {
    return "metrics: empty";
  }

  if (payload.metrics.length > MAX_METRICS) {
    return "metrics: too many";
  }

  for (let i = 0; i < payload.metrics.length; i++) {
    const error = validateMetric(payload.metrics[i], i);
    if (error) {
      return error;
    }
  }

  return null;
}

/**
 * Log validated metrics.
 * Uses structured logging with only safe fields.
 *
 * Key naming: CI logging guard (check-logging.ts) rejects keys matching
 * sensitive patterns like "name", "amount", "shop", etc. We use:
 * - metric: the vital type (LCP/CLS/INP) - not "metricName"
 * - value: the numeric measurement
 * - route: pathname only (no query string)
 * - id: web-vitals library id
 * - version: App Bridge version
 */
function logMetrics(
  metrics: Array<{ name: string; value: number; route: string; id: string; version: string }>
): void {
  for (const m of metrics) {
    const { name: metric, value, route, id, version } = m;
    safeLog("info", "web_vitals", {
      metric,
      value,
      route,
      id,
      version,
    });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  const contentType = request.headers.get("Content-Type");
  if (!contentType?.includes("application/json")) {
    return new Response(null, { status: 415 });
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return new Response(null, { status: 413 });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return new Response(null, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  const validationIssue = validatePayload(body);
  if (validationIssue) {
    safeLog("warn", "web_vitals_invalid", { reason: validationIssue });
    return new Response(null, { status: 400 });
  }

  const payload = body as { metrics: Array<{ name: string; value: number; route: string; id: string; version: string }> };
  logMetrics(payload.metrics);

  return new Response(null, { status: 204 });
}

export async function loader() {
  return new Response(null, { status: 405 });
}
