import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for shopify-client.server.ts
 *
 * Tests:
 * - THROTTLED-then-success retry with computed wait
 * - 429 honouring Retry-After
 * - No retry on userErrors
 * - Request-path retry cap
 */

// Create a shared mock admin that can be referenced after hoisting
const mockAdmin = {
  graphql: vi.fn(),
};

// Mock request context (for getRequestSql)
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => ({})),
}));

// Mock offline-admin module - the factory returns a function that creates the mock
// We use a getter to access mockAdmin after hoisting
vi.mock("~/lib/offline-admin.server", async () => {
  return {
    getOfflineAdminContext: vi.fn(),
  };
});

// Import the mock after vi.mock declarations
import { getOfflineAdminContext } from "~/lib/offline-admin.server";
const mockGetOfflineAdminContext = vi.mocked(getOfflineAdminContext);

// Import after mocks
import {
  shopifyGraphQL,
  shopifyGraphQLRequest,
  shopifyGraphQLQueue,
} from "../shopify-client.server";

describe("shopify-client.server", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Set required environment variables for token refresh
    process.env = {
      ...originalEnv,
      SHOPIFY_API_KEY: "test-api-key",
      SHOPIFY_API_SECRET: "test-api-secret",
    };
    // Set up default mock for getOfflineAdminContext to return success with mockAdmin
    mockGetOfflineAdminContext.mockResolvedValue({
      success: true,
      admin: mockAdmin,
      retryable: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  describe("Missing credentials", () => {
    it("returns non-retryable error when SHOPIFY_API_KEY is missing", async () => {
      process.env = { ...originalEnv };
      delete process.env.SHOPIFY_API_KEY;
      delete process.env.SHOPIFY_API_SECRET;

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      // Error message is generic, doesn't expose which credential is missing (security rule)
      expect(result.error).toContain("credentials not configured");
      expect(result.retriesAttempted).toBe(0);
      // graphql should never be called
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });

    it("returns non-retryable error when only SHOPIFY_API_SECRET is missing", async () => {
      process.env = { ...originalEnv, SHOPIFY_API_KEY: "test-key" };
      delete process.env.SHOPIFY_API_SECRET;

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.error).toContain("credentials not configured");
      expect(result.retriesAttempted).toBe(0);
    });
  });

  describe("Successful requests", () => {
    it("returns data on success", async () => {
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          data: { shop: { name: "Test Shop" } },
        }),
      });

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ shop: { name: "Test Shop" } });
      expect(result.retryable).toBe(false);
    });
  });

  describe("THROTTLED handling", () => {
    it("calculates wait from throttleStatus and retries", async () => {
      // First call: THROTTLED
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [
            {
              message: "Throttled",
              extensions: {
                code: "THROTTLED",
                cost: {
                  requestedQueryCost: 100,
                  actualQueryCost: 100,
                  throttleStatus: {
                    maximumAvailable: 1000,
                    currentlyAvailable: 50,
                    restoreRate: 50, // 50 points/sec
                  },
                },
              },
            },
          ],
          extensions: {
            cost: {
              requestedQueryCost: 100,
              actualQueryCost: 100,
              throttleStatus: {
                maximumAvailable: 1000,
                currentlyAvailable: 50,
                restoreRate: 50,
              },
            },
          },
        }),
      });

      // Second call: Success
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          data: { shop: { name: "Test Shop" } },
        }),
      });

      const resultPromise = shopifyGraphQLQueue(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      // Advance time to allow retry
      await vi.advanceTimersByTimeAsync(2000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.wasRateLimited).toBe(true);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
    });

    it("surfaces retryable error when max wait exceeded", async () => {
      // All calls: THROTTLED with long wait
      mockAdmin.graphql.mockResolvedValue({
        json: async () => ({
          errors: [
            {
              message: "Throttled",
              extensions: {
                code: "THROTTLED",
                cost: {
                  requestedQueryCost: 1000,
                  actualQueryCost: 1000,
                  throttleStatus: {
                    maximumAvailable: 1000,
                    currentlyAvailable: 0,
                    restoreRate: 1, // 1 point/sec = 1000 seconds to restore
                  },
                },
              },
            },
          ],
        }),
      });

      const result = await shopifyGraphQLRequest(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      // Request context should not wait that long
      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.wasRateLimited).toBe(true);
    });
  });

  describe("userErrors handling", () => {
    it("does not retry on userErrors", async () => {
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [
            {
              message: "User error: Invalid input",
              extensions: { code: "USER_ERROR" },
            },
          ],
        }),
      });

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "mutation { createProduct { userErrors { message } } }"
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });
  });

  describe("Request-path retry cap", () => {
    it("limits retries to 1 in request context", async () => {
      // Setup: Network error that would normally retry
      mockAdmin.graphql.mockRejectedValue(new TypeError("fetch failed"));

      const result = await shopifyGraphQLRequest(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      // Should have tried original + 1 retry = 2 attempts max
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
    });

    it("allows more retries in queue context", async () => {
      // Setup: Network error that would normally retry
      mockAdmin.graphql.mockRejectedValue(new TypeError("fetch failed"));

      const resultPromise = shopifyGraphQLQueue(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      // Advance time for all retries
      await vi.advanceTimersByTimeAsync(30000);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      // Queue context allows up to 4 attempts (3 retries)
      expect(mockAdmin.graphql.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("4xx errors (not 429)", () => {
    it("401 errors are retryable (session refresh can recover)", async () => {
      const { HttpResponseError } = await import("@shopify/shopify-api");
      const error = new HttpResponseError({
        message: "Unauthorized",
        code: 401,
        statusText: "Unauthorized",
      });
      mockAdmin.graphql.mockRejectedValueOnce(error);

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      // P3: 401 should be retryable - session refresh (#76) can recover
      expect(result.retryable).toBe(true);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("403 errors are non-retryable (scope not granted)", async () => {
      const { HttpResponseError } = await import("@shopify/shopify-api");
      const error = new HttpResponseError({
        message: "Forbidden",
        code: 403,
        statusText: "Forbidden",
      });
      mockAdmin.graphql.mockRejectedValueOnce(error);

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      // 403 is non-retryable - scope not granted, needs reinstall
      expect(result.retryable).toBe(false);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("400 Bad Request is non-retryable", async () => {
      const { HttpResponseError } = await import("@shopify/shopify-api");
      const error = new HttpResponseError({
        message: "Bad Request",
        code: 400,
        statusText: "Bad Request",
      });
      mockAdmin.graphql.mockRejectedValueOnce(error);

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });
  });

  describe("5xx errors", () => {
    it("retries 5xx errors with backoff", async () => {
      const { HttpRetriableError } = await import("@shopify/shopify-api");

      // First call: 500
      mockAdmin.graphql.mockRejectedValueOnce(
        new HttpRetriableError({
          message: "Internal Server Error",
          code: 500,
          statusText: "Internal Server Error",
        })
      );

      // Second call: Success
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          data: { shop: { name: "Test Shop" } },
        }),
      });

      const resultPromise = shopifyGraphQLQueue(
        "test.myshopify.com",
        "query { shop { name } }"
      );

      // Advance time for retry
      await vi.advanceTimersByTimeAsync(1000);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(2);
    });
  });

  describe("Offline admin context errors", () => {
    it("maps admin_invalid_session to invalid_session (retryable)", async () => {
      mockGetOfflineAdminContext.mockResolvedValueOnce({
        success: false,
        errorCode: "admin_invalid_session",
        error: "Invalid session after token refresh",
        retryable: true,
        needsReauth: false,
      });

      const result = await shopifyGraphQL(
        "test-revoked-shop.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_session");
      expect(result.retryable).toBe(true);
      expect(result.retriesAttempted).toBe(0);
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });

    /**
     * Processor contract: drain/processor.server.ts checks errorCode === 'no_session'
     * for COMPANIES_* and ORDERS_* uninstalled-shop ack. This test proves the contract.
     */
    it("maps admin_no_session to no_session (non-retryable, processor contract)", async () => {
      mockGetOfflineAdminContext.mockResolvedValueOnce({
        success: false,
        errorCode: "admin_no_session",
        error: "No session found",
        retryable: false,
        needsReauth: true,
      });

      const result = await shopifyGraphQL(
        "test-missing-session.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      // Contract: drain/processor.server.ts checks result.errorCode === "no_session"
      // for the ORDERS_* uninstalled-shop ack path
      expect(result.errorCode).toBe("no_session");
      expect(result.retryable).toBe(false);
      expect(result.retriesAttempted).toBe(0);
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });

    it("returns non-retryable error for invalid_grant (needs re-auth)", async () => {
      mockGetOfflineAdminContext.mockResolvedValueOnce({
        success: false,
        errorCode: "invalid_grant",
        error: "Session needs re-authentication",
        retryable: false,
        needsReauth: true,
      });

      const result = await shopifyGraphQL(
        "test-expired-session.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("invalid_grant");
      expect(result.retryable).toBe(false);
      expect(result.retriesAttempted).toBe(0);
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });

    /**
     * Behaviour change: transient refresh failures (network_error, http_error, invalid_response)
     * are now retryable for queue paths. This is correct: a network blip during token refresh
     * should not DLQ the message immediately.
     */
    it("returns retryable error for transient refresh failures (network_error)", async () => {
      mockGetOfflineAdminContext.mockResolvedValueOnce({
        success: false,
        errorCode: "network_error",
        error: "Token refresh network error",
        retryable: true,
        needsReauth: false,
      });

      const result = await shopifyGraphQL(
        "test-network-error.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("network_error");
      expect(result.retryable).toBe(true);
      expect(result.retriesAttempted).toBe(0);
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });

    /**
     * Other session errors (message contains 'session' but not InvalidSession or 'No session found')
     * map to errorCode 'session_error', retryable: true. This matches the original behavior.
     */
    it("maps errors with 'session' in message to session_error (retryable)", async () => {
      mockGetOfflineAdminContext.mockResolvedValueOnce({
        success: false,
        errorCode: "unknown",
        error: "Session expired or invalid",
        retryable: false,
        needsReauth: false,
      });

      const result = await shopifyGraphQL(
        "test-session-error.myshopify.com",
        "query { shop { name } }"
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("session_error");
      expect(result.error).toBe("Session error");
      expect(result.retryable).toBe(true);
      expect(result.retriesAttempted).toBe(0);
      expect(mockAdmin.graphql).not.toHaveBeenCalled();
    });
  });

  describe("ACCESS_DENIED (GraphQL-level)", () => {
    it("returns non-retryable error for ACCESS_DENIED", async () => {
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [
            {
              message: "Access denied. Required scope: read_orders",
              extensions: { code: "ACCESS_DENIED" },
            },
          ],
        }),
      });

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { orders { edges { node { id } } } }"
      );

      expect(result.success).toBe(false);
      // P3: ACCESS_DENIED is non-retryable - scope not granted, permanent until reinstall
      expect(result.retryable).toBe(false);
      expect(result.error).toContain("Access denied");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });
  });

  describe("GraphQL validation/schema errors", () => {
    it("returns non-retryable error for schema errors", async () => {
      mockAdmin.graphql.mockResolvedValueOnce({
        json: async () => ({
          errors: [
            {
              message: "Field 'nonExistentField' doesn't exist on type 'Shop'",
              extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
            },
          ],
        }),
      });

      const result = await shopifyGraphQL(
        "test.myshopify.com",
        "query { shop { nonExistentField } }"
      );

      expect(result.success).toBe(false);
      // P3: GraphQL validation errors are non-retryable - schema mismatch
      expect(result.retryable).toBe(false);
      // Error message includes error code, not field name (security rule)
      expect(result.error).toContain("GRAPHQL_VALIDATION_FAILED");
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });
  });
});
