/**
 * Shopify Admin GraphQL client with rate limit handling (S20).
 *
 * Provides a wrapper for Admin API calls that handles:
 * - Token refresh: Checks expiry and refreshes before each call (5 min skew)
 * - THROTTLED responses: Uses extensions.cost.throttleStatus to compute wait
 * - HTTP 429: Honours Retry-After header, else exponential backoff with jitter
 * - 5xx and network errors: Bounded exponential backoff
 *
 * Token refresh uses CAS (compare-and-swap) for safe concurrent refreshes.
 * On invalid refresh token, marks session as needing re-auth and returns
 * a non-retryable error.
 *
 * Error classification for drain retry logic:
 *
 * RETRYABLE (drain should retry or leave for next read_ct):
 * - HTTP 401: Token expired → #76 session refresh can recover on next drain run
 * - HTTP 429: Rate limited, backoff and retry
 * - HTTP 5xx: Server errors, transient
 * - Network errors: Connection failures, timeouts
 * - InvalidSession: Token expired → refresh can recover
 *
 * NON-RETRYABLE (drain should DLQ immediately):
 * - HTTP 403: Scope not granted, permanent until app reinstall
 * - 'No session found': Shop uninstalled or never installed, no recovery possible
 * - Invalid refresh token: Re-authentication required (non-retryable)
 * - GraphQL validation errors: Schema mismatch, invalid query syntax, field errors
 * - GraphQL ACCESS_DENIED: Scope not granted, permanent until app reinstall
 * - GraphQL userErrors: Invalid input data
 *
 * Worker budget awareness:
 * - Request-path code: At most 1 short retry, 1s max wait
 * - Queue/job paths: Up to 3 retries, 25s max wait (< 30s pgmq visibility timeout)
 */

import {
  HttpResponseError,
  HttpRetriableError,
  HttpThrottlingError,
  GraphqlQueryError,
  InvalidSession,
} from "@shopify/shopify-api";
import { getRequestSql } from "~/lib/request-context.server";
import { getOfflineAdminContext } from "~/lib/offline-admin.server";
import { safeLog, shopHash } from "~/lib/log.server";

/**
 * Execution context: determines retry budget.
 */
export type ShopifyClientContext = "request" | "queue";

/**
 * Result of an Admin API call with retry support.
 */
export interface ShopifyClientResult<T = unknown> {
  success: boolean;
  data?: T;
  /** Error description (no PII, no shop domain) */
  error?: string;
  /** Error code for safe logging/response (no PII) */
  errorCode?: string;
  /** Whether the error is retryable (for queue retry logic) */
  retryable: boolean;
  /** Whether rate limited (for metrics) */
  wasRateLimited?: boolean;
  /** Total retries attempted */
  retriesAttempted?: number;
}

/**
 * GraphQL response shape from the Admin API.
 */
interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: {
      code?: string;
      cost?: {
        requestedQueryCost: number;
        actualQueryCost: number;
        throttleStatus: {
          maximumAvailable: number;
          currentlyAvailable: number;
          restoreRate: number;
        };
      };
    };
  }>;
  extensions?: {
    cost?: {
      requestedQueryCost: number;
      actualQueryCost: number;
      throttleStatus: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  /** Max retries for request-path code (default: 1) */
  requestPathMaxRetries: number;
  /** Max retries for queue/job code (default: 3) */
  queueMaxRetries: number;
  /** Base delay for exponential backoff in ms (default: 100) */
  baseDelayMs: number;
  /** Max delay for exponential backoff in ms (default: 5000) */
  maxDelayMs: number;
  /** Max wait time for request-path in ms (default: 1000) */
  requestPathMaxWaitMs: number;
  /** Max wait time for queue in ms (default: 25000, < 30s pgmq visibility timeout) */
  queueMaxWaitMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  requestPathMaxRetries: 1,
  queueMaxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  requestPathMaxWaitMs: 1000,
  // 25s < pgmq visibility timeout (30s) - ensures we finish before message becomes visible again
  queueMaxWaitMs: 25000,
};

/**
 * Calculate wait time from THROTTLED response.
 * Uses extensions.cost.throttleStatus to compute optimal wait.
 *
 * Formula: (requestedCost - currentlyAvailable) / restoreRate * 1000ms
 */
function calculateThrottleWait(
  extensions?: GraphQLResponse<unknown>["extensions"],
  errorExtensions?: GraphQLResponse<unknown>["errors"]
): number {
  // Try to get cost info from extensions or error extensions
  const cost = extensions?.cost ||
    errorExtensions?.find(e => e.extensions?.cost)?.extensions?.cost;

  if (cost?.throttleStatus) {
    const { currentlyAvailable, restoreRate } = cost.throttleStatus;
    const requestedCost = cost.requestedQueryCost || cost.actualQueryCost || 0;

    if (restoreRate > 0 && requestedCost > currentlyAvailable) {
      const pointsNeeded = requestedCost - currentlyAvailable;
      const waitSeconds = pointsNeeded / restoreRate;
      return Math.ceil(waitSeconds * 1000) + 100; // Add 100ms buffer
    }
  }

  // Fallback: 1 second
  return 1000;
}

/**
 * Calculate exponential backoff with jitter.
 */
function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Parse Retry-After header value.
 * Returns delay in milliseconds, or null if not parseable.
 */
function parseRetryAfter(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) return null;

  // Try as seconds first (most common)
  const seconds = parseFloat(retryAfter);
  if (!isNaN(seconds)) {
    return Math.ceil(seconds * 1000);
  }

  // Try as HTTP date
  const date = new Date(retryAfter);
  if (!isNaN(date.getTime())) {
    const now = Date.now();
    const wait = date.getTime() - now;
    return wait > 0 ? wait : null;
  }

  return null;
}

/**
 * Sleep for a given duration.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a GraphQL query with retry support.
 *
 * @param shop - Shop domain
 * @param query - GraphQL query string
 * @param variables - Optional query variables
 * @param context - Execution context (request or queue)
 * @param config - Optional retry configuration
 * @returns Result with data or error
 */
