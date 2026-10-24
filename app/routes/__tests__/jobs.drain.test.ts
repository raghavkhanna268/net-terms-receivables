import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock dependencies
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("~/services/drain/processor.server", () => ({
  runDrain: vi.fn(),
}));

vi.mock("~/lib/log.server", () => ({
  safeLog: vi.fn(),
  toErrorCode: vi.fn((err) => {
    if (err && typeof err === "object" && "code" in err) {
      return (err as { code: string }).code;
    }
    if (err instanceof Error) {
      return err.name !== "Error" ? err.name : "error";
    }
    return "unknown";
  }),
}));

function createActionArgs(options: {
  url?: string;
  secret?: string;
  method?: string;
}) {
  const urlStr = options.url ?? "https://example.com/jobs/drain";
  return {
    request: new Request(urlStr, {
      method: options.method ?? "POST",
      headers: {
        Authorization: `Bearer ${options.secret ?? "test-secret"}`,
      },
    }),
    context: {
      cloudflare: {
        env: { JOBS_DRAIN_SECRET: options.secret ?? "test-secret" },
      },
    },
    params: {},
    url: new URL(urlStr),
    pattern: "/jobs/drain",
  };
}

describe("jobs.drain route", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe("error handling", () => {
    it("logs drain error with safeLog, not raw error", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { runDrain } = await import("~/services/drain/processor.server");
      const { safeLog } = await import("~/lib/log.server");
      const { action } = await import("../jobs.drain");

      const mockSql = vi.fn();
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const testError = new TypeError("Connection failed");
      (runDrain as ReturnType<typeof vi.fn>).mockRejectedValue(testError);

      await action(createActionArgs({}));

      expect(safeLog).toHaveBeenCalledWith("error", "drain_error", {
        err: "TypeError",
      });

      // Verify raw error was not logged
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Connection failed")
      );
    });

    it("error log does not contain shop domain", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { runDrain } = await import("~/services/drain/processor.server");
      const { safeLog } = await import("~/lib/log.server");
      const { action } = await import("../jobs.drain");

      const mockSql = vi.fn();
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Error with shop domain in message
      const testError = new Error("Failed for test.myshopify.com");
      (runDrain as ReturnType<typeof vi.fn>).mockRejectedValue(testError);

      await action(createActionArgs({}));

      // Check safeLog was called
      expect(safeLog).toHaveBeenCalled();

      // Get all safeLog calls and verify none contain myshopify.com
      const calls = (safeLog as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of calls) {
        const callStr = JSON.stringify(call);
        expect(callStr).not.toContain("myshopify.com");
      }
    });

    it("reconcile error uses safeLog with error code", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { safeLog } = await import("~/lib/log.server");
      const { action } = await import("../jobs.drain");

      const mockSql = vi.fn();
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Mock the dynamic import to throw
      vi.doMock("~/services/drain/reconcile.server", () => {
        throw new Error("Module load error");
      });

      await action(createActionArgs({ url: "https://example.com/jobs/drain?reconcile=true" }));

      // Should have called safeLog for the error
      expect(safeLog).toHaveBeenCalledWith(
        "error",
        "drain_reconcile_error",
        expect.objectContaining({ err: expect.any(String) })
      );
    });
  });

  describe("response format", () => {
    it("returns error codes only, not raw messages", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      const { runDrain } = await import("~/services/drain/processor.server");
      const { action } = await import("../jobs.drain");

      const mockSql = vi.fn();
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Mock successful drain with errors
      (runDrain as ReturnType<typeof vi.fn>).mockResolvedValue({
        processed: 5,
        failed: 1,
        deadLettered: 1,
        skipped: 2,
        noHandler: 0,
        timedOut: false,
        elapsedMs: 1500,
        errors: [
          { msgId: "123", topic: "ORDERS_CREATE", code: "network_error" },
        ],
      });

      const response = await action(createActionArgs({}));
      const body = (await response.json()) as { errors: Array<{ code?: string; error?: string }> };

      // Verify errors array has 'code' not 'error'
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toHaveProperty("code", "network_error");
      expect(body.errors[0]).not.toHaveProperty("error");

      // Verify no shop domains in response
      const responseStr = JSON.stringify(body);
      expect(responseStr).not.toContain("myshopify.com");
    });
  });
});
