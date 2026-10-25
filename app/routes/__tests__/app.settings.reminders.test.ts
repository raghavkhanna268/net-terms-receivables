import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S18 reminder settings route (app/routes/app.settings.reminders.tsx).
 *
 * Covers:
 * - Loader: default disabled, not-configured state, caps and usage present, shop not found
 * - Action: toggle_enabled, update_rule, create_rule, delete_rule, offset validation, invalid intent
 * - ensureDefaultReminderRules: seeds 3 on first settings creation, no-op when settings exist
 * - R2 (#174): safeLog/toErrorCode logging with no PII leaks (uses REAL log.server)
 *
 * Uses partial mocking: DB functions are mocked, pure helpers (isValidOffset,
 * isReminderSendingEnabled) use real implementations. log.server is NOT mocked.
 */

vi.mock("~/services/reminders.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/reminders.server")>();
  return {
    ...actual,
    // Only mock DB-accessing functions
    getShopReminderSettings: vi.fn(),
    getShopReminderRules: vi.fn(),
    getShopReminderLogs: vi.fn(),
    updateShopReminderSettings: vi.fn(),
    updateReminderRule: vi.fn(),
    createReminderRule: vi.fn(),
    deleteReminderRule: vi.fn(),
    getGlobalSendCounts: vi.fn(),
    ensureDefaultReminderRules: vi.fn(),
    // Pure helpers use real implementations: isValidOffset, isReminderSendingEnabled
  };
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: vi.fn(() => ({})) },
}));

