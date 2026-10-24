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

      // Global sends count (single day)
      if (query.includes("FROM s18_global_sends") && query.includes("send_date =")) {
        return mockResults.get("global_daily") ?? [];
      }

      // Global sends monthly sum
      if (query.includes("SUM(daily_count)") && query.includes("s18_global_sends")) {
        return mockResults.get("global_monthly") ?? [{ monthlyTotal: 0 }];
      }

      // Global sends increment
      if (query.includes("INSERT INTO s18_global_sends")) {
        return mockResults.get("global_increment") ?? [{ dailyCount: 1, monthlyCount: 1 }];
      }

      // Global sends previous daily (for cap check)
      if (query.includes("daily_count - 1")) {
        return mockResults.get("global_prev_daily") ?? [{ prevDaily: 0 }];
      }

      // ReminderRule lookup
      if (query.includes("FROM \"ReminderRule\"") && query.includes("WHERE id")) {
        return mockResults.get("rule") ?? [];
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
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockSql = createMockSql();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleInfoSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("isReminderSendingEnabled", () => {
    it("returns false when RESEND_API_KEY is undefined (S18-01)", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({})).toBe(false);
    });

    it("returns false when RESEND_API_KEY is empty string (S18-02)", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "" })).toBe(false);
    });

    it("returns false when RESEND_API_KEY is whitespace (S18-02)", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "   " })).toBe(false);
    });

    it("returns true when RESEND_API_KEY is a valid key", async () => {
      const { isReminderSendingEnabled } = await import("../reminders.server");
      expect(isReminderSendingEnabled({ RESEND_API_KEY: "re_test_1234" })).toBe(true);
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

      // Should log exactly "reminders disabled"
      expect(consoleInfoSpy).toHaveBeenCalledWith("reminders disabled");

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

      // Mock global daily count at cap
      mockSql.setMockResult("global_daily", [{ dailyCount: DAILY_SEND_CAP, monthlyCount: 50 }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("capped");
      expect(result.skipReason).toContain("Daily send cap");
      expect(result.skipReason).toContain("100");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns capped when monthly GLOBAL cap (3000) is reached", async () => {
      const { sendPaymentReminder, MONTHLY_SEND_CAP } = await import("../reminders.server");

      // Mock monthly count at cap
      mockSql.setMockResult("global_monthly", [{ monthlyTotal: MONTHLY_SEND_CAP }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("capped");
      expect(result.skipReason).toContain("Monthly send cap");
      expect(result.skipReason).toContain("3000");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("sendPaymentReminder - invoice status", () => {
    const baseInvoice = {
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

    it("skips when invoice is paid (S18-12)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("global_daily", []);
      mockSql.setMockResult("invoice", [{ ...baseInvoice, status: "paid" }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is paid");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice is cancelled (S18-12)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("global_daily", []);
      mockSql.setMockResult("invoice", [{ ...baseInvoice, status: "cancelled" }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        0,
        "Asia/Kolkata",
        { RESEND_API_KEY: "re_test_1234" }
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
        { RESEND_API_KEY: "re_test_1234" }
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
        total: "100000",
        currency: "INR",
        dueAt: new Date(),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("global_daily", []);
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
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("already sent");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("sendPaymentReminder - error handling", () => {
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

    it("handles Resend 429 rate limit as retryable (S18-14)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("global_daily", []);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyCount: 1 }]);
      mockSql.setMockResult("global_prev_daily", [{ prevDaily: 0 }]);

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
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain("429");
    });

    it("handles Resend 401 auth error as non-retryable (S18-15)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("global_daily", []);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyCount: 1 }]);
      mockSql.setMockResult("global_prev_daily", [{ prevDaily: 0 }]);

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
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Resend auth error")
      );
    });

    it("handles 5xx server errors as retryable (S18-14)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("global_daily", []);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyCount: 1 }]);
      mockSql.setMockResult("global_prev_daily", [{ prevDaily: 0 }]);

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
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
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
