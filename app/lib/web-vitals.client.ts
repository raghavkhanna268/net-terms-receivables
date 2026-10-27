/**
 * Web Vitals Reporter for Shopify App Bridge.
 *
 * Registers with shopify.webVitals.onReport to collect Core Web Vitals
 * and forwards only LCP, CLS, and INP to our endpoint.
 *
 * Privacy requirements (S23-30, PCD-2):
 * - Only sends: name, value, route (pathname without query)
 * - NEVER sends: shop domain, host param, query strings, session token,
 *   user/customer data, country, IP, user agent, id, version
 *
 * Debug logging (opt-in):
 * - Set localStorage key `debug:web-vitals` to `1` to enable
 * - Logs ONLY metric name and value to console.debug
 * - See docs/ops/web-vitals-debug.md for usage instructions
 *
 * Authentication: Uses fetch (not sendBeacon) so App Bridge's global fetch
 * can attach the session token automatically.
 *
 * @module
 */

import {
  MAX_METRICS,
  isWithinBounds,
  type BoundedMetricName,
} from "./web-vitals-bounds";

/**
 * Metric names from App Bridge Web Vitals API.
 * We only forward the Core Web Vitals: LCP, CLS, INP.
 */
type MetricName = "LCP" | "FCP" | "CLS" | "INP" | "TTFB" | "FID";

/**
 * Metric from App Bridge shopify.webVitals.onReport callback.
 * Based on https://shopify.dev/docs/api/app-home/apis/web-vitals
 */
interface WebVitalsMetric {
  id: string;
  name: MetricName;
  value: number;
  version?: string;
  country?: string;
}

/**
 * Callback payload from shopify.webVitals.onReport.
 */
interface WebVitalsReport {
  metrics: WebVitalsMetric[];
}

/**
 * Shopify global with Web Vitals API.
 */
interface ShopifyGlobal {
  webVitals?: {
    onReport: (callback: ((report: WebVitalsReport) => void) | null) => void;
  };
}

/**
 * Core Web Vitals we forward to our endpoint.
 * Per S23-30: LCP, CLS, INP only.
 */
const ALLOWED_METRICS = new Set<MetricName>(["LCP", "CLS", "INP"]);

/**
 * localStorage key for enabling debug logging.
 * Set to "1" to enable console.debug output.
 */
const DEBUG_STORAGE_KEY = "debug:web-vitals";

/**
 * Check if debug logging is enabled via localStorage.
 * Returns false in SSR or when localStorage is unavailable.
 */
export function isDebugEnabled(): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Log a metric to console.debug if debug mode is enabled.
 * Only logs metric type and numeric value - no other data (privacy-safe).
 *
 * @param metric - Metric type (e.g., "LCP", "CLS", "INP")
 * @param val - Metric value (rounded appropriately)
 */
export function debugLogMetric(metric: string, val: number): void {
  if (isDebugEnabled()) {
    console.debug("[web-vitals]", metric, val);
  }
}

/**
 * Strict route allowlist: /app with optional path segments.
 * Only alphanumeric, underscore, and hyphen allowed in segments.
 */
const ROUTE_PATTERN = /^\/app(\/[A-Za-z0-9_-]+)*$/;

/**
 * Payload sent to our endpoint.
 * Minimal, privacy-safe fields only. No id or version.
 */
export interface WebVitalsPayload {
  metrics: Array<{
    name: MetricName;
    value: number;
    route: string;
  }>;
}

/**
 * Round a metric value appropriately.
 * - CLS: keep 4 decimal places (it's a score, typically 0.0000 to 0.xxxx)
 * - LCP/INP: round to integer (milliseconds)
 */
function roundValue(name: MetricName, value: number): number {
  if (name === "CLS") {
    return Math.round(value * 10000) / 10000;
  }
  return Math.round(value);
}

/**
 * Get clean route from current URL.
 * Returns pathname only, no query string or hash.
 * Returns null if route doesn't match allowlist.
 */
function getCleanRoute(): string | null {
  if (typeof window === "undefined") {
    return "/app";
  }
  const pathname = window.location.pathname;
  if (!ROUTE_PATTERN.test(pathname)) {
    return null;
  }
  return pathname;
}

/**
 * Send metrics to our endpoint using fetch with keepalive.
 * Uses fetch (not sendBeacon) so App Bridge's global fetch attaches session token.
 */
function sendMetrics(payload: WebVitalsPayload): void {
  const endpoint = "/api/web-vitals";
  const body = JSON.stringify(payload);

  if (typeof fetch !== "undefined") {
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {
      // Silently ignore send failures - these are optional analytics
    });
  }
}

/**
 * Filter and transform metrics from App Bridge to our payload format.
 * Only includes LCP, CLS, INP. Strips id, version, and all other data.
 * Also logs metrics to console.debug if debug mode is enabled.
 *
 * Drops any metric whose rounded value is non-finite (NaN or ±Infinity) or
 * falls outside the server's accepted bounds for its name, and never emits more
 * than MAX_METRICS entries. These mirror the server's validation so a report
 * built from noisy client values is accepted (204) rather than rejected as a
 * whole batch (400).
 *
 * @param metrics - Raw metrics from App Bridge
 * @param route - Clean route (pathname only)
 * @returns Filtered payload or null if no metric survives filtering
 */
export function filterMetrics(
  metrics: WebVitalsMetric[],
  route: string
): WebVitalsPayload | null {
  const filtered: WebVitalsPayload["metrics"] = [];

  for (const m of metrics) {
    if (!ALLOWED_METRICS.has(m.name)) {
      continue;
    }

    const name = m.name as BoundedMetricName;
    const roundedValue = roundValue(m.name, m.value);

    if (!isWithinBounds(name, roundedValue)) {
      continue;
    }

    debugLogMetric(m.name, roundedValue);
    filtered.push({ name: m.name, value: roundedValue, route });

    if (filtered.length >= MAX_METRICS) {
      break;
    }
  }

  if (filtered.length === 0) {
    return null;
  }

  return { metrics: filtered };
}

/**
 * Handle Web Vitals report from App Bridge.
 * Filters to allowed metrics and sends to our endpoint.
 */
function handleReport(report: WebVitalsReport): void {
  const route = getCleanRoute();
  if (!route) {
    return;
  }
  const payload = filterMetrics(report.metrics, route);

  if (payload) {
    sendMetrics(payload);
  }
}

/**
 * Check if running in SSR (server-side rendering).
 */
function isSSR(): boolean {
  return typeof window === "undefined";
}

/**
 * Get the shopify global object if available.
 */
function getShopify(): ShopifyGlobal | null {
  if (isSSR()) {
    return null;
  }
  return (window as unknown as { shopify?: ShopifyGlobal }).shopify ?? null;
}

/**
 * Register the Web Vitals reporter with App Bridge.
 *
 * Safe to call in SSR (no-op) and when shopify.webVitals is undefined
 * (older App Bridge versions or tests).
 *
 * @returns Cleanup function to unregister, or undefined if not registered
 */
export function registerWebVitalsReporter(): (() => void) | undefined {
  const shopify = getShopify();

  if (!shopify?.webVitals) {
    return undefined;
  }

  shopify.webVitals.onReport(handleReport);

  return () => {
    shopify.webVitals?.onReport(null);
  };
}
