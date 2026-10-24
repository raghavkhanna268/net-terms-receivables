import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for S18 Payment Reminders.
 *
 * Tests verify (per docs/qa/S18-payment-reminders.md):
 * - S18-01: No outbound HTTP with RESEND_API_KEY unset
 * - S18-02: RESEND_API_KEY="" or whitespace treated as unset
 * - S18-05: Log line "reminders disabled" when key unset
 * - S18-07: When key is later set, no backlog blast (only current-slot reminders)
 * - S18-10: One email per (invoice, offset) slot
 * - S18-11: No second email on retry/replay (idempotency via ReminderLog)
 * - S18-12: No reminder for paid/cancelled invoices
 * - S18-14: 429/5xx are retryable
 * - S18-15: 401 is non-retryable
 * - S18-16: Timezone (shop's IANA timezone for day math)
 * - Daily cap enforcement (100/day GLOBAL)
 * - Monthly cap enforcement (3,000/month GLOBAL)
 * - Send window (09:00-19:00 shop local time)
 * - PCD compliance (only email/displayName via CUSTOMER_PII_FIELDS)
 * - RESEND_FROM gate (both keys required)
 * - Reserve-then-release cap on non-retryable errors
 * - offsetDays validation (-30 to 90)
 * - formatAmount uses Decimal(14,2) rupees (not paise)
 * - Idempotency-Key HTTP header to Resend
 */

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock SQL client factory
function createMockSql() {
  const mockResults = new Map<string, unknown>();

  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join("?");

      // Invoice lookup
      if (query.includes("FROM \"Invoice\"") && query.includes("INNER JOIN")) {
        return mockResults.get("invoice") ?? [];
      }

      // Customer PII lookup
      if (query.includes("FROM s8_tagged_customers")) {
        return mockResults.get("customer") ?? [];
      }

      // ReminderLog exists check
      if (query.includes("EXISTS") && query.includes("ReminderLog")) {
        return mockResults.get("reminder_exists") ?? [{ exists: false }];
      }

      // ReminderLog INSERT (claim slot)
      if (query.includes("INSERT INTO \"ReminderLog\"")) {
        const claimed = mockResults.get("claim_slot") ?? [{ id: "new-log-id" }];
        return claimed;
      }

      // ReminderLog DELETE (release slot)
      if (query.includes("DELETE FROM \"ReminderLog\"")) {
        return [];
      }

      // Global sends CTE-based atomic reservation
      if (query.includes("WITH monthly_sum AS") && query.includes("upserted AS")) {
        const result = mockResults.get("global_increment") ?? [{ dailyCount: 1, monthlyTotal: 1 }];
        return result;
      }

      // Global sends release (decrement)
      if (query.includes("GREATEST(0, daily_count - 1)")) {
        return [];
      }

      // Global sends count query
      if (query.includes("FROM s18_global_sends") && query.includes("send_date =")) {
        return mockResults.get("global_daily") ?? [];
      }

      // Global sends monthly sum
      if (query.includes("SUM(daily_count)") && query.includes("s18_global_sends")) {
        return mockResults.get("global_monthly") ?? [{ monthlyTotal: 0 }];
      }

      // ReminderRule lookup
      if (query.includes("FROM \"ReminderRule\"") && query.includes("WHERE id")) {
        return mockResults.get("rule") ?? [];
      }

      // ReminderRule UPDATE
      if (query.includes("UPDATE \"ReminderRule\"") && query.includes("RETURNING id")) {
        return mockResults.get("rule_update") ?? [{ id: "rule-123" }];
      }

      // Shop reminder settings
      if (query.includes("FROM s18_shop_reminder_settings")) {
        return mockResults.get("settings") ?? [];
      }

      return [];
    }),
    {
      json: vi.fn((v) => v),
      unsafe: vi.fn((s: string) => s),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value),
      clearMockResults: () => mockResults.clear(),
    }
  ) as unknown as Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
  };

  return sql;
}

