import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAfterAuth,
  _resetSetupCacheForTesting,
  _isShopSetupStarted,
} from "../after-auth.server";

vi.mock("../validation-registration.server", () => ({
  ensureValidation: vi.fn(),
}));

import { ensureValidation } from "../validation-registration.server";

const mockEnsureValidation = ensureValidation as ReturnType<typeof vi.fn>;

describe("after-auth", () => {
  beforeEach(() => {
    _resetSetupCacheForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetSetupCacheForTesting();
  });

  describe("runAfterAuth", () => {
    it("calls ensureValidation for new shop (fire-and-forget)", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };
      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );

      expect(_isShopSetupStarted("test-shop.myshopify.com")).toBe(true);

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledWith(mockAdmin);
      });
    });

    it("skips setup for already-started shop", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );
      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
      });
    });

    it("does not throw on ensureValidation failure", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockEnsureValidation.mockRejectedValue(new Error("API error"));

      const mockAdmin = { graphql: vi.fn() };

      expect(() =>
        runAfterAuth(
          "failing-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
        ),
      ).not.toThrow();

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("[afterAuth] Failed to setup validation"),
          expect.any(Error),
        );
      });

      expect(_isShopSetupStarted("failing-shop.myshopify.com")).toBe(false);

      consoleSpy.mockRestore();
    });

    it("retries setup for shop after failure", async () => {
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

      runAfterAuth(
        "retry-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );

      await vi.waitFor(() => {
        expect(_isShopSetupStarted("retry-shop.myshopify.com")).toBe(false);
      });

      runAfterAuth(
        "retry-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );

      await vi.waitFor(() => {
        expect(_isShopSetupStarted("retry-shop.myshopify.com")).toBe(true);
      });

      expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });

    it("processes different shops independently", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = { graphql: vi.fn() };

      runAfterAuth(
        "shop-a.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );
      runAfterAuth(
        "shop-b.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
      );

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      });

      expect(_isShopSetupStarted("shop-a.myshopify.com")).toBe(true);
      expect(_isShopSetupStarted("shop-b.myshopify.com")).toBe(true);
    });
  });
});
