import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAfterAuth,
  evictShopFromSetupCache,
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

vi.mock("../payment-customization-registration.server", () => ({
  ensurePaymentCustomization: vi.fn(),
}));

const mockSqlQuery = Object.assign(
  vi.fn().mockResolvedValue([]),
  { json: (v: unknown) => JSON.stringify(v) }
);
vi.mock("../request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSqlQuery),
}));

import { ensureMetafieldDefinitions } from "../metafield-definitions.server";
import { ensureValidation } from "../validation-registration.server";
import { ensurePaymentCustomization } from "../payment-customization-registration.server";
import { getRequestSql } from "../request-context.server";

const mockEnsureMetafieldDefinitions =
  ensureMetafieldDefinitions as ReturnType<typeof vi.fn>;
const mockEnsureValidation = ensureValidation as ReturnType<typeof vi.fn>;
const mockEnsurePaymentCustomization =
  ensurePaymentCustomization as ReturnType<typeof vi.fn>;
const mockGetRequestSql = getRequestSql as ReturnType<typeof vi.fn>;

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

const createMockAdmin = () => ({
  graphql: vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
  }),
});

describe("after-auth", () => {
  beforeEach(() => {
    _resetSetupCacheForTesting();
    vi.clearAllMocks();
    mockSqlQuery.mockResolvedValue([]);
    mockEnsureMetafieldDefinitions.mockResolvedValue([]);
    mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });
    mockGetRequestSql.mockReturnValue(mockSqlQuery);
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

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      expect(mockWaitUntil).toHaveBeenCalled();
      expect(mockWaitUntil).toHaveBeenCalledWith(expect.any(Promise));

      await Promise.allSettled(waitUntilPromises);

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

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(false);

      resolveSetup();
      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(true);
      });
    });

    it("skips setup for already-completed shop when clear returns no row", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });
      mockSqlQuery.mockResolvedValue([]);

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-shop.myshopify.com")).toBe(true);
      });

      waitUntilPromises.length = 0;

      runAfterAuth(
        "test-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
    });

    it("re-runs setup when clear returns a row (cross-isolate reinstall)", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });
      mockSqlQuery.mockResolvedValue([]);

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-reinstall-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-reinstall-shop.myshopify.com")).toBe(true);
      });

      expect(mockEnsureMetafieldDefinitions).toHaveBeenCalledTimes(1);
      expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
      expect(mockEnsurePaymentCustomization).toHaveBeenCalledTimes(1);

      waitUntilPromises.length = 0;
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-123" }]);

      runAfterAuth(
        "test-reinstall-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(mockEnsureMetafieldDefinitions).toHaveBeenCalledTimes(2);
        expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
        expect(mockEnsurePaymentCustomization).toHaveBeenCalledTimes(2);
        expect(_isShopSetupComplete("test-reinstall-shop.myshopify.com")).toBe(true);
      });
    });

    it("does not throw on ensureValidation failure", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      mockEnsureValidation.mockRejectedValue(new Error("API error"));

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      expect(() =>
        runAfterAuth(
          "test-failing-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).not.toThrow();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("[afterAuth] validation_registration_failed"),
        );
      });

      expect(_isShopSetupComplete("test-failing-shop.myshopify.com")).toBe(false);

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

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-retry-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
        expect(_isShopSetupComplete("test-retry-shop.myshopify.com")).toBe(false);
        expect(_isShopSetupInFlight("test-retry-shop.myshopify.com")).toBe(false);
      });

      waitUntilPromises.length = 0;

      runAfterAuth(
        "test-retry-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-retry-shop.myshopify.com")).toBe(true);
        expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      });

      consoleSpy.mockRestore();
    });

    it("processes different shops independently", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

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

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
        expect(_isShopSetupComplete("shop-a.myshopify.com")).toBe(true);
        expect(_isShopSetupComplete("shop-b.myshopify.com")).toBe(true);
      });
    });

    it("works with bound waitUntil (this-dependent ctx)", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const ctx = new ThisDependentCtx();

      runAfterAuth(
        "test-bound-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        (p) => ctx.waitUntil(p),
      );

      expect(ctx.capturedPromises.length).toBeGreaterThan(0);

      await Promise.all(ctx.capturedPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-bound-shop.myshopify.com")).toBe(true);
      });
    });

    it("throws when waitUntil is passed unbound (loses this)", () => {
      mockGetRequestSql.mockImplementationOnce(() => {
        throw new Error("No request context");
      });

      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const ctx = new ThisDependentCtx();

      const unboundWaitUntil = ctx.waitUntil;

      expect(() =>
        runAfterAuth(
          "test-unbound-shop.myshopify.com",
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

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-concurrent-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(_isShopSetupInFlight("test-concurrent-shop.myshopify.com")).toBe(true);
      });

      runAfterAuth(
        "test-concurrent-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );
      runAfterAuth(
        "test-concurrent-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(_isShopSetupComplete("test-concurrent-shop.myshopify.com")).toBe(false);

      await vi.waitFor(() => {
        expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
      });

      expect(mockEnsureMetafieldDefinitions).toHaveBeenCalledTimes(1);

      resolveSetup();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-concurrent-shop.myshopify.com")).toBe(true);
        expect(_isShopSetupInFlight("test-concurrent-shop.myshopify.com")).toBe(false);
      });
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

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-failing-concurrent.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await vi.waitFor(() => {
        expect(_isShopSetupInFlight("test-failing-concurrent.myshopify.com")).toBe(true);
      });

      rejectSetup(new Error("API error"));

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalled();
      });

      expect(_isShopSetupInFlight("test-failing-concurrent.myshopify.com")).toBe(false);
      expect(_isShopSetupComplete("test-failing-concurrent.myshopify.com")).toBe(false);

      waitUntilPromises.length = 0;
      mockEnsureValidation.mockResolvedValueOnce({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      runAfterAuth(
        "test-failing-concurrent.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-failing-concurrent.myshopify.com")).toBe(true);
      });

      expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
      consoleSpy.mockRestore();
    });

    it("uninstall then afterAuth on same isolate runs upsert again", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-reinstall.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-reinstall.myshopify.com")).toBe(true);
      });

      expect(mockEnsureValidation).toHaveBeenCalledTimes(1);

      evictShopFromSetupCache("test-reinstall.myshopify.com");
      expect(_isShopSetupComplete("test-reinstall.myshopify.com")).toBe(false);

      waitUntilPromises.length = 0;

      runAfterAuth(
        "test-reinstall.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-reinstall.myshopify.com")).toBe(true);
      });

      expect(mockEnsureValidation).toHaveBeenCalledTimes(2);
    });

    it("clearUninstalledAt SQL is correct on cached shop (cross-isolate reinstall)", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-cached-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-cached-shop.myshopify.com")).toBe(true);
      });

      mockSqlQuery.mockClear();
      waitUntilPromises.length = 0;

      runAfterAuth(
        "test-cached-shop.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      expect(mockSqlQuery).toHaveBeenCalled();

      const sqlCall = mockSqlQuery.mock.calls[0];
      const sqlTemplate = sqlCall[0];
      const sqlValues = sqlCall.slice(1);

      const templateStr = Array.isArray(sqlTemplate) ? sqlTemplate.join("") : String(sqlTemplate);
      expect(templateStr).toContain('"uninstalledAt" = NULL');
      expect(templateStr).toContain('"uninstalledAt" IS NOT NULL');
      expect(sqlValues).toContain("test-cached-shop.myshopify.com");

      expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
    });

    it("clearUninstalledAt failure does not break /app load", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      
      mockSqlQuery.mockRejectedValueOnce(new Error("DB error"));
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      expect(() =>
        runAfterAuth(
          "test-clear-failed-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).not.toThrow();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-clear-failed-shop.myshopify.com")).toBe(true);
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[afterAuth] clear_uninstalled_at_failed"),
      );

      consoleSpy.mockRestore();
    });

    it("continues without clear when getRequestSql throws", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      mockGetRequestSql.mockImplementationOnce(() => {
        throw new Error("getRequestSql() called outside of request context");
      });

      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      expect(() =>
        runAfterAuth(
          "test-no-context-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).not.toThrow();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-no-context-shop.myshopify.com")).toBe(true);
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("[afterAuth] clear_uninstalled_at_failed reason=no_request_context"),
      );

      consoleSpy.mockRestore();
    });
  });

});