describe("Reminder Settings Route", () => {
  const mockSession = { shop: "test-store.myshopify.com" };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
    cloudflare: {
      env: {},
    },
  };
  const mockRequest = new Request("https://example.com/app/settings/reminders");
  const mockUrl = new URL(mockRequest.url);
  const mockPattern = "/app/settings/reminders";

  let mockSql: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSql = vi.fn();
    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
    });
    mockContext.cloudflare.env = {};
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("loader", () => {
    it("returns default disabled settings for new shop", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue(
        null
      );
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: true,
        count: 3,
      });

      // No env vars = not configured (real isReminderSendingEnabled)
      mockContext.cloudflare.env = {};

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.settings).toEqual({ enabled: false });
      expect(result.error).toBeNull();
    });

    it("returns not-configured state when RESEND_API_KEY is missing", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      // Only RESEND_FROM set, RESEND_API_KEY missing (real isReminderSendingEnabled)
      mockContext.cloudflare.env = { RESEND_FROM: "noreply@example.com" };

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.providerConfigured).toBe(false);
    });

    it("returns not-configured state when RESEND_FROM is missing", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      // Only RESEND_API_KEY set, RESEND_FROM missing (real isReminderSendingEnabled)
      mockContext.cloudflare.env = { RESEND_API_KEY: "re_test_123" };

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.providerConfigured).toBe(false);
    });

    it("returns configured state when both RESEND_API_KEY and RESEND_FROM are set", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: true,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 50,
        monthly: 1500,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      // Both keys set (real isReminderSendingEnabled)
      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.providerConfigured).toBe(true);
    });

    it("returns caps and usage data", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
        DAILY_SEND_CAP,
        MONTHLY_SEND_CAP,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 42,
        monthly: 1234,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.dailyCap).toBe(DAILY_SEND_CAP);
      expect(result.monthlyCap).toBe(MONTHLY_SEND_CAP);
      expect(result.dailyUsage).toBe(42);
      expect(result.monthlyUsage).toBe(1234);
      expect(result.usageError).toBe(false);
    });

    it("handles usage count fetch error gracefully", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      // Both keys set (real isReminderSendingEnabled)
      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const consoleErrorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      // Page should still load with default values
      expect(result.dailyUsage).toBe(0);
      expect(result.monthlyUsage).toBe(0);
      expect(result.usageError).toBe(true);
      expect(result.error).toBeNull();

      consoleErrorSpy.mockRestore();
    });

    it("returns shop not found error when shop doesn't exist", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.error).toBe("Shop not found");
      expect(result.settings).toBeNull();
    });

    it("calls ensureDefaultReminderRules for shop", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-456" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "rule-1", offsetDays: -3, channel: "email", enabled: true },
        { id: "rule-2", offsetDays: 0, channel: "email", enabled: true },
        { id: "rule-3", offsetDays: 7, channel: "email", enabled: true },
      ]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: true,
        count: 3,
      });

      // No env vars (real isReminderSendingEnabled)
      mockContext.cloudflare.env = {};

      const { loader } = await import("../app.settings.reminders");
      await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(ensureDefaultReminderRules).toHaveBeenCalledWith(
        mockSql,
        "shop-456"
      );
    });
  });

  describe("action - toggle_enabled", () => {
    it("blocks enabling when only RESEND_API_KEY is set (real isReminderSendingEnabled)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Only RESEND_API_KEY, no RESEND_FROM
      mockContext.cloudflare.env = { RESEND_API_KEY: "re_test_123" };

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("email provider is configured");
    });

    it("blocks enabling when only RESEND_FROM is set (real isReminderSendingEnabled)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      // Only RESEND_FROM, no RESEND_API_KEY
      mockContext.cloudflare.env = { RESEND_FROM: "noreply@example.com" };

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("email provider is configured");
    });

    it("allows disabling even when provider is not configured", async () => {
      const { updateShopReminderSettings } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (
        updateShopReminderSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);

      // No env vars (real isReminderSendingEnabled returns false)
      mockContext.cloudflare.env = {};

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "false");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Reminders disabled");
    });

    it("allows enabling when both RESEND_API_KEY and RESEND_FROM are set (real isReminderSendingEnabled)", async () => {
      const { updateShopReminderSettings } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (
        updateShopReminderSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);

      // Both keys set (real isReminderSendingEnabled returns true)
      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Reminders enabled");
    });
  });

  describe("action - update_rule (real isValidOffset)", () => {
    it("updates rule with valid offset (7)", async () => {
      const { updateReminderRule, getShopReminderRules } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      // Provider configured (real isReminderSendingEnabled)
      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-123");
      formData.append("offsetDays", "7");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Rule updated");
    });

    it("rejects offset at -31 (below OFFSET_MIN, real isValidOffset)", async () => {
      const { OFFSET_MIN, OFFSET_MAX } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-123");
      formData.append("offsetDays", "-31");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(`${OFFSET_MIN}`);
      expect(result.error).toContain(`${OFFSET_MAX}`);
    });

    it("rejects offset at 91 (above OFFSET_MAX, real isValidOffset)", async () => {
      const { OFFSET_MIN, OFFSET_MAX } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-123");
      formData.append("offsetDays", "91");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain(`${OFFSET_MIN}`);
      expect(result.error).toContain(`${OFFSET_MAX}`);
    });

    it("accepts offset at -30 (OFFSET_MIN boundary, real isValidOffset)", async () => {
      const { updateReminderRule } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-123");
      formData.append("offsetDays", "-30");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
    });

    it("accepts offset at 90 (OFFSET_MAX boundary, real isValidOffset)", async () => {
      const { updateReminderRule } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-123");
      formData.append("offsetDays", "90");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
    });

    it("returns error when rule not found", async () => {
      const { updateReminderRule, getShopReminderRules } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "nonexistent-rule");
      formData.append("offsetDays", "7");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Rule not found");
    });

    it("rejects duplicate offset when updating to match another rule", async () => {
      const { getShopReminderRules } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "rule-1", offsetDays: 7, channel: "email", enabled: true },
        { id: "rule-2", offsetDays: 14, channel: "email", enabled: true },
      ]);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-1");
      formData.append("offsetDays", "14");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });
  });

  describe("action - create_rule", () => {
    it("creates rule with valid offset (real isValidOffset)", async () => {
      const { getShopReminderRules, createReminderRule } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (createReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(
        "new-rule-id"
      );

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "create_rule");
      formData.append("offsetDays", "14");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Rule created");
    });

    it("rejects duplicate offset", async () => {
      const { getShopReminderRules } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "rule-1", offsetDays: 7, channel: "email", enabled: true },
      ]);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "create_rule");
      formData.append("offsetDays", "7");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("already exists");
    });
  });

  describe("action - delete_rule", () => {
    it("deletes rule successfully", async () => {
      const { deleteReminderRule } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (deleteReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "delete_rule");
      formData.append("ruleId", "rule-123");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Rule deleted");
    });

    it("returns error when rule has reminder history", async () => {
      const { deleteReminderRule } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (deleteReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "delete_rule");
      formData.append("ruleId", "rule-with-history");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("reminder history");
    });
  });

  describe("action - invalid intent", () => {
    it("returns error for unknown intent", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const formData = new FormData();
      formData.append("intent", "invalid_action");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown action");
    });
  });

  describe("action - shop not found", () => {
    it("returns error when shop not found", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Shop not found");
    });
  });
});