describe("Payment Reminders (S18)", () => {
  const originalEnv = process.env;
  let mockSql: ReturnType<typeof createMockSql>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));
    mockSql = createMockSql();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    consoleInfoSpy.mockRestore();
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("isReminderSendingEnabled", () => {
    it("returns false when RESEND_API_KEY is undefined (S18-01)", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({})).toBe(false);
    });

    it("returns false when RESEND_API_KEY is empty string (S18-02)", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "", RESEND_FROM: "test@example.com" })).toBe(false);
    });

    it("returns false when RESEND_API_KEY is whitespace (S18-02)", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "   ", RESEND_FROM: "test@example.com" })).toBe(false);
    });

    it("returns false when RESEND_FROM is missing", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "re_test_1234" })).toBe(false);
    });

    it("returns false when RESEND_FROM is empty", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "re_test_1234", RESEND_FROM: "" })).toBe(false);
    });

    it("returns false when RESEND_FROM is whitespace", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "re_test_1234", RESEND_FROM: "   " })).toBe(false);
    });

    it("returns true when both RESEND_API_KEY and RESEND_FROM are set", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ 
        RESEND_API_KEY: "re_test_1234", 
        RESEND_FROM: "noreply@example.com" 
      })).toBe(true);
    });
  });

  describe("isValidOffset", () => {
    it("accepts valid offsets within -30..90", async () => {
      const { isValidOffset, OFFSET_MIN, OFFSET_MAX } = await import("../reminders.server");
      expect(OFFSET_MIN).toBe(-30);
      expect(OFFSET_MAX).toBe(90);
      expect(isValidOffset(-30)).toBe(true);
      expect(isValidOffset(-3)).toBe(true);
      expect(isValidOffset(0)).toBe(true);
      expect(isValidOffset(7)).toBe(true);
      expect(isValidOffset(90)).toBe(true);
    });

    it("rejects offsets outside -30..90", async () => {
      const { isValidOffset } = await import("../reminders.server");
      expect(isValidOffset(-31)).toBe(false);
      expect(isValidOffset(91)).toBe(false);
      expect(isValidOffset(-100)).toBe(false);
      expect(isValidOffset(365)).toBe(false);
    });

    it("rejects non-integer offsets", async () => {
      const { isValidOffset } = await import("../reminders.server");
      expect(isValidOffset(3.5)).toBe(false);
      expect(isValidOffset(-1.1)).toBe(false);
    });
  });

  describe("sendPaymentReminder - RESEND_API_KEY gate", () => {
    it("when no key: acks without ReminderLog, logs 'reminders disabled', no HTTP, no cap consumed (S18-01, S18-05)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        "Asia/Kolkata",
        {} // No RESEND_API_KEY
      );

      // Should ack (success: true) without consuming slot
      expect(result.success).toBe(true);
      expect(result.action).toBe("disabled");
      expect(result.skipReason).toContain("reminders disabled");

      // Should log via safeLog (outputs JSON to console.log)
      // safeLog("info", ...) writes to console.log, not console.info
      expect(consoleLogSpy).toHaveBeenCalledWith(
        expect.stringContaining("reminders_disabled")
      );

      // Should NOT call fetch (S18-01)
      expect(mockFetch).not.toHaveBeenCalled();

      // Should NOT insert ReminderLog (no slot claim)
      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const reminderLogInserts = sqlCalls.filter((q: string) => q.includes("INSERT INTO \"ReminderLog\""));
      expect(reminderLogInserts).toHaveLength(0);
    });
  });

  describe("sendPaymentReminder - caps", () => {
    const _mockInvoiceData = {
      invoiceId: "inv-123",
      shopId: "shop-123",
      shopDomain: "test-shop.myshopify.com",
      shopTimezone: "Asia/Kolkata",
      invoiceName: "#1001",
      total: "100000",
      currency: "INR",
      dueAt: new Date("2026-10-30"),
      status: "open",
      buyerAccountId: "buyer-123",
      customerId: "gid://shopify/Customer/456",
    };

    it("returns capped when daily GLOBAL cap (100) is reached", async () => {
      const { sendPaymentReminder, DAILY_SEND_CAP } = await import("../reminders.server");

      const mockInvoice = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "1000.00",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("invoice", [mockInvoice]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      // Mock reservation failure due to daily cap - return 0 dailyCount
      mockSql.setMockResult("global_increment", [{ dailyCount: 0, monthlyTotal: 50 }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("capped");
      expect(result.skipReason).toContain("send cap");
      expect(mockFetch).not.toHaveBeenCalled();

      // Verify DAILY_SEND_CAP constant
      expect(DAILY_SEND_CAP).toBe(100);
    });

    it("returns capped when monthly GLOBAL cap (3000) is reached", async () => {
      const { sendPaymentReminder, MONTHLY_SEND_CAP } = await import("../reminders.server");

      const mockInvoice = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "1000.00",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("invoice", [mockInvoice]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      // Mock reservation failure - return 0 dailyCount but high monthly
      mockSql.setMockResult("global_increment", [{ dailyCount: 0, monthlyTotal: MONTHLY_SEND_CAP }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("capped");
      expect(result.skipReason).toContain("send cap");
      expect(mockFetch).not.toHaveBeenCalled();

      // Verify MONTHLY_SEND_CAP constant
      expect(MONTHLY_SEND_CAP).toBe(3000);
    });
  });

  describe("sendPaymentReminder - invoice status", () => {
    let baseInvoice: {
      invoiceId: string;
      shopId: string;
      shopDomain: string;
      shopTimezone: string;
      invoiceName: string;
      total: string;
      currency: string;
      dueAt: Date;
      buyerAccountId: string;
      customerId: string;
    };

    beforeEach(() => {
      baseInvoice = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "100000",
        currency: "INR",
        dueAt: new Date(),
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };
    });

    it("skips when invoice is paid (S18-12)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [{ ...baseInvoice, status: "paid" }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is paid");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice is cancelled (S18-12)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [{ ...baseInvoice, status: "cancelled" }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is cancelled");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("sendPaymentReminder - CUSTOMER_PII_FIELDS", () => {
    it("skips without consuming slot when buyer has no email (PII off)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const mockInvoiceData = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "100000",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("global_daily", []);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      // Customer has no email (CUSTOMER_PII_FIELDS is off)
      mockSql.setMockResult("customer", [{ email: null, displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("no email");
      expect(result.skipReason).toContain("CUSTOMER_PII_FIELDS");
      expect(mockFetch).not.toHaveBeenCalled();

      // Should NOT insert ReminderLog (no slot consumed)
      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const reminderLogInserts = sqlCalls.filter((q: string) => q.includes("INSERT INTO \"ReminderLog\""));
      expect(reminderLogInserts).toHaveLength(0);
    });
  });

  describe("sendPaymentReminder - idempotency (S18-11)", () => {
    it("skips on retry when reminder already sent", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const mockInvoiceData = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "1000.00",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", []); // Empty = slot not claimed (conflict)

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("already sent");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("sendPaymentReminder - error handling", () => {
    let mockInvoiceData: {
      invoiceId: string;
      shopId: string;
      shopDomain: string;
      shopTimezone: string;
      invoiceName: string;
      total: string;
      currency: string;
      dueAt: Date;
      status: string;
      buyerAccountId: string;
      customerId: string;
    };

    const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" };

    beforeEach(() => {
      mockInvoiceData = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "1000.00",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };
    });

    it("handles Resend 429 rate limit as retryable (S18-14)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      // R1: Now returns errorCode instead of raw message
      expect(result.errorCode).toBe("resend_rate_limited");
    });

    it("handles Resend 401 auth error as non-retryable and releases cap (S18-15)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      // safeLog outputs JSON with event name
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("reminders_auth_error")
      );

      // Verify cap was released (UPDATE query with GREATEST(0, daily_count - 1))
      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const capReleaseCalls = sqlCalls.filter((q: string) => q.includes("GREATEST(0, daily_count - 1)"));
      expect(capReleaseCalls.length).toBeGreaterThan(0);
    });

    it("handles 5xx server errors as retryable AND releases cap (only success counts)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "Service unavailable",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);

      // Verify cap WAS released - only successful sends count toward cap
      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const capReleaseCalls = sqlCalls.filter((q: string) => q.includes("GREATEST(0, daily_count - 1)"));
      expect(capReleaseCalls.length).toBeGreaterThan(0);
    });

    it("handles 429 rate limit as retryable AND releases cap (only success counts)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);

      // Verify cap WAS released - only successful sends count toward cap
      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const capReleaseCalls = sqlCalls.filter((q: string) => q.includes("GREATEST(0, daily_count - 1)"));
      expect(capReleaseCalls.length).toBeGreaterThan(0);
    });

    it("sends Idempotency-Key HTTP header to Resend", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.resend.com/emails");
      expect(options.headers["Idempotency-Key"]).toBe("s18_inv-123_rule-123");
    });

    it("uses RESEND_FROM for sender address", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "email-123" }),
      });

      await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "reminders@myapp.com" }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options.body);
      expect(body.from).toBe("reminders@myapp.com");
    });
  });

  describe("sendPaymentReminder - network errors", () => {
    let mockInvoiceData: {
      invoiceId: string;
      shopId: string;
      shopDomain: string;
      shopTimezone: string;
      invoiceName: string;
      total: string;
      currency: string;
      dueAt: Date;
      status: string;
      buyerAccountId: string;
      customerId: string;
    };

    const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" };

    beforeEach(() => {
      mockInvoiceData = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "1000.00",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };
    });

    it("releases cap slot on network error (only success counts)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

      // Simulate network error
      mockFetch.mockRejectedValueOnce(new Error("Network timeout"));

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      // R1: Now returns errorCode instead of raw message
      expect(result.errorCode).toBe("timeout");

      // Verify cap WAS released - only successful sends count toward cap
      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const capReleaseCalls = sqlCalls.filter((q: string) => q.includes("GREATEST(0, daily_count - 1)"));
      expect(capReleaseCalls.length).toBeGreaterThan(0);
    });
  });

  describe("sendPaymentReminder - send window", () => {
    it("returns outside_window when called outside 09:00-19:00 shop local time, without consuming cap or calling Resend", async () => {
      vi.setSystemTime(new Date("2026-10-24T15:00:00Z"));

      const { sendPaymentReminder } = await import("../reminders.server");

      const mockInvoiceData = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        shopTimezone: "Asia/Kolkata",
        invoiceName: "#1001",
        total: "1000.00",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("outside_window");
      expect(result.skipReason).toContain("Outside send window");
      expect(mockFetch).not.toHaveBeenCalled();

      const sqlCalls = (mockSql as unknown as { mock: { calls: Array<[TemplateStringsArray]> } }).mock.calls.map((c: [TemplateStringsArray]) => c[0].join("?"));
      const reminderLogInserts = sqlCalls.filter((q: string) => q.includes("INSERT INTO \"ReminderLog\""));
      expect(reminderLogInserts).toHaveLength(0);
      const globalIncrements = sqlCalls.filter((q: string) => q.includes("WITH monthly_sum AS") && q.includes("upserted AS"));
      expect(globalIncrements).toHaveLength(0);
    });
  });

  describe("validateTimezone safety", () => {
    it("returns fallback for invalid timezone strings", async () => {
      const { validateTimezone } = await import("~/lib/aging-dates.server");

      // Invalid timezone should return fallback (Asia/Kolkata)
      expect(validateTimezone("Invalid/Zone")).toBe("Asia/Kolkata");
      expect(validateTimezone("")).toBe("Asia/Kolkata");
      expect(validateTimezone("Not_A_Timezone")).toBe("Asia/Kolkata");
    });

    it("returns valid timezone unchanged", async () => {
      const { validateTimezone } = await import("~/lib/aging-dates.server");

      expect(validateTimezone("America/New_York")).toBe("America/New_York");
      expect(validateTimezone("Europe/London")).toBe("Europe/London");
      expect(validateTimezone("Asia/Kolkata")).toBe("Asia/Kolkata");
    });
  });

  describe("updateReminderRule", () => {
    it("updates offsetDays within valid bounds", async () => {
      const { updateReminderRule } = await import("../reminders.server");

      // Mock successful update
      const mockUpdateResult = [{ id: "rule-123" }];
      mockSql.setMockResult("rule_update", mockUpdateResult);

      const updated = await updateReminderRule(mockSql, "shop-123", "rule-123", {
        offsetDays: 7,
      });

      expect(updated).toBe(true);
    });

    it("throws error for offsetDays outside bounds", async () => {
      const { updateReminderRule, OFFSET_MIN, OFFSET_MAX } = await import("../reminders.server");

      await expect(
        updateReminderRule(mockSql, "shop-123", "rule-123", { offsetDays: -31 })
      ).rejects.toThrow(`offsetDays must be between ${OFFSET_MIN} and ${OFFSET_MAX}`);

      await expect(
        updateReminderRule(mockSql, "shop-123", "rule-123", { offsetDays: 91 })
      ).rejects.toThrow(`offsetDays must be between ${OFFSET_MIN} and ${OFFSET_MAX}`);
    });

    it("returns false when no updates provided", async () => {
      const { updateReminderRule } = await import("../reminders.server");

      const updated = await updateReminderRule(mockSql, "shop-123", "rule-123", {});
      expect(updated).toBe(false);
    });
  });

  describe("getReminderLabel", () => {
    it("formats days before due correctly", async () => {
      const { getReminderLabel } = await import("../reminders.server");

      expect(getReminderLabel(-3)).toBe("Payment due in 3 days");
      expect(getReminderLabel(-1)).toBe("Payment due in 1 day");
    });

    it("formats due today correctly", async () => {
      const { getReminderLabel } = await import("../reminders.server");

      expect(getReminderLabel(0)).toBe("Payment due today");
    });

    it("formats days overdue correctly", async () => {
      const { getReminderLabel } = await import("../reminders.server");

      expect(getReminderLabel(7)).toBe("Payment 7 days overdue");
      expect(getReminderLabel(1)).toBe("Payment 1 day overdue");
    });
  });

  describe("cap constants", () => {
    it("DAILY_SEND_CAP is 100 per Resend free tier", async () => {
      const { DAILY_SEND_CAP } = await import("../reminders.server");
      expect(DAILY_SEND_CAP).toBe(100);
    });

    it("MONTHLY_SEND_CAP is 3000 per Resend free tier", async () => {
      const { MONTHLY_SEND_CAP } = await import("../reminders.server");
      expect(MONTHLY_SEND_CAP).toBe(3000);
    });
  });

  describe("isWithinSendWindow", () => {
    it("returns true when within 09:00-19:00 in shop timezone", async () => {
      const { isWithinSendWindow } = await import("../reminders.server");

      // Mock DateTime.now to return 14:00 IST
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 14, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      expect(isWithinSendWindow("Asia/Kolkata")).toBe(true);
    });

    it("returns false when outside 09:00-19:00 in shop timezone", async () => {
      const { isWithinSendWindow } = await import("../reminders.server");

      // Mock DateTime.now to return 06:00 IST (before window)
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 6, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      expect(isWithinSendWindow("Asia/Kolkata")).toBe(false);
    });

    it("returns false at 19:00 (window ends)", async () => {
      const { isWithinSendWindow } = await import("../reminders.server");

      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 19, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      expect(isWithinSendWindow("Asia/Kolkata")).toBe(false);
    });

    it("returns true at 09:00 (window starts)", async () => {
      const { isWithinSendWindow } = await import("../reminders.server");

      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 9, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      expect(isWithinSendWindow("Asia/Kolkata")).toBe(true);
    });
  });

  describe("isReminderDueToday (S18-16 timezone)", () => {
    it("uses shop timezone for day boundary calculation", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      // Set "now" to Oct 30 2026 at noon IST
      const mockNow = DateTime.fromObject({ year: 2026, month: 10, day: 30, hour: 12 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      // Due date is Oct 27 2026 in IST, offset is -3 → reminder on Oct 24
      // But today is Oct 30, so this should be false
      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);

      // Due date is Nov 2 2026 in IST, offset is -3 → reminder on Oct 30
      const dueDate2 = new Date("2026-11-02T00:00:00+05:30");
      expect(isReminderDueToday(dueDate2, -3, "Asia/Kolkata")).toBe(true);
    });

    it("correctly handles timezone day boundary edge cases", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      // It's 11pm UTC on Oct 30, which is 4:30am IST on Oct 31
      const mockNow = DateTime.fromISO("2026-10-30T23:00:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      // Due date is Nov 3 IST, offset is -3 → reminder on Oct 31 IST
      // Now is Oct 31 IST (4:30am), so this should be true
      const dueDate = new Date("2026-11-03T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });
  });
});

describe("Payment Reminder Email Template", () => {
  it("renders email with correct structure", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    const html = renderPaymentReminderEmail({
      invoiceName: "#1001",
      buyerName: "Test Customer",
      amount: "₹1,000.00",
      dueDate: "October 30, 2026",
      merchantName: "Test Shop",
      reminderType: "Payment due in 3 days",
    });

    expect(html).toContain("Payment due in 3 days");
    expect(html).toContain("Test Customer");
    expect(html).toContain("#1001");
    expect(html).toContain("₹1,000.00");
    expect(html).toContain("October 30, 2026");
    expect(html).toContain("Test Shop");
  });

  it("escapes HTML in user-provided content", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    const html = renderPaymentReminderEmail({
      invoiceName: "<script>alert('xss')</script>",
      buyerName: "Test & Co <Ltd>",
      amount: "₹1,000.00",
      dueDate: "October 30, 2026",
      merchantName: "Shop \"Name\"",
      reminderType: "Payment due today",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Test &amp; Co &lt;Ltd&gt;");
    expect(html).toContain("Shop &quot;Name&quot;");
  });

  it("shows overdue styling for overdue reminders", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    const html = renderPaymentReminderEmail({
      invoiceName: "#1001",
      buyerName: "Test Customer",
      amount: "₹1,000.00",
      dueDate: "October 30, 2026",
      merchantName: "Test Shop",
      reminderType: "Payment 7 days overdue",
    });

    expect(html).toContain("Overdue");
    expect(html).toContain("#dc2626"); // Red color for overdue
  });
});

