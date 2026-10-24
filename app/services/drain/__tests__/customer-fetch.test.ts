import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for customer PII ACCESS_DENIED fallback.
 *
 * Tests verify:
 * (a) ACCESS_DENIED on PII → second call uses id+tags-only, customer processed, warning logged, counter incremented
 * (b) Success first time → single call, counter untouched
 * (c) ACCESS_DENIED on fallback too → existing DLQ path (error returned)
 * (d) Non-ACCESS_DENIED error → no fallback
 * (e) PII field list still exactly [email, displayName]
 */

// Mock admin-client
const mockAdminGraphQL = vi.fn();
vi.mock("../admin-client.server", () => ({
  adminGraphQL: (...args: unknown[]) => mockAdminGraphQL(...args),
}));

// Mock request context - must include getRequestSql for shopify.server.ts
vi.mock("~/lib/request-context.server", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    getRequestEnv: vi.fn(() => ({ CUSTOMER_PII_FIELDS: "1" })),
    getRequestSql: vi.fn(() => null),
  };
});

// Import after mocks
import {
  fetchCustomerWithFallback,
  incrementCustomerPiiAccessDeniedFallback,
  getCustomerPiiAccessDeniedFallbackCount,
} from "../customer-fetch.server";
import { CUSTOMER_OPTIONAL_PII_FIELDS } from "~/services/sync/customer-fields.server";

describe("Customer PII ACCESS_DENIED fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("(a) ACCESS_DENIED on PII → fallback succeeds", () => {
    it("retries with base-only query and returns customer without PII", async () => {
      // First call: ACCESS_DENIED
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Access denied. Required access: read_customers with Level 1 + Email.",
        retryable: false,
      });

      // Second call (fallback): success with base fields
      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: "gid://shopify/Customer/123",
            tags: ["net-terms", "gold"],
          },
        },
        retryable: false,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/123"
      );

      // Should succeed
      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.id).toBe("gid://shopify/Customer/123");
      expect(result.data?.tags).toEqual(["net-terms", "gold"]);
      // PII should be null
      expect(result.data?.email).toBeNull();
      expect(result.data?.displayName).toBeNull();

      // Should have made 2 calls
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(2);

      // First call should be PII query (contains email)
      const firstQuery = mockAdminGraphQL.mock.calls[0][1] as string;
      expect(firstQuery).toContain("email");
      expect(firstQuery).toContain("displayName");

      // Second call should be base-only query (no email)
      const secondQuery = mockAdminGraphQL.mock.calls[1][1] as string;
      expect(secondQuery).not.toContain("email");
      expect(secondQuery).not.toContain("displayName");
      expect(secondQuery).toContain("id");
      expect(secondQuery).toContain("tags");
    });

    it("handles ACCESS_DENIED with code extension", async () => {
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "ACCESS_DENIED: Required scope read_customers Level 1 + Name + Email",
        retryable: false,
      });

      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: { node: { id: "gid://shopify/Customer/456", tags: [] } },
        retryable: false,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/456"
      );

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(2);
    });
  });

  describe("(b) Success first time → single call", () => {
    it("returns customer without fallback when PII fetch succeeds", async () => {
      mockAdminGraphQL.mockResolvedValueOnce({
        success: true,
        data: {
          node: {
            id: "gid://shopify/Customer/789",
            tags: ["premium"],
            email: "customer@example.com",
            displayName: "John Doe",
          },
        },
        retryable: false,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/789"
      );

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(false);
      expect(result.data?.email).toBe("customer@example.com");
      expect(result.data?.displayName).toBe("John Doe");

      // Should have made only 1 call
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(1);
    });
  });

  describe("(c) ACCESS_DENIED on fallback too → error returned", () => {
    it("returns error when both PII and base queries fail with ACCESS_DENIED", async () => {
      // First call: ACCESS_DENIED
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Access denied",
        retryable: false,
      });

      // Second call (fallback): also fails
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Access denied - no customer read scope",
        retryable: false,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/999"
      );

      expect(result.success).toBe(false);
      expect(result.usedFallback).toBe(true);
      expect(result.error).toContain("Access denied");
      expect(result.retryable).toBe(false);

      // Should have made 2 calls (tried fallback)
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(2);
    });

    it("returns retryable error when fallback fails with network error", async () => {
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "ACCESS_DENIED: email field",
        retryable: false,
      });

      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Network error: connection refused",
        retryable: true,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/999"
      );

      expect(result.success).toBe(false);
      expect(result.usedFallback).toBe(true);
      expect(result.retryable).toBe(true);
    });
  });

  describe("(d) Non-ACCESS_DENIED error → no fallback", () => {
    it("returns error immediately for non-ACCESS_DENIED errors", async () => {
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "THROTTLED: rate limited",
        retryable: true,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/123"
      );

      expect(result.success).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(result.error).toContain("THROTTLED");
      expect(result.retryable).toBe(true);

      // Should have made only 1 call (no fallback attempted)
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(1);
    });

    it("does not fallback for 500 errors", async () => {
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Internal server error",
        retryable: true,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/123"
      );

      expect(result.success).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(1);
    });

    it("does not fallback for 404/not found errors", async () => {
      mockAdminGraphQL.mockResolvedValueOnce({
        success: false,
        error: "Customer not found",
        retryable: false,
      });

      const result = await fetchCustomerWithFallback(
        "test.myshopify.com",
        "gid://shopify/Customer/123"
      );

      expect(result.success).toBe(false);
      expect(result.usedFallback).toBe(false);
      expect(mockAdminGraphQL).toHaveBeenCalledTimes(1);
    });
  });

  describe("(e) PII field list", () => {
    it("PII fields are exactly [email, displayName]", () => {
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).toEqual(["email", "displayName"]);
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).toHaveLength(2);
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).toContain("email");
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).toContain("displayName");
      // No phone or address
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).not.toContain("phone");
      expect(CUSTOMER_OPTIONAL_PII_FIELDS).not.toContain("addresses");
    });
  });

  describe("Counter functions", () => {
    it("incrementCustomerPiiAccessDeniedFallback calls SQL correctly", async () => {
      const mockSql = vi.fn().mockResolvedValue([]);

      await incrementCustomerPiiAccessDeniedFallback(
        mockSql as never,
        "test.myshopify.com"
      );

      expect(mockSql).toHaveBeenCalledTimes(1);
      const query = mockSql.mock.calls[0][0].raw.join("");
      expect(query).toContain("s10b_customer_pii_fallback");
      expect(query).toContain("INSERT");
      expect(query).toContain("ON CONFLICT");
    });

    it("getCustomerPiiAccessDeniedFallbackCount returns count", async () => {
      const mockSql = vi.fn().mockResolvedValue([{ total: "42" }]);

      const count = await getCustomerPiiAccessDeniedFallbackCount(
        mockSql as never,
        "test.myshopify.com"
      );

      expect(count).toBe(42);
    });

    it("getCustomerPiiAccessDeniedFallbackCount with since filter", async () => {
      const mockSql = vi.fn().mockResolvedValue([{ total: "10" }]);
      const since = new Date("2026-10-01");

      const count = await getCustomerPiiAccessDeniedFallbackCount(
        mockSql as never,
        "test.myshopify.com",
        since
      );

      expect(count).toBe(10);
      const query = mockSql.mock.calls[0][0].raw.join("");
      expect(query).toContain("day >=");
    });
  });
});

