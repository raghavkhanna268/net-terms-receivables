import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

/**
 * Tests for App Bridge script positioning in <head>.
 *
 * BFS requirement 3.1.1 / App Store 2.2.3:
 * - App Bridge must be in <head> of every document (embedded admin routes only)
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
 * App Bridge behavior outside admin:
 * When loaded top-level (not in Shopify admin iframe) with no host/shop param,
 * App Bridge throws: "App Bridge Next: missing required configuration fields: shop"
 * and does NOT initialize window.shopify. Therefore, we only load it for embedded
 * routes (/app/* and /auth/*) that run inside the Shopify admin.
 *
 * @see https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
 * @see https://shopify.dev/docs/apps/build/performance/admin-installation-oauth
 * @see https://shopify.dev/docs/api/app-home/latest/apis/authentication-and-data/config-api
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

  describe("/privacy route (resource route, no App Bridge)", () => {
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

    it("does NOT include app-bridge.js (public route outside admin)", async () => {
      const { loader } = await import("../privacy");

      const response = await loader({
        request: new Request("https://example.com/privacy"),
        context: {} as never,
        params: {},
        url: new URL("https://example.com/privacy"),
        pattern: "/privacy",
      });

      const html = await response.text();
      expect(html).not.toContain("app-bridge.js");
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

  describe("AppBridgeHead component", () => {
    it("renders debug meta before app-bridge.js script in dev mode", async () => {
      vi.doMock("react-router", async (importOriginal) => {
        const actual = await importOriginal<typeof import("react-router")>();
        return {
          ...actual,
          useLoaderData: () => ({ apiKey: "test-key", isDevMode: true }),
          useMatches: () => [
            { id: "root", pathname: "/app", handle: undefined },
          ],
          useRouteLoaderData: () => ({ apiKey: "test-key", isDevMode: true }),
          useRouteError: () => null,
          Links: () => null,
          Meta: () => null,
          Outlet: () => null,
          Scripts: () => null,
          ScrollRestoration: () => null,
          isRouteErrorResponse: () => false,
        };
      });

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/);
      expect(headMatch).not.toBeNull();
      const headContent = headMatch![1];

      const metaPos = headContent.indexOf('name="shopify-debug"');
      const scriptPos = headContent.indexOf("app-bridge.js");

      expect(metaPos).toBeGreaterThan(-1);
      expect(scriptPos).toBeGreaterThan(-1);
      expect(metaPos).toBeLessThan(scriptPos);

      vi.doUnmock("react-router");
    });

    it("app-bridge.js is the first script in head for /app routes", async () => {
      vi.doMock("react-router", async (importOriginal) => {
        const actual = await importOriginal<typeof import("react-router")>();
        return {
          ...actual,
          useLoaderData: () => ({ apiKey: "test-key", isDevMode: true }),
          useMatches: () => [
            { id: "root", pathname: "/app", handle: undefined },
          ],
          useRouteLoaderData: () => ({ apiKey: "test-key", isDevMode: true }),
          useRouteError: () => null,
          Links: () => null,
          Meta: () => null,
          Outlet: () => null,
          Scripts: () => null,
          ScrollRestoration: () => null,
          isRouteErrorResponse: () => false,
        };
      });

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/);
      expect(headMatch).not.toBeNull();
      const headContent = headMatch![1];

      const firstScriptMatch = headContent.match(/<script[^>]*>/);
      expect(firstScriptMatch).not.toBeNull();
      expect(firstScriptMatch![0]).toContain("app-bridge.js");

      vi.doUnmock("react-router");
    });

    it("does NOT render app-bridge.js for non-embedded routes like /unsubscribe", async () => {
      vi.doMock("react-router", async (importOriginal) => {
        const actual = await importOriginal<typeof import("react-router")>();
        return {
          ...actual,
          useLoaderData: () => ({ apiKey: "test-key", isDevMode: true }),
          useMatches: () => [
            { id: "root", pathname: "/unsubscribe", handle: undefined },
          ],
          useRouteLoaderData: () => ({ apiKey: "test-key", isDevMode: true }),
          useRouteError: () => null,
          Links: () => null,
          Meta: () => null,
          Outlet: () => null,
          Scripts: () => null,
          ScrollRestoration: () => null,
          isRouteErrorResponse: () => false,
        };
      });

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");

      vi.doUnmock("react-router");
    });

    it("does NOT render debug meta in production mode", async () => {
      vi.doMock("react-router", async (importOriginal) => {
        const actual = await importOriginal<typeof import("react-router")>();
        return {
          ...actual,
          useLoaderData: () => ({ apiKey: "test-key", isDevMode: false }),
          useMatches: () => [
            { id: "root", pathname: "/app", handle: undefined },
          ],
          useRouteLoaderData: () => ({ apiKey: "test-key", isDevMode: false }),
          useRouteError: () => null,
          Links: () => null,
          Meta: () => null,
          Outlet: () => null,
          Scripts: () => null,
          ScrollRestoration: () => null,
          isRouteErrorResponse: () => false,
        };
      });

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain('name="shopify-debug"');
      expect(html).toContain("app-bridge.js");

      vi.doUnmock("react-router");
    });
  });
});
