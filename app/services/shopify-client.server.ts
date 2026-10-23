/**
 * Shopify Admin GraphQL client with rate limit handling (S20).
 *
 * Provides a wrapper for Admin API calls that handles:
 * - THROTTLED responses: Uses extensions.cost.throttleStatus to compute wait
 * - HTTP 429: Honours Retry-After header, else exponential backoff with jitter
 * - 5xx and network errors: Bounded exponential backoff
 *
 * NOT retried (caller must handle):
 * - HTTP 4xx (except 429): 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found
 * - GraphQL userErrors: Application-level validation errors (e.g., invalid input)
 * - GraphQL errors without THROTTLED code: Query syntax errors, field errors
 * - InvalidSession: Token revoked, shop needs to reinstall
 *
 * Worker budget awareness:
 * - Request-path code: At most 1 short retry, 1s max wait
 * - Queue/job paths: Up to 3 retries, 25s max wait (< 30s pgmq visibility timeout)
 *
 * Uses the existing admin client from drain/admin-client.server.ts as the
 * underlying implementation.
 */

import { getShopifyApp } from "~/shopify.server";
import {
  HttpResponseError,
  HttpRetriableError,
  HttpThrottlingError,
  GraphqlQueryError,
  InvalidSession,
} from "@shopify/shopify-api";

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
  error?: string;
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

  // Hoist admin client outside retry loop - the session doesn't change between retries
  // Wrap in try/catch to handle InvalidSession (missing/revoked offline session)
  let admin: Awaited<ReturnType<ReturnType<typeof getShopifyApp>["unauthenticated"]["admin"]>>["admin"];
  try {
    const shopify = getShopifyApp();
    const result = await shopify.unauthenticated.admin(shop);
    admin = result.admin;
  } catch (err) {
    // InvalidSession or 'No session found' - non-retryable, drain should archive
    if (err instanceof InvalidSession) {
      return {
        success: false,
        error: `Invalid session for ${shop}. Shop may need to reinstall the app.`,
        retryable: false,
        retriesAttempted: 0,
      };
    }
    // Other session errors (e.g., 'No session found')
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("session") || message.includes("Session")) {
      return {
        success: false,
        error: `Session error for ${shop}: ${message}`,
        retryable: false,
        retriesAttempted: 0,
      };
    }
    // Re-throw unexpected errors
    throw err;
  }

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
            error: `GraphQL THROTTLED. Wait ${waitMs}ms recommended.`,
            retryable: true,
            wasRateLimited: true,
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
            error: `User errors: ${json.errors.map((e) => e.message).join("; ")}`,
            retryable: false,
            retriesAttempted: attempt,
          };
        }

        // Other GraphQL errors - not retryable
        return {
          success: false,
          error: `GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`,
          retryable: false,
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
          error: `Rate limited (429). Retry after ${waitMs}ms.`,
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
          error: `Server error (${err.response.code}). Exhausted retries.`,
          retryable: true,
          retriesAttempted: attempt,
        };
      }

      // Other HTTP errors (4xx except 429) - not retryable
      if (err instanceof HttpResponseError) {
        const code = err.response.code;
        if (code === 401 || code === 403) {
          return {
            success: false,
            error: `Authentication failed for ${shop} (${code}). Token may be revoked.`,
            retryable: false,
            retriesAttempted: attempt,
          };
        }
        return {
          success: false,
          error: `HTTP error ${code}: ${err.message}`,
          retryable: false,
          retriesAttempted: attempt,
        };
      }

      // GraphQL query errors - not retryable
      if (err instanceof GraphqlQueryError) {
        return {
          success: false,
          error: `GraphQL query error: ${err.message}`,
          retryable: false,
          retriesAttempted: attempt,
        };
      }

      // Session errors - not retryable
      if (err instanceof InvalidSession) {
        return {
          success: false,
          error: `Invalid session for ${shop}. Shop may need to reinstall the app.`,
          retryable: false,
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
          error: `Network error: ${message}`,
          retryable: true,
          retriesAttempted: attempt,
        };
      }

      // Unknown errors - not retryable to avoid infinite loops
      return {
        success: false,
        error: message,
        retryable: false,
        retriesAttempted: attempt,
      };
    }
  }

  // Should not reach here, but safety return
  return {
    success: false,
    error: "Max retries exceeded",
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