describe("ensureDefaultReminderRules (via loader)", () => {
  it("loader calls ensureDefaultReminderRules with correct shopId", async () => {
    const {
      getShopReminderSettings,
      getShopReminderRules,
      getShopReminderLogs,
      getGlobalSendCounts,
      ensureDefaultReminderRules,
    } = await import("~/services/reminders.server");
    const { getRequestSql } = await import("~/lib/request-context.server");

    const mockSql = vi.fn().mockResolvedValueOnce([{ id: "shop-xyz" }]);
    (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
    (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
      enabled: false,
    });
    (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
      daily: 0,
      monthly: 0,
    });
    (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
      seeded: true,
      count: 3,
    });

    const mockSession = { shop: "test-store.myshopify.com" };
    const mockContext = {
      shopify: {
        authenticate: {
          admin: vi.fn().mockResolvedValue({ session: mockSession }),
        },
      },
      cloudflare: { env: {} }, // No env vars (real isReminderSendingEnabled)
    };
    const mockRequest = new Request("https://example.com/app/settings/reminders");

    const { loader } = await import("../app.settings.reminders");
    await loader({
      request: mockRequest,
      context: mockContext as never,
      params: {},
      url: new URL(mockRequest.url),
      pattern: "/app/settings/reminders",
    });

    expect(ensureDefaultReminderRules).toHaveBeenCalledWith(
      mockSql,
      "shop-xyz"
    );
  });

  it("DEFAULT_RULE_OFFSETS constant is -3, 0, 7", async () => {
    const { DEFAULT_RULE_OFFSETS } = await import("~/services/reminders.server");

    expect(DEFAULT_RULE_OFFSETS).toEqual([-3, 0, 7]);
  });
});

