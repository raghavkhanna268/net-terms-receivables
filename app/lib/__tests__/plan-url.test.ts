import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("plan-url", () => {
  const originalEnv = process.env.APP_HANDLE;

  afterEach(() => {
    (process.env as Record<string, string | undefined>).APP_HANDLE = originalEnv;
  });

  describe("getAppHandle", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("returns env value when APP_HANDLE is set", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { getAppHandle } = await import("../plan-url");
      expect(getAppHandle()).toBe("net-terms-receivables-1");
    });

    it("returns null when APP_HANDLE is unset", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = undefined;
      const { getAppHandle } = await import("../plan-url");
      expect(getAppHandle()).toBeNull();
    });

    it("returns null when APP_HANDLE is empty string", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "";
      const { getAppHandle } = await import("../plan-url");
      expect(getAppHandle()).toBeNull();
    });

    it("returns null when APP_HANDLE is whitespace only", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "   ";
      const { getAppHandle } = await import("../plan-url");
      expect(getAppHandle()).toBeNull();
    });
  });

  describe("buildPlanSelectionUrl", () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it("builds URL for test-shop.myshopify.com", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-shop.myshopify.com");
      expect(url).toBe(
        "https://admin.shopify.com/store/test-shop/charges/net-terms-receivables-1/pricing_plans"
      );
    });

    it("handles bare store handle (no .myshopify.com suffix)", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-shop");
      expect(url).toBe(
        "https://admin.shopify.com/store/test-shop/charges/net-terms-receivables-1/pricing_plans"
      );
    });

    it("returns null when app handle is null", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = undefined;
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-shop.myshopify.com");
      expect(url).toBeNull();
    });

    it("returns null when explicit appHandle parameter is null", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-shop.myshopify.com", null);
      expect(url).toBeNull();
    });

    it("returns null for invalid domain (empty string)", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("");
      expect(url).toBeNull();
    });

    it("returns null for invalid domain (whitespace only)", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("   ");
      expect(url).toBeNull();
    });

    it("returns null when domain strips to empty (suffix-only input)", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "net-terms-receivables-1";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-suffix-strip", "test-app");
      expect(url).not.toBeNull();
      const emptyResult = buildPlanSelectionUrl("", "test-app");
      expect(emptyResult).toBeNull();
    });

    it("does not URL-encode unexpected characters", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "my-app";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-store.myshopify.com", "my-app");
      expect(url).toBe(
        "https://admin.shopify.com/store/test-store/charges/my-app/pricing_plans"
      );
      expect(url).not.toContain("%");
    });

    it("uses explicit appHandle parameter over env when provided", async () => {
      (process.env as Record<string, string | undefined>).APP_HANDLE = "env-app";
      const { buildPlanSelectionUrl } = await import("../plan-url");
      const url = buildPlanSelectionUrl("test-shop.myshopify.com", "param-app");
      expect(url).toBe(
        "https://admin.shopify.com/store/test-shop/charges/param-app/pricing_plans"
      );
    });
  });
});