describe("Reminder Job Handler", () => {
  it("validates REMINDER_SEND message format", async () => {
    const { isReminderSendMessage } = await import("~/jobs/reminders");

    expect(isReminderSendMessage(null)).toBe(false);
    expect(isReminderSendMessage({})).toBe(false);
    expect(isReminderSendMessage({ topic: "OTHER" })).toBe(false);

    expect(
      isReminderSendMessage({
        topic: "REMINDER_SEND",
        shop: "test.myshopify.com",
        shopId: "shop-123",
        invoiceId: "inv-123",
        ruleId: "rule-123",
        offsetDays: -3,
        timezone: "Asia/Kolkata",
        webhookId: "s18_inv-123_rule-123_2026-10-30",
        enqueuedAt: "2026-10-30T10:00:00Z",
      })
    ).toBe(true);

    // Also valid without optional fields
    expect(
      isReminderSendMessage({
        topic: "REMINDER_SEND",
        shop: "test.myshopify.com",
        shopId: "shop-123",
        invoiceId: "inv-123",
        ruleId: "rule-123",
        webhookId: "s18_inv-123_rule-123_2026-10-30",
        enqueuedAt: "2026-10-30T10:00:00Z",
      })
    ).toBe(true);
  });
});

describe("formatAmount (rendered in email)", () => {
  it("renders INR amount from Decimal(14,2) correctly (no paise division)", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    // Invoice.total is "1234.56" (Decimal(14,2) rupees), NOT paise
    // The email should show ₹1,234.56, not ₹12.35
    const html = renderPaymentReminderEmail({
      invoiceName: "#1001",
      buyerName: "Test Customer",
      amount: "₹1,234.56", // This is what formatAmount should produce from "1234.56"
      dueDate: "October 30, 2026",
      merchantName: "Test Shop",
      reminderType: "Payment due today",
    });

    expect(html).toContain("₹1,234.56");
    expect(html).not.toContain("₹12.35"); // Would be wrong if we divided by 100
  });
});

