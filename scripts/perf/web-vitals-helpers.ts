/**
 * Helper functions for Web Vitals measurement tooling.
 * Extracted for testability with Vitest (separate from Playwright spec).
 */

/**
 * Calculate median of non-null values.
 * Returns null if no values are provided.
 */
export function medianOfReported(values: (number | null)[]): number | null {
  const reported = values.filter((v): v is number => v !== null);
  if (reported.length === 0) return null;
  const sorted = [...reported].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Count non-null values in array.
 */
export function countReported(values: (number | null)[]): number {
  return values.filter((v) => v !== null).length;
}

/**
 * Format a metric value for display.
 * Shows 'not measured' only when value is null (truly not reported).
 * A real CLS of 0 is shown as '0.0000'.
 */
export function formatMetric(
  value: number | null,
  reported: number,
  total: number,
  unit: string = "ms"
): string {
  if (value === null) return "not measured";
  const valueStr = unit === "ms" ? `${value.toFixed(0)}${unit}` : value.toFixed(4);
  return `${valueStr} (${reported}/${total})`;
}
