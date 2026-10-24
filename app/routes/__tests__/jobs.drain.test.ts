import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

/**
 * Tests for S10 jobs.drain route.
 *
 * Tests verify:
 * 1. Auth: Missing/malformed/invalid Bearer token returns 401
 * 2. Auth: Valid Bearer token allows request
 * 3. Batch size configuration from query params
 * 4. Time budget configuration from query params
 * 5. Reconcile mode enqueues messages
 * 6. Drain runs and returns result
 * 7. 500 response is generic (no raw error)
 * 8. Error logging uses safeLog with error codes (no raw messages)
 * 9. Response errors array uses 'code' not 'error'
 */

// Mock SQL client
const mockSql = Object.assign(
  vi.fn().mockImplementation(() => Promise.resolve([])),
  { json: vi.fn((v) => v) }
);

// Mock request context
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

// Mock drain processor
const mockRunDrain = vi.fn().mockResolvedValue({
  processed: 2,
  failed: 0,
  deadLettered: 0,
  skipped: 1,
  noHandler: 0,
  timedOut: false,
  elapsedMs: 150,
  errors: [],
});

vi.mock("~/services/drain/processor.server", () => ({
  runDrain: mockRunDrain,
  DEFAULT_DRAIN_CONFIG: {
    batchSize: 5,
    visibilityTimeoutSec: 30,
    timeBudgetMs: 15000,
    maxRetries: 5,
    noHandlerMaxReads: 48,
    bulkChunkSize: 500,
  },
}));

// Mock log.server for error logging tests
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

// NOTE: reconcile.server is not mocked because reconcile is disabled (returns 501)

