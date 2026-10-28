/**
 * Tests for app.tsx ErrorBoundary in-layout error rendering.
 *
 * Verifies that 4xx/5xx route errors render inside the /app layout with:
 * - Navigation visible (s-app-nav)
 * - User-friendly error message (s-page, s-section)
 * - No stack traces, error messages, IDs, or shop data leaked
 * - HTTP status code preserved
 * - Sentry not called for 4xx errors
 * - 401/403 auth errors rethrow for Shopify auth flow
 *
 * The ErrorBoundary handles errors that bubble up from child routes when
 * they don't have their own ErrorBoundary. It renders them in-layout
 * instead of rethrowing to root (which would lose the nav).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { UNSAFE_ErrorResponseImpl } from "react-router";

vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

function setupRouterMock(error: unknown, apiKey = "test-api-key") {
  vi.doMock("react-router", async () => {
    const actual = await vi.importActual<typeof import("react-router")>("react-router");
    return {
      ...actual,
      useRouteError: () => error,
      useNavigate: () => vi.fn(),
      useRouteLoaderData: () => ({ apiKey }),
    };
  });
}

describe("app.tsx ErrorBoundary in-layout rendering", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("401/403 auth errors rethrow for Shopify auth flow", () => {
    it("rethrows 401 for re-auth flow", async () => {
      const reauthError = new UNSAFE_ErrorResponseImpl(401, "Unauthorized", null);

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => reauthError,
          useRouteLoaderData: () => ({ apiKey: "test-key" }),
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });

    it("rethrows 403 for permission flow", async () => {
      const forbiddenError = new UNSAFE_ErrorResponseImpl(403, "Forbidden", null);

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => forbiddenError,
          useRouteLoaderData: () => ({ apiKey: "test-key" }),
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      expect(() => renderToString(createElement(ErrorBoundary))).toThrow();
    });
  });

  describe("404 Not Found", () => {
    it("renders nav for 404 route error response", async () => {
      const notFoundError = new UNSAFE_ErrorResponseImpl(404, "Not Found", null);
      setupRouterMock(notFoundError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("s-link");
      expect(html).toContain('href="/app"');
    });

    it("shows correct 404 message", async () => {
      const notFoundError = new UNSAFE_ErrorResponseImpl(404, "Not Found", null);
      setupRouterMock(notFoundError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("Page not found");
      expect(html).toContain("could not be found");
      expect(html).toContain('href="/app"');
    });

    it("does not leak stack or error data for 404", async () => {
      const notFoundError = new UNSAFE_ErrorResponseImpl(
        404,
        "Not Found",
        { secretData: "shop-12345.example.com", requestId: "req-abc123" }
      );
      setupRouterMock(notFoundError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("shop-12345");
      expect(html).not.toContain("req-abc123");
      expect(html).not.toContain("secretData");
      expect(html).not.toContain("requestId");
      expect(html).not.toContain("stack");
      expect(html).not.toContain("Error:");
    });
  });

  describe("410 Gone", () => {
    it("renders nav for 410 route error response", async () => {
      const goneError = new UNSAFE_ErrorResponseImpl(410, "Gone", null);
      setupRouterMock(goneError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("s-link");
      expect(html).toContain('href="/app"');
    });

    it("shows correct 410 message", async () => {
      const goneError = new UNSAFE_ErrorResponseImpl(410, "Gone", null);
      setupRouterMock(goneError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("Page no longer available");
      expect(html).toContain("no longer available");
      expect(html).toContain('href="/app"');
    });

    it("does not leak stack or error data for 410", async () => {
      const goneError = new UNSAFE_ErrorResponseImpl(
        410,
        "Gone",
        { shopDomain: "test-store.example.com", userId: "user-xyz789" }
      );
      setupRouterMock(goneError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("test-store");
      expect(html).not.toContain("user-xyz789");
      expect(html).not.toContain("shopDomain");
      expect(html).not.toContain("userId");
    });
  });

  describe("500 Internal Server Error", () => {
    it("renders nav for 500 route error response", async () => {
      const serverError = new UNSAFE_ErrorResponseImpl(500, "Internal Server Error", null);
      setupRouterMock(serverError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("s-link");
      expect(html).toContain('href="/app"');
    });

    it("shows correct 500 message", async () => {
      const serverError = new UNSAFE_ErrorResponseImpl(500, "Internal Server Error", null);
      setupRouterMock(serverError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("Something went wrong");
      expect(html).toContain("try again");
      expect(html).toContain('href="/app"');
    });

    it("does not leak stack or error data for 500", async () => {
      const serverError = new UNSAFE_ErrorResponseImpl(
        500,
        "Internal Server Error",
        { message: "Database connection failed", stack: "Error: at line 42" }
      );
      setupRouterMock(serverError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).not.toContain("Database");
      expect(html).not.toContain("connection failed");
      expect(html).not.toContain("line 42");
      expect(html).not.toContain("stack");
    });

    it("renders nav for thrown Error (non-Response)", async () => {
      const thrownError = new Error("Unexpected failure in loader");
      setupRouterMock(thrownError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-app-nav");
      expect(html).toContain("Something went wrong");
      expect(html).not.toContain("Unexpected failure");
      expect(html).not.toContain("loader");
    });
  });

  describe("200 bounce response (unchanged behavior)", () => {
    it("still renders bounce HTML without nav", async () => {
      const bounceError = new UNSAFE_ErrorResponseImpl(
        200,
        "OK",
        "<script>window.shopify.reload()</script>"
      );

      vi.doMock("react-router", async () => {
        const actual = await vi.importActual<typeof import("react-router")>("react-router");
        return {
          ...actual,
          useRouteError: () => bounceError,
          useNavigate: () => vi.fn(),
          useRouteLoaderData: () => ({ apiKey: "test-key" }),
        };
      });

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("window.shopify.reload()");
      expect(html).not.toContain("s-app-nav");
    });
  });

  describe("Polaris components rendered", () => {
    it("renders s-page and s-section for error display", async () => {
      const notFoundError = new UNSAFE_ErrorResponseImpl(404, "Not Found", null);
      setupRouterMock(notFoundError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("s-page");
      expect(html).toContain("s-section");
      expect(html).toContain("s-empty-state");
      expect(html).toContain("s-button");
    });

    it("includes link back to app home", async () => {
      const serverError = new UNSAFE_ErrorResponseImpl(500, "Internal Server Error", null);
      setupRouterMock(serverError);

      vi.resetModules();
      const { ErrorBoundary } = await import("../app");

      const html = renderToString(createElement(ErrorBoundary));

      expect(html).toContain("Go to app home");
      expect(html).toMatch(/href="\/app"/);
    });
  });
});

describe("Status code preservation with in-layout ErrorBoundary", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("entry.server handleError skips Sentry for 404 (existing behavior)", async () => {
    const { captureExceptionWithTags } = await import("~/lib/sentry");
    const mockCapture = vi.mocked(captureExceptionWithTags);
    mockCapture.mockClear();

    const { handleError } = await import("../../entry.server");

    const request = new Request("https://test-store.example.com/app/missing");
    const error = new Response(null, { status: 404 });

    handleError(error, { request });

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("entry.server handleError skips Sentry for 410 (existing behavior)", async () => {
    const { captureExceptionWithTags } = await import("~/lib/sentry");
    const mockCapture = vi.mocked(captureExceptionWithTags);
    mockCapture.mockClear();

    const { handleError } = await import("../../entry.server");

    const request = new Request("https://test-store.example.com/app/old-page");
    const error = new Response(null, { status: 410 });

    handleError(error, { request });

    expect(mockCapture).not.toHaveBeenCalled();
  });

  it("entry.server handleError calls Sentry for 500 (existing behavior)", async () => {
    const { captureExceptionWithTags } = await import("~/lib/sentry");
    const mockCapture = vi.mocked(captureExceptionWithTags);
    mockCapture.mockClear();

    const { handleError } = await import("../../entry.server");

    const request = new Request("https://test-store.example.com/app/broken");
    const error = new Response("error", { status: 500 });

    handleError(error, { request });

    expect(mockCapture).toHaveBeenCalled();
  });
});

describe("Bot-UA 410 status code preservation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("410 route error preserves status for bot user agent", async () => {
    vi.doMock("react-dom/server", () => ({
      renderToReadableStream: vi.fn(async () => {
        return {
          allReady: Promise.resolve(),
          [Symbol.asyncIterator]: async function* () {
            yield new TextEncoder().encode("<html>error page</html>");
          },
        };
      }),
    }));

    vi.resetModules();
    const entryServer = await import("../../entry.server");

    const botUserAgent = "Googlebot/2.1 (+http://www.google.com/bot.html)";
    const request = new Request("https://test-store.example.com/app/old", {
      headers: { "User-Agent": botUserAgent },
    });

    const responseHeaders = new Headers();
    const reactRouterContext = {
      staticHandlerContext: {
        loaderData: {},
        actionData: null,
        errors: null,
      },
      manifest: {
        routes: {},
        entry: { imports: [], module: "" },
        url: "",
        version: "",
      },
      routeModules: {},
      future: {},
      ssr: true,
      isSpaMode: false,
      routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
      branches: [],
    };
    const loadContext = {
      shopify: { addDocumentResponseHeaders: vi.fn() },
    };

    const response = await entryServer.default(
      request,
      410,
      responseHeaders,
      reactRouterContext as unknown as Parameters<typeof entryServer.default>[3],
      loadContext as unknown as Parameters<typeof entryServer.default>[4]
    );

    expect(response.status).toBe(410);
  });
});
