/**
 * Tests for entry.server's handling of thrown responses that reach the render.
 *
 * When a route throws a Response (e.g., 410 or 500), and there's no ErrorBoundary
 * that catches it (or the boundary rethrows), the error reaches entry.server's
 * onError callback and handleError function.
 *
 * This test suite verifies:
 * - handleError skips Sentry capture for expected 4xx route responses (e.g., 410)
 * - handleError calls Sentry capture for 5xx responses and thrown Errors
 * - The real render path's onError callback honors the same logic
 *
 * Uses the REAL entry.server module and REAL safeLog (log.server.ts is not mocked).
 * Only ~/lib/sentry is mocked to verify capture behavior.
 * react-dom/server is mocked because renderToReadableStream is only available in
 * edge environments (Cloudflare Workers), not in Node.js test environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { createRequestHandler, useRouteError } from "react-router";
import type { ServerBuild } from "react-router";
import * as React from "react";

vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

let _capturedOnError: ((error: unknown) => void) | null = null;

vi.mock("react-dom/server", () => ({
  renderToReadableStream: vi.fn(
    async (
      _element: ReactNode,
      options?: { onError?: (error: unknown) => void }
    ) => {
      _capturedOnError = options?.onError ?? null;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("<html><body>mock</body></html>")
          );
          controller.close();
        },
      });
    }
  ),
}));

describe("entry.server route response handling", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    _capturedOnError = null;
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  describe("handleError function", () => {
    it("does not call captureExceptionWithTags for 410 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const { handleError } = await import("../entry.server");

      const request = new Request("https://test-store.example.com/app");
      const error = new Response(null, { status: 410 });

      handleError(error, { request });

      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("does not call captureExceptionWithTags for 404 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const { handleError } = await import("../entry.server");

      const request = new Request("https://test-store.example.com/app");
      const error = new Response(null, { status: 404 });

      handleError(error, { request });

      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("calls captureExceptionWithTags for 500 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const { handleError } = await import("../entry.server");

      const request = new Request("https://test-store.example.com/app");
      const error = new Response("error", { status: 500 });

      handleError(error, { request });

      expect(mockCapture).toHaveBeenCalled();
    });

    it("calls captureExceptionWithTags for thrown Error", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const { handleError } = await import("../entry.server");

      const request = new Request("https://test-store.example.com/app");
      const error = new Error("something went wrong");

      handleError(error, { request });

      expect(mockCapture).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ code: "error" })
      );
    });

    it("does not call captureExceptionWithTags for aborted request", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const { handleError } = await import("../entry.server");

      const controller = new AbortController();
      controller.abort();

      const request = new Request("https://test-store.example.com/app", {
        signal: controller.signal,
      });

      handleError(new Error("test"), { request });

      expect(mockCapture).not.toHaveBeenCalled();
    });
  });

  describe("render path via createRequestHandler", () => {
    function RethrowingErrorBoundary(): React.ReactNode {
      const error = useRouteError();
      throw error;
    }

    async function createTestBuild(
      loaderError: Response | Error
    ): Promise<ServerBuild> {
      const entryModule = await import("../entry.server");

      return {
        entry: { module: entryModule },
        routes: {
          root: {
            id: "root",
            path: "",
            module: {
              default: function Root({
                children,
              }: {
                children?: React.ReactNode;
              }) {
                return React.createElement(
                  "html",
                  null,
                  React.createElement("body", null, children)
                );
              },
              ErrorBoundary: RethrowingErrorBoundary,
            },
          },
          "routes/test": {
            id: "routes/test",
            parentId: "root",
            path: "test",
            module: {
              loader() {
                throw loaderError;
              },
              default: function TestRoute() {
                return React.createElement("div", null, "test content");
              },
              ErrorBoundary: RethrowingErrorBoundary,
            },
          },
        },
        assets: {
          entry: { imports: [], module: "/build/entry.client.js" },
          routes: {
            root: {
              id: "root",
              path: "",
              hasAction: false,
              hasLoader: false,
              hasClientAction: false,
              hasClientLoader: false,
              hasClientMiddleware: false,
              hasErrorBoundary: true,
              module: "/build/root.js",
              clientActionModule: undefined,
              clientLoaderModule: undefined,
              clientMiddlewareModule: undefined,
              hydrateFallbackModule: undefined,
            },
            "routes/test": {
              id: "routes/test",
              parentId: "root",
              path: "test",
              hasAction: false,
              hasLoader: true,
              hasClientAction: false,
              hasClientLoader: false,
              hasClientMiddleware: false,
              hasErrorBoundary: true,
              module: "/build/routes/test.js",
              clientActionModule: undefined,
              clientLoaderModule: undefined,
              clientMiddlewareModule: undefined,
              hydrateFallbackModule: undefined,
            },
          },
          url: "/build/manifest.json",
          version: "test",
        },
        basename: undefined,
        publicPath: "/build/",
        assetsBuildDirectory: "public/build",
        future: {
          v8_passThroughRequests: false,
          v8_trailingSlashAwareDataRequests: false,
          v8_middleware: false,
        },
        ssr: true,
        isSpaMode: false,
        prerender: [],
        routeDiscovery: {
          mode: "initial",
          manifestPath: "/__manifest",
        },
      } as ServerBuild;
    }

    it("returns 410 status, no ssr_render_error log, no Sentry capture for 410 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const build = await createTestBuild(new Response(null, { status: 410 }));
      const handler = createRequestHandler(build, "test");

      const request = new Request("https://test-store.example.com/test");
      const loadContext = {
        shopify: { addDocumentResponseHeaders: vi.fn() },
        cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
        sessionStorage: {},
      };

      const response = await handler(request, loadContext as unknown as Parameters<typeof handler>[1]);
      await response.text();

      expect(response.status).toBe(410);

      const allConsoleOutput = consoleErrorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");
      expect(allConsoleOutput).not.toContain("ssr_render_error");

      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("returns 500 status for 500 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const build = await createTestBuild(
        new Response("error", { status: 500 })
      );
      const handler = createRequestHandler(build, "test");

      const request = new Request("https://test-store.example.com/test");
      const loadContext = {
        shopify: { addDocumentResponseHeaders: vi.fn() },
        cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
        sessionStorage: {},
      };

      const response = await handler(request, loadContext as unknown as Parameters<typeof handler>[1]);
      await response.text();

      expect(response.status).toBe(500);
    });

    it("returns 500 status, logs ssr_render_error, calls Sentry capture for thrown Error", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const build = await createTestBuild(new Error("something went wrong"));
      const handler = createRequestHandler(build, "test");

      const request = new Request("https://test-store.example.com/test");
      const loadContext = {
        shopify: { addDocumentResponseHeaders: vi.fn() },
        cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
        sessionStorage: {},
      };

      const response = await handler(request, loadContext as unknown as Parameters<typeof handler>[1]);
      await response.text();

      expect(response.status).toBe(500);

      expect(mockCapture).toHaveBeenCalled();
    });
  });
});
