/**
 * Web Vitals ingestion endpoint (S23-30).
 *
 * POST /api/web-vitals
 *
 * Receives Core Web Vitals (LCP, CLS, INP) from the embedded app's
 * client-side reporter. Authenticated via Shopify session token.
 *
 * Privacy requirements (PCD-2):
 * - Never echoes input in response
 * - Never logs raw error objects or the shop domain
 * - Logs only validated enum/numeric fields via safeLog:
 *   - metric: LCP|CLS|INP (enum)
 *   - value: numeric, clamped and rounded
 *   - rating: good|needs-improvement|poor (computed server-side)
 *   - route: route-id enum (app_home, app_accounts, etc.)
 *
 * Security:
 * - Requires Shopify session token authentication
 * - Strict validation of metric names (allowlist)
 * - Value bounds checking
 * - Body size cap (4 KB)
 * - Max 10 metrics per request
 * - Route must match strict allowlist: ^/app(/[A-Za-z0-9_-]+)*$
 *
 * @module
 */

import type { ActionFunctionArgs } from "react-router";
import { safeLog } from "~/lib/log.server";
import {
  MAX_METRICS,
  VALUE_BOUNDS,
  type BoundedMetricName,
} from "~/lib/web-vitals-bounds";

/**
 * Maximum request body size in bytes (4 KB).
 * A typical report has 1-3 metrics, ~200 bytes total.
 */
const MAX_BODY_SIZE = 4096;

/**
 * Allowed metric names (Core Web Vitals only).
 */
const ALLOWED_NAMES = new Set(["LCP", "CLS", "INP"]);

/**
 * Strict route allowlist: /app with optional path segments.
 * Only alphanumeric, underscore, and hyphen allowed in segments.
 */
const ROUTE_PATTERN = /^\/app(\/[A-Za-z0-9_-]+)*$/;

/**
 * Google's Web Vitals thresholds for rating computation.
 * @see https://web.dev/articles/vitals
 */
const RATING_THRESHOLDS: Record<string, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
};

/**
 * Map route path to route-id enum.
 * Never log raw paths - only these safe identifiers.
 */
function mapRouteToId(path: string): string {
  if (path === "/app" || path === "/app/") {
    return "app_home";
  }
  if (path.startsWith("/app/accounts")) {
    return "app_accounts";
  }
  if (path.startsWith("/app/data-requests") && path.includes("/download")) {
    return "app_data_requests_download";
  }
  if (path.startsWith("/app/data-requests")) {
    return "app_data_requests";
  }
  if (path === "/app/imports") {
    return "app_imports";
  }
  if (path === "/app/onboarding") {
    return "app_onboarding";
  }
  if (path === "/app/plan") {
    return "app_plan";
  }
  if (path === "/app/reconcile") {
    return "app_reconcile";
  }
  if (path === "/app/settings/reminders") {
    return "app_settings_reminders";
  }
  return "other";
}

/**
 * Compute rating from value using Google's thresholds.
 */
function computeRating(metricName: string, value: number): "good" | "needs-improvement" | "poor" {
  const thresholds = RATING_THRESHOLDS[metricName];
  if (!thresholds) {
    return "poor";
  }
  if (value <= thresholds.good) {
    return "good";
  }
  if (value > thresholds.poor) {
    return "poor";
  }
  return "needs-improvement";
}

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

  const bounds = VALUE_BOUNDS[m.name as BoundedMetricName];
  if (m.value < bounds.min || m.value > bounds.max) {
    return `metrics[${index}].value: out of bounds`;
  }

  if (typeof m.route !== "string" || !ROUTE_PATTERN.test(m.route)) {
    return `metrics[${index}].route: invalid`;
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
    const validationIssue = validateMetric(payload.metrics[i], i);
    if (validationIssue) {
      return validationIssue;
    }
  }

  return null;
}

/**
 * Log validated metrics using safeLog with strict validation keys.
 *
 * Log fields (all validated by safeLog):
 * - metric: LCP|CLS|INP (enum)
 * - value: numeric, clamped and rounded
 * - rating: good|needs-improvement|poor (computed from thresholds)
 * - route: route-id enum (never raw path)
 */
function logMetrics(
  metrics: Array<{ name: string; value: number; route: string }>
): void {
  for (const m of metrics) {
    const { name: metric, value, route } = m;
    const routeId = mapRouteToId(route);
    const rating = computeRating(metric, value);
    
    safeLog("info", "web_vitals", {
      metric,
      value,
      rating,
      route: routeId,
    });
  }
}

export async function action({ request, context }: ActionFunctionArgs) {
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

  const { shopify } = context;
  try {
    await shopify.authenticate.admin(request);
  } catch {
    return new Response(null, { status: 401 });
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

  const payload = body as { metrics: Array<{ name: string; value: number; route: string }> };
  logMetrics(payload.metrics);

  return new Response(null, { status: 204 });
}

export async function loader() {
  return new Response(null, { status: 405 });
}
