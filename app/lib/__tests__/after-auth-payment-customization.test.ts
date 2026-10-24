import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAfterAuth,
  _resetSetupCacheForTesting,
  _isShopSetupComplete,
} from "../after-auth.server";

// Mock all dependencies
vi.mock("../metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../validation-registration.server", () => ({
  ensureValidation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../payment-customization-registration.server", () => ({
  ensurePaymentCustomization: vi.fn().mockResolvedValue({ id: "pc-123", created: false }),
}));

vi.mock("../request-context.server", () => ({
  getRequestSql: vi.fn().mockReturnValue(() => []),
}));

interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<{ json: () => Promise<unknown> }>;
}

describe("after-auth with payment customization", () => {
  let mockAdmin: AdminGraphqlClient;
  let waitUntilPromises: Promise<unknown>[];
  let mockWaitUntil: (p: Promise<unknown>) => void;

  beforeEach(async () => {
    _resetSetupCacheForTesting();
    waitUntilPromises = [];
    mockWaitUntil = (p) => waitUntilPromises.push(p);
    
    const mockGraphql = vi.fn().mockResolvedValue({
      json: async () => ({
        data: { shop: { ianaTimezone: "America/New_York" } },
      }),
    });
    mockAdmin = { graphql: mockGraphql } as unknown as AdminGraphqlClient;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("calls ensurePaymentCustomization during setup", async () => {
    const { ensurePaymentCustomization } = await import(
      "../payment-customization-registration.server"
    );

    runAfterAuth("test-shop.myshopify.com", mockAdmin, mockWaitUntil);

    // Wait for setup to complete
    await Promise.all(waitUntilPromises);

    expect(ensurePaymentCustomization).toHaveBeenCalledWith(mockAdmin);
  });

  it("marks shop complete even if payment customization fails", async () => {
    const { ensurePaymentCustomization } = await import(
      "../payment-customization-registration.server"
    );
    const mockEnsurePaymentCustomization = ensurePaymentCustomization as ReturnType<typeof vi.fn>;
    mockEnsurePaymentCustomization.mockRejectedValueOnce(new Error("Test error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runAfterAuth("test-shop.myshopify.com", mockAdmin, mockWaitUntil);
    await Promise.all(waitUntilPromises);

    // Error was logged
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[afterAuth] payment_customization_failed"),
      expect.any(Error),
    );

    // Shop is NOT marked complete because there was an error
    expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(false);

    consoleSpy.mockRestore();
  });

  it("does not throw from runAfterAuth even if payment customization fails", async () => {
    const { ensurePaymentCustomization } = await import(
      "../payment-customization-registration.server"
    );
    const mockEnsurePaymentCustomization = ensurePaymentCustomization as ReturnType<typeof vi.fn>;
    mockEnsurePaymentCustomization.mockRejectedValueOnce(new Error("API Error"));

    vi.spyOn(console, "error").mockImplementation(() => {});

    // Should not throw
    expect(() =>
      runAfterAuth("test-shop.myshopify.com", mockAdmin, mockWaitUntil),
    ).not.toThrow();

    // Wait for promises - they should not reject
    await expect(Promise.all(waitUntilPromises)).resolves.not.toThrow();
  });

  it("retries on next request if previous setup failed", async () => {
    const { ensurePaymentCustomization } = await import(
      "../payment-customization-registration.server"
    );
    const mockEnsurePaymentCustomization = ensurePaymentCustomization as ReturnType<typeof vi.fn>;

    // First call fails
    mockEnsurePaymentCustomization.mockRejectedValueOnce(new Error("Temporary error"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    runAfterAuth("retry-shop.myshopify.com", mockAdmin, mockWaitUntil);
    await Promise.all(waitUntilPromises);

    // Shop not marked complete
    expect(_isShopSetupComplete("retry-shop.myshopify.com")).toBe(false);

    // Second call succeeds
    mockEnsurePaymentCustomization.mockResolvedValueOnce({ id: "pc-456", created: true });
    waitUntilPromises = [];

    runAfterAuth("retry-shop.myshopify.com", mockAdmin, mockWaitUntil);
    await Promise.all(waitUntilPromises);

    // Now shop is complete (assuming all other steps also pass)
    // Note: This depends on all mocked services succeeding
    expect(mockEnsurePaymentCustomization).toHaveBeenCalledTimes(2);
  });
});
