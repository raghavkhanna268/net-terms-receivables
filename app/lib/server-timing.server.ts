/**
 * Server-Timing instrumentation for /app load measurement.
 *
 * Records named phases with high-resolution timing and exports a
 * Server-Timing header value. Designed for performance measurement
 * only; timing failures are silently ignored.
 *
 * Phase codes (fixed allowlist, PCD-compliant):
 * - auth_layout: authenticate.admin in app/routes/app.tsx
 * - auth_index: authenticate.admin in app._index.tsx
 * - shop_lookup: Shop query by domain
 * - onboarding_checks: Onboarding redirect logic
 * - plan_resolve: Plan resolution via resolvePlan
 * - ledger_rows: Buyer ledger query
 * - ledger_count: Over-limit count query
 * - loader_total: Total loader time
 *
 * Privacy: Only phase codes and durations are recorded.
 * No shop domain, IDs, or descriptions are included.
 *
 * @module
 */

/**
 * Allowed phase codes for Server-Timing.
 * These are the ONLY phase names that can appear in headers or logs.
 */
const ALLOWED_PHASES = new Set([
  "auth_layout",
  "auth_index",
  "db_connect",
  "shop_lookup",
  "onboarding_checks",
  "plan_resolve",
  "ledger_rows",
  "ledger_count",
  "loader_total",
]);

/**
 * Track cold start (first request in this isolate).
 */
let isolateRequestCount = 0;

/**
 * Check if this is the first request in the isolate.
 */
export function isFirstRequestInIsolate(): boolean {
  return isolateRequestCount === 0;
}

/**
 * Increment the isolate request counter.
 * Call this once per request after timing is complete.
 */
export function markRequestServed(): void {
  isolateRequestCount++;
}

/**
 * Reset isolate state for testing only.
 * @internal
 */
export function _resetIsolateStateForTesting(): void {
  isolateRequestCount = 0;
}

/**
 * A single phase timing entry.
 */
interface PhaseEntry {
  start: number;
  end?: number;
}

/**
 * Server timing tracker for a single request.
 */
export class ServerTiming {
  private phases: Map<string, PhaseEntry> = new Map();
  private requestStart: number;
  private cold: boolean;

  constructor() {
    this.requestStart = performance.now();
    this.cold = isFirstRequestInIsolate();
  }

  /**
   * Start timing a phase.
   * Silently ignores unknown phase codes.
   */
  startPhase(phase: string): void {
    try {
      if (!ALLOWED_PHASES.has(phase)) return;
      this.phases.set(phase, { start: performance.now() });
    } catch {
      // Timing must never throw
    }
  }

  /**
   * End timing a phase.
   * Silently ignores unknown phase codes or phases not started.
   */
  endPhase(phase: string): void {
    try {
      if (!ALLOWED_PHASES.has(phase)) return;
      const entry = this.phases.get(phase);
      if (entry) {
        entry.end = performance.now();
      }
    } catch {
      // Timing must never throw
    }
  }

  /**
   * Time an async operation as a named phase.
   * Returns the operation result. Timing failures are ignored.
   */
  async time<T>(phase: string, fn: () => Promise<T>): Promise<T> {
    this.startPhase(phase);
    try {
      return await fn();
    } finally {
      this.endPhase(phase);
    }
  }

  /**
   * Get the duration of a phase in milliseconds.
   * Returns undefined if phase not recorded or not ended.
   */
  getDuration(phase: string): number | undefined {
    try {
      const entry = this.phases.get(phase);
      if (!entry || entry.end === undefined) return undefined;
      return entry.end - entry.start;
    } catch {
      return undefined;
    }
  }

  /**
   * Get the total time from construction to now.
   */
  getTotalDuration(): number {
    try {
      return performance.now() - this.requestStart;
    } catch {
      return 0;
    }
  }

  /**
   * Whether this is a cold start request.
   */
  isCold(): boolean {
    return this.cold;
  }

  /**
   * Build Server-Timing header value.
   * Format: phase;dur=X.X, phase2;dur=Y.Y
   * Only includes phases with completed timing.
   */
  toHeaderValue(): string {
    try {
      const parts: string[] = [];
      for (const [phase, entry] of this.phases) {
        if (entry.end !== undefined) {
          const dur = (entry.end - entry.start).toFixed(1);
          parts.push(`${phase};dur=${dur}`);
        }
      }
      return parts.join(", ");
    } catch {
      return "";
    }
  }

  /**
   * Build timing data for logging.
   * Returns only phase codes with durationMs numbers.
   */
  toLogFields(): Record<string, number | boolean> {
    try {
      const fields: Record<string, number | boolean> = {
        cold: this.cold,
      };
      for (const [phase, entry] of this.phases) {
        if (entry.end !== undefined) {
          fields[`${phase}Ms`] = Math.round(entry.end - entry.start);
        }
      }
      return fields;
    } catch {
      return { cold: this.cold };
    }
  }
}

/**
 * Merge Server-Timing header values from multiple sources.
 * Used to combine layout and index loader timings.
 */
export function mergeServerTimingHeaders(...values: (string | null | undefined)[]): string {
  try {
    const parts: string[] = [];
    for (const value of values) {
      if (value) {
        parts.push(value);
      }
    }
    return parts.join(", ");
  } catch {
    return "";
  }
}

/**
 * Validate that a Server-Timing header value contains only allowed phase entries.
 * Used for testing compliance.
 */
export function isValidServerTimingHeader(value: string): boolean {
  if (!value) return true;
  const entryPattern = /^[a-z_]+;dur=\d+(\.\d+)?$/;
  const entries = value.split(/,\s*/);
  for (const entry of entries) {
    if (!entry) continue;
    if (!entryPattern.test(entry)) return false;
    const phase = entry.split(";")[0];
    if (!ALLOWED_PHASES.has(phase)) return false;
  }
  return true;
}

/**
 * Get the set of allowed phase codes.
 * Exported for testing.
 */
export function getAllowedPhases(): Set<string> {
  return new Set(ALLOWED_PHASES);
}
