import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { isValidServerTimingHeader, _resetIsolateStateForTesting } from "~/lib/server-timing.server";

/**
 * Helper to extract headers from data() result.
 */
function extractHeaders(result: unknown): Headers | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init: { headers?: HeadersInit } | null }).init;
    if (init?.headers) {
      return new Headers(init.headers);
    }
  }
  return undefined;
}

/**
 * Tests for app home timing instrumentation (issue #290).
 *
 * Validates:
 * 1. Server-Timing header contains only allowed phase names
 * 2. app_home_timing log has only allowed keys and no domain
 * 3. Header format matches ^[a-z_]+;dur=\d+(\.\d+)?$ pattern
 */

// Mock SQL client
const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn((s) => s) });

// Mock modules
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => undefined),
}));

vi.mock("~/services/plan.server", () => ({
  resolvePlan: vi.fn().mockResolvedValue({
    plan: { key: "free" },
    subscriptionName: "Free",
    isTest: false,
  }),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 2, limit: 3 },
    importsThisMonth: { current: 0, limit: 1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/aging-queries.server", () => ({
  getShopAgingTotals: vi.fn().mockResolvedValue({
    totalByCurrency: {},
    buckets: {
      current: { byCurrency: {} },
      "1-30": { byCurrency: {} },
      "31-60": { byCurrency: {} },
      "61-90": { byCurrency: {} },
      "90+": { byCurrency: {} },
    },
    overdueByCurrency: {},
    oldestOverdueDays: null,
  }),
  getBuyerLedger: vi.fn().mockResolvedValue({
    rows: [],
    totalCount: 0,
  }),
  getBuyerInvoices: vi.fn().mockResolvedValue({
    rows: [],
    totalCount: 0,
  }),
}));