describe("Real handleCustomer tests with fallback", () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let mockProcessCustomerWebhook: ReturnType<typeof vi.fn>;
  let mockIsWebhookProcessed: ReturnType<typeof vi.fn>;
  let mockMarkWebhookProcessed: ReturnType<typeof vi.fn>;
  let mockIncrementCounter: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Re-mock dependencies for handleCustomer
    vi.doMock("../admin-client.server", () => ({
      adminGraphQL: mockAdminGraphQL,
    }));

    vi.doMock("~/lib/request-context.server", () => ({
      getRequestEnv: vi.fn(() => ({ CUSTOMER_PII_FIELDS: "1" })),
      getRequestSql: vi.fn(() => ({})),
    }));

    mockProcessCustomerWebhook = vi.fn().mockResolvedValue({
      success: true,
      action: "created",
      entityId: "contact-123",
    });

    mockIsWebhookProcessed = vi.fn().mockResolvedValue(false);
    mockMarkWebhookProcessed = vi.fn().mockResolvedValue(undefined);

    vi.doMock("~/services/sync/customer.server", () => ({
      processCustomerWebhook: mockProcessCustomerWebhook,
      CustomerPiiMode: {} as never,
    }));

    vi.doMock("~/services/sync/company.server", () => ({
      isWebhookProcessed: mockIsWebhookProcessed,
      markWebhookProcessed: mockMarkWebhookProcessed,
    }));

    mockIncrementCounter = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../customer-fetch.server", async () => {
      const actual = await vi.importActual<typeof import("../customer-fetch.server")>("../customer-fetch.server");
      return {
        ...actual,
        incrementCustomerPiiAccessDeniedFallback: mockIncrementCounter,
      };
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.resetModules();
  });

  it("fallback succeeds: logs warning, increments counter, passes 'fallback' piiMode", async () => {
    // First call: ACCESS_DENIED
    mockAdminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "Access denied: Required scope read_customers Level 1 + Email",
      retryable: false,
    });
    // Fallback call: success
    mockAdminGraphQL.mockResolvedValueOnce({
      success: true,
      data: { node: { id: "gid://shopify/Customer/123", tags: ["net-terms"] } },
      retryable: false,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("CUSTOMERS_UPDATE");

    const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
      json: vi.fn((v: unknown) => v),
    });

    const message = {
      topic: "CUSTOMERS_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-fallback-1",
      resourceGid: "gid://shopify/Customer/123",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(true);

    // Verify warning was logged
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[customer_pii_access_denied_fallback]")
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("shop=test.myshopify.com")
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("fields=email,displayName")
    );

    // Verify counter was incremented
    expect(mockIncrementCounter).toHaveBeenCalledWith(mockSql, "test.myshopify.com");

    // Verify processCustomerWebhook was called with 'fallback' mode
    expect(mockProcessCustomerWebhook).toHaveBeenCalledWith(
      mockSql,
      "test.myshopify.com",
      "CUSTOMERS_UPDATE",
      expect.objectContaining({ id: "gid://shopify/Customer/123" }),
      "wh-fallback-1",
      "fallback"
    );
  });

  it("both calls denied: returns failure, no counter increment", async () => {
    // First call: ACCESS_DENIED
    mockAdminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "Access denied",
      retryable: false,
    });
    // Fallback call: also ACCESS_DENIED
    mockAdminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "Access denied - scope not granted",
      retryable: false,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("CUSTOMERS_CREATE");

    const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
      json: vi.fn((v: unknown) => v),
    });

    const message = {
      topic: "CUSTOMERS_CREATE",
      shop: "test.myshopify.com",
      webhookId: "wh-both-denied-1",
      resourceGid: "gid://shopify/Customer/456",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Access denied");

    // Counter should NOT be called (processing failed)
    expect(mockIncrementCounter).not.toHaveBeenCalled();
    // processCustomerWebhook should NOT be called (fetch failed)
    expect(mockProcessCustomerWebhook).not.toHaveBeenCalled();
  });

  it("first call succeeds: no warning, no counter, 'fetched' piiMode", async () => {
    // First call: success with PII
    mockAdminGraphQL.mockResolvedValueOnce({
      success: true,
      data: {
        node: {
          id: "gid://shopify/Customer/789",
          tags: ["premium"],
          email: "customer@example.com",
          displayName: "John Doe",
        },
      },
      retryable: false,
    });

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("CUSTOMERS_UPDATE");

    const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
      json: vi.fn((v: unknown) => v),
    });

    const message = {
      topic: "CUSTOMERS_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-success-1",
      resourceGid: "gid://shopify/Customer/789",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    expect(result.success).toBe(true);

    // No warning should be logged
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("[customer_pii_access_denied_fallback]")
    );

    // Counter should NOT be called
    expect(mockIncrementCounter).not.toHaveBeenCalled();

    // processCustomerWebhook should be called with 'fetched' mode
    expect(mockProcessCustomerWebhook).toHaveBeenCalledWith(
      mockSql,
      "test.myshopify.com",
      "CUSTOMERS_UPDATE",
      expect.objectContaining({
        id: "gid://shopify/Customer/789",
        email: "customer@example.com",
      }),
      "wh-success-1",
      "fetched"
    );
  });

  it("counter insert throws: message still succeeds (best-effort)", async () => {
    // First call: ACCESS_DENIED
    mockAdminGraphQL.mockResolvedValueOnce({
      success: false,
      error: "Access denied",
      retryable: false,
    });
    // Fallback call: success
    mockAdminGraphQL.mockResolvedValueOnce({
      success: true,
      data: { node: { id: "gid://shopify/Customer/999", tags: [] } },
      retryable: false,
    });

    // Counter throws (e.g., table doesn't exist, migration not applied)
    mockIncrementCounter.mockRejectedValueOnce(new Error("relation s10b_customer_pii_fallback does not exist"));

    const { getSyncHandler } = await import("../processor.server");
    const handler = getSyncHandler("CUSTOMERS_UPDATE");

    const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
      json: vi.fn((v: unknown) => v),
    });

    const message = {
      topic: "CUSTOMERS_UPDATE",
      shop: "test.myshopify.com",
      webhookId: "wh-counter-fail-1",
      resourceGid: "gid://shopify/Customer/999",
      enqueuedAt: new Date().toISOString(),
    };

    const result = await handler!(mockSql as never, message);

    // Message should still succeed despite counter failure
    expect(result.success).toBe(true);

    // Warning should include counter failure
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining("counter increment failed")
    );

    // processCustomerWebhook should still have been called
    expect(mockProcessCustomerWebhook).toHaveBeenCalled();
  });
});