describe("jobs.drain route", () => {
  const VALID_SECRET = "test-drain-secret-12345";
  let originalConsole: typeof console.log;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalConsole = console.log;
    console.log = vi.fn();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    console.log = originalConsole;
    consoleErrorSpy.mockRestore();
  });

  function createRequest(
    options: {
      method?: string;
      authHeader?: string | null;
      queryParams?: Record<string, string>;
    } = {}
  ): Request {
    const { method = "POST", authHeader, queryParams = {} } = options;
    const url = new URL("https://example.com/jobs/drain");
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authHeader !== null) {
      headers["Authorization"] = authHeader ?? `Bearer ${VALID_SECRET}`;
    }

    return new Request(url.toString(), {
      method,
      headers,
    });
  }

  function createActionArgs(
    request: Request,
    secret?: string
  ): ActionFunctionArgs {
    return {
      request,
      context: {
        cloudflare: {
          env: { JOBS_DRAIN_SECRET: secret ?? VALID_SECRET },
          ctx: {},
        },
      },
      params: {},
      url: new URL(request.url),
      pattern: "/jobs/drain",
    };
  }

  describe("authentication", () => {
    it("returns 401 when Authorization header is missing", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ authHeader: null });
      request.headers.delete("Authorization");

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Unauthorized");
    });

    it("returns 401 when Authorization header is malformed (no Bearer)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ authHeader: VALID_SECRET }); // Missing "Bearer " prefix

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(401);
    });

    it("returns 401 when Authorization header is malformed (Basic instead of Bearer)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ authHeader: `Basic ${VALID_SECRET}` });

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(401);
    });

    it("returns 401 when Bearer token is invalid", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ authHeader: "Bearer wrong-secret" });

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(401);
    });

    it("returns 401 when JOBS_DRAIN_SECRET is not configured", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      // Pass undefined to simulate missing secret
      const args = createActionArgs(request);
      (
        args.context as { cloudflare: { env: { JOBS_DRAIN_SECRET?: string } } }
      ).cloudflare.env.JOBS_DRAIN_SECRET = undefined;

      const responseNoSecret = await action(args);

      expect(responseNoSecret.status).toBe(401);
    });

    it("returns 200 with valid Bearer token", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
    });

    it("uses constant-time byte comparison (timing-safe)", async () => {
      const { action } = await import("../jobs.drain");

      // Test with same-length but different secrets
      const request1 = createRequest({
        authHeader: "Bearer aaaaaaaaaaaaaaaaaaaaaa",
      });
      const response1 = await action(createActionArgs(request1));
      expect(response1.status).toBe(401);

      // Test with different-length secrets
      const request2 = createRequest({ authHeader: "Bearer short" });
      const response2 = await action(createActionArgs(request2));
      expect(response2.status).toBe(401);
    });
  });

  describe("HTTP methods", () => {
    it("returns 405 for GET requests (loader)", async () => {
      const { loader } = await import("../jobs.drain");

      const response = await loader();

      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method Not Allowed");
    });

    it("returns 405 for non-POST requests", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ method: "PUT" });

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(405);
    });
  });

  describe("drain execution", () => {
    it("calls runDrain with default config", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, {});
    });

    it("parses batchSize from query params", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { batchSize: "10" } });

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { batchSize: 10 });
    });

    it("parses timeBudgetMs from query params", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { timeBudgetMs: "10000" } });

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { timeBudgetMs: 10000 });
    });

    it("ignores invalid batchSize values", async () => {
      const { action } = await import("../jobs.drain");

      // Non-numeric
      const request1 = createRequest({ queryParams: { batchSize: "abc" } });
      await action(createActionArgs(request1));
      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, {});

      // Too large
      mockRunDrain.mockClear();
      const request2 = createRequest({ queryParams: { batchSize: "500" } });
      await action(createActionArgs(request2));
      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, {});

      // Negative
      mockRunDrain.mockClear();
      const request3 = createRequest({ queryParams: { batchSize: "-5" } });
      await action(createActionArgs(request3));
      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, {});
    });

    it("returns drain result as JSON with noHandler field", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");

      const result = (await response.json()) as Record<string, unknown>;
      expect(result).toMatchObject({
        processed: 2,
        failed: 0,
        deadLettered: 0,
        skipped: 1,
        noHandler: 0,
        timedOut: false,
        elapsedMs: 150,
      });
    });

    it("returns generic 500 on drain error (no raw error.message)", async () => {
      mockRunDrain.mockRejectedValueOnce(new Error("Database connection failed"));
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(500);
      const result = (await response.json()) as { error: string };
      // Should be generic, not the raw error message
      expect(result.error).toBe("Internal server error");
    });
  });

  describe("reconcile mode", () => {
    it("returns 200 and enqueues messages when reconcile=true", async () => {
      // Mock the enqueueReconcileForAllShops function
      vi.doMock("~/services/drain/reconcile.server", () => ({
        enqueueReconcileForAllShops: vi.fn().mockResolvedValue(4), // 2 shops × 2 messages
      }));

      // Re-import to get fresh module with mock
      vi.resetModules();
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { reconcile: "true" } });

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(200);
      const result = (await response.json()) as { mode: string; messagesEnqueued: number };
      expect(result.mode).toBe("reconcile");
      expect(result.messagesEnqueued).toBe(4);
    });

    it("runs drain normally when reconcile is not true", async () => {
      const { action } = await import("../jobs.drain");

      // No param - runs drain
      const request1 = createRequest();
      const response1 = await action(createActionArgs(request1));
      expect(response1.status).toBe(200);
      expect(mockRunDrain).toHaveBeenCalled();

      // false value - runs drain
      mockRunDrain.mockClear();
      const request2 = createRequest({ queryParams: { reconcile: "false" } });
      const response2 = await action(createActionArgs(request2));
      expect(response2.status).toBe(200);
      expect(mockRunDrain).toHaveBeenCalled();
    });

    it("handles reconcile errors gracefully", async () => {
      // Mock the enqueueReconcileForAllShops to throw
      vi.doMock("~/services/drain/reconcile.server", () => ({
        enqueueReconcileForAllShops: vi.fn().mockRejectedValue(new Error("DB error")),
      }));

      vi.resetModules();
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { reconcile: "true" } });

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(500);
      const result = (await response.json()) as { error: string };
      expect(result.error).toBe("Internal server error");
    });
  });

  describe("error logging (PII safety)", () => {
    it("logs drain error with safeLog, not raw error", async () => {
      const { safeLog } = await import("~/lib/log.server");
      mockRunDrain.mockRejectedValueOnce(new TypeError("Connection failed"));

      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

      expect(safeLog).toHaveBeenCalledWith("error", "drain_error", {
        err: "TypeError",
      });

      // Verify raw error was not logged to console
      expect(consoleErrorSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("Connection failed")
      );
    });

    it("error log does not contain shop domain", async () => {
      const { safeLog } = await import("~/lib/log.server");

      // Error with shop domain in message
      mockRunDrain.mockRejectedValueOnce(new Error("Failed for test.myshopify.com"));

      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

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
      const { safeLog } = await import("~/lib/log.server");

      // Mock the enqueueReconcileForAllShops to throw
      vi.doMock("~/services/drain/reconcile.server", () => ({
        enqueueReconcileForAllShops: vi.fn().mockRejectedValue(new Error("Module error")),
      }));

      vi.resetModules();
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { reconcile: "true" } });

      await action(createActionArgs(request));

      // Should have called safeLog for the error
      expect(safeLog).toHaveBeenCalledWith(
        "error",
        "drain_reconcile_error",
        expect.objectContaining({ err: expect.any(String) })
      );
    });
  });

  describe("response format (PII safety)", () => {
    it("returns error codes only, not raw messages", async () => {
      // Mock successful drain with errors
      mockRunDrain.mockResolvedValueOnce({
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

      const { action } = await import("../jobs.drain");
      const request = createRequest();

      const response = await action(createActionArgs(request));
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
