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
 * The mock calls onError synchronously with the test's renderError value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";

vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

let renderError: unknown = null;

vi.mock("react-dom/server", () => ({
  renderToReadableStream: vi.fn(
    async (
      _element: ReactNode,
      options?: { onError?: (error: unknown) => void }
    ) => {
      if (renderError !== null && options?.onError) {
        options.onError(renderError);
      }
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
    renderError = null;
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

  describe("render path onError callback", () => {
    async function callHandleRequestWithRenderError(errorToThrow: unknown) {
      renderError = errorToThrow;

      const entryServer = await import("../entry.server");

      const request = new Request("https://test-store.example.com/app");
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

      return entryServer.default(
        request,
        200,
        responseHeaders,
        reactRouterContext as unknown as Parameters<typeof entryServer.default>[3],
        loadContext as unknown as Parameters<typeof entryServer.default>[4]
      );
    }

    it("does not log ssr_render_error for 410 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const response = await callHandleRequestWithRenderError(
        new Response(null, { status: 410 })
      );
      await response.text();

      const allConsoleOutput = [
        ...consoleErrorSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ]
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).not.toContain("ssr_render_error");
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("does not log ssr_render_error for 404 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const response = await callHandleRequestWithRenderError(
        new Response(null, { status: 404 })
      );
      await response.text();

      const allConsoleOutput = [
        ...consoleErrorSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ]
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).not.toContain("ssr_render_error");
      expect(mockCapture).not.toHaveBeenCalled();
    });

    it("logs ssr_render_error for 500 Response", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const response = await callHandleRequestWithRenderError(
        new Response("error", { status: 500 })
      );
      await response.text();

      const allConsoleOutput = [
        ...consoleErrorSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ]
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).toContain("ssr_render_error");
    });

    it("logs ssr_render_error for thrown Error", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      mockCapture.mockClear();

      const response = await callHandleRequestWithRenderError(
        new Error("something went wrong")
      );
      await response.text();

      const allConsoleOutput = [
        ...consoleErrorSpy.mock.calls,
        ...consoleWarnSpy.mock.calls,
        ...consoleLogSpy.mock.calls,
      ]
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).toContain("ssr_render_error");
    });
  });
});
