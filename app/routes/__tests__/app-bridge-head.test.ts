import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for App Bridge script positioning in <head>.
 *
 * BFS requirement 3.1.1 / App Store 2.2.3:
 * - App Bridge must be in <head> of every document
 * - App Bridge must come before any other <script> tags
 * - The shopify-debug meta tag (for web vitals) must come before App Bridge
 *
 * Per Shopify docs (https://shopify.dev/docs/apps/build/performance/admin-installation-oauth):
 * ```html
 * <head>
 *   <!-- to enable Web Vitals debug logging, add the shopify-debug meta tag -->
 *   <meta name="shopify-debug" content="web-vitals" />
 *   <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" />
 * </head>
 * ```
 *
 * The debug meta tag enables:
 * - Real-time logs from Web Vitals with attribution data
 * - Send-time logs showing final values recorded by Shopify
 *
 * This is useful for debugging during development or staging, not production.
 *
 * @see https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
 * @see https://shopify.dev/docs/apps/build/performance/admin-installation-oauth
 */

describe("App Bridge script positioning", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SHOPIFY_API_KEY", "test-api-key-12345");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("root layout loader (serves /app, /auth/login)", () => {
    it("returns apiKey from environment", async () => {
      const { loader } = await import("../../root");

      const result = await loader({
        request: new Request("https://example.com/app"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/app"),
        pattern: "/",
      });

      expect(result).toHaveProperty("apiKey", "test-api-key-12345");
    });

    it("returns isDevMode flag", async () => {
      const { loader } = await import("../../root");

      const result = await loader({
        request: new Request("https://example.com/app"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/app"),
        pattern: "/",
      });

      expect(result).toHaveProperty("isDevMode");
      expect(typeof result.isDevMode).toBe("boolean");
    });

    it("uses same env var as app.tsx route (SHOPIFY_API_KEY)", async () => {
      const { loader: rootLoader } = await import("../../root");
      const rootResult = await rootLoader({
        request: new Request("https://example.com/"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/"),
        pattern: "/",
      });

      expect(rootResult.apiKey).toBe("test-api-key-12345");
    });
  });

  describe("/privacy route HTML output", () => {
    it("returns HTML with proper structure", async () => {
      const { loader } = await import("../privacy");

      const response = await loader({
        request: new Request("https://example.com/privacy"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/privacy"),
        pattern: "/privacy",
      });

      const html = await response.text();

      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("<head>");
      expect(html).toContain("</head>");
    });

    it("has shopify-debug meta tag before app-bridge.js script in dev mode", async () => {
      const { loader } = await import("../privacy");

      const response = await loader({
        request: new Request("https://example.com/privacy"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/privacy"),
        pattern: "/privacy",
      });

      const html = await response.text();
      const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
      expect(headMatch).not.toBeNull();
      const headContent = headMatch![1];

      const metaPos = headContent.indexOf('name="shopify-debug"');
      const scriptPos = headContent.indexOf("app-bridge.js");

      expect(metaPos).toBeGreaterThan(-1);
      expect(scriptPos).toBeGreaterThan(-1);
      expect(metaPos).toBeLessThan(scriptPos);
    });

    it("has app-bridge.js as the first script in head", async () => {
      const { loader } = await import("../privacy");

      const response = await loader({
        request: new Request("https://example.com/privacy"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/privacy"),
        pattern: "/privacy",
      });

      const html = await response.text();
      const headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
      expect(headMatch).not.toBeNull();
      const headContent = headMatch![1];

      const firstScriptMatch = headContent.match(/<script[^>]*>/);
      expect(firstScriptMatch).not.toBeNull();
      expect(firstScriptMatch![0]).toContain("app-bridge.js");
    });

    it("includes data-api-key attribute on app-bridge.js script", async () => {
      const { loader } = await import("../privacy");

      const response = await loader({
        request: new Request("https://example.com/privacy"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/privacy"),
        pattern: "/privacy",
      });

      const html = await response.text();
      expect(html).toContain('data-api-key="test-api-key-12345"');
    });
  });

  describe("/auth/login route", () => {
    it("renders null component (uses root layout for HTML)", async () => {
      const { default: AuthLogin } = await import("../auth.login/route");
      const result = AuthLogin();
      expect(result).toBeNull();
    });

    it("inherits App Bridge from root layout (loader provides apiKey)", async () => {
      const { loader: rootLoader } = await import("../../root");

      const result = await rootLoader({
        request: new Request("https://example.com/auth/login"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/auth/login"),
        pattern: "/",
      });

      expect(result.apiKey).toBe("test-api-key-12345");
      expect(result).toHaveProperty("isDevMode");
    });
  });
});
