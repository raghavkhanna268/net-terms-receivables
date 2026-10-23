import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAfterAuth,
  _resetSetupCacheForTesting,
  _isShopSetupComplete,
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
          expect.stringContaining("[afterAuth] Failed to setup validation"),
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
  });
});
