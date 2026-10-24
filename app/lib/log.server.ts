/**
 * Safe logging helper with PII redaction.
 *
 * Provides safeLog() for structured logging with automatic redaction of
 * sensitive data. Output is single-line JSON for easy parsing.
 *
 * Allowlisted fields: shopId, shopHash, requestId, webhookId, jobId, matchId,
 * buyerAccountId, orderGid, invoiceId, and other *Id/*Gid keys, plus topic,
 * status, reason, code, err, count/*Count, boolean flags, durationMs, timestamps.
 *
 * Any other key, or any string value matching sensitive patterns, is redacted.
 *
 * @module
 */

/**
 * Allowlisted field patterns for safe logging.
 * Keys matching these patterns pass through unredacted.
 */
const ALLOWED_KEY_PATTERNS: RegExp[] = [
  /^shopId$/,
  /^shopHash$/,
  /^requestId$/,
  /^webhookId$/,
  /^jobId$/,
  /^matchId$/,
  /^buyerAccountId$/,
  /^orderGid$/,
  /^invoiceId$/,
  /^customerId$/,
  /^companyId$/,
  /^locationId$/,
  /^sessionId$/,
  /^operationId$/,
  /^messageId$/,
  /^msgId$/,
  /Id$/,
  /Gid$/,
  /^topic$/,
  /^status$/,
  /^reason$/,
  /^reasonCode$/,
  /^code$/,
  /^err$/,
  /^errorCode$/,
  /^httpStatus$/,
  /^pgCode$/,
  /Count$/,
  /^count$/,
  /^durationMs$/,
  /^elapsedMs$/,
  /^at$/,
  /^timestamp$/,
  /^createdAt$/,
  /^updatedAt$/,
  /^processedAt$/,
  /^enqueuedAt$/,
  /^readCt$/,
  /^applied$/,
  /^skipped$/,
  /^success$/,
  /^retryable$/,
  /^wasRefreshed$/,
  /^usedFallback$/,
  /^action$/,
  /^fields$/,
  /^version$/,
  /^stage$/,
  /^queue$/,
  /^origin$/,
  /^piiMode$/,
  /^holdState$/,
  /^bypass$/,
  /^bulkType$/,
  /^byteOffset$/,
  /^ownerType$/,
  /^lineCount$/,
  /^metric$/,
  /^value$/,
  /^rating$/,
  /^route$/,
];

/**
 * Patterns that indicate sensitive data in string values.
 * If a value matches any of these, it is redacted.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /\.myshopify\.com/i,
  /@/,
  /Bearer\s/i,
  /^shpat_/i,
  /^shpua_/i,
  /^shpss_/i,
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
];

const REDACTED = "<redacted>";

/**
 * Web Vitals metric names (S23-30).
 * Only these exact values are allowed for the `metric` key.
 */
const WEB_VITALS_METRICS = new Set(["LCP", "CLS", "INP"]);

/**
 * Web Vitals rating values.
 * Computed server-side from Google's standard thresholds.
 */
const WEB_VITALS_RATINGS = new Set(["good", "needs-improvement", "poor"]);

/**
 * Valid route-id enum values for Web Vitals logging.
 * Maps from validated paths to safe identifiers. Never log raw paths.
 */
const WEB_VITALS_ROUTES = new Set([
  "app_home",
  "app_accounts",
  "app_data_requests",
  "app_data_requests_download",
  "app_imports",
  "app_onboarding",
  "app_plan",
  "app_reconcile",
  "app_settings_reminders",
  "other",
]);

/**
 * Value bounds for Web Vitals metrics.
 * - LCP/INP: 0 to 60000 ms
 * - CLS: 0 to 10
 */
const WEB_VITALS_VALUE_BOUNDS = { min: 0, maxMs: 60000, maxCls: 10 };

/**
 * Pattern for valid error codes.
 * Must start with a letter, contain only alphanumerics, underscores, colons, and commas.
 * Max 128 chars. Colons and commas allow compound codes like graphql_error:ACCESS_DENIED,USER_ERROR.
 */
const SAFE_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_:,]{0,127}$/;

