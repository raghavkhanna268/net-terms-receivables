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
 * @see https://shopify.dev/docs/apps/launch/built-for-shopify/requirements
 * @see https://shopify.dev/docs/apps/build/performance/admin-installation-oauth
 */

function mockReactRouter(pathname: string, isDevMode = true, hasLoaderData = true) {
  vi.doMock("react-router", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-router")>();
    return {
      ...actual,
      useLoaderData: () =>
        hasLoaderData ? { apiKey: "test-key", isDevMode } : undefined,
      useMatches: () => [{ id: "root", pathname, handle: undefined }],
      useRouteLoaderData: () =>
        hasLoaderData ? { apiKey: "test-key", isDevMode } : undefined,
      useRouteError: () => null,
      Links: () => null,
      Meta: () => null,
      Outlet: () => null,
      Scripts: () => null,
      ScrollRestoration: () => null,
      isRouteErrorResponse: () => false,
    };
  });
}

describe("App Bridge script positioning", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("SHOPIFY_API_KEY", "test-api-key-12345");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("react-router");
  });

  describe("root loader", () => {
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

    it("exports shouldRevalidate that returns false", async () => {
      const { shouldRevalidate } = await import("../../root");
      expect(shouldRevalidate()).toBe(false);
    });
  });

  describe("/privacy resource route (regression guard)", () => {
    it("returns HTML without app-bridge.js (resource route bypasses root)", async () => {
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
      expect(html).not.toContain("app-bridge.js");
    });
  });

  describe("/auth/login route (regression guard)", () => {
    it("renders null (redirect-only route)", async () => {
      const { default: AuthLogin } = await import("../auth.login/route");
      expect(AuthLogin()).toBeNull();
    });
  });

  describe("root Layout - embedded routes", () => {
    it("/app renders debug meta before app-bridge.js in dev mode", async () => {
      mockReactRouter("/app", true);

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
    });

    it("/app renders app-bridge.js as first script in head", async () => {
      mockReactRouter("/app", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      const headMatch = html.match(/<head[^>]*>([\s\S]*?)<\/head>/);
      expect(headMatch).not.toBeNull();
      const headContent = headMatch![1];

      const firstScriptMatch = headContent.match(/<script[^>]*>/);
      expect(firstScriptMatch).not.toBeNull();
      expect(firstScriptMatch![0]).toContain("app-bridge.js");
    });

    it("/app/accounts renders app-bridge.js", async () => {
      mockReactRouter("/app/accounts", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).toContain("app-bridge.js");
    });

    it("/auth renders app-bridge.js", async () => {
      mockReactRouter("/auth", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).toContain("app-bridge.js");
    });

    it("/auth/login renders app-bridge.js", async () => {
      mockReactRouter("/auth/login", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).toContain("app-bridge.js");
    });

    it("/app does NOT render debug meta in production mode", async () => {
      mockReactRouter("/app", false);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain('name="shopify-debug"');
      expect(html).toContain("app-bridge.js");
    });
  });

  describe("root Layout - public routes (no App Bridge)", () => {
    it("/unsubscribe renders no app-bridge.js or debug meta", async () => {
      mockReactRouter("/unsubscribe", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
      expect(html).not.toContain('name="shopify-debug"');
    });

    it("/privacy-like renders no app-bridge.js or debug meta", async () => {
      mockReactRouter("/privacy-like", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
      expect(html).not.toContain('name="shopify-debug"');
    });

    it("/ (landing) renders no app-bridge.js", async () => {
      mockReactRouter("/", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
    });
  });

  describe("root Layout - near-miss paths (no App Bridge)", () => {
    it("/apple renders no app-bridge.js", async () => {
      mockReactRouter("/apple", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
    });

    it("/application renders no app-bridge.js", async () => {
      mockReactRouter("/application", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
    });

    it("/authors renders no app-bridge.js", async () => {
      mockReactRouter("/authors", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
    });

    it("/authx renders no app-bridge.js", async () => {
      mockReactRouter("/authx", true);

      const { default: App } = await import("../../root");
      const html = renderToString(createElement(App));

      expect(html).not.toContain("app-bridge.js");
    });
  });

  describe("root ErrorBoundary - embedded routes", () => {
    it("/app renders app-bridge.js with loader data", async () => {
      mockReactRouter("/app", true, true);

      const { ErrorBoundary } = await import("../../root");
      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("app-bridge.js");
    });

    it("/auth/login renders app-bridge.js with loader data", async () => {
      mockReactRouter("/auth/login", true, true);

      const { ErrorBoundary } = await import("../../root");
      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("app-bridge.js");
    });

    it("/app without loader data renders no app-bridge.js", async () => {
      mockReactRouter("/app", true, false);

      const { ErrorBoundary } = await import("../../root");
      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("app-bridge.js");
    });
  });

  describe("root ErrorBoundary - public routes (no App Bridge)", () => {
    it("/unsubscribe renders no app-bridge.js", async () => {
      mockReactRouter("/unsubscribe", true, true);

      const { ErrorBoundary } = await import("../../root");
      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("app-bridge.js");
    });

    it("/privacy-like renders no app-bridge.js", async () => {
      mockReactRouter("/privacy-like", true, true);

      const { ErrorBoundary } = await import("../../root");
      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("app-bridge.js");
    });
  });
});