describe("app home timing instrumentation", () => {
  const TEST_SHOP = "test-timing.myshopify.com";
  const TEST_SHOP_ID = "shop-timing-123";

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIsolateStateForTesting();

    // Default mock for shop query
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("SELECT id, currency, timezone FROM")) {
          return Promise.resolve([
            { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
          ]);
        }
        if (query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
        }
        if (
          query.includes("COUNT(DISTINCT") &&
          query.includes("gated_at IS NOT NULL")
        ) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "1" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      }
    );
  });

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              sessionToken: "test-session-token",
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
    } as unknown as LoaderFunctionArgs;
  }

  describe("Server-Timing header format", () => {
    it("loader sets Server-Timing header with valid phase names", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      expect(headers).toBeDefined();
      const serverTiming = headers!.get("Server-Timing");
      expect(serverTiming).toBeTruthy();
      expect(isValidServerTimingHeader(serverTiming!)).toBe(true);
    });

    it("Server-Timing entries match expected pattern", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers!.get("Server-Timing")!;
      const entries = serverTiming.split(/,\s*/);
      const pattern = /^[a-z_]+;dur=\d+(\.\d+)?$/;

      for (const entry of entries) {
        if (entry) {
          expect(entry).toMatch(pattern);
        }
      }
    });

    it("Server-Timing header contains no shop domain or ids", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";

      // Must not contain shop domain patterns
      expect(serverTiming).not.toContain(".myshopify.com");
      expect(serverTiming).not.toContain("test-timing");
      expect(serverTiming).not.toContain(TEST_SHOP_ID);

      // Must not contain description strings (;desc=)
      expect(serverTiming).not.toMatch(/;desc=/);
    });
  });

  describe("app_home_timing log lines (one per phase)", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    /**
     * Phases that run in the initial loader response (before streaming).
     * These are logged immediately and included in Server-Timing header.
     *
     * Note: plan_resolve, ledger_rows, ledger_count now run in the deferred
     * promise (streaming) and are not included in the initial response timing.
     * This improves LCP by returning a skeleton immediately while data loads.
     */
    const EXPECTED_PHASES = [
      "auth_index",
      "shop_lookup",
      "onboarding_checks",
      "loader_total",
    ];

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("emits one log line per phase with exact fields: event, route, stage, durationMs", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      // Should have at least one log per timed phase
      expect(allLogs.length).toBeGreaterThanOrEqual(EXPECTED_PHASES.length);

      for (const log of allLogs) {
        // Check event name
        expect(log.event).toBe("app_home_timing");

        // Check allowed fields: exactly event, route, stage, durationMs
        expect(log.route).toBe("app_home");
        expect(typeof log.stage).toBe("string");
        expect(typeof log.durationMs).toBe("number");

        // Verify ONLY these exact keys are present
        const allowedKeys = ["event", "route", "stage", "durationMs"];
        const actualKeys = Object.keys(log);
        expect(actualKeys.sort()).toEqual(allowedKeys.sort());

        // cold field must NOT be present (encoded in stage name)
        expect(log.cold).toBeUndefined();

        // No domain, id, or other fields
        expect(log.domain).toBeUndefined();
        expect(log.id).toBeUndefined();
        expect(log.shopId).toBeUndefined();
      }
    });

    it("stage names are from allowed phase codes (with optional _cold suffix)", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      const validStages = [
        "auth_layout", "auth_layout_cold",
        "auth_index", "auth_index_cold",
        "shop_lookup", "shop_lookup_cold",
        "onboarding_checks", "onboarding_checks_cold",
        "plan_resolve", "plan_resolve_cold",
        "ledger_rows", "ledger_rows_cold",
        "ledger_count", "ledger_count_cold",
        "loader_total", "loader_total_cold",
      ];

      for (const log of allLogs) {
        expect(validStages).toContain(log.stage);
      }
    });

    it("app_home_timing log contains no shop domain", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"));

      for (const logStr of allLogs) {
        expect(logStr).not.toContain(".myshopify.com");
        expect(logStr).not.toContain("test-timing");
        expect(logStr).not.toContain(TEST_SHOP);
        expect(logStr).not.toContain(TEST_SHOP_ID);
      }
    });

    it("app_home_timing log is at info level", async () => {
      const consoleInfoSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});

      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const timingLogs = consoleInfoSpy.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("app_home_timing")
      );

      // safeLog at "info" level uses console.log
      expect(timingLogs.length).toBeGreaterThanOrEqual(EXPECTED_PHASES.length);

      consoleInfoSpy.mockRestore();
    });

    it("cold flag encoded in stage name reflects isolate state", async () => {
      // Both layout and index must receive the same context object to share cold state
      // (workers/app.ts creates one context per fetch, React Router passes it to all loaders)
      const { loader: layoutLoader } = await import("../app");
      const { loader: indexLoader } = await import("../app._index");

      // Helper to extract and await deferred dashboardData from index loader result
      async function awaitDeferredData(result: unknown): Promise<void> {
        const data = (result as { data?: Record<string, unknown> })?.data;
        if (data?.dashboardData && typeof (data.dashboardData as Promise<unknown>).then === "function") {
          await (data.dashboardData as Promise<unknown>);
        }
      }

      // Create a context factory (one context per request, shared by layout and index)
      const createContext = () => ({
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              admin: {},
              session: { shop: TEST_SHOP },
              sessionToken: "test-session-token",
              redirect: vi.fn(),
            }),
          },
        },
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      });

      // First request - both loaders get the same context object
      const context1 = createContext();
      const request1Layout = new Request("https://example.com/app");
      const request1Index = new Request("https://example.com/app");
      const [, indexResult1] = await Promise.all([
        layoutLoader({ request: request1Layout, context: context1, params: {} } as never),
        indexLoader({ request: request1Index, context: context1, params: {} } as never),
      ]);

      await awaitDeferredData(indexResult1);

      let allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      // All first-request stages should have _cold suffix
      for (const log of allLogs) {
        expect(log.stage).toMatch(/_cold$/);
      }

      // Clear and make second request with a new context object
      consoleLogSpy.mockClear();
      const context2 = createContext();
      const request2Layout = new Request("https://example.com/app");
      const request2Index = new Request("https://example.com/app");
      const [, indexResult2] = await Promise.all([
        layoutLoader({ request: request2Layout, context: context2, params: {} } as never),
        indexLoader({ request: request2Index, context: context2, params: {} } as never),
      ]);

      await awaitDeferredData(indexResult2);

      allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      // Second request stages should NOT have _cold suffix
      for (const log of allLogs) {
        expect(log.stage).not.toMatch(/_cold$/);
      }
    });

    it("emits log for loader_total phase", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      const loaderTotalLogs = allLogs.filter(
        (log: { stage: string }) => log.stage === "loader_total_cold" || log.stage === "loader_total"
      );
      expect(loaderTotalLogs.length).toBe(1);
    });

    it("P2: deferred phases (plan_resolve, ledger_rows, ledger_count) are logged after promise settles", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());

      const initialLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      const initialStages = initialLogs.map((log: { stage: string }) => log.stage.replace(/_cold$/, ""));
      expect(initialStages).toContain("auth_index");
      expect(initialStages).toContain("shop_lookup");
      expect(initialStages).toContain("loader_total");
      expect(initialStages).not.toContain("plan_resolve");
      expect(initialStages).not.toContain("ledger_rows");

      consoleLogSpy.mockClear();

      const data = (result as { data: Record<string, unknown> }).data;
      if (data.dashboardData && typeof (data.dashboardData as Promise<unknown>).then === "function") {
        await (data.dashboardData as Promise<unknown>);
      }

      const deferredLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      const deferredStages = deferredLogs.map((log: { stage: string }) => log.stage.replace(/_cold$/, ""));
      expect(deferredStages).toContain("plan_resolve");
      expect(deferredStages).toContain("ledger_rows");
    });
  });

  describe("timing phases", () => {
    it("times auth_index phase", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("auth_index");
    });

    it("times shop_lookup phase", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("shop_lookup");
    });

    /**
     * With streaming/deferred data, plan_resolve runs in the deferred promise
     * and is NOT included in the Server-Timing header of the initial response.
     * This is expected behavior for LCP optimization.
     */
    it("does NOT include plan_resolve in initial response Server-Timing (runs in deferred promise)", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).not.toContain("plan_resolve");
    });

    /**
     * With streaming/deferred data, ledger_rows runs in the deferred promise
     * and is NOT included in the Server-Timing header of the initial response.
     */
    it("does NOT include ledger_rows in initial response Server-Timing (runs in deferred promise)", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).not.toContain("ledger_rows");
    });

    it("times loader_total phase", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("loader_total");
    });
  });
});