describe("Reminder Settings Route error logging (R2)", () => {
  const mockSession = { shop: "test-sensitive-store.myshopify.com" };
  const mockContext = {
    shopify: {
      authenticate: {
        admin: vi.fn().mockResolvedValue({ session: mockSession }),
      },
    },
    cloudflare: {
      env: {},
    },
  };
  const mockRequest = new Request("https://example.com/app/settings/reminders");
  const mockUrl = new URL(mockRequest.url);
  const mockPattern = "/app/settings/reminders";

  let mockSql: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockSql = vi.fn();
    mockContext.shopify.authenticate.admin.mockResolvedValue({
      session: mockSession,
    });
    mockContext.cloudflare.env = {};
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe("loader error logging (R2)", () => {
    it("logs error code via real safeLog, not raw error with domain or email", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      const sensitiveError = new Error(
        "Database error for admin@test-sensitive-store.myshopify.com: balance 99500"
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockRejectedValue(
        sensitiveError
      );

      const { loader } = await import("../app.settings.reminders");
      const result = await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      const logOutput = consoleErrorSpy.mock.calls[0][0];

      expect(logOutput).toContain('"event":"reminders_send_counts_error"');
      expect(logOutput).toContain('"shopId":"shop-123"');
      expect(logOutput).toContain('"err":');

      expect(logOutput).not.toContain("myshopify.com");
      expect(logOutput).not.toContain("@sensitive-store");
      expect(logOutput).not.toContain("99500");
      expect(logOutput).not.toContain("balance");

      expect(result.usageError).toBe(true);
    });

    it("logs shopId and errorCode for send counts error", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-456" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      const dbError = new TypeError("Connection failed");
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockRejectedValue(
        dbError
      );

      const { loader } = await import("../app.settings.reminders");
      await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      expect(logOutput).toContain('"event":"reminders_send_counts_error"');
      expect(logOutput).toContain('"shopId":"shop-456"');
      expect(logOutput).toContain('"err":"TypeError"');
    });
  });

  describe("action error logging (R2)", () => {
    it("logs shopId, action, and errorCode for action error", async () => {
      const { updateShopReminderSettings } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-action-test" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const actionError = new Error(
        "Update failed for merchant@shop.myshopify.com with amount 50000"
      );
      (
        updateShopReminderSettings as ReturnType<typeof vi.fn>
      ).mockRejectedValue(actionError);

      const formData = new FormData();
      formData.append("intent", "toggle_enabled");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      expect(logOutput).toContain('"event":"reminders_action_error"');
      expect(logOutput).toContain('"shopId":"shop-action-test"');
      expect(logOutput).toContain('"action":"toggle_enabled"');
      expect(logOutput).toContain('"err":');

      expect(logOutput).not.toContain("myshopify.com");
      expect(logOutput).not.toContain("@shop");
      expect(logOutput).not.toContain("50000");
      expect(logOutput).not.toContain("merchant");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Action failed");
    });

    it("does not log raw error message with customer email", async () => {
      const { updateReminderRule } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-email-test" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const errorWithEmail = new Error(
        "Reminder failed for customer@business.com invoice INV-2024-001"
      );
      (updateReminderRule as ReturnType<typeof vi.fn>).mockRejectedValue(
        errorWithEmail
      );

      const formData = new FormData();
      formData.append("intent", "update_rule");
      formData.append("ruleId", "rule-123");
      formData.append("offsetDays", "7");
      formData.append("enabled", "true");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      const logOutput = consoleErrorSpy.mock.calls[0][0];
      expect(logOutput).not.toContain("customer@business.com");
      expect(logOutput).not.toContain("INV-2024-001");
      expect(logOutput).not.toContain("Reminder failed");
    });

    it("logs hostile intent as 'other' (toSafeIntent)", async () => {
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-hostile-intent" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      const formData = new FormData();
      // Hostile intent that could be an email or XSS attempt
      formData.append("intent", "x@y.com");

      const postRequest = new Request(
        "https://example.com/app/settings/reminders",
        {
          method: "POST",
          body: formData,
        }
      );

      const { action } = await import("../app.settings.reminders");
      const result = await action({
        request: postRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown action");

      const logOutput = consoleWarnSpy.mock.calls[0][0];
      // Should log "other" instead of the hostile intent
      expect(logOutput).toContain('"event":"reminders_unknown_action"');
      expect(logOutput).toContain('"action":"other"');
      // Should NOT contain the hostile input
      expect(logOutput).not.toContain("x@y.com");

      consoleWarnSpy.mockRestore();
    });
  });

  describe("loader success paths (no errors)", () => {
    it("does not call console.error when no errors occur", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        getShopReminderLogs,
        getGlobalSendCounts,
        ensureDefaultReminderRules,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-ok" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (getShopReminderSettings as ReturnType<typeof vi.fn>).mockResolvedValue({
        enabled: false,
      });
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getShopReminderLogs as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

      const { loader } = await import("../app.settings.reminders");
      await loader({
        request: mockRequest,
        context: mockContext as never,
        params: {},
        url: mockUrl,
        pattern: mockPattern,
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