/**
 * Check if a field key is allowlisted.
 */
function isAllowedKey(key: string): boolean {
  return ALLOWED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Check if a string value contains sensitive data.
 */
function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Check if a string is a safe error code.
 * Must match safe pattern and not contain sensitive patterns.
 * Exported for use in credit-status error handling.
 */
export function isSafeCode(code: string): boolean {
  return SAFE_CODE_PATTERN.test(code) && !isSensitiveValue(code);
}

const PROMISE_REDACTED = "<promise>";

/**
 * Redact a value based on its type and content.
 */
function redactValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Detect unawaited Promises - common mistake with async functions like shopHash
  if (value instanceof Promise || (typeof value === "object" && value !== null && "then" in value && typeof (value as { then: unknown }).then === "function")) {
    // In test environment, throw to catch the bug immediately
    if (process.env.NODE_ENV === "test" || process.env.VITEST) {
      throw new Error(`safeLog received unawaited Promise for key "${key}" - did you forget to await?`);
    }
    return PROMISE_REDACTED;
  }

  if (typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    if (isAllowedKey(key)) {
      if (isSensitiveValue(value)) {
        return REDACTED;
      }
      return redactString(value);
    }
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, key));
  }

  if (typeof value === "object") {
    return redactFields(value as Record<string, unknown>);
  }

  return REDACTED;
}

/**
 * Validate and transform a Web Vitals `metric` value.
 * Only LCP, CLS, INP are allowed.
 */
function validateMetricValue(value: unknown): string | null {
  if (typeof value === "string" && WEB_VITALS_METRICS.has(value)) {
    return value;
  }
  return null;
}

/**
 * Validate and transform a Web Vitals `value` field.
 * Must be a finite number, clamped to bounds, rounded.
 */
function validateWebVitalsValue(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const clamped = Math.max(WEB_VITALS_VALUE_BOUNDS.min, Math.min(value, WEB_VITALS_VALUE_BOUNDS.maxMs));
  return Math.round(clamped * 10000) / 10000;
}

/**
 * Validate and transform a Web Vitals `rating` value.
 * Only good, needs-improvement, poor are allowed.
 */
function validateRatingValue(value: unknown): string | null {
  if (typeof value === "string" && WEB_VITALS_RATINGS.has(value)) {
    return value;
  }
  return null;
}

/**
 * Validate and transform a Web Vitals `route` value.
 * Must be a valid route-id enum value.
 */
function validateRouteValue(value: unknown): string | null {
  if (typeof value === "string" && WEB_VITALS_ROUTES.has(value)) {
    return value;
  }
  return null;
}

/**
 * Redact all fields in an object, keeping only allowlisted keys.
 * Non-allowlisted keys have all values redacted (including numbers, per #174 money rule).
 * Only booleans pass through for non-allowlisted keys.
 * The `err` key is special: it is routed through toErrorCode to ensure only safe codes.
 *
 * Web Vitals keys (S23-30) have strict validation:
 * - metric: must be LCP, CLS, or INP
 * - value: must be finite number, clamped and rounded
 * - rating: must be good, needs-improvement, or poor
 * - route: must be a valid route-id enum
 */
function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key === "err") {
      result[key] = toErrorCode(value);
    } else if (key === "metric") {
      const validated = validateMetricValue(value);
      result[key] = validated ?? REDACTED;
    } else if (key === "value") {
      const validated = validateWebVitalsValue(value);
      result[key] = validated ?? REDACTED;
    } else if (key === "rating") {
      const validated = validateRatingValue(value);
      result[key] = validated ?? REDACTED;
    } else if (key === "route") {
      const validated = validateRouteValue(value);
      result[key] = validated ?? REDACTED;
    } else if (isAllowedKey(key)) {
      result[key] = redactValue(value, key);
    } else {
      result[key] = typeof value === "boolean" ? value : REDACTED;
    }
  }

  return result;
}

/**
 * Redact a string, replacing sensitive patterns.
 * Used for error messages and other free-text strings.
 */