/**
 * Test that Server-Timing header entries match the required format.
 * Each entry must be: phase_name;dur=X.X (no descriptions, no shop data)
 */
describe("Server-Timing format compliance", () => {
  it("validates entry format: phase;dur=number", () => {
    expect(isValidServerTimingHeader("auth_layout;dur=123")).toBe(true);
    expect(isValidServerTimingHeader("auth_layout;dur=123.4")).toBe(true);
    expect(isValidServerTimingHeader("auth_layout;dur=0")).toBe(true);
    expect(isValidServerTimingHeader("auth_layout;dur=0.1")).toBe(true);
  });

  it("rejects entries with descriptions", () => {
    expect(
      isValidServerTimingHeader('auth_layout;desc="Auth time";dur=100')
    ).toBe(false);
  });

  it("rejects entries with shop domains", () => {
    expect(
      isValidServerTimingHeader("test.myshopify.com;dur=100")
    ).toBe(false);
  });

  it("rejects entries with non-lowercase phase names", () => {
    expect(isValidServerTimingHeader("AUTH_LAYOUT;dur=100")).toBe(false);
    expect(isValidServerTimingHeader("AuthLayout;dur=100")).toBe(false);
  });

  it("accepts all allowed phase codes", () => {
    const allowedPhases = [
      "auth_layout",
      "auth_index",
      "shop_lookup",
      "onboarding_checks",
      "plan_resolve",
      "ledger_rows",
      "ledger_count",
      "loader_total",
    ];

    for (const phase of allowedPhases) {
      expect(isValidServerTimingHeader(`${phase};dur=100`)).toBe(true);
    }
  });

  it("rejects db_connect (no longer measured)", () => {
    expect(isValidServerTimingHeader("db_connect;dur=100")).toBe(false);
  });
});

/**
 * Tests that index headers() merges parent (layout) and loader Server-Timing values.
 */
describe("index headers() merges parent and loader Server-Timing", () => {
  it("merged Server-Timing contains both layout auth_layout and index phases", async () => {
    // Import the headers function from app._index
    const { headers } = await import("../app._index");
    const { mergeServerTimingHeaders } = await import("~/lib/server-timing.server");

    // Simulate layout Server-Timing (from parent)
    const layoutTiming = "auth_layout;dur=50.0";
    // Simulate index Server-Timing (from loader)
    const indexTiming = "auth_index;dur=10.0, loader_total;dur=100.0";

    // Create mock headersArgs
    const mockHeadersArgs = {
      loaderHeaders: new Headers({ "Server-Timing": indexTiming }),
      parentHeaders: new Headers({ "Server-Timing": layoutTiming }),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    };

    // Call the headers function
    const result = headers(mockHeadersArgs as never);
    // Convert to Headers if needed (headers function may return Headers or HeadersInit)
    const resultHeaders = result instanceof Headers ? result : new Headers(result);

    // The Server-Timing should contain both parent and loader timings
    const mergedTiming = resultHeaders.get("Server-Timing");
    expect(mergedTiming).toBeTruthy();
    expect(mergedTiming).toContain("auth_layout");
    expect(mergedTiming).toContain("auth_index");
    expect(mergedTiming).toContain("loader_total");

    // Should match our merge function's expected output
    const expected = mergeServerTimingHeaders(layoutTiming, indexTiming);
    expect(mergedTiming).toBe(expected);
  });
});

