/**
 * R1: Logging tests for reminders.server.ts
 *
 * Verifies that safeLog output contains no PII:
 * - No shop domains (myshopify.com)
 * - No emails
 * - No amounts
 *
 * Per QA: Uses REAL safeLog, spies on console methods, parses emitted JSON,
 * and asserts no sensitive data leaks while verifying expected safe keys.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const SENSITIVE_DOMAIN = "pii-test-reminder.myshopify.com";
const SENSITIVE_EMAIL = "buyer@pii-reminder-test.com";
const SENSITIVE_AMOUNT = "75000";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("~/lib/aging-dates.server", () => ({
  validateTimezone: vi.fn().mockReturnValue("Asia/Kolkata"),
}));

vi.mock("~/emails/PaymentReminderEmail", () => ({
  renderPaymentReminderEmail: vi.fn().mockReturnValue("<html>test</html>"),
}));

vi.mock("luxon", async () => {
  const actual = await vi.importActual<typeof import("luxon")>("luxon");
  return {
    ...actual,
    DateTime: {
      ...actual.DateTime,
      now: vi.fn().mockReturnValue({
        setZone: vi.fn().mockReturnValue({
          hour: 12,
          startOf: vi.fn().mockReturnValue({
            hasSame: vi.fn().mockReturnValue(true),
          }),
        }),
      }),
      fromJSDate: vi.fn().mockReturnValue({
        startOf: vi.fn().mockReturnValue({
          plus: vi.fn().mockReturnValue({
            hasSame: vi.fn().mockReturnValue(true),
          }),
        }),
        toLocaleString: vi.fn().mockReturnValue("October 30, 2026"),
      }),
    },
  };
});

function createMockSql() {
  const mockResults = new Map<string, unknown>();

  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray) => {
      const query = strings.join("?");

      if (query.includes("FROM \"Invoice\"") && query.includes("INNER JOIN")) {
        return mockResults.get("invoice") ?? [];
      }
      if (query.includes("FROM s8_tagged_customers")) {
        return mockResults.get("customer") ?? [];
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
      if (query.includes("WITH monthly_sum AS") && query.includes("upserted AS")) {
        return mockResults.get("global_increment") ?? [{ dailyCount: 1, monthlyTotal: 1 }];
      }
      if (query.includes("GREATEST(0, daily_count - 1)")) {
        return [];
      }
      return [];
    }),
    {
      json: vi.fn((v) => v),
      unsafe: vi.fn((s: string) => s),
      setMockResult: (key: string, value: unknown) => mockResults.set(key, value),
      clearMockResults: () => mockResults.clear(),
    }
  ) as unknown as import("~/lib/db-light.server").Sql & {
    setMockResult: (key: string, value: unknown) => void;
    clearMockResults: () => void;
  };

  return sql;
}

describe("Reminders Logging: No PII in log output (R1)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  function parseLogCalls(spy: ReturnType<typeof vi.spyOn>): Array<{ event: string; [key: string]: unknown }> {
    const parsed: Array<{ event: string; [key: string]: unknown }> = [];
    for (const call of spy.mock.calls) {
      const arg = call[0];
      if (typeof arg === "string" && arg.startsWith("{")) {
        try {
          parsed.push(JSON.parse(arg));
        } catch {
          // Not JSON, skip
        }
      }
    }
    return parsed;
  }

  function assertNoSensitiveDataInLogs(logs: Array<Record<string, unknown>>) {
    for (const log of logs) {
      const serialized = JSON.stringify(log);
      expect(serialized).not.toContain("myshopify.com");
      expect(serialized).not.toContain(SENSITIVE_EMAIL);
      expect(serialized).not.toContain(SENSITIVE_AMOUNT);
    }
  }

  function assertNoSensitiveDataInRawCalls(spy: ReturnType<typeof vi.spyOn>) {
    for (const call of spy.mock.calls) {
      const raw = String(call[0]);
      expect(raw).not.toContain("myshopify.com");
      expect(raw).not.toContain(SENSITIVE_EMAIL);
      expect(raw).not.toContain(SENSITIVE_AMOUNT);
    }
  }

  it("reminders disabled log contains only shopId", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const mockSql = createMockSql();

    const result = await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      {} // No RESEND_API_KEY - triggers "reminders disabled"
    );

    expect(result.action).toBe("disabled");
    
    const logs = parseLogCalls(consoleLogSpy);
    assertNoSensitiveDataInLogs(logs);
    assertNoSensitiveDataInRawCalls(consoleLogSpy);

    const disabledLogs = logs.filter(l => l.event === "reminders_disabled");
    expect(disabledLogs.length).toBe(1);

    const log = disabledLogs[0];
    expect(Object.keys(log).sort()).toEqual(["event", "shopId"]);
    expect(log.shopId).toBe("shop-123");
  });

  it("auth error log contains only shopId and httpStatus", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const mockSql = createMockSql();

    const mockInvoiceData = {
      invoiceId: "inv-123",
      shopId: "shop-123",
      shopDomain: SENSITIVE_DOMAIN,
      shopTimezone: "Asia/Kolkata",
      invoiceName: "#1001",
      total: SENSITIVE_AMOUNT,
      currency: "INR",
      dueAt: new Date(),
      status: "open",
      buyerAccountId: "buyer-123",
      customerId: "gid://shopify/Customer/456",
      buyerAccountGatedAt: null,
    };

    mockSql.setMockResult("invoice", [mockInvoiceData]);
    mockSql.setMockResult("customer", [{ email: SENSITIVE_EMAIL, displayName: "Test Buyer" }]);
    mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
    mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => `Unauthorized for ${SENSITIVE_DOMAIN}: ${SENSITIVE_EMAIL}`,
    });

    await sendPaymentReminder(
      mockSql,
      "shop-123",
      "inv-123",
      "rule-123",
      0,
      "Asia/Kolkata",
      { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com" }
    );

    const errorLogs = parseLogCalls(consoleErrorSpy);
    assertNoSensitiveDataInLogs(errorLogs);
    assertNoSensitiveDataInRawCalls(consoleErrorSpy);

    const authErrorLogs = errorLogs.filter(l => l.event === "reminders_auth_error");
    expect(authErrorLogs.length).toBe(1);

    const log = authErrorLogs[0];
    expect(Object.keys(log).sort()).toEqual(["event", "httpStatus", "shopId"]);
    expect(log.shopId).toBe("shop-123");
    expect(log.httpStatus).toBe(401);
  });
});