export async function shopifyGraphQL<T = unknown>(
  shop: string,
  query: string,
  variables?: Record<string, unknown>,
  context: ShopifyClientContext = "queue",
  config: Partial<RetryConfig> = {}
): Promise<ShopifyClientResult<T>> {
  const cfg = { ...DEFAULT_RETRY_CONFIG, ...config };
  const maxRetries = context === "request"
    ? cfg.requestPathMaxRetries
    : cfg.queueMaxRetries;
  const maxWaitMs = context === "request"
    ? cfg.requestPathMaxWaitMs
    : cfg.queueMaxWaitMs;

  let attempt = 0;
  let totalWaitTime = 0;
  let wasRateLimited = false;

  // Get admin client with proper token refresh locking
  // This ensures:
  // 1. Token refresh is serialized per-shop via advisory lock
  // 2. The admin client is only returned after token is confirmed fresh
  // 3. Non-retryable failures are typed for proper DLQ handling
  const clientId = process.env.SHOPIFY_API_KEY;
  const clientSecret = process.env.SHOPIFY_API_SECRET;
  
  if (!clientId || !clientSecret) {
    safeLog("error", "shopify_missing_credentials", {
      shopHash: await shopHash(shop),
      code: "missing_credentials",
    });
    return {
      success: false,
      error: "Shopify credentials not configured",
      errorCode: "missing_credentials",
      retryable: false,
      retriesAttempted: 0,
    };
  }

  const sql = getRequestSql();
  const adminResult = await getOfflineAdminContext(sql, shop, clientId, clientSecret);
  
  if (!adminResult.success || !adminResult.admin) {
    // Map admin error codes to the original shopifyGraphQL codes for compatibility
    // with drain/processor.server.ts, sync-error-info.ts, and credit-status.server.ts
    let errorCode = adminResult.errorCode ?? "token_refresh_failed";
    let retryable = adminResult.retryable;
    let error = adminResult.error ?? "Token refresh failed";

    // Token refresh failures (from refreshOfflineTokenIfNeeded)
    // Behaviour change: transient refresh failures (network_error, http_error, invalid_response)
    // are now retryable for queue paths. Non-retryable codes: invalid_grant, no_refresh_token, no_session.
    if (errorCode === "admin_no_session") {
      // No session found after token refresh - shop uninstalled or never installed
      errorCode = "no_session";
      error = "No session found";
      retryable = false;
    } else if (errorCode === "admin_invalid_session") {
      // InvalidSession from admin - token expired, session refresh can recover
      errorCode = "invalid_session";
      error = "Invalid session";
      retryable = true;
    } else if (
      // Only apply session_error fallback for unknown error codes with 'session' in message
      // Don't override specific codes like invalid_grant, no_refresh_token, network_error
      errorCode === "unknown" &&
      (error.includes("session") || error.includes("Session"))
    ) {
      // Other session errors - may be recoverable via session refresh
      errorCode = "session_error";
      error = "Session error";
      retryable = true;
    }
    // Note: other codes (invalid_grant, no_refresh_token, no_session, network_error, etc.)
    // pass through unchanged from refreshOfflineTokenIfNeeded

    return {
      success: false,
      error,
      errorCode,
      retryable,
      retriesAttempted: 0,
    };
  }

  const admin = adminResult.admin;

  while (attempt <= maxRetries) {
    try {
      const response = await admin.graphql(query, { variables });
      const json = (await response.json()) as GraphQLResponse<T>;

      // Check for GraphQL-level THROTTLED errors
      if (json.errors && json.errors.length > 0) {
        const throttled = json.errors.some((e) => e.extensions?.code === "THROTTLED");

        if (throttled) {
          wasRateLimited = true;

          // Calculate wait from throttle status
          const waitMs = calculateThrottleWait(json.extensions, json.errors);

          // Check if we have budget for retry
          if (attempt < maxRetries && totalWaitTime + waitMs <= maxWaitMs) {
            console.log(
              `[shopify-client] THROTTLED, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`
            );
            await sleep(waitMs);
            totalWaitTime += waitMs;
            attempt++;
            continue;
          }

          // No budget for retry
          return {
            success: false,
            error: "Rate limited (THROTTLED)",
            errorCode: "throttled",
            retryable: true,
            wasRateLimited: true,
            retriesAttempted: attempt,
          };
        }

        // Extract error codes from extensions for safe logging
        const errorCodes = json.errors
          .map((e) => e.extensions?.code)
          .filter((c): c is string => typeof c === "string");
        const errorCodeList = errorCodes.length > 0 ? errorCodes.join(",") : "unknown";

        // Check for ACCESS_DENIED - scope not granted, permanent until reinstall
        const hasAccessDenied = errorCodes.includes("ACCESS_DENIED");

        if (hasAccessDenied) {
          return {
            success: false,
            error: "Access denied",
            errorCode: "access_denied",
            retryable: false, // Non-retryable: scope not granted
            retriesAttempted: attempt,
          };
        }

        // Check for user errors (never retry)
        const hasUserErrors = json.errors.some((e) =>
          e.message.toLowerCase().includes("user error") ||
          e.extensions?.code === "USER_ERROR"
        );

        if (hasUserErrors) {
          return {
            success: false,
            error: `User errors (${json.errors.length})`,
            errorCode: "user_error",
            retryable: false, // Non-retryable: invalid input
            retriesAttempted: attempt,
          };
        }

        // Other GraphQL errors (schema/validation) - not retryable
        return {
          success: false,
          error: `GraphQL errors (${json.errors.length}): ${errorCodeList}`,
          errorCode: `graphql_error:${errorCodeList}`,
          retryable: false, // Non-retryable: schema mismatch or query syntax error
          retriesAttempted: attempt,
        };
      }

      // Success
      return {
        success: true,
        data: json.data as T,
        retryable: false,
        wasRateLimited,
        retriesAttempted: attempt,
      };
    } catch (err) {
      // Handle HTTP-level errors

      // 429 rate limiting
      if (err instanceof HttpThrottlingError) {
        wasRateLimited = true;
        const retryAfterHeader = err.response.retryAfter?.toString();
        const waitMs = parseRetryAfter(retryAfterHeader) ||
          calculateBackoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs);

        if (attempt < maxRetries && totalWaitTime + waitMs <= maxWaitMs) {
          console.log(
            `[shopify-client] 429 rate limited, waiting ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`
          );
          await sleep(waitMs);
          totalWaitTime += waitMs;
          attempt++;
          continue;
        }

        return {
          success: false,
          error: "Rate limited (429)",
          errorCode: "http_429",
          retryable: true,
          wasRateLimited: true,
          retriesAttempted: attempt,
        };
      }

      // 5xx server errors (HttpRetriableError is parent of HttpThrottlingError)
      if (err instanceof HttpRetriableError) {
        const waitMs = calculateBackoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs);

        if (attempt < maxRetries && totalWaitTime + waitMs <= maxWaitMs) {
          console.log(
            `[shopify-client] Server error (${err.response.code}), retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`
          );
          await sleep(waitMs);
          totalWaitTime += waitMs;
          attempt++;
          continue;
        }

        return {
          success: false,
          error: `Server error (${err.response.code})`,
          errorCode: `http_${err.response.code}`,
          retryable: true,
          retriesAttempted: attempt,
        };
      }

      // HTTP 4xx errors
      if (err instanceof HttpResponseError) {
        const code = err.response.code;
        // 401: Token expired - RETRYABLE (#76 session refresh can recover)
        if (code === 401) {
          return {
            success: false,
            error: "Authentication failed (401)",
            errorCode: "http_401",
            retryable: true, // Retryable: session refresh can recover expired token
            retriesAttempted: attempt,
          };
        }
        // 403: Forbidden - NON-RETRYABLE (scope not granted, needs reinstall)
        if (code === 403) {
          return {
            success: false,
            error: "Forbidden (403)",
            errorCode: "http_403",
            retryable: false, // Non-retryable: needs app reinstall with correct scopes
            retriesAttempted: attempt,
          };
        }
        // Other 4xx (400 Bad Request, 404 Not Found) - not retryable
        return {
          success: false,
          error: `HTTP error (${code})`,
          errorCode: `http_${code}`,
          retryable: false,
          retriesAttempted: attempt,
        };
      }

      // GraphQL query errors - not retryable
      if (err instanceof GraphqlQueryError) {
        return {
          success: false,
          error: "GraphQL query error",
          errorCode: "graphql_query_error",
          retryable: false,
          retriesAttempted: attempt,
        };
      }

      // Session errors - RETRYABLE (#76 refresh can recover expired tokens)
      if (err instanceof InvalidSession) {
        return {
          success: false,
          error: "Invalid session",
          errorCode: "invalid_session",
          retryable: true, // Retryable: #76 session refresh can recover
          retriesAttempted: attempt,
        };
      }

      // Network errors - retryable
      const message = err instanceof Error ? err.message : "Unknown error";
      const isNetworkError =
        err instanceof TypeError ||
        message.includes("fetch") ||
        message.includes("network") ||
        message.includes("ECONNREFUSED") ||
        message.includes("ETIMEDOUT") ||
        message.includes("ENOTFOUND");

      if (isNetworkError) {
        const waitMs = calculateBackoff(attempt, cfg.baseDelayMs, cfg.maxDelayMs);

        if (attempt < maxRetries && totalWaitTime + waitMs <= maxWaitMs) {
          console.log(
            `[shopify-client] Network error, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries + 1})`
          );
          await sleep(waitMs);
          totalWaitTime += waitMs;
          attempt++;
          continue;
        }

        return {
          success: false,
          error: "Network error",
          errorCode: "network_error",
          retryable: true,
          retriesAttempted: attempt,
        };
      }

      // Unknown errors - not retryable to avoid infinite loops
      const { toErrorCode } = await import("~/lib/log.server");
      return {
        success: false,
        error: "Unknown error",
        errorCode: toErrorCode(err),
        retryable: false,
        retriesAttempted: attempt,
      };
    }
  }

  // Should not reach here, but safety return
  return {
    success: false,
    error: "Max retries exceeded",
    errorCode: "max_retries_exceeded",
    retryable: true,
    retriesAttempted: attempt,
  };
}

/**
 * Execute a GraphQL query in request-path context.
 * At most 1 short retry, then surface retryable error for pgmq to handle.
 */
export async function shopifyGraphQLRequest<T = unknown>(
  shop: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<ShopifyClientResult<T>> {
  return shopifyGraphQL<T>(shop, query, variables, "request");
}

/**
 * Execute a GraphQL query in queue/job context.
 * Can wait longer within platform wall-clock limits.
 */
export async function shopifyGraphQLQueue<T = unknown>(
  shop: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<ShopifyClientResult<T>> {
  return shopifyGraphQL<T>(shop, query, variables, "queue");
}
