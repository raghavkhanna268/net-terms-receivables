import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Currency gate tests for app.tag-rules route.
 *
 * Tests verify that:
 * - USD shop: loader returns notSupported: true, action rejects with currency error
 * - XXX/NULL shop (setting up): loader returns finishingSetup: true (settingUp), action rejects
 * - INR shop: loader returns notSupported: false, finishingSetup: false
 */

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

vi.mock("~/services/drain/reconcile-handlers.server", () => ({
  enqueueReconcileStage: vi.fn().mockResolvedValue(true),
}));

vi.mock("~/services/gating.server", () => ({
  getUsageStats: vi.fn().mockResolvedValue({
    companies: { current: 5, limit: 25 },
    importsThisMonth: { current: 0, limit: -1 },
  }),
  isGatingEnforced: vi.fn().mockReturnValue(false),
}));

vi.mock("~/lib/plan-url", () => ({
  getAppHandle: vi.fn().mockReturnValue("net-terms-receivables-1"),
  buildPlanSelectionUrl: vi.fn().mockReturnValue("https://example.com/upgrade"),
}));

interface TestLoaderData {
  storeMode?: string;
  tagRules?: unknown[];
  shopId?: string | null;
  error?: string | null;
  finishingSetup?: boolean;
  notSupported?: boolean;
  storeSetupStatus?: string;
}

interface TestActionData {
  success?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
}

function extractLoaderData(result: unknown): TestLoaderData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: TestLoaderData }).data;
  }
  return result as TestLoaderData;
}

function extractActionData(result: unknown): TestActionData {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "data" in result
  ) {
    return (result as { data: TestActionData }).data;
  }
  return result as TestActionData;
}

function extractStatus(result: unknown): number | undefined {
  if (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    (result as { type: string }).type === "DataWithResponseInit" &&
    "init" in result
  ) {
    const init = (result as { init: { status?: number } | null }).init;
    return init?.status;
  }
  return undefined;
}

const TEST_SHOP_DOMAIN = "test-tagrules-gate.myshopify.com";

describe("#292 currency gate on /app/tag-rules", () => {
  const mockSession = { shop: TEST_SHOP_DOMAIN };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
  };

  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSql = vi.fn();
    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function setupSqlMock(storedCurrency: string | null) {
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("SELECT id, currency, timezone FROM") && query.includes("Shop")) {
        if (storedCurrency === null) {
          return Promise.resolve([{ id: "shop-123", currency: null, timezone: "Asia/Kolkata" }]);
        }
        return Promise.resolve([{ id: "shop-123", currency: storedCurrency, timezone: "Asia/Kolkata" }]);
      }
      if (query.includes("SELECT id, domain, currency FROM") && query.includes("Shop")) {
        if (storedCurrency === null) {
          return Promise.resolve([{ id: "shop-123", domain: TEST_SHOP_DOMAIN, currency: null }]);
        }
        return Promise.resolve([{ id: "shop-123", domain: TEST_SHOP_DOMAIN, currency: storedCurrency }]);
      }
      if (query.includes("BuyerAccount") && query.includes("COMPANY")) {
        return Promise.resolve([]);
      }
      if (query.includes("AccountSource")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  }

  describe("loader", () => {
    it("USD shop: returns notSupported=true", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("USD");

      const { loader } = await import("../app.tag-rules");
      const rawResult = await loader({
        request: new Request("https://example.com/app/tag-rules"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractLoaderData(rawResult);
      expect(result.notSupported).toBe(true);
      expect(result.finishingSetup).toBe(false);
      expect(result.storeSetupStatus).toBe("not_supported");
    });

    it("XXX (setting up) shop: returns finishingSetup=true", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("XXX");

      const { loader } = await import("../app.tag-rules");
      const rawResult = await loader({
        request: new Request("https://example.com/app/tag-rules"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractLoaderData(rawResult);
      expect(result.finishingSetup).toBe(true);
      expect(result.notSupported).toBe(false);
      expect(result.storeSetupStatus).toBe("setting_up");
    });

    it("NULL currency: returns finishingSetup=true", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock(null);

      const { loader } = await import("../app.tag-rules");
      const rawResult = await loader({
        request: new Request("https://example.com/app/tag-rules"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractLoaderData(rawResult);
      expect(result.finishingSetup).toBe(true);
      expect(result.storeSetupStatus).toBe("setting_up");
    });

    it("INR shop: returns notSupported=false, finishingSetup=false", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("INR");

      const { loader } = await import("../app.tag-rules");
      const rawResult = await loader({
        request: new Request("https://example.com/app/tag-rules"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractLoaderData(rawResult);
      expect(result.notSupported).toBe(false);
      expect(result.finishingSetup).toBe(false);
      expect(result.storeSetupStatus).toBe("supported");
    });
  });

  describe("action", () => {
    const validFormData = () => {
      const formData = new FormData();
      formData.append("intent", "create_tag_rule");
      formData.append("tag", "net30");
      formData.append("defaultTermsDays", "30");
      return formData;
    };

    it("USD shop: rejects with 'Only INR currency is supported'", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("USD");

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: new Request("https://example.com/app/tag-rules", {
          method: "POST",
          body: validFormData(),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Only INR currency is supported");
    });

    it("XXX shop: rejects with setting up message", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("XXX");

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: new Request("https://example.com/app/tag-rules", {
          method: "POST",
          body: validFormData(),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("NULL currency: rejects with setting up message", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock(null);

      const { action } = await import("../app.tag-rules");
      const rawResult = await action({
        request: new Request("https://example.com/app/tag-rules", {
          method: "POST",
          body: validFormData(),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/tag-rules"),
        pattern: "/app/tag-rules",
      });

      const result = extractActionData(rawResult);
      const status = extractStatus(rawResult);
      expect(status).toBe(400);
      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });
  });
});