/**
 * Tests for cold flag behavior across layout and index.
 * Uses the existing test infrastructure.
 */
describe("cold flag across layout and index", () => {
  const TEST_SHOP = "test-cold.myshopify.com";
  const TEST_SHOP_ID = "shop-cold-123";

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIsolateStateForTesting();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Use the existing mockSql that was set up at the top
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("SELECT id, currency, timezone FROM")) {
          return Promise.resolve([
            { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
          ]);
        }
        if (query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([{ onboarding_dismissed_at: new Date() }]);
        }
        if (query.includes("COUNT(DISTINCT") && query.includes("gated_at IS NOT NULL")) {
          return Promise.resolve([{ count: "0" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "1" }]);
        }
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      }
    );
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  function createContextForColdTest() {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            admin: {},
            session: { shop: TEST_SHOP },
            sessionToken: "test-session-token",
            redirect: vi.fn(),
          }),
        },
      },
      cloudflare: {
        env: {},
        ctx: { waitUntil: vi.fn() },
      },
    };
  }

  it("different Request objects but same context gives same cold value to layout and index", async () => {
    const { loader: layoutLoader } = await import("../app");
    const { loader: indexLoader } = await import("../app._index");

    // React Router 7.18.4 creates new Request objects for each loader,
    // but workers/app.ts creates one context per fetch. Cold is keyed by context.
    const context = createContextForColdTest();
    const requestLayout = new Request("https://example.com/app");
    const requestIndex = new Request("https://example.com/app");

    // Layout and index get different Request objects but same context
    const argsLayout = { request: requestLayout, context, params: {} } as never;
    const argsIndex = { request: requestIndex, context, params: {} } as never;

    await Promise.all([
      layoutLoader(argsLayout),
      indexLoader(argsIndex),
    ]);

    const allLogs = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
      .map((logStr: unknown) => JSON.parse(logStr as string));

    // All stages should have _cold suffix since same context (same request)
    expect(allLogs.length).toBeGreaterThan(0);
    for (const log of allLogs) {
      expect(log.stage).toMatch(/_cold$/);
    }
  });

  it("overlapping requests A and B: ALL of A's logs are cold, NONE of B's are", async () => {
    const { loader: layoutLoader } = await import("../app");
    const { loader: indexLoader } = await import("../app._index");

    // Helper to extract and await deferred dashboardData from index loader result
    async function awaitDeferredData(result: unknown): Promise<void> {
      const data = (result as { data?: Record<string, unknown> })?.data;
      if (data?.dashboardData && typeof (data.dashboardData as Promise<unknown>).then === "function") {
        await (data.dashboardData as Promise<unknown>);
      }
    }

    // Different contexts for A and B (workers/app.ts creates one per fetch)
    const contextA = createContextForColdTest();
    const contextB = createContextForColdTest();
    const requestA = new Request("https://example.com/app");
    const requestB = new Request("https://example.com/app");
    const argsA = { request: requestA, context: contextA, params: {} } as never;
    const argsB = { request: requestB, context: contextB, params: {} } as never;

    // Start both requests before awaiting either (overlapping)
    // Promise.all preserves execution order: layoutLoader(argsA) calls readColdOnce first
    const promiseA = Promise.all([layoutLoader(argsA), indexLoader(argsA)]);
    const promiseB = Promise.all([layoutLoader(argsB), indexLoader(argsB)]);

    const [[, indexResultA], [, indexResultB]] = await Promise.all([promiseA, promiseB]);

    // Await deferred data to ensure all deferred phases are logged
    await Promise.all([awaitDeferredData(indexResultA), awaitDeferredData(indexResultB)]);

    const allLogs = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
      .map((logStr: unknown) => JSON.parse(logStr as string));

    // Count cold and warm logs
    const coldLogs = allLogs.filter((log: { stage: string }) => log.stage.endsWith("_cold"));
    const warmLogs = allLogs.filter((log: { stage: string }) => !log.stage.endsWith("_cold"));

    // ALL of A's logs end in _cold, NONE of B's do
    // Since both requests execute the same phases, counts should be equal
    expect(coldLogs.length).toBeGreaterThan(0);
    expect(warmLogs.length).toBeGreaterThan(0);
    expect(coldLogs.length).toBe(warmLogs.length);

    // Verify stage names are consistent (same phases recorded for both)
    const coldStages = new Set(coldLogs.map((log: { stage: string }) => log.stage.replace(/_cold$/, "")));
    const warmStages = new Set(warmLogs.map((log: { stage: string }) => log.stage));
    expect(coldStages).toEqual(warmStages);
  });

  it("third sequential request is warm", async () => {
    const { loader: layoutLoader } = await import("../app");
    const { loader: indexLoader } = await import("../app._index");

    // Request 1 (cold) - each request gets its own context (workers/app.ts creates one per fetch)
    const context1 = createContextForColdTest();
    const request1 = new Request("https://example.com/app");
    const args1 = { request: request1, context: context1, params: {} } as never;
    await Promise.all([layoutLoader(args1), indexLoader(args1)]);

    // Request 2 (warm)
    const context2 = createContextForColdTest();
    const request2 = new Request("https://example.com/app");
    const args2 = { request: request2, context: context2, params: {} } as never;
    await Promise.all([layoutLoader(args2), indexLoader(args2)]);

    consoleLogSpy.mockClear();

    // Request 3 (should still be warm)
    const context3 = createContextForColdTest();
    const request3 = new Request("https://example.com/app");
    const args3 = { request: request3, context: context3, params: {} } as never;
    await Promise.all([layoutLoader(args3), indexLoader(args3)]);

    const logs = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
      .map((logStr: unknown) => JSON.parse(logStr as string));

    // All third request stages should NOT have _cold suffix
    expect(logs.length).toBeGreaterThan(0);
    for (const log of logs) {
      expect(log.stage).not.toMatch(/_cold$/);
    }
  });
});

