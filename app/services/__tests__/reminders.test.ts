import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for S18 Payment Reminders.
 *
 * Tests verify (per docs/qa/S18-payment-reminders.md):
 * - S18-01: No outbound HTTP with RESEND_API_KEY unset
 * - S18-02: RESEND_API_KEY="" or whitespace treated as unset
 * - S18-05: Log line "reminders disabled" when key unset
 * - S18-10: One email per (invoice, offset) slot
 * - S18-11: No second email on retry/replay (idempotency)
 * - S18-12: No reminder for paid/cancelled invoices
 * - Daily cap enforcement (100/day)
 * - Idempotency via ReminderLog unique index
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

      // Daily sends count
      if (query.includes("FROM s18_daily_sends") && query.includes("SELECT count")) {
        return mockResults.get("daily_count") ?? [];
      }

      // Daily sends increment
      if (query.includes("INSERT INTO s18_daily_sends")) {
        return mockResults.get("daily_increment") ?? [{ count: 1 }];
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

  describe("sendPaymentReminder", () => {
    const mockInvoiceData = {
      invoiceId: "inv-123",
      shopId: "shop-123",
      shopDomain: "test-shop.myshopify.com",
      invoiceName: "#1001",
      total: "100000",
      currency: "INR",
      dueAt: new Date("2026-10-30"),
      status: "open",
      buyerAccountId: "buyer-123",
      customerId: "gid://shopify/Customer/456",
    };

    it("logs 'reminders disabled' and returns disabled when no API key (S18-01, S18-05)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        {} // No RESEND_API_KEY
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("disabled");
      expect(result.skipReason).toContain("reminders disabled");
      expect(consoleInfoSpy).toHaveBeenCalledWith("reminders disabled");
      expect(mockFetch).not.toHaveBeenCalled(); // S18-01: No HTTP calls
    });

    it("returns capped when daily send cap is reached", async () => {
      const { sendPaymentReminder, DAILY_SEND_CAP } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: DAILY_SEND_CAP }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("capped");
      expect(result.skipReason).toContain("cap reached");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice not found", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", []); // No invoice

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("Invoice not found");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice is paid (S18-12)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [{ ...mockInvoiceData, status: "paid" }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is paid");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice is cancelled (S18-12)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [{ ...mockInvoiceData, status: "cancelled" }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is cancelled");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when buyer has no email", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: null, displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("Buyer has no email");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips on retry when reminder already sent - idempotency (S18-11)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", []); // Empty = slot not claimed (already exists)

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("already sent");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends email successfully and increments daily count (S18-10)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 5 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("daily_increment", [{ count: 6 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-msg-123" }),
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");
      expect(result.resendId).toBe("resend-msg-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify Resend API call
      const fetchCall = mockFetch.mock.calls[0];
      expect(fetchCall[0]).toBe("https://api.resend.com/emails");
      expect(fetchCall[1].method).toBe("POST");
      expect(fetchCall[1].headers.Authorization).toBe("Bearer re_test_1234");

      const body = JSON.parse(fetchCall[1].body);
      expect(body.to).toEqual(["buyer@example.test"]);
      expect(body.subject).toContain("Payment due in 3 days");
      expect(body.headers["X-Idempotency-Key"]).toBe("s18_inv-123_rule-123");
    });

    it("handles Resend 429 rate limit as retryable", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);

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
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.error).toContain("429");
    });

    it("handles Resend 401 auth error as non-retryable (S18-15)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);

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
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false); // 401 is not retryable
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Resend auth error")
      );
    });

    it("handles 5xx server errors as retryable (S18-14)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);

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
        -3,
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
      expect(getReminderLabel(-1)).toBe("Payment due in 1 days");
    });

    it("formats due today correctly", async () => {
      const { getReminderLabel } = await import("../reminders.server");

      expect(getReminderLabel(0)).toBe("Payment due today");
    });

    it("formats days overdue correctly", async () => {
      const { getReminderLabel } = await import("../reminders.server");

      expect(getReminderLabel(7)).toBe("Payment 7 days overdue");
      expect(getReminderLabel(1)).toBe("Payment 1 days overdue");
    });
  });

  describe("DAILY_SEND_CAP constant", () => {
    it("is set to 100 per Resend free tier", async () => {
      const { DAILY_SEND_CAP } = await import("../reminders.server");
      expect(DAILY_SEND_CAP).toBe(100);
    });
  });

  describe("PCD compliance (PCD-1, PCD-2)", () => {
    it("only uses email and displayName from customer record", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const mockInvoiceData = {
        invoiceId: "inv-123",
        shopId: "shop-123",
        shopDomain: "test-shop.myshopify.com",
        invoiceName: "#1001",
        total: "100000",
        currency: "INR",
        dueAt: new Date("2026-10-30"),
        status: "open",
        buyerAccountId: "buyer-123",
        customerId: "gid://shopify/Customer/456",
      };

      mockSql.setMockResult("daily_count", [{ count: 0 }]);
      mockSql.setMockResult("invoice", [mockInvoiceData]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-msg-123" }),
      });

      await sendPaymentReminder(
        mockSql,
        "shop-123",
        "inv-123",
        "rule-123",
        -3,
        { RESEND_API_KEY: "re_test_1234" }
      );

      // Verify the email body doesn't contain phone or address
      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      const html = body.html;

      expect(html).toContain("Test Buyer");
      expect(html).toContain("#1001");
      expect(html).not.toContain("phone");
      expect(html).not.toContain("address");
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
        webhookId: "s18_enqueue_inv-123_rule-123_2026-10-30",
        enqueuedAt: "2026-10-30T10:00:00Z",
      })
    ).toBe(true);
  });
});
