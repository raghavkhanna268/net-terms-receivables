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
 * Redact a value based on its type and content.
 */
function redactValue(value: unknown, key: string): unknown {
  if (value === null || value === undefined) {
    return value;
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
 * Redact all fields in an object, keeping only allowlisted keys.
 */
function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(fields)) {
    if (isAllowedKey(key)) {
      result[key] = redactValue(value, key);
    } else {
      result[key] = typeof value === "boolean" || typeof value === "number"
        ? value
        : REDACTED;
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

    if (typeof errObj.code === "string" && errObj.code) {
      return errObj.code;
    }

    if (typeof errObj.errorCode === "string" && errObj.errorCode) {
      return errObj.errorCode;
    }

    if (typeof errObj.name === "string" && errObj.name && errObj.name !== "Error") {
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

      return err.name !== "Error" ? err.name : "error";
    }
  }

  if (typeof err === "string") {
    return err.length < 50 && !err.includes(" ") ? err : "string_error";
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

/**
 * Synchronous version of shopHash using a simple hash for hot paths.
 * Uses djb2 algorithm - fast but not cryptographic.
 * For compliance paths, prefer the async shopHash.
 */
export function shopHashSync(domain: string): string {
  const str = domain.toLowerCase();
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  const unsigned = hash >>> 0;
  return unsigned.toString(16).padStart(8, "0").slice(0, 12);
}
