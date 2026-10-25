import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import { isValidServerTimingHeader } from "~/lib/server-timing.server";
import { _resetIsolateStateForTesting } from "~/lib/server-timing.server";

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
      const response = await loader(createLoaderArgs());

      expect(response).toBeInstanceOf(Response);
      const serverTiming = (response as Response).headers.get("Server-Timing");
      expect(serverTiming).toBeTruthy();
      expect(isValidServerTimingHeader(serverTiming!)).toBe(true);
    });

    it("Server-Timing entries match expected pattern", async () => {
      const { loader } = await import("../app._index");
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing")!;
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
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing") ?? "";

      // Must not contain shop domain patterns
      expect(serverTiming).not.toContain(".myshopify.com");
      expect(serverTiming).not.toContain("test-timing");
      expect(serverTiming).not.toContain(TEST_SHOP_ID);

      // Must not contain description strings (;desc=)
      expect(serverTiming).not.toMatch(/;desc=/);
    });
  });

  describe("app_home_timing log line", () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it("logs app_home_timing with allowed fields only", async () => {
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      const allLogs = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .filter((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"));

      expect(allLogs.length).toBeGreaterThanOrEqual(1);

      for (const logStr of allLogs) {
        const log = JSON.parse(logStr as string);

        // Check event name
        expect(log.event).toBe("app_home_timing");

        // Check allowed fields
        expect(log.route).toBe("app_home");
        expect(typeof log.cold).toBe("boolean");
        expect(typeof log.durationMs).toBe("number");

        // Verify only allowed keys are present
        const allowedKeys = ["event", "route", "cold", "durationMs"];
        for (const key of Object.keys(log)) {
          expect(allowedKeys).toContain(key);
        }
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
      expect(timingLogs.length).toBeGreaterThanOrEqual(1);

      consoleInfoSpy.mockRestore();
    });

    it("cold flag reflects isolate state", async () => {
      // First request should be cold
      const { loader } = await import("../app._index");
      await loader(createLoaderArgs());

      let timingLog = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .find((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"));

      expect(timingLog).toBeDefined();
      let parsed = JSON.parse(timingLog as string);
      expect(parsed.cold).toBe(true);

      // Clear and make second request
      consoleLogSpy.mockClear();
      await loader(createLoaderArgs());

      timingLog = consoleLogSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .find((log: unknown) => typeof log === "string" && (log as string).includes("app_home_timing"));

      expect(timingLog).toBeDefined();
      parsed = JSON.parse(timingLog as string);
      expect(parsed.cold).toBe(false);
    });
  });

  describe("timing phases", () => {
    it("times auth_index phase", async () => {
      const { loader } = await import("../app._index");
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("auth_index");
    });

    it("times shop_lookup phase", async () => {
      const { loader } = await import("../app._index");
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("shop_lookup");
    });

    it("times plan_resolve phase", async () => {
      const { loader } = await import("../app._index");
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("plan_resolve");
    });

    it("times ledger_rows phase", async () => {
      const { loader } = await import("../app._index");
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing") ?? "";
      expect(serverTiming).toContain("ledger_rows");
    });

    it("times loader_total phase", async () => {
      const { loader } = await import("../app._index");
      const response = await loader(createLoaderArgs());

      const serverTiming = (response as Response).headers.get("Server-Timing") ?? "";
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
      "db_connect",
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
});
