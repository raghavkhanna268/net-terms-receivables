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
  timedOut: false,
  elapsedMs: 150,
  errors: [],
});

vi.mock("~/services/drain/processor.server", () => ({
  runDrain: mockRunDrain,
  DEFAULT_DRAIN_CONFIG: {
    batchSize: 5,
    visibilityTimeoutSec: 30,
    timeBudgetMs: 20000,
    maxRetries: 5,
  },
}));

// Mock reconcile
const mockEnqueueReconcile = vi.fn().mockResolvedValue(4);

vi.mock("~/services/drain/reconcile.server", () => ({
  enqueueReconcileForAllShops: mockEnqueueReconcile,
}));

describe("jobs.drain route", () => {
  const VALID_SECRET = "test-drain-secret-12345";
  let originalConsole: typeof console.log;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    originalConsole = console.log;
    console.log = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsole;
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

    it("uses constant-time comparison (timing-safe)", async () => {
      // This test verifies the code path, not actual timing
      // The constantTimeCompare function uses timingSafeEqual
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
      const request = createRequest({ queryParams: { timeBudgetMs: "15000" } });

      await action(createActionArgs(request));

      expect(mockRunDrain).toHaveBeenCalledWith(mockSql, { timeBudgetMs: 15000 });
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

    it("returns drain result as JSON", async () => {
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
        timedOut: false,
        elapsedMs: 150,
      });
    });

    it("returns 500 on drain error", async () => {
      mockRunDrain.mockRejectedValueOnce(new Error("Database connection failed"));
      const { action } = await import("../jobs.drain");
      const request = createRequest();

      const response = await action(createActionArgs(request));

      expect(response.status).toBe(500);
      const result = (await response.json()) as { error: string };
      expect(result.error).toBe("Database connection failed");
    });
  });

  describe("reconcile mode", () => {
    it("enqueues reconcile messages when reconcile=true", async () => {
      const { action } = await import("../jobs.drain");
      const request = createRequest({ queryParams: { reconcile: "true" } });

      const response = await action(createActionArgs(request));

      expect(mockEnqueueReconcile).toHaveBeenCalledWith(mockSql);
      expect(response.status).toBe(200);

      const result = (await response.json()) as { reconcileEnqueued: number };
      expect(result.reconcileEnqueued).toBe(4);
    });

    it("does not enqueue reconcile when reconcile is not true", async () => {
      const { action } = await import("../jobs.drain");

      // No param
      const request1 = createRequest();
      await action(createActionArgs(request1));
      expect(mockEnqueueReconcile).not.toHaveBeenCalled();

      // false value
      mockEnqueueReconcile.mockClear();
      const request2 = createRequest({ queryParams: { reconcile: "false" } });
      await action(createActionArgs(request2));
      expect(mockEnqueueReconcile).not.toHaveBeenCalled();
    });
  });
});
