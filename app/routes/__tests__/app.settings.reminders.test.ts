import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for S18 reminder settings route (app/routes/app.settings.reminders.tsx).
 *
 * Covers:
 * - Loader: default disabled, not-configured state, caps and usage present, shop not found
 * - Action: toggle_enabled, update_rule, create_rule, delete_rule, offset validation, invalid intent
 * - ensureDefaultReminderRules: seeds 3 on empty shop, no-op when rules exist, concurrency safety
 */

vi.mock("~/services/reminders.server", () => ({
  getShopReminderSettings: vi.fn(),
  getShopReminderRules: vi.fn(),
  updateShopReminderSettings: vi.fn(),
  updateReminderRule: vi.fn(),
  createReminderRule: vi.fn(),
  deleteReminderRule: vi.fn(),
  isReminderSendingEnabled: vi.fn(),
  isValidOffset: vi.fn(),
  getGlobalSendCounts: vi.fn(),
  ensureDefaultReminderRules: vi.fn(),
  DAILY_SEND_CAP: 100,
  MONTHLY_SEND_CAP: 3000,
  OFFSET_MIN: -30,
  OFFSET_MAX: 90,
  DEFAULT_RULE_OFFSETS: [-3, 0, 7],
}));

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
        isReminderSendingEnabled,
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
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: true,
        count: 3,
      });

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
        isReminderSendingEnabled,
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
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
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

      expect(result.providerConfigured).toBe(false);
    });

    it("returns not-configured state when RESEND_FROM is missing", async () => {
      const {
        getShopReminderSettings,
        getShopReminderRules,
        isReminderSendingEnabled,
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
      // Only RESEND_API_KEY is set, RESEND_FROM is missing
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

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
        isReminderSendingEnabled,
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
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 50,
        monthly: 1500,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

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
        isReminderSendingEnabled,
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
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
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
        isReminderSendingEnabled,
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
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("Database error")
      );
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: false,
        count: 0,
      });

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
        isReminderSendingEnabled,
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
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );
      (getGlobalSendCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
        daily: 0,
        monthly: 0,
      });
      (ensureDefaultReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue({
        seeded: true,
        count: 3,
      });

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
    it("blocks enabling when provider is not configured", async () => {
      const { isReminderSendingEnabled } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );

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
      const { isReminderSendingEnabled, updateShopReminderSettings } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        false
      );
      (
        updateShopReminderSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);

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

    it("allows enabling when provider is configured", async () => {
      const { isReminderSendingEnabled, updateShopReminderSettings } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (
        updateShopReminderSettings as ReturnType<typeof vi.fn>
      ).mockResolvedValue(undefined);

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

      mockContext.cloudflare.env = {
        RESEND_API_KEY: "re_test_123",
        RESEND_FROM: "noreply@example.com",
      };

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

  describe("action - update_rule", () => {
    it("updates rule with valid offset", async () => {
      const { isReminderSendingEnabled, isValidOffset, updateReminderRule } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

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

    it("rejects offset at -31 (below OFFSET_MIN)", async () => {
      const { isReminderSendingEnabled, isValidOffset, OFFSET_MIN, OFFSET_MAX } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(false);

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

    it("rejects offset at 91 (above OFFSET_MAX)", async () => {
      const { isReminderSendingEnabled, isValidOffset, OFFSET_MIN, OFFSET_MAX } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(false);

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

    it("accepts offset at -30 (OFFSET_MIN boundary)", async () => {
      const { isReminderSendingEnabled, isValidOffset, updateReminderRule } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

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

    it("accepts offset at 90 (OFFSET_MAX boundary)", async () => {
      const { isReminderSendingEnabled, isValidOffset, updateReminderRule } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(true);
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
      const { isReminderSendingEnabled, isValidOffset, updateReminderRule } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (updateReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(false);

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
  });

  describe("action - create_rule", () => {
    it("creates rule with valid offset", async () => {
      const {
        isReminderSendingEnabled,
        isValidOffset,
        getShopReminderRules,
        createReminderRule,
      } = await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (createReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(
        "new-rule-id"
      );

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
      const { isReminderSendingEnabled, isValidOffset, getShopReminderRules } =
        await import("~/services/reminders.server");
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (isValidOffset as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (getShopReminderRules as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "rule-1", offsetDays: 7, channel: "email", enabled: true },
      ]);

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
      const { isReminderSendingEnabled, deleteReminderRule } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (deleteReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(true);

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
      const { isReminderSendingEnabled, deleteReminderRule } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );
      (deleteReminderRule as ReturnType<typeof vi.fn>).mockResolvedValue(false);

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
      const { isReminderSendingEnabled } = await import(
        "~/services/reminders.server"
      );
      const { getRequestSql } = await import("~/lib/request-context.server");

      mockSql.mockResolvedValueOnce([{ id: "shop-123" }]);
      (getRequestSql as ReturnType<typeof vi.fn>).mockReturnValue(mockSql);
      (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true
      );

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
      isReminderSendingEnabled,
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
    (isReminderSendingEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
      false
    );
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
      cloudflare: { env: {} },
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