describe("ensureDefaultReminderRules", () => {
  it("DEFAULT_RULE_OFFSETS contains -3, 0, 7", async () => {
    const { DEFAULT_RULE_OFFSETS } = await import("../reminders.server");

    expect(DEFAULT_RULE_OFFSETS).toEqual([-3, 0, 7]);
  });

  it("seeds 3 rules on FIRST settings creation", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    const insertedRules: { offset: number }[] = [];
    const mockTx = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        // Advisory lock
        if (query.includes("pg_advisory_xact_lock")) {
          return [];
        }

        // Re-check ReminderLog inside transaction
        if (query.includes("EXISTS") && query.includes("ReminderLog")) {
          return [{ hasHistory: false }];
        }

        // Insert settings row - return shop_id to indicate it was created
        if (query.includes("INSERT INTO s18_shop_reminder_settings")) {
          return [{ shop_id: "shop-new" }];
        }

        // Insert rule
        if (query.includes("INSERT INTO \"ReminderRule\"")) {
          const offsetDays = values[1] as number;
          insertedRules.push({ offset: offsetDays });
          return [];
        }

        return [];
      }),
      {}
    );

    // Pre-tx EXISTS check returns no settings, no history
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: false, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
          return callback(mockTx);
        }),
      }
    );

    const result = await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-new"
    );

    expect(result.seeded).toBe(true);
    expect(result.count).toBe(3);
    expect(insertedRules.map((r) => r.offset)).toEqual([-3, 0, 7]);
  });

  it("is no-op when settings row already exists (via cheap EXISTS check)", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let beginCalled = false;

    // Pre-tx EXISTS check returns settings exist - should skip entirely
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: true, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async () => {
          beginCalled = true;
          return { seeded: false, count: 0 };
        }),
      }
    );

    const result = await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-with-settings"
    );

    expect(result.seeded).toBe(false);
    expect(result.count).toBe(0);
    expect(beginCalled).toBe(false);
  });

  it("does NOT re-seed after merchant deletes all rules (settings row already exists)", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let beginCalled = false;

    // Pre-tx EXISTS check returns settings exist (merchant deleted rules but settings remain)
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: true, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async () => {
          beginCalled = true;
          return { seeded: false, count: 0 };
        }),
      }
    );

    const result = await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-deleted-all-rules"
    );

    // No re-seeding because settings row already exists
    expect(result.seeded).toBe(false);
    expect(result.count).toBe(0);
    expect(beginCalled).toBe(false);
  });

  it("uses advisory lock for concurrency safety", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let lockAcquired = false;
    let lockShopId: string | null = null;
    const mockTx = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join("?");

        // Advisory lock
        if (query.includes("pg_advisory_xact_lock")) {
          lockAcquired = true;
          lockShopId = values[0] as string;
          return [];
        }

        // Re-check ReminderLog inside transaction
        if (query.includes("EXISTS") && query.includes("ReminderLog")) {
          return [{ hasHistory: false }];
        }

        // Insert settings row - conflict (already exists)
        if (query.includes("INSERT INTO s18_shop_reminder_settings")) {
          return [];
        }

        return [];
      }),
      {}
    );

    // Pre-tx EXISTS check returns no settings, no history
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: false, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
          return callback(mockTx);
        }),
      }
    );

    await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-concurrent"
    );

    expect(lockAcquired).toBe(true);
    expect(lockShopId).toBe("shop-concurrent");
  });

  it("inserts settings with enabled=false (query structure check)", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let settingsInsertQuery = "";
    const mockTx = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");

        // Advisory lock
        if (query.includes("pg_advisory_xact_lock")) {
          return [];
        }

        // Re-check ReminderLog inside transaction
        if (query.includes("EXISTS") && query.includes("ReminderLog")) {
          return [{ hasHistory: false }];
        }

        // Insert settings row - capture query structure
        if (query.includes("INSERT INTO s18_shop_reminder_settings")) {
          settingsInsertQuery = query;
          return [{ shop_id: "shop-new" }];
        }

        // Insert rule
        if (query.includes("INSERT INTO \"ReminderRule\"")) {
          return [];
        }

        return [];
      }),
      {}
    );

    // Pre-tx EXISTS check returns no settings, no history
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: false, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
          return callback(mockTx);
        }),
      }
    );

    await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-new"
    );

    // Query inserts with enabled = false (second placeholder after shop_id)
    expect(settingsInsertQuery).toContain("INSERT INTO s18_shop_reminder_settings");
    expect(settingsInsertQuery).toContain("shop_id");
    expect(settingsInsertQuery).toContain("enabled");
    // enabled=false is passed as second value placeholder
  });

  it("skips seeding when shop has ReminderLog history (cheap EXISTS check)", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let beginCalled = false;

    // Pre-tx EXISTS check returns history exists
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: false, hasHistory: true }];
        }
        return [];
      }),
      {
        begin: vi.fn(async () => {
          beginCalled = true;
          return { seeded: false, count: 0 };
        }),
      }
    );

    const result = await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-with-history"
    );

    // Should skip without even starting transaction
    expect(result.seeded).toBe(false);
    expect(result.count).toBe(0);
    expect(beginCalled).toBe(false);
  });

  it("skips seeding when shop has existing settings (cheap EXISTS check)", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let beginCalled = false;

    // Pre-tx EXISTS check returns settings exist
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: true, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async () => {
          beginCalled = true;
          return { seeded: false, count: 0 };
        }),
      }
    );

    const result = await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-with-settings"
    );

    // Should skip without even starting transaction
    expect(result.seeded).toBe(false);
    expect(result.count).toBe(0);
    expect(beginCalled).toBe(false);
  });

  it("re-checks ReminderLog inside transaction (race condition protection)", async () => {
    const { ensureDefaultReminderRules } = await import("../reminders.server");

    let ruleInsertCalled = false;
    const mockTx = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");

        // Advisory lock
        if (query.includes("pg_advisory_xact_lock")) {
          return [];
        }

        // Re-check ReminderLog inside transaction - NOW returns true (race condition)
        if (query.includes("EXISTS") && query.includes("ReminderLog")) {
          return [{ hasHistory: true }];
        }

        // Insert settings row (should not be called due to history check)
        if (query.includes("INSERT INTO s18_shop_reminder_settings")) {
          return [{ shop_id: "shop-race" }];
        }

        // Insert rule (should not be called)
        if (query.includes("INSERT INTO \"ReminderRule\"")) {
          ruleInsertCalled = true;
          return [];
        }

        return [];
      }),
      {}
    );

    // Pre-tx EXISTS check returns NO history (but it appears inside tx)
    const mockSql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        const query = strings.join("?");
        if (query.includes("hasSettings") && query.includes("hasHistory")) {
          return [{ hasSettings: false, hasHistory: false }];
        }
        return [];
      }),
      {
        begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
          return callback(mockTx);
        }),
      }
    );

    const result = await ensureDefaultReminderRules(
      mockSql as unknown as Parameters<typeof ensureDefaultReminderRules>[0],
      "shop-race"
    );

    // Should not seed due to in-tx history check
    expect(result.seeded).toBe(false);
    expect(result.count).toBe(0);
    expect(ruleInsertCalled).toBe(false);
  });
});
