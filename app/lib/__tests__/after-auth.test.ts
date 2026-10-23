import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAfterAuth,
  _resetSetupCacheForTesting,
  _isShopSetupComplete,
  _isShopSetupInFlight,
} from "../after-auth.server";

vi.mock("../metafield-definitions.server", () => ({
  ensureMetafieldDefinitions: vi.fn(),
}));

vi.mock("../validation-registration.server", () => ({
  ensureValidation: vi.fn(),
}));

import { ensureMetafieldDefinitions } from "../metafield-definitions.server";
import { ensureValidation } from "../validation-registration.server";

const mockEnsureMetafieldDefinitions =
  ensureMetafieldDefinitions as ReturnType<typeof vi.fn>;
const mockEnsureValidation = ensureValidation as ReturnType<typeof vi.fn>;

/**
 * A fake ctx class whose waitUntil method reads `this`.
 * If the method is passed unbound (e.g., `ctx.waitUntil` instead of
 * `(p) => ctx.waitUntil(p)`), it will throw "Illegal invocation".
 */
class ThisDependentCtx {
  private marker = "ThisDependentCtx";
  public capturedPromises: Promise<unknown>[] = [];

  waitUntil(promise: Promise<unknown>): void {
    if (this.marker !== "ThisDependentCtx") {
      throw new Error("Illegal invocation");
    }
    this.capturedPromises.push(promise);
  }
}

describe("after-auth", () => {
  beforeEach(() => {
    _resetSetupCacheForTesting();
    vi.clearAllMocks();
    mockEnsureMetafieldDefinitions.mockResolvedValue([]);
  });

  afterEach(() => {
    _resetSetupCacheForTesting();
  });

  describe("runAfterAuth", () => {
    it("passes setup promise to waitUntil", async () => {
      const setupPromise = Promise.resolve({
        id: "gid://shopify/Validation/123",
        created: true,
      });
      mockEnsureValidation.mockReturnValue(setupPromise);

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
      expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Promise));

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledWith(mockAdmin);
      });
    });

    it("marks shop complete only after successful setup", async () => {
      let resolveSetup!: () => void;
      const setupPromise = new Promise<void>((resolve) => {
        resolveSetup = resolve;
      });
      mockEnsureValidation.mockReturnValue(setupPromise);

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(false);

      resolveSetup();
      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(true);
      });
    });

    it("skips setup for already-completed shop", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(true);
      });

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
      expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
    });

    it("does not throw on ensureValidation failure", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockEnsureValidation.mockRejectedValue(new Error("API error"));

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      expect(() =>
        runAfterAuth(
          "failing-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).not.toThrow();

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("[afterAuth] Failed to setup for"),
          expect.any(Error),
        );
      });

      expect(_isShopSetupComplete("failing-shop.myshopify.com")).toBe(false);

      consoleSpy.mockRestore();
    });

    it("allows retry after failure (shop not marked complete)", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      mockEnsureValidation
        .mockRejectedValueOnce(new Error("API error"))
        .mockResolvedValueOnce({
          id: "gid://shopify/Validation/123",
          created: true,
        });

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      runAfterAuth(
        "retry-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });

      expect(_isShopSetupComplete("retry-shop.myshopify.com")).toBe(false);

      runAfterAuth(
        "retry-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("retry-shop.myshopify.com")).toBe(true);
      });

      expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      expect(mockWaitUntil).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });

    it("processes different shops independently", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      runAfterAuth(
        "shop-a.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );
      runAfterAuth(
        "shop-b.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      });

      expect(_isShopSetupComplete("shop-a.myshopify.com")).toBe(true);
      expect(_isShopSetupComplete("shop-b.myshopify.com")).toBe(true);
      expect(mockWaitUntil).toHaveBeenCalledTimes(2);
    });

    it("works with bound waitUntil (this-dependent ctx)", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };
      const ctx = new ThisDependentCtx();

      // Pass bound waitUntil - this is how app.tsx should call it
      runAfterAuth(
        "bound-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        (p) => ctx.waitUntil(p),
      );

      expect(ctx.capturedPromises).toHaveLength(1);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("bound-shop.myshopify.com")).toBe(true);
      });
    });

    it("throws when waitUntil is passed unbound (loses this)", () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };
      const ctx = new ThisDependentCtx();

      // Pass unbound waitUntil - this simulates the bug that causes
      // "Illegal invocation" on workerd (here it throws due to lost this)
      const unboundWaitUntil = ctx.waitUntil;

      expect(() =>
        runAfterAuth(
          "unbound-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          unboundWaitUntil,
        ),
      ).toThrow();
    });

    it("concurrent first loads share one ensureValidation call", async () => {
      let resolveSetup!: () => void;
      const setupPromise = new Promise<void>((resolve) => {
        resolveSetup = resolve;
      });
      mockEnsureValidation.mockReturnValue(setupPromise);

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      // Simulate concurrent first loads
      runAfterAuth(
        "concurrent-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );
      runAfterAuth(
        "concurrent-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );
      runAfterAuth(
        "concurrent-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      // But waitUntil should be called for each concurrent request
      expect(mockWaitUntil).toHaveBeenCalledTimes(3);
      // All should receive the same promise
      const firstPromise = mockWaitUntil.mock.calls[0][0];
      expect(mockWaitUntil.mock.calls[1][0]).toBe(firstPromise);
      expect(mockWaitUntil.mock.calls[2][0]).toBe(firstPromise);

      // Shop should be in-flight
      expect(_isShopSetupInFlight("concurrent-shop.myshopify.com")).toBe(true);
      expect(_isShopSetupComplete("concurrent-shop.myshopify.com")).toBe(false);

      // Wait for ensureMetafieldDefinitions to resolve before checking ensureValidation
      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
      });

      // Should only call metafield definitions once too
      expect(mockEnsureMetafieldDefinitions).toHaveBeenCalledTimes(1);

      // Complete setup
      resolveSetup();

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("concurrent-shop.myshopify.com")).toBe(true);
      });

      // In-flight should be cleared
      expect(_isShopSetupInFlight("concurrent-shop.myshopify.com")).toBe(false);
    });

    it("clears in-flight on failure and allows retry", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      let rejectSetup!: (err: Error) => void;
      const failingPromise = new Promise<void>((_, reject) => {
        rejectSetup = reject;
      });
      mockEnsureValidation.mockReturnValueOnce(failingPromise);

      const mockAdmin = { graphql: vi.fn() };
      const mockWaitUntil = vi.fn();

      // First load starts setup
      runAfterAuth(
        "failing-concurrent.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      expect(_isShopSetupInFlight("failing-concurrent.myshopify.com")).toBe(true);

      // Fail the setup
      rejectSetup(new Error("API error"));

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });

      // In-flight should be cleared
      expect(_isShopSetupInFlight("failing-concurrent.myshopify.com")).toBe(false);
      // Shop not marked complete
      expect(_isShopSetupComplete("failing-concurrent.myshopify.com")).toBe(false);

      // Second attempt should trigger new ensureValidation
      mockEnsureValidation.mockResolvedValueOnce({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      runAfterAuth(
        "failing-concurrent.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("failing-concurrent.myshopify.com")).toBe(true);
      });

      expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });
  });
});
