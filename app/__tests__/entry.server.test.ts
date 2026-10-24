import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Sentry - still needed for captureExceptionWithTags
vi.mock("~/lib/sentry", () => ({
  captureExceptionWithTags: vi.fn(),
}));

// NOTE: log.server is NOT mocked - we test the real safeLog/toErrorCode

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

  describe("onError handler (PII safety)", () => {
    /**
     * These tests use the REAL safeLog/toErrorCode (not mocked).
     * They spy on console.error to capture actual output and verify:
     * 1. Output contains expected event name and error code
     * 2. Output does NOT contain PII (domain, email, free text)
     *
     * We test the onError behavior by calling the real handleError function
     * with errors containing PII, since both use the same toErrorCode path.
     * The SSR onError callback uses the same pattern: safeLog("error", "ssr_render_error", { err: toErrorCode(error) })
     */

    it("handleError uses real toErrorCode to extract code, no PII in Sentry tag", async () => {
      const { captureExceptionWithTags } = await import("~/lib/sentry");
      const mockCapture = vi.mocked(captureExceptionWithTags);
      const { handleError } = await import("../entry.server");

      // Error containing fictional domain, email, and free text
      const piiError = new TypeError(
        "Render failed for handle-shop.myshopify.com, contact render@example.com: component state corrupted"
      );

      const request = new Request("https://example.com/app");
      handleError(piiError, { request });

      // Verify captureExceptionWithTags was called with error code, not raw message
      expect(mockCapture).toHaveBeenCalledWith(piiError, { code: "TypeError" });

      // The code tag should be just the error name, no PII
      const callArgs = mockCapture.mock.calls[0];
      const tags = callArgs[1] as Record<string, string>;
      expect(tags.code).toBe("TypeError");
      expect(tags.code).not.toContain("myshopify.com");
      expect(tags.code).not.toContain("render@example.com");
      expect(tags.code).not.toContain("component state corrupted");
    });

    it("real toErrorCode converts PII-laden error to safe code", async () => {
      const { toErrorCode } = await import("~/lib/log.server");

      // Error containing fictional domain, email, and free text
      const piiError = new Error(
        "SSR crash for ssr-shop.myshopify.com, user ssr@example.com: hydration mismatch in UserProfile"
      );

      const code = toErrorCode(piiError);

      // Code should be safe - just "error" for generic Error with name="Error"
      expect(code).toBe("error");
      expect(code).not.toContain("myshopify.com");
      expect(code).not.toContain("ssr-shop");
      expect(code).not.toContain("ssr@example.com");
      expect(code).not.toContain("hydration mismatch");
    });

    it("real safeLog with err key routes through toErrorCode, no PII leaked", async () => {
      const { safeLog } = await import("~/lib/log.server");

      // Error containing fictional domain, email, and free text
      const piiError = new TypeError(
        "Component error for log-shop.myshopify.com, contact log@example.com: state update on unmounted"
      );

      // Call safeLog the same way onError does
      safeLog("error", "ssr_render_error", { err: piiError });

      // Capture the console.error output
      expect(consoleErrorSpy).toHaveBeenCalled();

      const logOutput = consoleErrorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      // Find the ssr_render_error log
      expect(logOutput).toContain("ssr_render_error");

      // Parse to verify structure
      const ssrLog = consoleErrorSpy.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("ssr_render_error")
      );
      expect(ssrLog).toBeDefined();

      const parsed = JSON.parse(ssrLog![0] as string);
      expect(parsed.event).toBe("ssr_render_error");
      expect(parsed.err).toBe("TypeError");

      // Verify NO PII leaked in the log output
      expect(logOutput).not.toContain("myshopify.com");
      expect(logOutput).not.toContain("log-shop");
      expect(logOutput).not.toContain("log@example.com");
      expect(logOutput).not.toContain("state update on unmounted");
      expect(logOutput).not.toContain("Component error");
    });
  });
});
