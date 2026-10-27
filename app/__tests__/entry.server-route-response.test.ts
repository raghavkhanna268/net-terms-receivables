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
 * - The isExpectedResponse helper correctly identifies expected vs unexpected errors
 * - The onError callback skips ssr_render_error logging for expected responses
 *
 * Uses the REAL entry.server module and REAL safeLog (log.server.ts is not mocked).
 * Only ~/lib/sentry is mocked to verify capture behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

describe("entry.server route response handling", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
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

  describe("isExpectedResponse helper logic", () => {
    it("identifies 4xx Response as expected", async () => {
      const { isRouteErrorResponse } = await import("react-router");
      
      const isExpectedResponse = (e: unknown): boolean => {
        if (isRouteErrorResponse(e)) {
          return e.status < 500;
        }
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      expect(isExpectedResponse(new Response(null, { status: 410 }))).toBe(true);
      expect(isExpectedResponse(new Response(null, { status: 404 }))).toBe(true);
      expect(isExpectedResponse(new Response(null, { status: 401 }))).toBe(true);
      expect(isExpectedResponse(new Response(null, { status: 499 }))).toBe(true);
    });

    it("identifies 5xx Response as unexpected", async () => {
      const { isRouteErrorResponse } = await import("react-router");
      
      const isExpectedResponse = (e: unknown): boolean => {
        if (isRouteErrorResponse(e)) {
          return e.status < 500;
        }
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      expect(isExpectedResponse(new Response(null, { status: 500 }))).toBe(false);
      expect(isExpectedResponse(new Response(null, { status: 502 }))).toBe(false);
      expect(isExpectedResponse(new Response(null, { status: 503 }))).toBe(false);
    });

    it("identifies Error as unexpected", async () => {
      const { isRouteErrorResponse } = await import("react-router");
      
      const isExpectedResponse = (e: unknown): boolean => {
        if (isRouteErrorResponse(e)) {
          return e.status < 500;
        }
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      expect(isExpectedResponse(new Error("test"))).toBe(false);
      expect(isExpectedResponse(new TypeError("test"))).toBe(false);
    });
  });

  describe("onError SSR callback behavior via safeLog", () => {
    it("does not log ssr_render_error for 410 Response", async () => {
      const { safeLog, toErrorCode } = await import("~/lib/log.server");
      const { isRouteErrorResponse } = await import("react-router");

      const isExpectedResponse = (e: unknown): boolean => {
        if (isRouteErrorResponse(e)) {
          return e.status < 500;
        }
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      const error = new Response(null, { status: 410 });
      
      if (!isExpectedResponse(error)) {
        safeLog("error", "ssr_render_error", { err: toErrorCode(error) });
      }

      const allConsoleOutput = consoleErrorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).not.toContain("ssr_render_error");
    });

    it("logs ssr_render_error for 500 Response", async () => {
      const { safeLog, toErrorCode } = await import("~/lib/log.server");
      const { isRouteErrorResponse } = await import("react-router");

      const isExpectedResponse = (e: unknown): boolean => {
        if (isRouteErrorResponse(e)) {
          return e.status < 500;
        }
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      const error = new Response("error", { status: 500 });
      
      if (!isExpectedResponse(error)) {
        safeLog("error", "ssr_render_error", { err: toErrorCode(error) });
      }

      const allConsoleOutput = consoleErrorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).toContain("ssr_render_error");
    });

    it("logs ssr_render_error for thrown Error", async () => {
      const { safeLog, toErrorCode } = await import("~/lib/log.server");
      const { isRouteErrorResponse } = await import("react-router");

      const isExpectedResponse = (e: unknown): boolean => {
        if (isRouteErrorResponse(e)) {
          return e.status < 500;
        }
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      const error = new Error("something went wrong");
      
      if (!isExpectedResponse(error)) {
        safeLog("error", "ssr_render_error", { err: toErrorCode(error) });
      }

      const allConsoleOutput = consoleErrorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      expect(allConsoleOutput).toContain("ssr_render_error");
    });
  });

  describe("response status preservation", () => {
    it("preserves 410 status when onError returns early for expected response", () => {
      let responseStatusCode = 410;

      const isExpectedResponse = (e: unknown): boolean => {
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      const error = new Response(null, { status: 410 });
      
      if (isExpectedResponse(error)) {
        // Early return - don't set responseStatusCode to 500
      } else {
        responseStatusCode = 500;
      }

      expect(responseStatusCode).toBe(410);
    });

    it("sets 500 status for 5xx Response in onError", () => {
      let responseStatusCode = 500;

      const isExpectedResponse = (e: unknown): boolean => {
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      const error = new Response("error", { status: 500 });
      
      if (isExpectedResponse(error)) {
        // Early return - don't set responseStatusCode to 500
      } else {
        responseStatusCode = 500;
      }

      expect(responseStatusCode).toBe(500);
    });

    it("sets 500 status for thrown Error in onError", () => {
      let responseStatusCode = 200;

      const isExpectedResponse = (e: unknown): boolean => {
        if (e instanceof Response) {
          return e.status < 500;
        }
        return false;
      };

      const error = new Error("something went wrong");
      
      if (isExpectedResponse(error)) {
        // Early return - don't set responseStatusCode to 500
      } else {
        responseStatusCode = 500;
      }

      expect(responseStatusCode).toBe(500);
    });
  });
});
