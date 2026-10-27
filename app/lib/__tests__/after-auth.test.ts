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
    vi.unstubAllEnvs();
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

      // runAfterAuth is now async, must await it
      await runAfterAuth(
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
      const setupPromise = new Promise<{ id: string; created: boolean }>((resolve) => {
        resolveSetup = () => resolve({ id: "gid://shopify/Validation/123", created: false });
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

      // runAfterAuth is now async; it should not reject even when validation fails
      await expect(
        runAfterAuth(
          "test-failing-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).resolves.not.toThrow();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('"event":"validation_registration_failed"'),
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

      // runAfterAuth is now async, must await it
      await runAfterAuth(
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

    it("throws when waitUntil is passed unbound (loses this)", async () => {
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

      // runAfterAuth is now async, so we need to await and catch the rejection
      await expect(
        runAfterAuth(
          "test-unbound-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          unboundWaitUntil,
        ),
      ).rejects.toThrow();
    });

    it("concurrent first loads share one ensureValidation call", async () => {
      let resolveSetup!: () => void;
      const setupPromise = new Promise<{ id: string; created: boolean }>((resolve) => {
        resolveSetup = () => resolve({ id: "gid://shopify/Validation/123", created: false });
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

    it("S23-09: reinstall SQL resets onboarding_dismissed_at", async () => {
      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-onboarding-reset.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      expect(mockSqlQuery).toHaveBeenCalled();

      const sqlCall = mockSqlQuery.mock.calls[0];
      const sqlTemplate = sqlCall[0];

      const templateStr = Array.isArray(sqlTemplate) ? sqlTemplate.join("") : String(sqlTemplate);
      expect(templateStr).toContain('"uninstalledAt" = NULL');
      expect(templateStr).toContain('onboarding_dismissed_at = NULL');
      expect(templateStr).toContain('"uninstalledAt" IS NOT NULL');
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

      // runAfterAuth is now async; it should not reject even when clear fails
      await expect(
        runAfterAuth(
          "test-clear-failed-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).resolves.not.toThrow();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-clear-failed-shop.myshopify.com")).toBe(true);
      });

      // Now logs via safeLog with clear_uninstalled_at_failed and reason=db_error
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"clear_uninstalled_at_failed"'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"db_error"'),
      );

      consoleSpy.mockRestore();
    });

    it("continues without clear when getRequestSql throws", async () => {
      // safeLog("warn", ...) logs to console.warn, not console.error
      const consoleSpy = vi
        .spyOn(console, "warn")
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

      // runAfterAuth is now async; it should not reject even when getRequestSql throws
      await expect(
        runAfterAuth(
          "test-no-context-shop.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ).resolves.not.toThrow();

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-no-context-shop.myshopify.com")).toBe(true);
      });

      // Now logs via safeLog with clear_uninstalled_at_failed and reason=no_request_context
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"clear_uninstalled_at_failed"'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"no_request_context"'),
      );

      consoleSpy.mockRestore();
    });

    it("S23-09: reinstall log uses safeLog with shopHash, no raw id or domain", async () => {
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-uuid-123" }]);

      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      runAfterAuth(
        "test-safelog.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        const safeLogCall = consoleLogSpy.mock.calls.find(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("cleared_uninstalled_at_and_metafield_errors"),
        );
        expect(safeLogCall).toBeDefined();

        const logOutput = safeLogCall![0] as string;
        const parsed = JSON.parse(logOutput);

        expect(parsed.event).toBe("cleared_uninstalled_at_and_metafield_errors");
        expect(parsed.shopHash).toBeDefined();
        expect(typeof parsed.shopHash).toBe("string");
        expect(parsed.shopHash.length).toBeGreaterThan(0);

        expect(logOutput).not.toContain("shop-uuid-123");
        expect(logOutput).not.toContain("test-safelog.myshopify.com");
        expect(logOutput).not.toContain("shop_id=");
      });

      consoleLogSpy.mockRestore();
    });
  });

  describe("#292: shop_config metafield write on auth", () => {
    it("shop_config is written with fetched currency during syncShopInfo", async () => {
      const mockWriteShopConfigMetafield = vi.fn().mockResolvedValue({ success: true });
      vi.doMock("~/services/shop-config.server", () => ({
        writeShopConfigMetafield: mockWriteShopConfigMetafield,
      }));

      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      vi.resetModules();

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");

      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                shop: {
                  id: "gid://shopify/Shop/12345",
                  ianaTimezone: "America/New_York",
                  currencyCode: "USD",
                },
              },
            }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      await runAfterAuth(
        "test-shop-config-write.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-shop-config-write.myshopify.com")).toBe(true);
      });

      expect(mockWriteShopConfigMetafield).toHaveBeenCalledWith(
        mockAdmin,
        "gid://shopify/Shop/12345",
        "USD",
      );
    });

    it("shop_config_write_failed is logged via real safeLog on write failure, Shop upsert still runs", async () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const mockWriteShopConfigMetafield = vi
        .fn()
        .mockResolvedValue({ success: false, error: "user_errors" });
      vi.doMock("~/services/shop-config.server", () => ({
        writeShopConfigMetafield: mockWriteShopConfigMetafield,
      }));

      mockEnsureValidation.mockResolvedValue({
        id: "gid://shopify/Validation/123",
        created: true,
      });

      let upsertCalled = false;
      mockSqlQuery.mockImplementation((strings: TemplateStringsArray) => {
        const query = Array.isArray(strings) ? strings.join("") : String(strings);
        if (query.includes("INSERT INTO") && query.includes('"Shop"')) {
          upsertCalled = true;
        }
        return Promise.resolve([{ id: "shop-uuid-test", closed_count: 0 }]);
      });

      vi.resetModules();

      const { runAfterAuth, _resetSetupCacheForTesting, _isShopSetupComplete } =
        await import("../after-auth.server");

      _resetSetupCacheForTesting();

      const mockAdmin = {
        graphql: vi.fn().mockResolvedValue({
          json: () =>
            Promise.resolve({
              data: {
                shop: {
                  id: "gid://shopify/Shop/99999",
                  ianaTimezone: "America/Los_Angeles",
                  currencyCode: "INR",
                },
              },
            }),
        }),
      };

      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      await runAfterAuth(
        "test-shop-config-fail.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-shop-config-fail.myshopify.com")).toBe(true);
      });

      const safeLogCall = consoleWarnSpy.mock.calls.find(
        (call) =>
          typeof call[0] === "string" && call[0].includes("shop_config_write_failed"),
      );
      expect(safeLogCall).toBeDefined();

      const logOutput = safeLogCall![0] as string;
      expect(logOutput).toContain('"event":"shop_config_write_failed"');
      expect(logOutput).toContain('"err":"user_errors"');

      expect(upsertCalled).toBe(true);

      consoleWarnSpy.mockRestore();
    });
  });

  describe("reinstall critical path", () => {
    it("reinstall awaits definitions-then-validation chain + payment customization + plan refresh", async () => {
      const callOrder: string[] = [];
      
      mockEnsureMetafieldDefinitions.mockImplementation(async () => {
        callOrder.push("definitions_start");
        await new Promise(r => setTimeout(r, 10));
        callOrder.push("definitions_end");
        return [];
      });
      
      mockEnsureValidation.mockImplementation(async () => {
        callOrder.push("validation_start");
        await new Promise(r => setTimeout(r, 10));
        callOrder.push("validation_end");
        return { id: "val-123", created: false };
      });
      
      mockEnsurePaymentCustomization.mockImplementation(async () => {
        callOrder.push("payment_start");
        await new Promise(r => setTimeout(r, 10));
        callOrder.push("payment_end");
        return { id: "pc-123", created: false };
      });

      // Mock reinstall scenario: clearUninstalledAt returns shop id
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-reinstall-uuid", closed_count: 0, deleted_claims_count: 0 }]);
      mockSqlQuery.mockResolvedValue([]);
      
      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      await runAfterAuth(
        "test-reinstall-order.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      // After runAfterAuth resolves, the critical path is complete
      // Definitions should run before validation (chain)
      const defsEnd = callOrder.indexOf("definitions_end");
      const valStart = callOrder.indexOf("validation_start");
      expect(defsEnd).toBeLessThan(valStart);
      
      // All critical steps should have completed
      expect(callOrder).toContain("definitions_end");
      expect(callOrder).toContain("validation_end");
      expect(callOrder).toContain("payment_end");
      
      // syncShopInfo runs in background (via waitUntil)
      expect(mockWaitUntil).toHaveBeenCalled();
    });

    it("failed registration step leaves shop retryable (not marked complete)", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      mockEnsureMetafieldDefinitions.mockResolvedValue([]);
      mockEnsureValidation.mockRejectedValue(new Error("Validation failed"));
      mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });

      // Mock reinstall scenario
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-fail-uuid", closed_count: 0, deleted_claims_count: 0 }]);
      mockSqlQuery.mockResolvedValue([]);
      
      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      await runAfterAuth(
        "test-reinstall-fail.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      // Shop should NOT be marked complete because validation failed
      expect(_isShopSetupComplete("test-reinstall-fail.myshopify.com")).toBe(false);
      
      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"validation_registration_failed"'),
      );

      consoleSpy.mockRestore();
    });

    it("syncShopInfo failure on reinstall leaves shop retryable", async () => {
      vi.stubEnv("SHOPIFY_API_KEY", "");
      vi.stubEnv("SHOPIFY_API_SECRET", "");
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      
      mockEnsureMetafieldDefinitions.mockResolvedValue([]);
      mockEnsureValidation.mockResolvedValue({ id: "val-123", created: false });
      mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });

      // Mock reinstall scenario
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-sync-fail-uuid", closed_count: 0, deleted_claims_count: 0 }]);
      // Plan refresh succeeds
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-sync-fail-uuid" }]);
      mockSqlQuery.mockResolvedValueOnce([{ plan_key: "none", subscription_id: null, subscription_name: null, is_test: false, plan_cached_at: null }]);
      // syncShopInfo fails on the upsert
      mockSqlQuery.mockRejectedValueOnce(new Error("DB connection failed"));
      
      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      await runAfterAuth(
        "test-sync-fail.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      // Shop should NOT be marked complete because syncShopInfo failed
      expect(_isShopSetupComplete("test-sync-fail.myshopify.com")).toBe(false);
      
      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"event":"sync_shop_info_failed"'),
      );

      consoleSpy.mockRestore();
    });

    it("plan refresh is called during reinstall critical path", async () => {
      // This test verifies that refreshPlanCache IS called on the critical path
      // during reinstall. We verify by checking for the SELECT id FROM "Shop"
      // query pattern that getShopId makes (part of resolvePlan/refreshPlanCache).
      
      let getShopIdCalled = false;
      
      mockEnsureMetafieldDefinitions.mockResolvedValue([]);
      mockEnsureValidation.mockResolvedValue({ id: "val-123", created: false });
      mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });

      mockSqlQuery.mockImplementation(async (strings: TemplateStringsArray) => {
        const query = Array.isArray(strings) ? strings.join("") : String(strings);
        
        if (query.includes('"uninstalledAt" = NULL') && query.includes('AND "uninstalledAt" IS NOT NULL')) {
          // clearUninstalledAtAndMetafieldErrors - return reinstall
          return [{ id: "shop-plan-uuid", closed_count: 0, deleted_claims_count: 0 }];
        }
        
        // getShopId query pattern from plan.server.ts
        if (query.includes('SELECT id FROM "Shop"') && query.includes('domain')) {
          getShopIdCalled = true;
          return [{ id: "shop-plan-uuid" }];
        }
        
        // getCachedPlan query pattern
        if (query.includes('plan_key') && query.includes('plan_cached_at') && query.includes('SELECT')) {
          return [{
            plan_key: "starter",
            subscription_id: "gid://shopify/AppSubscription/123",
            subscription_name: "Starter",
            is_test: false,
            plan_cached_at: new Date(),
          }];
        }
        
        return [];
      });
      
      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      await runAfterAuth(
        "test-plan-refresh.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      await Promise.allSettled(waitUntilPromises);

      // The getShopId query is only called by resolvePlan (via refreshPlanCache).
      // Its presence indicates that plan refresh was triggered during the reinstall path.
      expect(getShopIdCalled).toBe(true);
    });

    it("syncShopInfo runs through waitUntil, not awaited on critical path (runAfterAuth resolves while background pending)", async () => {
      mockEnsureMetafieldDefinitions.mockResolvedValue([]);
      mockEnsureValidation.mockResolvedValue({ id: "val-123", created: false });
      mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });

      // Use deferred promise to hold the shop-info Admin query
      let resolveShopInfoQuery!: () => void;
      const shopInfoDeferred = new Promise<void>((resolve) => {
        resolveShopInfoQuery = resolve;
      });
      let shopInfoQueryStarted = false;

      // Mock reinstall scenario
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-waituntil-uuid", closed_count: 0, deleted_claims_count: 0 }]);
      mockSqlQuery.mockResolvedValue([]);
      
      // Mock Admin to hang on shop info query until we release it
      const mockAdmin = {
        graphql: vi.fn().mockImplementation(async () => {
          shopInfoQueryStarted = true;
          await shopInfoDeferred;
          return {
            json: () => Promise.resolve({ data: { shop: { ianaTimezone: "America/New_York" } } }),
          };
        }),
      };
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      // Start runAfterAuth - it should resolve while syncShopInfo is still pending
      const runAfterAuthPromise = runAfterAuth(
        "test-waituntil.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      // Wait for runAfterAuth to resolve
      await runAfterAuthPromise;

      // At this point, runAfterAuth has resolved BUT the shop info query is still pending
      // This proves syncShopInfo runs in background (via waitUntil), not blocking critical path
      expect(shopInfoQueryStarted).toBe(true);
      expect(waitUntilPromises.length).toBeGreaterThan(0);

      // Shop should NOT be marked complete yet (background still pending)
      expect(_isShopSetupComplete("test-waituntil.myshopify.com")).toBe(false);

      // Now release the shop info query
      resolveShopInfoQuery();

      // Wait for background to complete
      await Promise.allSettled(waitUntilPromises);

      // Now shop should be marked complete
      await vi.waitFor(() => {
        expect(_isShopSetupComplete("test-waituntil.myshopify.com")).toBe(true);
      });
    });

    it("concurrent reinstall loads: exactly one takes reinstall path via SQL atomicity", async () => {
      // This test verifies that the UPDATE...RETURNING SQL atomicity ensures
      // exactly ONE call gets the row. This is the key guarantee for preventing
      // duplicate reinstall processing.
      
      // Track which call paths were taken via SQL
      const reinstallWinners: number[] = [];
      let clearCallCount = 0;

      mockEnsureMetafieldDefinitions.mockResolvedValue([]);
      mockEnsureValidation.mockResolvedValue({ id: "val-123", created: false });
      mockEnsurePaymentCustomization.mockResolvedValue({ id: "pc-123", created: false });

      // Track SQL calls to identify reinstall vs normal path
      // First caller gets the row (reinstall), second gets empty (lost SQL race)
      mockSqlQuery.mockImplementation(async (strings: TemplateStringsArray) => {
        const query = Array.isArray(strings) ? strings.join("") : String(strings);
        
        if (query.includes('"uninstalledAt" = NULL') && query.includes('AND "uninstalledAt" IS NOT NULL')) {
          // This is the clearUninstalledAtAndMetafieldErrors CTE
          clearCallCount++;
          // First call gets the row, second gets empty (simulating Postgres atomicity)
          if (reinstallWinners.length === 0) {
            reinstallWinners.push(clearCallCount);
            return [{ id: "shop-concurrent-uuid", closed_count: 0, deleted_claims_count: 0 }];
          } else {
            return [];
          }
        }
        return [];
      });
      
      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      // Run two concurrent reinstall loads with Promise.all
      await Promise.all([
        runAfterAuth(
          "test-concurrent-reinstall.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
        runAfterAuth(
          "test-concurrent-reinstall.myshopify.com",
          mockAdmin as Parameters<typeof runAfterAuth>[1],
          mockWaitUntil,
        ),
      ]);

      await Promise.allSettled(waitUntilPromises);

      // With per-isolate deduplication set BEFORE the DB call, only ONE call
      // actually runs - the other awaits the first's promise. So:
      // - Exactly ONE clear query is made
      // - Exactly ONE call gets the RETURNING row
      expect(clearCallCount).toBe(1);
      expect(reinstallWinners).toHaveLength(1);
      
      // Registration should have been called exactly once by the winner
      expect(mockEnsureMetafieldDefinitions).toHaveBeenCalledTimes(1);
      expect(mockEnsureValidation).toHaveBeenCalledTimes(1);
      expect(mockEnsurePaymentCustomization).toHaveBeenCalledTimes(1);
    });

    it("latency: parallel chains - payment starts while definitions still running (deterministic)", async () => {
      // Use deferred promises for deterministic ordering
      let resolveDefinitions!: () => void;
      let resolvePayment!: () => void;
      
      const definitionsStarted = vi.fn();
      const paymentStarted = vi.fn();
      
      mockEnsureMetafieldDefinitions.mockImplementation(async () => {
        definitionsStarted();
        await new Promise<void>(r => { resolveDefinitions = r; });
        return [];
      });
      
      mockEnsureValidation.mockResolvedValue({ id: "val-123", created: false });
      
      mockEnsurePaymentCustomization.mockImplementation(async () => {
        paymentStarted();
        await new Promise<void>(r => { resolvePayment = r; });
        return { id: "pc-123", created: false };
      });

      // Mock reinstall scenario
      mockSqlQuery.mockResolvedValueOnce([{ id: "shop-parallel-uuid", closed_count: 0, deleted_claims_count: 0 }]);
      mockSqlQuery.mockResolvedValue([]);
      
      const mockAdmin = createMockAdmin();
      const waitUntilPromises: Promise<unknown>[] = [];
      const mockWaitUntil = vi.fn((p) => waitUntilPromises.push(p));

      const runPromise = runAfterAuth(
        "test-parallel.myshopify.com",
        mockAdmin as Parameters<typeof runAfterAuth>[1],
        mockWaitUntil,
      );

      // Wait for both to start
      await vi.waitFor(() => {
        expect(definitionsStarted).toHaveBeenCalled();
        expect(paymentStarted).toHaveBeenCalled();
      });

      // Payment started while definitions was still pending (parallel execution)
      // Now resolve both
      resolveDefinitions();
      resolvePayment();

      await runPromise;
    });
  });

});
