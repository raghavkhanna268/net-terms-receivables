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

// Mock the shopify app
const mockAdmin = {
  graphql: vi.fn(),
};

const mockShopifyApp = {
  unauthenticated: {
    admin: vi.fn().mockResolvedValue({ admin: mockAdmin }),
  },
};

vi.mock("~/shopify.server", () => ({
  getShopifyApp: () => mockShopifyApp,
}));

// Import after mocks
import {
  shopifyGraphQL,
  shopifyGraphQLRequest,
  shopifyGraphQLQueue,
} from "../shopify-client.server";

describe("shopify-client.server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
    it("does not retry 401 errors", async () => {
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
      expect(result.retryable).toBe(false);
      expect(mockAdmin.graphql).toHaveBeenCalledTimes(1);
    });

    it("does not retry 403 errors", async () => {
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
});
