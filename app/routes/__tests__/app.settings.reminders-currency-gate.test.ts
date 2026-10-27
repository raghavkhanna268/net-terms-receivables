import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Currency gate tests for app.settings.reminders route toggle_enabled action.
 *
 * Tests verify that:
 * - USD shop: action rejects toggle_enabled with currency error
 * - XXX/NULL shop (setting up): action rejects toggle_enabled with setting up message
 * - INR shop: toggle_enabled works normally
 */

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

vi.mock("~/services/reminders.server", () => ({
  getShopReminderSettings: vi.fn().mockResolvedValue({ enabled: false }),
  getShopReminderRules: vi.fn().mockResolvedValue([]),
  getShopReminderLogs: vi.fn().mockResolvedValue([]),
  updateShopReminderSettings: vi.fn().mockResolvedValue(true),
  updateReminderRule: vi.fn().mockResolvedValue(true),
  createReminderRule: vi.fn().mockResolvedValue({ id: "new-rule" }),
  deleteReminderRule: vi.fn().mockResolvedValue(true),
  isReminderSendingEnabled: vi.fn().mockReturnValue(true),
  isValidOffset: vi.fn().mockReturnValue(true),
  ensureDefaultReminderRules: vi.fn().mockResolvedValue(undefined),
  OFFSET_MIN: -30,
  OFFSET_MAX: 90,
}));

vi.mock("~/services/reminder-status.server", () => ({
  getReminderStatusCounts: vi.fn().mockResolvedValue({
    sent: 0,
    delayed: 0,
    skippedDailyLimit: 0,
    skippedOptedOut: 0,
  }),
  getDelayedReminders: vi.fn().mockResolvedValue([]),
  getShopSentTodayCount: vi.fn().mockResolvedValue(0),
}));

interface TestActionData {
  success: boolean;
  error?: string;
  message?: string;
}

interface TestLoaderData {
  error: string | null;
  settings: unknown;
  rules: unknown[];
  logs: unknown[];
  providerConfigured: boolean;
  shopTimezone: string;
  statusCounts: unknown;
  delayedReminders: unknown[];
  shopSentToday: number;
  settingUp?: boolean;
  notSupported?: boolean;
  storeSetupStatus?: string;
}

function extractLoaderData(result: unknown): TestLoaderData {
  return result as TestLoaderData;
}

const TEST_SHOP_DOMAIN = "test-reminders-gate.myshopify.com";

describe("#292 currency gate on /app/settings/reminders toggle_enabled", () => {
  const mockSession = { shop: TEST_SHOP_DOMAIN };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
    cloudflare: {
      env: { RESEND_API_KEY: "test-key", RESEND_FROM: "test@example.com" },
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
      if (query.includes("SELECT id, timezone, currency FROM") && query.includes("Shop")) {
        if (storedCurrency === null) {
          return Promise.resolve([{ id: "shop-123", timezone: "UTC", currency: null }]);
        }
        return Promise.resolve([{ id: "shop-123", timezone: "UTC", currency: storedCurrency }]);
      }
      if (query.includes("SELECT id, currency FROM") && query.includes("Shop")) {
        if (storedCurrency === null) {
          return Promise.resolve([{ id: "shop-123", currency: null }]);
        }
        return Promise.resolve([{ id: "shop-123", currency: storedCurrency }]);
      }
      return Promise.resolve([]);
    });
  }

  describe("loader", () => {
    it("USD shop: returns notSupported=true", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("USD");

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: new Request("https://example.com/app/settings/reminders"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      });

      const data = extractLoaderData(result);
      expect(data.notSupported).toBe(true);
      expect(data.settingUp).toBe(false);
      expect(data.storeSetupStatus).toBe("not_supported");
    });

    it("XXX (setting up) shop: returns settingUp=true", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("XXX");

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: new Request("https://example.com/app/settings/reminders"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      });

      const data = extractLoaderData(result);
      expect(data.settingUp).toBe(true);
      expect(data.notSupported).toBe(false);
      expect(data.storeSetupStatus).toBe("setting_up");
    });

    it("INR shop: returns settingUp=false, notSupported=false", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("INR");

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: new Request("https://example.com/app/settings/reminders"),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      });

      const data = extractLoaderData(result);
      expect(data.settingUp).toBe(false);
      expect(data.notSupported).toBe(false);
      expect(data.storeSetupStatus).toBe("supported");
    });
  });

  describe("action toggle_enabled", () => {
    const toggleFormData = (enabled: boolean) => {
      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", String(enabled));
      return formData;
    };

    it("USD shop: rejects toggle_enabled with 'Only INR currency is supported'", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("USD");

      const { action } = await import("../app.settings.reminders");
      const result = (await action({
        request: new Request("https://example.com/app/settings/reminders", {
          method: "POST",
          body: toggleFormData(true),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      })) as TestActionData;

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only INR currency is supported");
    });

    it("XXX shop: rejects toggle_enabled with setting up message", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("XXX");

      const { action } = await import("../app.settings.reminders");
      const result = (await action({
        request: new Request("https://example.com/app/settings/reminders", {
          method: "POST",
          body: toggleFormData(true),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      })) as TestActionData;

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("NULL currency: rejects toggle_enabled with setting up message", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock(null);

      const { action } = await import("../app.settings.reminders");
      const result = (await action({
        request: new Request("https://example.com/app/settings/reminders", {
          method: "POST",
          body: toggleFormData(true),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      })) as TestActionData;

      expect(result.success).toBe(false);
      expect(result.error).toContain("still being set up");
    });

    it("INR shop: toggle_enabled works normally", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      setupSqlMock("INR");

      const { action } = await import("../app.settings.reminders");
      const result = (await action({
        request: new Request("https://example.com/app/settings/reminders", {
          method: "POST",
          body: toggleFormData(true),
        }),
        context: mockContext as never,
        params: {},
        url: new URL("https://example.com/app/settings/reminders"),
        pattern: "/app/settings/reminders",
      })) as TestActionData;

      expect(result.success).toBe(true);
      expect(result.message).toContain("enabled");
    });
  });
});
