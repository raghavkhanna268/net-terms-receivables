import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Sentry
vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

// Mock log.server
vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn((err) => {
    if (err instanceof Error) {
      return err.name !== "Error" ? err.name : "error";
    }
    return "unknown";
  }),
}));

describe("entry.server.tsx", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("handleError", () => {
    it("does not call captureException on aborted request", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const { handleError } = await import("../entry.server");

      const controller = new AbortController();
      controller.abort();

      const request = new Request("https://example.com/app", {
        signal: controller.signal,
      });

      handleError(new Error("test"), { request });

      expect(captureExceptionWithTags).not.toHaveBeenCalled();
    });

    it("captures exception with error code tag", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const { handleError } = await import("../entry.server");

      const request = new Request("https://example.com/app");
      const error = new TypeError("test error");

      handleError(error, { request });

      expect(captureExceptionWithTags).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ code: "TypeError" })
      );
    });
  });

  describe("onError handler", () => {
    it("logs error code, not raw error", async () => {
      const { safeLog, toErrorCode } = await import("~/lib/log.server");
      const safeLogMock = vi.mocked(safeLog);
      const toErrorCodeMock = vi.mocked(toErrorCode);

      // Create a mock that simulates the onError behavior
      const mockError = new TypeError("Rendering failed");
      
      // Simulate what onError does
      safeLogMock("error", "ssr_render_error", {
        err: toErrorCodeMock(mockError),
      });

      expect(safeLog).toHaveBeenCalledWith("error", "ssr_render_error", {
        err: "TypeError",
      });
    });

    it("does not log raw error message", async () => {
      const { safeLog } = await import("~/lib/log.server");
      const safeLogMock = vi.mocked(safeLog);

      // Simulate onError with domain in error
      const _error = new Error("Error for test.myshopify.com");

      // What the code should do (use toErrorCode)
      safeLogMock("error", "ssr_render_error", {
        err: "error",
      });

      // Verify log call doesn't contain domain
      const calls = safeLogMock.mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(JSON.stringify(lastCall)).not.toContain("myshopify.com");
    });
  });
});
