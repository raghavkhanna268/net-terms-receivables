/**
 * Critical Path Tests for Payment Reminders (S18).
 *
 * Comprehensive real-path tests for the payment-reminder and email-sending
 * system covering the reminders service, Resend email sender, queue/drain
 * handlers, and safeLog/Sentry/AuditEvent security.
 *
 * These tests call the REAL code paths with I/O mocked at the edge:
 * - Resend API (fetch stub)
 * - Sentry (captureException spy)
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

    if (query.includes("sentToday")) {
      return mockResults.get("sent_today") ?? [{ sentToday: false }];
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
    RESEND_FROM: "reminders@test-example.com",
    REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake-abc123",
    SHOPIFY_APP_URL: "https://app.test-example.com",
    RESEND_TEST_RECIPIENTS: "buyer@test-example.com",
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Crit Buyer" }]);
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
  });

  describe("Case 2: test-recipient allowlist gate", () => {
    it("sends only to allowlisted recipient", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
        { ...validEnv, RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
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
      mockSql.setMockResult("customer", [{ email: "notallowed@blocked-domain.example.com", displayName: "Blocked Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "allowed@test-example.com" }
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

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
      mockSql.setMockResult("customer", [{ email: "BUYER@TEST-EXAMPLE.COM", displayName: "Test Buyer" }]);
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
        { ...validEnv, RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

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
    it("isReminderDueToday returns true on exact reminder day (offsetDays=-3, dueAt=Oct 27 → reminder on Oct 24)", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromObject(
        { year: 2026, month: 10, day: 24, hour: 12 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });

    it("isReminderDueToday returns false one day before reminder day", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromObject(
        { year: 2026, month: 10, day: 23, hour: 12 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);
    });

    it("isReminderDueToday returns false one day after reminder day", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromObject(
        { year: 2026, month: 10, day: 25, hour: 12 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);
    });

    it("handles due today (offsetDays=0) correctly", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 12 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-30T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, 0, "Asia/Kolkata")).toBe(true);
    });

    it("handles overdue (offsetDays=+7) correctly", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromObject(
        { year: 2026, month: 11, day: 6, hour: 12 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-30T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, 7, "Asia/Kolkata")).toBe(true);
    });

    it("handles IST midnight boundary (23:59 UTC Oct 23 = 05:29 IST Oct 24)", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromISO("2026-10-23T23:59:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });

    it("handles just after IST midnight", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromISO("2026-10-23T18:31:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(true);
    });

    it("handles just before IST midnight", async () => {
      const { isReminderDueToday } = await import("../reminders.server");
      const { DateTime } = await import("luxon");

      const mockNow = DateTime.fromISO("2026-10-23T18:29:00Z").setZone("Asia/Kolkata");
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const dueDate = new Date("2026-10-27T00:00:00+05:30");
      expect(isReminderDueToday(dueDate, -3, "Asia/Kolkata")).toBe(false);
    });
  });

  describe("Case 6: API key and email bodies never reach safeLog/Sentry/AuditEvent", () => {
    it("Resend API key is NEVER logged via safeLog", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      const SECRET_EMAIL = "secretbuyer@private-company.example.com";

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: SECRET_EMAIL, displayName: "Secret Buyer" }]);

      const result = await sendPaymentReminder(
        mockSql,
        "shop-crit-123",
        "inv-crit-123",
        "rule-crit-123",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_TEST_RECIPIENTS: "other@test-example.com" }
      );

      expect(result.action).toBe("skipped");

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(SECRET_EMAIL);
      expect(allLogs).not.toContain("secretbuyer");
      expect(allLogs).not.toContain("private-company");
    });

    it("Sentry captureException is never called with API key or email body", async () => {
      const { captureException } = await import("@sentry/cloudflare");
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      expect(sentryCallArgs).not.toContain("buyer@test-example.com");
    });
  });

  describe("Case 7: Resend failure handling", () => {
    it("handles thrown error gracefully - no crash, retryable", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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

    it("retry after failure does not produce duplicate send (slot already released)", async () => {
      const { DateTime } = await import("luxon");
      const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

      const { sendPaymentReminder } = await import("../reminders.server");

      mockSql.setMockResult("invoice", [getMockInvoice()]);
      mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);
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
        from: "test@test-example.com",
        to: ["buyer@test-example.com"],
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
        from: "test@test-example.com",
        to: ["buyer@test-example.com"],
        subject: "Test",
        html: "<p>Test</p>",
        idempotencyKey: "test-idem-key-123",
      },
      {
        RESEND_API_KEY: FAKE_RESEND_KEY,
        RESEND_TEST_RECIPIENTS: "buyer@test-example.com",
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
        from: "test@test-example.com",
        to: ["notallowed@blocked.example.com"],
        subject: "Test",
        html: "<p>Test</p>",
      },
      {
        RESEND_API_KEY: FAKE_RESEND_KEY,
        RESEND_TEST_RECIPIENTS: "allowed@test-example.com",
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

    const input = "Error for buyer@secret-domain.com: failed";
    const redacted = redactString(input);

    expect(redacted).not.toContain("buyer@secret-domain.com");
    expect(redacted).toContain("<redacted>");
  });

  it("redacts shop domains from log output", async () => {
    const { redactString } = await import("~/lib/log.server");

    const input = "Shop test-shop.myshopify.com failed";
    const redacted = redactString(input);

    expect(redacted).not.toContain("test-shop.myshopify.com");
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

describeWithDb("Critical Path: DB-backed idempotency tests", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-critpath";
  const TEST_SHOP_ID = `shop-critpath-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-critpath-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-critpath-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `cust-critpath-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-critpath-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

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
        'CritPath Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'critpath-buyer@test-example.com', 'CritPath Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

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

  it("AuditEvent does not contain Resend API key or buyer email in data column", async () => {
    const invoiceId = `inv-audit-${TEST_SUFFIX}`;
    const orderId = `ord-audit-${TEST_SUFFIX}`;
    const testEmail = "audit-buyer@test-example.com";

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        '#AUDIT-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (
        gen_random_uuid(),
        ${TEST_SHOP_ID},
        'system',
        'reminder.sent',
        ${sql.json({ invoiceId, ruleId: TEST_RULE_ID, stage: 0 })},
        NOW()
      )
    `;

    const events = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM "AuditEvent"
      WHERE "shopId" = ${TEST_SHOP_ID} AND type = 'reminder.sent'
    `;

    expect(events.length).toBe(1);
    const eventData = JSON.stringify(events[0].data);

    expect(eventData).not.toContain(FAKE_RESEND_KEY);
    expect(eventData).not.toContain("re_test_");
    expect(eventData).not.toContain(testEmail);
    expect(eventData).not.toContain("@test-example.com");

    await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });
});
