/**
 * Shared Web Vitals bounds and limits.
 *
 * Single source of truth for the value bounds and the per-request metric cap,
 * imported by both the client reporter (app/lib/web-vitals.client.ts) and the
 * ingestion route (app/routes/api.web-vitals.tsx) so the client's pre-send
 * filtering and the server's validation cannot drift apart.
 *
 * This module is intentionally framework-free and has no side effects, so it is
 * safe to import from both the browser bundle and the server route.
 *
 * @module
 */

/**
 * Core Web Vitals metric names we accept.
 */
export type BoundedMetricName = "LCP" | "CLS" | "INP";

/**
 * Inclusive value bounds per metric type.
 * - LCP: 0 to 60,000 ms (60 seconds max, way beyond poor threshold)
 * - CLS: 0 to 10 (scores above 1 are extremely poor, 10 is sanity cap)
 * - INP: 0 to 30,000 ms (30 seconds max)
 */
export const VALUE_BOUNDS: Record<BoundedMetricName, { min: number; max: number }> = {
  LCP: { min: 0, max: 60000 },
  CLS: { min: 0, max: 10 },
  INP: { min: 0, max: 30000 },
};

/**
 * Maximum metrics accepted in a single request.
 */
export const MAX_METRICS = 10;

/**
 * Check whether a value is finite and within the inclusive bounds for a metric.
 * Returns false for NaN, ±Infinity, and out-of-range values.
 */
export function isWithinBounds(name: BoundedMetricName, value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  const bounds = VALUE_BOUNDS[name];
  return value >= bounds.min && value <= bounds.max;
}
