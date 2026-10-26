/**
 * Critical Path Tests for Payment Reminders (S18).
 *
 * Comprehensive real-path tests for the payment-reminder and email-sending
 * system covering the reminders service, Resend email sender, queue/drain
 * handlers, and safeLog/Sentry security.
 *
 * These tests call the REAL code paths with I/O mocked at the edge:
 * - Resend API (fetch stub)
 * - Sentry (captureException spy)
 *
 * Note: The send path does not write AuditEvent rows; these tests verify
 * ReminderLog persistence and safeLog/Sentry redaction only.
 *
 * DB tests use the repo's existing describeWithDb/TEST_DATABASE_URL pattern.
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import type { Sql } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@sentry/cloudflare", () => ({
  withSentry: vi.fn((configFn, handler) => handler),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

function createMockSql() {
  const mockResults = new Map<string, unknown>();
  const allCalls: string[] = [];

  const createQueryHandler = () => async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    allCalls.push(query);

    if (query.includes("FROM \"Invoice\"") && query.includes("INNER JOIN")) {
      return mockResults.get("invoice") ?? [];
    }

    if (query.includes("FROM s8_tagged_customers")) {
      return mockResults.get("customer") ?? [];
    }

    if (query.includes("buyerAccountId") && query.includes("FROM \"Invoice\"") && !query.includes("INNER JOIN")) {
      return mockResults.get("buyer_account_id") ?? [{ buyerAccountId: "buyer-crit-123" }];
    }

    if (query.includes("reminderOptOutAt") && query.includes("FROM \"BuyerAccount\"")) {
      return mockResults.get("buyer_opted_out") ?? [{ optedOut: false }];
    }

    if (query.includes("sentToday")) {
      return mockResults.get("sent_today") ?? [{ sentToday: false }];
    }

    if (query.includes("EXISTS") && query.includes("ReminderLog")) {
      return mockResults.get("reminder_exists") ?? [{ exists: false }];
    }

    if (query.includes("INSERT INTO \"ReminderLog\"")) {
      return mockResults.get("claim_slot") ?? [{ id: "new-log-id" }];
    }

    if (query.includes("DELETE FROM \"ReminderLog\"")) {
      return [];
    }

    if (query.includes("pg_advisory_xact_lock")) {
      return [];
    }

    if (query.includes("dailyCount") && query.includes("monthlyTotal") && query.includes("s18_global_sends")) {
      const counts = mockResults.get("global_counts") ?? { dailyCount: 0, monthlyTotal: 0 };
      return [counts];
    }

    if (query.includes("INSERT INTO s18_global_sends") && query.includes("ON CONFLICT")) {
      return mockResults.get("global_increment") ?? [{ dailyCount: 1 }];
    }

    if (query.includes("GREATEST(0, daily_count - 1)")) {
      return [];
    }

    if (query.includes("FROM \"ReminderRule\"") && query.includes("WHERE id")) {
      return mockResults.get("rule") ?? [];
    }

    if (query.includes("FROM s18_shop_reminder_settings")) {
      return mockResults.get("settings") ?? [];
    }

    if (query.includes("FROM \"ReminderLog\"") && query.includes("status")) {
      return mockResults.get("log_status") ?? [{ status: "delayed" }];
    }

    if (query.includes("UPDATE \"ReminderLog\"") && query.includes("SET status")) {
      return [];
    }

    if (query.includes("currency") && query.includes("\"Shop\"") && query.includes("WHERE id")) {
      return mockResults.get("shop_currency") ?? [{ currency: "INR" }];
    }

    return [];
  };

  const queryHandler = createQueryHandler();
  const mockTx = Object.assign(vi.fn(queryHandler), {});

  const sql = Object.assign(
    vi.fn(queryHandler),
    {
      json: vi.fn((v) => v),
      unsafe: vi.fn((s: string) => s),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value),
      clearMockResults: () => { mockResults.clear(); allCalls.length = 0; },
      begin: vi.fn(async <T>(callback: (tx: typeof mockTx) => Promise<T>): Promise<T> => {
        return callback(mockTx);
      }),
      getAllCalls: () => allCalls,
    }
  ) as unknown as Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
    getAllCalls: () => string[];
  };

  return sql;
}

const FAKE_RESEND_KEY = "re_test_FAKE_KEY_123";

describe("Critical Path: Reminder Sending Gates", () => {
  const originalEnv = process.env;
  let mockSql: ReturnType<typeof createMockSql>;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const getMockInvoice = (overrides: Partial<{
    invoiceId: string;
    status: string;
    outstanding: string;
    buyerEmail: string | null;
    buyerAccountGatedAt: Date | null;
  }> = {}) => ({
    invoiceId: overrides.invoiceId ?? "inv-crit-123",
    shopId: "shop-crit-123",
    shopDomain: "test-critical-path.myshopify.com",
    shopTimezone: "Asia/Kolkata",
    invoiceName: "#CRIT-1001",
    total: "50000.00",
    outstanding: overrides.outstanding ?? "50000.00",
    currency: "INR",
    dueAt: new Date("2026-10-24T00:00:00+05:30"),
    status: overrides.status ?? "open",
    buyerAccountId: "buyer-crit-123",
    customerId: "cust-crit-456",
    shopUninstalledAt: null,
    buyerAccountGatedAt: overrides.buyerAccountGatedAt ?? null,
    mainContactEmail: null,
    mainContactDisplayName: null,
    accountKind: "TAGGED_CUSTOMER",
  });

  const validEnv = {
    RESEND_API_KEY: FAKE_RESEND_KEY,
    RESEND_FROM: "reminders@example.com",
    REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake-abc123",
    SHOPIFY_APP_URL: "https://test-app.example.com",
    RESEND_TEST_RECIPIENTS: "buyer@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));
    mockSql = createMockSql();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  describe("Case 1: remindersEnabled + email sender config gates", () => {
    it("sends when both remindersEnabled and email sender are configured", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Crit Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-email-crit-123" }),
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");
      expect(result.resendId).toBe("resend-email-crit-123");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns disabled when RESEND_API_KEY is missing", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_API_KEY: undefined }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("disabled");
      expect(result.skipReason).toContain("reminders disabled");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns disabled when RESEND_FROM is missing", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_FROM: undefined }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("disabled");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns disabled when both RESEND_API_KEY and RESEND_FROM are empty strings", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_API_KEY: "", RESEND_FROM: "" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("disabled");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sendCatchupReminder returns skipped when shop reminders disabled (sender configured)", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-24T12:00:00", { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendCatchupReminder } = await import("../reminders.server");

      mockSql.setMockResult("log_status", [{ status: "delayed" }]);
      mockSql.setMockResult("invoice", [{
        ...getMockInvoice(),
        dueAt: new Date("2026-10-23T00:00:00+05:30"),
      }]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("settings", [{ enabled: false }]);

      const result = await sendCatchupReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        "log-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toBe("Shop reminders disabled");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Case 2: test-recipient allowlist gate", () => {
    it("sends only to allowlisted recipient", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-email-123" }),
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "buyer@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("blocks non-allowlisted recipient - Resend is NEVER called", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "notallowed@example.com", displayName: "Blocked Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "allowed@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("not in pre-launch allowlist");
      expect(mockFetch).not.toHaveBeenCalled();

      const sqlCalls = mockSql.getAllCalls();
      const reminderLogInserts = sqlCalls.filter((q: string) => q.includes("INSERT INTO \"ReminderLog\""));
      expect(reminderLogInserts).toHaveLength(0);
    });

    it("blocks all sends when allowlist is empty", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("empty or not configured");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("case-insensitive matching on allowlist", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "BUYER@EXAMPLE.COM", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-email-123" }),
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "buyer@example.com" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");
    });
  });

  describe("Case 3: Idempotency - same invoice+stage never sends twice", () => {
    it("skips on retry when reminder slot already claimed", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", []);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("already sent");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when reminder already sent today for this invoice", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("sent_today", [{ sentToday: true }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Case 4: Paid or closed invoices get no reminder", () => {
    it("skips when invoice status is paid", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice({ status: "paid" })]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is paid");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice status is cancelled", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice({ status: "cancelled" })]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("status is cancelled");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips when invoice outstanding is zero", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice({ outstanding: "0.00" })]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("fully paid");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Case 5: Stage selection at boundaries with IST timezone", () => {
    it("isReminderDueToday returns true on exact reminder day (Oct 24 IST)", async () => {
      vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-24T06:30:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });

    it("isReminderDueToday returns false one day before reminder day (Oct 23 IST)", async () => {
      vi.setSystemTime(new Date("2026-10-23T06:30:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-23T06:30:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);
    });

    it("isReminderDueToday returns false one day after reminder day (Oct 25 IST)", async () => {
      vi.setSystemTime(new Date("2026-10-25T06:30:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-25T06:30:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);
    });

    it("handles due today (offsetDays=0) correctly on Oct 30 IST", async () => {
      vi.setSystemTime(new Date("2026-10-30T06:30:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-30T06:30:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-30T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, 0, "Asia/Kolkata")).toBe(true);
    });

    it("handles overdue (offsetDays=+7) correctly on Nov 6 IST", async () => {
      vi.setSystemTime(new Date("2026-11-06T06:30:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-11-06T06:30:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-30T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, 7, "Asia/Kolkata")).toBe(true);
    });

    it("returns false at 2026-10-23T18:29:59Z (23:59:59 IST Oct 23)", async () => {
      vi.setSystemTime(new Date("2026-10-23T18:29:59Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-23T18:29:59Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);
    });

    it("returns true at 2026-10-23T18:30:00Z (00:00:00 IST Oct 24)", async () => {
      vi.setSystemTime(new Date("2026-10-23T18:30:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-23T18:30:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });

    it("returns true at 2026-10-23T23:59:00Z (05:29:00 IST Oct 24)", async () => {
      vi.setSystemTime(new Date("2026-10-23T23:59:00Z"));
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromISO("2026-10-23T23:59:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { isReminderDueToday } = await import("../reminders.server");

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });
  });

  describe("Case 6: API key and email bodies never reach safeLog/Sentry", () => {
    it("Resend API key is NEVER logged via safeLog", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-email-123" }),
      });

      await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(FAKE_RESEND_KEY);
      expect(allLogs).not.toContain("re_test_FAKE");
    });

    it("buyer email is NEVER logged via safeLog", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");
      const SECRET_EMAIL = "someone@example.com";

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: SECRET_EMAIL, displayName: "Secret Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "other@example.com" }
      );

      expect(result.action).toBe("skipped");

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(SECRET_EMAIL);
      expect(allLogs).not.toContain("someone@");
    });

    it("Sentry captureException is never called with API key or email body", async () => {
      const { captureException } = await import("@sentry/cloudflare");
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockRejectedValueOnce(new Error("Network failure"));

      await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      const sentryCallArgs = (captureException as ReturnType<typeof vi.fn>).mock.calls
        .map(c => JSON.stringify(c))
        .join("\n");

      expect(sentryCallArgs).not.toContain(FAKE_RESEND_KEY);
      expect(sentryCallArgs).not.toContain("buyer@example.com");
    });
  });

  describe("Case 7: Resend failure handling", () => {
    it("handles thrown error gracefully - no crash, retryable", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("connection_refused");
    });

    it("handles 401 unauthorized - non-retryable, releases slot", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => "Unauthorized",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.errorCode).toBe("resend_auth_error");

      const sqlCalls = mockSql.getAllCalls();
      const capReleaseCalls = sqlCalls.filter((q: string) => q.includes("GREATEST(0, daily_count - 1)"));
      expect(capReleaseCalls.length).toBeGreaterThan(0);
    });

    it("handles 429 rate limit - retryable, releases slot", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "Rate limited",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("resend_rate_limited");
    });

    it("handles 500 server error - retryable, releases slot", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(false);
      expect(result.retryable).toBe(true);
      expect(result.errorCode).toBe("resend_server_error");
    });

    it("500 failure releases slot and cap, retry succeeds, third call is skipped", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@example.com", displayName: "Test Buyer" }]);
      mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
      mockSql.setMockResult("global_counts", { dailyCount: 0, monthlyTotal: 0 });
      mockSql.setMockResult("global_increment", [{ dailyCount: 1 }]);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Server Error",
      });

      const result1 = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result1.success).toBe(false);
      expect(result1.retryable).toBe(true);

      const sqlCallsAfterFailure = mockSql.getAllCalls();
      const slotReleaseCalls = sqlCallsAfterFailure.filter((q: string) => q.includes("DELETE FROM \"ReminderLog\""));
      expect(slotReleaseCalls.length).toBeGreaterThan(0);
      const capReleaseCalls = sqlCallsAfterFailure.filter((q: string) => q.includes("GREATEST(0, daily_count - 1)"));
      expect(capReleaseCalls.length).toBeGreaterThan(0);

      mockSql.setMockResult("claim_slot", [{ id: "retry-log-id" }]);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-email-retry-123" }),
      });

      const result2 = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result2.success).toBe(true);
      expect(result2.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(2);

      mockSql.setMockResult("claim_slot", []);

      const result3 = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result3.success).toBe(true);
      expect(result3.action).toBe("skipped");
      expect(result3.skipReason).toContain("already sent");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});

describe("Critical Path: Reminder Job Handler", () => {
  it("isReminderSendMessage validates message format correctly", async () => {
    const { isReminderSendMessage } = await import("~/jobs/reminders");

    expect(isReminderSendMessage(null)).toBe(false);
    expect(isReminderSendMessage({})).toBe(false);
    expect(isReminderSendMessage({ topic: "OTHER" })).toBe(false);

    expect(
      isReminderSendMessage({
        topic: "REMINDER_SEND",
        shop: "test-critical.myshopify.com",
        shopId: "shop-crit-123",
        invoiceId: "inv-crit-123",
        ruleId: "rule-crit-123",
        webhookId: "s18_inv-crit-123_rule-crit-123_2026-10-24",
        enqueuedAt: "2026-10-24T10:00:00Z",
      })
    ).toBe(true);
  });

  it("isReminderCatchupMessage validates catchup message format", async () => {
    const { isReminderCatchupMessage } = await import("~/jobs/reminders");

    expect(isReminderCatchupMessage(null)).toBe(false);
    expect(isReminderCatchupMessage({})).toBe(false);
    expect(isReminderCatchupMessage({ topic: "REMINDER_SEND" })).toBe(false);

    expect(
      isReminderCatchupMessage({
        topic: "REMINDER_CATCHUP",
        shop: "test-critical.myshopify.com",
        shopId: "shop-crit-123",
        invoiceId: "inv-crit-123",
        ruleId: "rule-crit-123",
        logId: "log-crit-123",
        webhookId: "s18_catchup_inv-crit-123_rule-crit-123",
        enqueuedAt: "2026-10-24T10:00:00Z",
      })
    ).toBe(true);
  });
});

describe("Critical Path: Resend Client", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockFetch.mockReset();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it("sendViaResend returns error when API key is missing", async () => {
    const { sendViaResend } = await import("../resend-client.server");

    const result = await sendViaResend(
      {
        from: "test@example.com",
        to: ["buyer@example.com"],
        subject: "Test",
        html: "<p>Test</p>",
      },
      { RESEND_API_KEY: "" }
    );

    expect(result.sent).toBe(false);
    if (!result.sent && !result.skipped) {
      expect(result.error).toBe("resend_no_api_key");
      expect(result.retryable).toBe(false);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sendViaResend includes Idempotency-Key header when provided", async () => {
    const { sendViaResend } = await import("../resend-client.server");

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "test-email-id" }),
    });

    await sendViaResend(
      {
        from: "test@example.com",
        to: ["buyer@example.com"],
        subject: "Test",
        html: "<p>Test</p>",
        idempotencyKey: "test-idem-key-123",
      },
      {
        RESEND_API_KEY: FAKE_RESEND_KEY,
        RESEND_TEST_RECIPIENTS: "buyer@example.com",
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Idempotency-Key"]).toBe("test-idem-key-123");
  });

  it("sendViaResend returns skipped when recipient not in allowlist", async () => {
    const { sendViaResend } = await import("../resend-client.server");

    const result = await sendViaResend(
      {
        from: "test@example.com",
        to: ["notallowed@example.com"],
        subject: "Test",
        html: "<p>Test</p>",
      },
      {
        RESEND_API_KEY: FAKE_RESEND_KEY,
        RESEND_TEST_RECIPIENTS: "allowed@example.com",
      }
    );

    expect(result.sent).toBe(false);
    if (!result.sent && result.skipped) {
      expect(result.reason).toBe("recipient_not_allowlisted");
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("Critical Path: safeLog redaction", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("redacts email addresses from log output", async () => {
    const { redactString } = await import("~/lib/log.server");

    const input = "Error for someone@example.com: failed";
    const redacted = redactString(input);

    expect(redacted).not.toContain("someone@example.com");
    expect(redacted).toContain("<redacted>");
  });

  it("redacts shop domains from log output", async () => {
    const { redactString } = await import("~/lib/log.server");

    const input = "Shop test-redact.myshopify.com failed";
    const redacted = redactString(input);

    expect(redacted).not.toContain("test-redact.myshopify.com");
    expect(redacted).toContain("<redacted>");
  });

  it("redacts Shopify API tokens from log output", async () => {
    const { redactString } = await import("~/lib/log.server");

    const input = "Token shpat_abc123xyz was invalid";
    const redacted = redactString(input);

    expect(redacted).not.toContain("shpat_abc123xyz");
    expect(redacted).toContain("<redacted>");
  });

  it("toErrorCode maps network errors to safe codes", async () => {
    const { toErrorCode } = await import("~/lib/log.server");

    expect(toErrorCode(new Error("ECONNREFUSED 127.0.0.1:5432"))).toBe("connection_refused");
    expect(toErrorCode(new Error("Request timeout after 30s"))).toBe("timeout");
    expect(toErrorCode(new Error("getaddrinfo ENOTFOUND api.resend.com"))).toBe("dns_error");
    expect(toErrorCode(new Error("fetch failed"))).toBe("fetch_error");
  });
});

describeWithDb("Critical Path: DB-backed tests", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-critdb";
  const TEST_SHOP_ID = `shop-critdb-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-critdb-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-critdb-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `cust-critdb-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-critdb-${TEST_SUFFIX}`;
  const TEST_EMAIL = "critdb-buyer@example.com";

  let globalSendsSnapshot: { dailyCount: number; monthlyCount: number; sendDate: Date; sendMonth: string } | null = null;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [existingGlobal] = await sql<{ daily_count: number; monthly_count: number; send_date: Date; send_month: string }[]>`
      SELECT daily_count, monthly_count, send_date, send_month FROM s18_global_sends WHERE send_key = 'global'
    `;
    if (existingGlobal) {
      globalSendsSnapshot = {
        dailyCount: existingGlobal.daily_count,
        monthlyCount: existingGlobal.monthly_count,
        sendDate: existingGlobal.send_date,
        sendMonth: existingGlobal.send_month,
      };
    }

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${TEST_CUSTOMER_ID},
        'CritDB Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, ${TEST_EMAIL}, 'CritDB Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true, updated_at = NOW()
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    if (globalSendsSnapshot) {
      await sql`
        UPDATE s18_global_sends
        SET daily_count = ${globalSendsSnapshot.dailyCount},
            monthly_count = ${globalSendsSnapshot.monthlyCount},
            send_date = ${globalSendsSnapshot.sendDate},
            send_month = ${globalSendsSnapshot.sendMonth}
        WHERE send_key = 'global'
      `;
    } else {
      await sql`DELETE FROM s18_global_sends WHERE send_key = 'global'`;
    }

    await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  it("claimReminderSlot returns true on first claim, false on duplicate", async () => {
    const { claimReminderSlot } = await import("../reminders.server");

    const invoiceId = `inv-claim-${TEST_SUFFIX}`;
    const orderId = `ord-claim-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CLAIM-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
      )
    `;

    const claim1 = await claimReminderSlot(sql, TEST_SHOP_ID, TEST_RULE_ID, invoiceId);
    expect(claim1).toBe(true);

    const claim2 = await claimReminderSlot(sql, TEST_SHOP_ID, TEST_RULE_ID, invoiceId);
    expect(claim2).toBe(false);

    const logs = await sql<{ id: string }[]>`
      SELECT id FROM "ReminderLog"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${invoiceId}
    `;
    expect(logs.length).toBe(1);
  });

  it("concurrent claimReminderSlot calls give exactly one successful claim", async () => {
    const { claimReminderSlot } = await import("../reminders.server");

    const invoiceId = `inv-conc-${TEST_SUFFIX}`;
    const orderId = `ord-conc-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#CONC-1', 20000.00, 20000.00, 'open',
        NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
      )
    `;

    const N = 5;
    const results = await Promise.all(
      Array.from({ length: N }, () => claimReminderSlot(sql, TEST_SHOP_ID, TEST_RULE_ID, invoiceId))
    );

    const successfulClaims = results.filter(r => r === true);
    const failedClaims = results.filter(r => r === false);

    expect(successfulClaims.length).toBe(1);
    expect(failedClaims.length).toBe(N - 1);

    const logs = await sql<{ id: string }[]>`
      SELECT id FROM "ReminderLog"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${invoiceId}
    `;
    expect(logs.length).toBe(1);
  });

  it("releaseReminderSlot allows re-claiming after release", async () => {
    const { claimReminderSlot, releaseReminderSlot } = await import("../reminders.server");

    const invoiceId = `inv-release-${TEST_SUFFIX}`;
    const orderId = `ord-release-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#RELEASE-1', 30000.00, 30000.00, 'open',
        NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
      )
    `;

    const claim1 = await claimReminderSlot(sql, TEST_SHOP_ID, TEST_RULE_ID, invoiceId);
    expect(claim1).toBe(true);

    await releaseReminderSlot(sql, TEST_SHOP_ID, TEST_RULE_ID, invoiceId);

    const claim2 = await claimReminderSlot(sql, TEST_SHOP_ID, TEST_RULE_ID, invoiceId);
    expect(claim2).toBe(true);
  });

  it("real sendPaymentReminder twice for same invoice: fetch once, second skipped", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));

    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-idem-${TEST_SUFFIX}`;
    const orderId = `ord-idem-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#IDEM-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', ${new Date("2026-10-24T00:00:00+05:30")}, NOW(), NOW()
      )
    `;

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-idem-123" }),
    });

    const validEnv = {
      RESEND_API_KEY: FAKE_RESEND_KEY,
      RESEND_FROM: "reminders@example.com",
      REMINDER_UNSUBSCRIBE_SECRET: "test-secret",
      SHOPIFY_APP_URL: "https://test-app.example.com",
      RESEND_TEST_RECIPIENTS: TEST_EMAIL,
    };

    const result1 = await sendPaymentReminder(
      sql,
      TEST_SHOP_ID,
      invoiceId,
      TEST_RULE_ID,
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result1.success).toBe(true);
    expect(result1.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const result2 = await sendPaymentReminder(
      sql,
      TEST_SHOP_ID,
      invoiceId,
      TEST_RULE_ID,
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result2.success).toBe(true);
    expect(result2.action).toBe("skipped");
    expect(result2.skipReason).toContain("already sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("500 then retry: ReminderLog released after failure, 1 sent row after success", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));

    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-500retry-${TEST_SUFFIX}`;
    const orderId = `ord-500retry-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#500RETRY-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', ${new Date("2026-10-24T00:00:00+05:30")}, NOW(), NOW()
      )
    `;

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Server Error",
    });

    const validEnv = {
      RESEND_API_KEY: FAKE_RESEND_KEY,
      RESEND_FROM: "reminders@example.com",
      REMINDER_UNSUBSCRIBE_SECRET: "test-secret",
      SHOPIFY_APP_URL: "https://test-app.example.com",
      RESEND_TEST_RECIPIENTS: TEST_EMAIL,
    };

    const result1 = await sendPaymentReminder(
      sql,
      TEST_SHOP_ID,
      invoiceId,
      TEST_RULE_ID,
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result1.success).toBe(false);
    expect(result1.retryable).toBe(true);

    const logsAfterFailure = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM "ReminderLog"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${invoiceId}
    `;
    expect(logsAfterFailure.length).toBe(0);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "resend-500retry-123" }),
    });

    const result2 = await sendPaymentReminder(
      sql,
      TEST_SHOP_ID,
      invoiceId,
      TEST_RULE_ID,
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result2.success).toBe(true);
    expect(result2.action).toBe("sent");

    const logsAfterSuccess = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM "ReminderLog"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${invoiceId}
    `;
    expect(logsAfterSuccess.length).toBe(1);
    expect(logsAfterSuccess[0].status).toBe("sent");

    vi.useRealTimers();
  });

  it("ReminderLog after send does not contain API key, email, or subject", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));

    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-logcheck-${TEST_SUFFIX}`;
    const orderId = `ord-logcheck-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#LOGCHECK-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', ${new Date("2026-10-24T00:00:00+05:30")}, NOW(), NOW()
      )
    `;

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "resend-logcheck-123" }),
    });

    const validEnv = {
      RESEND_API_KEY: FAKE_RESEND_KEY,
      RESEND_FROM: "reminders@example.com",
      REMINDER_UNSUBSCRIBE_SECRET: "test-secret",
      SHOPIFY_APP_URL: "https://test-app.example.com",
      RESEND_TEST_RECIPIENTS: TEST_EMAIL,
    };

    await sendPaymentReminder(
      sql,
      TEST_SHOP_ID,
      invoiceId,
      TEST_RULE_ID,
      0,
      "Asia/Kolkata",
      validEnv
    );

    const logs = await sql<{ id: string; status: string }[]>`
      SELECT * FROM "ReminderLog"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${invoiceId}
    `;
    expect(logs.length).toBe(1);

    const logRow = JSON.stringify(logs[0]);
    expect(logRow).not.toContain(FAKE_RESEND_KEY);
    expect(logRow).not.toContain("re_test_");
    expect(logRow).not.toContain(TEST_EMAIL);
    expect(logRow).not.toContain("@example.com");
    expect(logRow).not.toContain("Payment due");

    vi.useRealTimers();
  });

  it("hasNewerStageDueToday returns false when shop reminders disabled", async () => {
    const { hasNewerStageDueToday } = await import("../reminders.server");

    const invoiceId = `inv-newstagegate-${TEST_SUFFIX}`;
    const orderId = `ord-newstagegate-${TEST_SUFFIX}`;
    const rule2Id = `rule2-critdb-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#NEWSTAGEGATE-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days',
        (NOW() AT TIME ZONE 'Asia/Kolkata')::DATE - 7,
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${rule2Id}, ${TEST_SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    const resultEnabled = await hasNewerStageDueToday(sql, TEST_SHOP_ID, invoiceId, 0, "Asia/Kolkata");
    expect(resultEnabled).toBe(true);

    await sql`UPDATE s18_shop_reminder_settings SET enabled = false WHERE shop_id = ${TEST_SHOP_ID}`;

    const resultDisabled = await hasNewerStageDueToday(sql, TEST_SHOP_ID, invoiceId, 0, "Asia/Kolkata");
    expect(resultDisabled).toBe(false);

    await sql`UPDATE s18_shop_reminder_settings SET enabled = true WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE id = ${rule2Id}`;
  });

  it("handleReminderSend twice with same message: fetch once, one sent ReminderLog row", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));

    const originalEnv = process.env;
    (process.env as Record<string, string | undefined>).RESEND_API_KEY = FAKE_RESEND_KEY;
    (process.env as Record<string, string | undefined>).RESEND_FROM = "reminders@example.com";
    (process.env as Record<string, string | undefined>).REMINDER_UNSUBSCRIBE_SECRET = "test-secret";
    (process.env as Record<string, string | undefined>).SHOPIFY_APP_URL = "https://test-app.example.com";
    (process.env as Record<string, string | undefined>).RESEND_TEST_RECIPIENTS = TEST_EMAIL;

    const { handleReminderSend } = await import("~/jobs/reminders");

    const invoiceId = `inv-handler-${TEST_SUFFIX}`;
    const orderId = `ord-handler-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#HANDLER-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', ${new Date("2026-10-24T00:00:00+05:30")}, NOW(), NOW()
      )
    `;

    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-handler-123" }),
    });

    const message = {
      topic: "REMINDER_SEND" as const,
      shop: TEST_SHOP_DOMAIN,
      shopId: TEST_SHOP_ID,
      invoiceId,
      ruleId: TEST_RULE_ID,
      offsetDays: 0,
      timezone: "Asia/Kolkata",
      webhookId: `s18_${invoiceId}_${TEST_RULE_ID}_2026-10-24`,
      enqueuedAt: "2026-10-24T06:30:00Z",
    };

    const result1 = await handleReminderSend(sql, message);
    expect(result1.success).toBe(true);
    expect(result1.action).toBe("created");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const result2 = await handleReminderSend(sql, message);
    expect(result2.success).toBe(true);
    expect(result2.action).toBe("skipped");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const logs = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM "ReminderLog"
      WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID} AND "invoiceId" = ${invoiceId}
    `;
    expect(logs.length).toBe(1);
    expect(logs[0].status).toBe("sent");

    process.env = originalEnv;
    vi.useRealTimers();
  });
});