/**
 * Tests that the onboarding redirect still works.
 * Note: The onboarding redirect test is already covered in app.onboarding.test.ts.
 * This test verifies timing code doesn't interfere with the throw.
 */
describe("redirect and throw paths", () => {
  const TEST_SHOP = "test-redirect.myshopify.com";
  const TEST_SHOP_ID = "shop-redirect-123";

  beforeEach(() => {
    vi.clearAllMocks();
    _resetIsolateStateForTesting();

    // Configure mockSql to trigger onboarding redirect
    mockSql.mockImplementation(
      (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join("?");
        if (query.includes("SELECT id, currency, timezone FROM")) {
          return Promise.resolve([
            { id: TEST_SHOP_ID, currency: "INR", timezone: "Asia/Kolkata" },
          ]);
        }
        // Return null to trigger redirect (onboarding not dismissed)
        if (query.includes("onboarding_dismissed_at")) {
          return Promise.resolve([{ onboarding_dismissed_at: null }]);
        }
        // No buyers - triggers redirect
        if (query.includes("COUNT(*)") && query.includes("BuyerAccount")) {
          return Promise.resolve([{ count: "0" }]);
        }
        // No tag rules - triggers redirect
        if (query.includes("COUNT(*)") && query.includes("AccountSource")) {
          return Promise.resolve([{ count: "0" }]);
        }
        return Promise.resolve([]);
      }
    );
  });

  it("onboarding redirect throws a 302 Response with Location /app/onboarding", async () => {
    const { loader } = await import("../app._index");

    const mockRedirect = vi.fn().mockImplementation((path: string) => {
      const error = new Response(null, {
        status: 302,
        headers: { Location: path },
      });
      throw error;
    });

    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            admin: {},
            session: { shop: TEST_SHOP },
            sessionToken: "test-session-token",
            redirect: mockRedirect,
          }),
        },
      },
      cloudflare: {
        env: {},
        ctx: { waitUntil: vi.fn() },
      },
    };

    const request = new Request("https://example.com/app");
    const args = { request, context: mockContext, params: {} } as never;

    // The loader should throw a 302 redirect
    let thrownResponse: Response | null = null;
    try {
      await loader(args);
    } catch (err) {
      if (err instanceof Response) {
        thrownResponse = err;
      } else {
        throw err;
      }
    }

    // Verify redirect was called with /app/onboarding
    expect(mockRedirect).toHaveBeenCalledWith("/app/onboarding");

    // Verify the thrown Response is a 302 with correct Location
    expect(thrownResponse).toBeInstanceOf(Response);
    expect(thrownResponse!.status).toBe(302);
    expect(thrownResponse!.headers.get("Location")).toBe("/app/onboarding");
  });
});
