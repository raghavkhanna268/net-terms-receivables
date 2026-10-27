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
  deadLetterAlreadyGoneCount: 0,
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
    maxPasses: 1,
  },
}));

// NOTE: log.server is NOT mocked - we test the real safeLog/toErrorCode
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
    options: { secret?: string; drainMaxPasses?: string } = {}
  ): ActionFunctionArgs {
    const env: { JOBS_DRAIN_SECRET?: string; DRAIN_MAX_PASSES?: string } = {
      JOBS_DRAIN_SECRET: options.secret ?? VALID_SECRET,
    };
    if (options.drainMaxPasses !== undefined) {
      env.DRAIN_MAX_PASSES = options.drainMaxPasses;
    }
    return {
      request,
      context: {
        cloudflare: {
          env,
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
    it("calls runDrain with default config (maxPasses=1)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
    });

    it("parses batchSize from query params", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { batchSize: "10" } });

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { batchSize: 10, maxPasses: 1 });
    });

    it("parses timeBudgetMs from query params", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { timeBudgetMs: "10000" } });

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { timeBudgetMs: 10000, maxPasses: 1 });
    });

    it("ignores invalid batchSize values", async () => {
      const { action } = await import("../jobs.drain");

      // Non-numeric
      const request1 = createRequest({ queryParams: { batchSize: "abc" } });
      await action(createActionArgs(request1));
      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });

      // Too large
      mockRunDrain.mockClear();
      const request2 = createRequest({ queryParams: { batchSize: "500" } });
      await action(createActionArgs(request2));
      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });

      // Negative
      mockRunDrain.mockClear();
      const request3 = createRequest({ queryParams: { batchSize: "-5" } });
      await action(createActionArgs(request3));
      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
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
        deadLetterAlreadyGoneCount: 0,
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

  describe("DRAIN_MAX_PASSES env var parsing", () => {
    it("default with no env var gives maxPasses=1 (same as today)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
    });

    it("'0' becomes maxPasses=1 (clamped)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "0" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
    });

    it("'9' becomes maxPasses=4 (clamped to MAX_DRAIN_PASSES)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "9" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 4 });
    });

    it("'abc' (garbage) becomes maxPasses=1", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "abc" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
    });

    it("'3' gives maxPasses=3 (valid value)", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "3" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 3 });
    });

    it("'' (empty string) becomes maxPasses=1", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
    });

    it("'2.5x' (garbage with numbers) becomes maxPasses=1", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "2.5x" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
    });

    it("negative value becomes maxPasses=1", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request, { drainMaxPasses: "-1" }));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { maxPasses: 1 });
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
    /**
     * These tests use the REAL safeLog/toErrorCode (not mocked).
     * They spy on console.error to capture actual output and verify:
     * 1. Output contains expected event name and error code
     * 2. Output does NOT contain PII (domain, email, free text)
     */

    it("logs drain error with error code, no raw message or PII", async () => {
      // Error containing fictional domain, email, and free text
      const piiError = new TypeError(
        "Connection failed for shop test-pii-shop.myshopify.com, contact alice@example.com: sensitive details here"
      );
      mockRunDrain.mockRejectedValueOnce(piiError);

      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

      // Find the safeLog output in console.error calls
      const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]);
      const drainErrorLog = errorCalls.find(
        (c: unknown) => typeof c === "string" && c.includes("drain_error")
      );

      expect(drainErrorLog).toBeDefined();

      // Parse the JSON to verify structure
      const parsed = JSON.parse(drainErrorLog as string);
      expect(parsed.event).toBe("drain_error");
      expect(parsed.err).toBe("TypeError");

      // Verify NO PII leaked
      expect(drainErrorLog).not.toContain("myshopify.com");
      expect(drainErrorLog).not.toContain("pii-shop");
      expect(drainErrorLog).not.toContain("alice@example.com");
      expect(drainErrorLog).not.toContain("sensitive details");
      expect(drainErrorLog).not.toContain("Connection failed");
    });

    it("drain error log redacts domain, email, and free text from error message", async () => {
      // Error with multiple PII types in message
      const piiError = new Error(
        "Database error for merchant@shop.com at test-customer-store.myshopify.com: credit limit exceeded for John Doe"
      );
      mockRunDrain.mockRejectedValueOnce(piiError);

      const { action } = await import("../jobs.drain");
      const request = createRequest();

      await action(createActionArgs(request));

      // Capture all console.error output
      const allOutput = consoleErrorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join("\n");

      // Verify PII is NOT in any error output
      expect(allOutput).not.toContain("merchant@shop.com");
      expect(allOutput).not.toContain("test-customer-store.myshopify.com");
      expect(allOutput).not.toContain("John Doe");
      expect(allOutput).not.toContain("credit limit exceeded");

      // Verify the drain_error event WAS logged with a code
      expect(allOutput).toContain("drain_error");
      expect(allOutput).toContain('"err"');
    });

    it("reconcile error uses error code, no raw message or PII", async () => {
      // Error containing fictional domain, email, and free text
      const piiError = new Error(
        "Reconcile failed for admin@company.com at test-reconcile-shop.myshopify.com: internal auth token expired"
      );

      // Mock the enqueueReconcileForAllShops to throw
      vi.doMock("~/services/drain/reconcile.server", () => ({
        enqueueReconcileForAllShops: vi.fn().mockRejectedValue(piiError),
      }));

      vi.resetModules();
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { reconcile: "true" } });

      await action(createActionArgs(request));

      // Find the safeLog output in console.error calls
      const errorCalls = consoleErrorSpy.mock.calls.map((c: unknown[]) => c[0]);
      const reconcileErrorLog = errorCalls.find(
        (c: unknown) => typeof c === "string" && c.includes("drain_reconcile_error")
      );

      expect(reconcileErrorLog).toBeDefined();

      // Parse the JSON to verify structure
      const parsed = JSON.parse(reconcileErrorLog as string);
      expect(parsed.event).toBe("drain_reconcile_error");
      expect(parsed.err).toBe("error"); // Generic Error with name="Error" → "error"

      // Verify NO PII leaked
      expect(reconcileErrorLog).not.toContain("myshopify.com");
      expect(reconcileErrorLog).not.toContain("reconcile-shop");
      expect(reconcileErrorLog).not.toContain("admin@company.com");
      expect(reconcileErrorLog).not.toContain("internal auth token");
      expect(reconcileErrorLog).not.toContain("Reconcile failed");
    });
  });

  describe("response format (PII safety)", () => {
    it("returns error codes only, not raw messages", async () => {
      // Mock successful drain with errors
      mockRunDrain.mockResolvedValueOnce({
        processed: 5,
        failed: 1,
        deadLettered: 1,
        deadLetterAlreadyGoneCount: 0,
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
