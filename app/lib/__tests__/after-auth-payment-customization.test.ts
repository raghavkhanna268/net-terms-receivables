/**
 * S13: Payment customization tests for after-auth setup.
 *
 * Tests verify:
 * 1. ensurePaymentCustomization is called during setup
 * 2. Failure leaves shop NOT marked complete (does not throw)
 * 3. Retry on next auth runs it again
 * 4. Created id logged as id only (no raw objects)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: vi.fn(),
}));

vi.mock("../validation-registration.server", () => ({
  ensureValidation: vi.fn(),
}));

vi.mock("../payment-customization-registration.server", () => ({
  ensurePaymentCustomization: vi.fn(),
}));

const mockSqlQuery = Object.assign(
  vi.fn(),
  { json: (v: unknown) => JSON.stringify(v) }
);
vi.mock("../request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSqlQuery),
}));

import {
  runAfterAuth,
  _resetSetupCacheForTesting,
  _isShopSetupComplete,
} from "../after-auth.server";
import { ensureMetafieldDefinitions } from "../metafield-definitions.server";
import { ensureValidation } from "../validation-registration.server";
import { ensurePaymentCustomization } from "../payment-customization-registration.server";

const mockEnsureMetafieldDefinitions = ensureMetafieldDefinitions as ReturnType<typeof vi.fn>;
const mockEnsureValidation = ensureValidation as ReturnType<typeof vi.fn>;
const mockEnsurePaymentCustomization = ensurePaymentCustomization as ReturnType<typeof vi.fn>;

const createMockAdmin = () => ({
  graphql: vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
  }),
});

describe("after-auth with payment customization (S13)", () => {
  beforeEach(() => {
    _resetSetupCacheForTesting();
    vi.clearAllMocks();
    mockSqlQuery.mockResolvedValue([]);
    mockEnsureMetafieldDefinitions.mockResolvedValue([]);
    mockEnsureValidation.mockResolvedValue({ id: "val-123", created: false });
    mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });
  });

  afterEach(() => {
    _resetSetupCacheForTesting();
  });

  it("calls ensurePaymentCustomization during setup", async () => {
    const mockAdmin = createMockAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

    runAfterAuth("test-shop.myshopify.com", mockAdmin, mockWaitUntil);

    let prevLen = 0;
    while (waitUntilPromises.length > prevLen) {
      prevLen = waitUntilPromises.length;
      await Promise.allSettled(waitUntilPromises);
    }

    expect(mockEnsurePaymentCustomization).toHaveBeenCalledWith(mockAdmin);
  });

  it("logs payment customization created id only (no raw objects)", async () => {
    mockEnsurePaymentCustomization.mockResolvedValue({ 
      id: "gid://shopify/PaymentCustomization/pc-456", 
      created: true 
    });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockAdmin = createMockAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

    runAfterAuth("log-test-shop.myshopify.com", mockAdmin, mockWaitUntil);

    let prevLen = 0;
    while (waitUntilPromises.length > prevLen) {
      prevLen = waitUntilPromises.length;
      await Promise.allSettled(waitUntilPromises);
    }

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[afterAuth] payment_customization_created id=")
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("gid://shopify/PaymentCustomization/pc-456")
    );

    consoleSpy.mockRestore();
  });

  it("failure leaves shop NOT marked complete and does not throw", async () => {
    mockEnsurePaymentCustomization.mockRejectedValue(new Error("Test error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockAdmin = createMockAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

    expect(() =>
      runAfterAuth("s13-failing-shop.myshopify.com", mockAdmin, mockWaitUntil)
    ).not.toThrow();

    let prevLen = 0;
    while (waitUntilPromises.length > prevLen) {
      prevLen = waitUntilPromises.length;
      await Promise.allSettled(waitUntilPromises);
    }

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[afterAuth] payment_customization_failed reason=exception err=")
    );

    expect(_isShopSetupComplete("s13-failing-shop.myshopify.com")).toBe(false);

    consoleSpy.mockRestore();
  });

  it("error log contains err= with code/name only, no raw error object", async () => {
    const testError = new Error("Test error");
    testError.name = "TestError";
    mockEnsurePaymentCustomization.mockRejectedValue(testError);
    
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockAdmin = createMockAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

    runAfterAuth("error-log-shop.myshopify.com", mockAdmin, mockWaitUntil);

    let prevLen = 0;
    while (waitUntilPromises.length > prevLen) {
      prevLen = waitUntilPromises.length;
      await Promise.allSettled(waitUntilPromises);
    }

    const pcFailedCall = consoleSpy.mock.calls.find(
      (call) => call[0]?.includes?.("[afterAuth] payment_customization_failed")
    );
    expect(pcFailedCall).toBeDefined();
    expect(pcFailedCall).toHaveLength(1);
    expect(pcFailedCall![0]).toContain("err=TestError");
    expect(pcFailedCall![0]).not.toContain("[object");

    consoleSpy.mockRestore();
  });

  it("retry on next auth runs ensurePaymentCustomization again", async () => {
    mockEnsurePaymentCustomization.mockRejectedValueOnce(new Error("Temporary error"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const mockAdmin = createMockAdmin();
    const waitUntilPromises: Promise<unknown>[] = [];
    const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

    runAfterAuth("s13-retry-shop.myshopify.com", mockAdmin, mockWaitUntil);

    let prevLen = 0;
    while (waitUntilPromises.length > prevLen) {
      prevLen = waitUntilPromises.length;
      await Promise.allSettled(waitUntilPromises);
    }

    expect(_isShopSetupComplete("s13-retry-shop.myshopify.com")).toBe(false);
    expect(mockEnsurePaymentCustomization).toHaveBeenCalledTimes(1);

    waitUntilPromises.length = 0;
    mockEnsurePaymentCustomization.mockResolvedValueOnce({ id: "pc-789", created: true });

    runAfterAuth("s13-retry-shop.myshopify.com", mockAdmin, mockWaitUntil);

    prevLen = 0;
    while (waitUntilPromises.length > prevLen) {
      prevLen = waitUntilPromises.length;
      await Promise.allSettled(waitUntilPromises);
    }

    expect(mockEnsurePaymentCustomization).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });
});
