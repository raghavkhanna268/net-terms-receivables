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

    const EXPECTED_PHASES = [
      "auth_index",
      "shop_lookup",
      "onboarding_checks",
      "plan_resolve",
      "ledger_rows",
      "ledger_count",
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
      // Layout controls cold marking, so we need both loaders
      // Run them concurrently like React Router does
      const { loader: layoutLoader } = await import("../app");
      const { loader: indexLoader } = await import("../app._index");

      // Helper to create context for layout
      const createLayoutArgs = () => ({
        request: new Request("https://example.com/app"),
        context: {
          shopify: {
            authenticate: {
              admin: vi.fn().mockResolvedValue({
                admin: {},
                session: { shop: TEST_SHOP },
              }),
            },
          },
          cloudflare: {
            env: {},
            ctx: { waitUntil: vi.fn() },
          },
        },
        params: {},
      } as never);

      // First request - run concurrently to simulate real React Router behavior
      await Promise.all([
        layoutLoader(createLayoutArgs()),
        indexLoader(createLoaderArgs()),
      ]);

      let allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
        .map((logStr: unknown) => JSON.parse(logStr as string));

      // All first-request stages should have _cold suffix
      for (const log of allLogs) {
        expect(log.stage).toMatch(/_cold$/);
      }

      // Clear and make second request (layout already marked served, so second is warm)
      consoleLogSpy.mockClear();
      await Promise.all([
        layoutLoader(createLayoutArgs()),
        indexLoader(createLoaderArgs()),
      ]);

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

    it("times plan_resolve phase", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("plan_resolve");
    });

    it("times ledger_rows phase", async () => {
      const { loader } = await import("../app._index");
      const result = await loader(createLoaderArgs());
      const headers = extractHeaders(result);

      const serverTiming = headers?.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("ledger_rows");
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

  function createLoaderArgs(): LoaderFunctionArgs {
    const url = new URL("https://example.com/app");
    return {
      request: new Request(url.toString()),
      context: {
        shopify: {
          authenticate: {
            admin: vi.fn().mockResolvedValue({
              session: { shop: TEST_SHOP },
              redirect: vi.fn(),
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

  function createContextForColdTest() {
    return {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({
            admin: {},
            session: { shop: TEST_SHOP },
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

  it("request 1: both layout and index stages end in _cold; request 2: none have _cold", async () => {
    const { loader: layoutLoader } = await import("../app");
    const { loader: indexLoader } = await import("../app._index");

    const request = new Request("https://example.com/app");
    const layoutArgs = { request, context: createContextForColdTest(), params: {} } as never;
    const indexArgs = createLoaderArgs();

    // Request 1: both layout and index run concurrently (like React Router)
    await Promise.all([
      layoutLoader(layoutArgs),
      indexLoader(indexArgs),
    ]);

    const request1Logs = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
      .map((logStr: unknown) => JSON.parse(logStr as string));

    // All stages from request 1 should have _cold suffix
    expect(request1Logs.length).toBeGreaterThan(0);
    for (const log of request1Logs) {
      expect(log.stage).toMatch(/_cold$/);
    }

    // Request 2: clear and run again
    consoleLogSpy.mockClear();
    await Promise.all([
      layoutLoader(layoutArgs),
      indexLoader(indexArgs),
    ]);

    const request2Logs = consoleLogSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"))
      .map((logStr: unknown) => JSON.parse(logStr as string));

    // No stages from request 2 should have _cold suffix
    expect(request2Logs.length).toBeGreaterThan(0);
    for (const log of request2Logs) {
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

  it("onboarding redirect throws the same redirect without timing affecting it", async () => {
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

    // The loader should throw the redirect
    await expect(loader(args)).rejects.toThrow();

    // Verify redirect was called with /app/onboarding
    expect(mockRedirect).toHaveBeenCalledWith("/app/onboarding");
  });
});