export function redactString(str: string): string {
  let result = str;
  result = result.replace(/[a-z0-9-]+\.myshopify\.com/gi, REDACTED);
  result = result.replace(/Bearer\s+\S+/gi, REDACTED);
  result = result.replace(/shpat_\S+/gi, REDACTED);
  result = result.replace(/shpua_\S+/gi, REDACTED);
  result = result.replace(/shpss_\S+/gi, REDACTED);
  result = result.replace(/[^\s"']+@[^\s"']+/g, REDACTED);
  return result;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Log a structured event with automatic field redaction.
 *
 * Output is single-line JSON with the event name and redacted fields.
 * Only allowlisted fields pass through; others become "<redacted>".
 * Sensitive patterns in string values are also redacted.
 *
 * @param level - Log level (debug, info, warn, error)
 * @param event - Event name (e.g., "order_refetch_null", "backstop.applied")
 * @param fields - Key-value pairs to log
 *
 * @example
 * safeLog("warn", "order_refetch_null", { shopId: "abc", orderGid: "gid://shopify/Order/123" });
 * // Output: {"event":"order_refetch_null","shopId":"abc","orderGid":"gid://shopify/Order/123"}
 */
export function safeLog(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const redactedFields = redactFields(fields);
  const logEntry = JSON.stringify({ event, ...redactedFields });

  switch (level) {
    case "debug":
      console.debug(logEntry);
      break;
    case "info":
      console.log(logEntry);
      break;
    case "warn":
      console.warn(logEntry);
      break;
    case "error":
      console.error(logEntry);
      break;
  }
}

/**
 * Map an error to an error code for safe logging.
 *
 * Extracts code from error objects or maps known error types.
 * Never returns the raw error message.
 * Validates codes to prevent domain/email-like strings from leaking.
 *
 * @param err - Error object or unknown
 * @returns Error code string
 */
export function toErrorCode(err: unknown): string {
  if (err === null || err === undefined) {
    return "unknown";
  }

  if (typeof err === "object") {
    const errObj = err as Record<string, unknown>;

    if (typeof errObj.code === "string" && errObj.code && isSafeCode(errObj.code)) {
      return errObj.code;
    }

    if (typeof errObj.errorCode === "string" && errObj.errorCode && isSafeCode(errObj.errorCode)) {
      return errObj.errorCode;
    }

    if (typeof errObj.name === "string" && errObj.name && errObj.name !== "Error" && isSafeCode(errObj.name)) {
      return errObj.name;
    }

    if (err instanceof Error) {
      const msg = err.message.toLowerCase();

      if (msg.includes("econnrefused")) return "connection_refused";
      if (msg.includes("etimedout") || msg.includes("timeout")) return "timeout";
      if (msg.includes("enotfound")) return "dns_error";
      if (msg.includes("fetch failed")) return "fetch_error";

      if (msg.includes("invalid_grant")) return "invalid_grant";
      if (msg.includes("access denied") || msg.includes("access_denied")) return "access_denied";
      if (msg.includes("throttled")) return "throttled";
      if (msg.includes("rate limit")) return "rate_limited";

      if (msg.includes("unique constraint") || msg.includes("duplicate key")) return "pg_unique_violation";
      if (msg.includes("foreign key")) return "pg_foreign_key_violation";
      if (msg.includes("connection") && msg.includes("postgres")) return "pg_connection_error";
      if (msg.includes("pgmq") || msg.includes("queue")) return "queue_error";

      if (err.name !== "Error" && isSafeCode(err.name)) {
        return err.name;
      }
      return "error";
    }
  }

  if (typeof err === "string") {
    // Validate string codes
    if (isSafeCode(err)) {
      return err;
    }
    return "string_error";
  }

  return "unknown";
}

/**
 * Compute a SHA-256 hash of a shop domain for safe logging.
 *
 * Returns the first 12 hex characters of the hash.
 * Used for compliance/redact paths where no shopId exists.
 *
 * Uses Web Crypto API for Cloudflare Workers compatibility.
 *
 * @param domain - Shop domain (e.g., "example.myshopify.com")
 * @returns First 12 hex characters of SHA-256 hash
 */
export async function shopHash(domain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(domain.toLowerCase());
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.slice(0, 12);
}

