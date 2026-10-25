import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";

/**
 * Tests for reminder email sending with recipient allowlist.
 *
 * These tests verify that:
 * 1. Allowlisted addresses are sent (Resend fetch mocked and called once)
 * 2. Non-allowlisted addresses are skipped (no fetch, not marked sent, slot and cap not consumed, acked)
 * 3. Missing or empty list skips all
 * 4. Mixed-case address and whitespace in the list still match
 * 5. Mixed recipient lists send only the allowed ones
 * 6. No addresses are logged (uses REAL safeLog)
 */

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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
      return mockResults.get("buyer_account_id") ?? [{ buyerAccountId: "buyer-123" }];
    }

    if (query.includes("reminderOptOutAt") && query.includes("FROM \"BuyerAccount\"")) {
      return mockResults.get("buyer_opted_out") ?? [{ optedOut: false }];
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

describe("sendPaymentReminder - allowlist", () => {
  const originalEnv = process.env;
  let mockSql: ReturnType<typeof createMockSql>;
  let consoleLogOutput: string[] = [];
  let consoleInfoOutput: string[] = [];

  const validEnv = {
    RESEND_API_KEY: "re_test_1234",
    RESEND_FROM: "noreply@test-example.com",
    REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
    SHOPIFY_APP_URL: "https://app.example.com",
    RESEND_TEST_RECIPIENTS: "",
  };

  const getMockInvoice = () => ({
    invoiceId: "inv-123",
    shopId: "shop-123",
    shopDomain: "test-shop.myshopify.com",
    shopTimezone: "Asia/Kolkata",
    invoiceName: "#1001",
    total: "1000.00",
    outstanding: "1000.00",
    currency: "INR",
    dueAt: new Date("2026-10-24T00:00:00+05:30"),
    status: "open",
    buyerAccountId: "buyer-123",
    customerId: "gid://shopify/Customer/456",
    shopUninstalledAt: null,
    buyerAccountGatedAt: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));
    mockSql = createMockSql();
    mockFetch.mockReset();
    process.env = { ...originalEnv };
    consoleLogOutput = [];
    consoleInfoOutput = [];

    vi.spyOn(console, "log").mockImplementation((...args) => {
      consoleLogOutput.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "info").mockImplementation((...args) => {
      consoleInfoOutput.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("sends to allowlisted address (fetch called once)", async () => {
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
      json: async () => ({ id: "email-123" }),
    });

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("skips non-allowlisted address (no fetch, not marked sent, acked)", async () => {
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const { sendPaymentReminder } = await import("../reminders.server");

    mockSql.setMockResult("invoice", [getMockInvoice()]);
    mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "other@test-example.com" }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toContain("not in pre-launch allowlist");
    expect(mockFetch).not.toHaveBeenCalled();

    const sqlCalls = mockSql.getAllCalls();
    const reminderLogInserts = sqlCalls.filter((q: string) => q.includes("INSERT INTO \"ReminderLog\""));
    expect(reminderLogInserts).toHaveLength(0);
  });

  it("skips all when allowlist is empty (acked)", async () => {
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const { sendPaymentReminder } = await import("../reminders.server");

    mockSql.setMockResult("invoice", [getMockInvoice()]);
    mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "" }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toContain("empty or not configured");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips all when allowlist is undefined (acked)", async () => {
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const { sendPaymentReminder } = await import("../reminders.server");

    mockSql.setMockResult("invoice", [getMockInvoice()]);
    mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

    const envWithoutAllowlist = { ...validEnv };
    delete (envWithoutAllowlist as Record<string, unknown>).RESEND_TEST_RECIPIENTS;

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      envWithoutAllowlist
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("matches mixed-case address against allowlist", async () => {
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
      json: async () => ({ id: "email-123" }),
    });

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "buyer@test-example.com" }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("handles whitespace in allowlist", async () => {
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
      json: async () => ({ id: "email-123" }),
    });

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "  buyer@test-example.com  ,  other@test.com  " }
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not consume slot or cap when skipped", async () => {
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const { sendPaymentReminder } = await import("../reminders.server");

    mockSql.setMockResult("invoice", [getMockInvoice()]);
    mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

    await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "other@test-example.com" }
    );

    const sqlCalls = mockSql.getAllCalls();

    const slotClaims = sqlCalls.filter((q: string) => q.includes("INSERT INTO \"ReminderLog\""));
    expect(slotClaims).toHaveLength(0);

    const capIncrements = sqlCalls.filter((q: string) => q.includes("INSERT INTO s18_global_sends"));
    expect(capIncrements).toHaveLength(0);
  });

  it("does not log any email addresses when skipped", async () => {
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const { sendPaymentReminder } = await import("../reminders.server");

    mockSql.setMockResult("invoice", [getMockInvoice()]);
    mockSql.setMockResult("customer", [{ email: "secretbuyer@private-domain.com", displayName: "Test Buyer" }]);

    await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "allowed@test-example.com" }
    );

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput].join("\n");

    expect(allLogs).not.toContain("secretbuyer@private-domain.com");
    expect(allLogs).not.toContain("private-domain.com");
    expect(allLogs).not.toContain("allowed@test-example.com");

    expect(allLogs).toContain("reminder_send_skipped");
    expect(allLogs).toContain("recipient_not_allowlisted");
  });

  it("logs reason enum when skipped due to empty allowlist", async () => {
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const { sendPaymentReminder } = await import("../reminders.server");

    mockSql.setMockResult("invoice", [getMockInvoice()]);
    mockSql.setMockResult("customer", [{ email: "buyer@test-example.com", displayName: "Test Buyer" }]);

    await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { ...validEnv, RESEND_TEST_RECIPIENTS: "" }
    );

    const allLogs = [...consoleLogOutput, ...consoleInfoOutput].join("\n");

    expect(allLogs).toContain("reminder_send_skipped");
    expect(allLogs).toContain("recipient_allowlist_empty");
  });
});
