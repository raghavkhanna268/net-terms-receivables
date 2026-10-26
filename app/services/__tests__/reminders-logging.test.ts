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

const SENSITIVE_DOMAIN = "test-pii-reminder.myshopify.com";
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

  const createQueryHandler = () => async (strings: TemplateStringsArray) => {
    const query = strings.join("?");

    if (query.includes("FROM \"Invoice\"") && query.includes("INNER JOIN")) {
      return mockResults.get("invoice") ?? [];
    }
    // getBuyerAccountId lookup (standalone query)
    if (query.includes("buyerAccountId") && query.includes("FROM \"Invoice\"") && !query.includes("INNER JOIN")) {
      return mockResults.get("buyer_account_id") ?? [{ buyerAccountId: "buyer-123" }];
    }
    // isBuyerOptedOut check
    if (query.includes("reminderOptOutAt") && query.includes("FROM \"BuyerAccount\"")) {
      return mockResults.get("buyer_opted_out") ?? [{ optedOut: false }];
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
    // Advisory lock for global send cap (transaction-based approach)
    if (query.includes("pg_advisory_xact_lock")) {
      return [];
    }
    // Global sends count query (inside transaction)
    if (query.includes("dailyCount") && query.includes("monthlyTotal") && query.includes("s18_global_sends")) {
      const counts = mockResults.get("global_counts") ?? { dailyCount: 0, monthlyTotal: 0 };
      return [counts];
    }
    // Global sends INSERT...ON CONFLICT (reservation increment)
    if (query.includes("INSERT INTO s18_global_sends") && query.includes("ON CONFLICT")) {
      const result = mockResults.get("global_increment") ?? [{ dailyCount: 1 }];
      return result;
    }
    if (query.includes("GREATEST(0, daily_count - 1)")) {
      return [];
    }
    // #292: Shop currency check (INR-only in v1)
    if (query.includes("currency") && query.includes("Shop") && query.includes("SELECT")) {
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
      clearMockResults: () => mockResults.clear(),
      begin: vi.fn(async <T>(callback: (tx: typeof mockTx) => Promise<T>): Promise<T> => {
        return callback(mockTx);
      }),
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
      outstanding: SENSITIVE_AMOUNT,
      currency: "INR",
      dueAt: new Date(),
      status: "open",
      buyerAccountId: "buyer-123",
      customerId: "gid://shopify/Customer/456",
      buyerAccountGatedAt: null,
      shopUninstalledAt: null,
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
      { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "buyer@pii-reminder-test.com,buyer@example.test" }
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

  /**
   * R1: Send failure returns errorCode, no raw provider message.
   * Forces a network error with sentinel string, asserts:
   * - Result has exact keys: success, action, errorCode, retryable
   * - No 'error' field with raw message
   * - No sentinel appears in result or logs
   */
  it("R1: send failure returns errorCode, no raw message in result", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const mockSql = createMockSql();

    const SENTINEL_PROVIDER = "SENTINEL_RESEND_RAW_r1x9";
    const SENTINEL_EMAIL_R1 = "sentinel-r1@provider-leak.test";

    const mockInvoiceData = {
      invoiceId: "inv-r1",
      shopId: "shop-r1",
      shopDomain: "test-r1.myshopify.com",
      shopTimezone: "Asia/Kolkata",
      invoiceName: "#R1-001",
      total: "50000",
      outstanding: "50000",
      currency: "INR",
      dueAt: new Date(),
      status: "open",
      buyerAccountId: "buyer-r1",
      customerId: "gid://shopify/Customer/r1",
      buyerAccountGatedAt: null,
      shopUninstalledAt: null,
    };

    mockSql.setMockResult("invoice", [mockInvoiceData]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
    mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
    mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

    // Force network error with sentinel string
    mockFetch.mockRejectedValueOnce(
      new Error(`Network error connecting to ${SENTINEL_PROVIDER} for ${SENTINEL_EMAIL_R1}`)
    );

    const result = await sendPaymentReminder(
      mockSql,
      "shop-r1",
      "inv-r1",
      "rule-r1",
      0,
      { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "buyer@pii-reminder-test.com,buyer@example.test" }
    );

    // Result should have errorCode, not error with raw message
    expect(result.success).toBe(false);
    expect(result.action).toBe("skipped");
    expect(result.retryable).toBe(true);
    expect(result.errorCode).toBeDefined();
    expect(typeof result.errorCode).toBe("string");

    // Exact keys check - no 'error' field
    const resultKeys = Object.keys(result).sort();
    expect(resultKeys).toEqual(["action", "errorCode", "retryable", "success"]);

    // Sentinel must NOT appear in the result
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain(SENTINEL_PROVIDER);
    expect(resultStr).not.toContain(SENTINEL_EMAIL_R1);
    expect(resultStr).not.toContain("provider-leak");

    // Sentinel must NOT appear in any console output
    for (const spy of [consoleLogSpy, consoleErrorSpy]) {
      for (const call of spy.mock.calls) {
        const raw = String(call[0]);
        expect(raw).not.toContain(SENTINEL_PROVIDER);
        expect(raw).not.toContain(SENTINEL_EMAIL_R1);
        expect(raw).not.toContain("provider-leak");
      }
    }
  });

  /**
   * R1: HTTP error returns errorCode, not interpolated status message.
   */
  it("R1: HTTP error returns errorCode, not raw status in result", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const mockSql = createMockSql();

    const mockInvoiceData = {
      invoiceId: "inv-r1-http",
      shopId: "shop-r1-http",
      shopDomain: "test-r1-http.myshopify.com",
      shopTimezone: "Asia/Kolkata",
      invoiceName: "#R1-HTTP",
      total: "50000",
      outstanding: "50000",
      currency: "INR",
      dueAt: new Date(),
      status: "open",
      buyerAccountId: "buyer-r1-http",
      customerId: "gid://shopify/Customer/r1-http",
      buyerAccountGatedAt: null,
      shopUninstalledAt: null,
    };

    mockSql.setMockResult("invoice", [mockInvoiceData]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
    mockSql.setMockResult("claim_slot", [{ id: "new-log-id" }]);
    mockSql.setMockResult("global_increment", [{ dailyCount: 1, monthlyTotal: 1 }]);

    // Force 503 error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "Service unavailable with PII: secret@leak.test",
    });

    const result = await sendPaymentReminder(
      mockSql,
      "shop-r1-http",
      "inv-r1-http",
      "rule-r1-http",
      0,
      { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@example.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "buyer@pii-reminder-test.com,buyer@example.test" }
    );

    // Result should have errorCode, not error with interpolated status
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("resend_server_error");

    // Exact keys check - no 'error' field
    const resultKeys = Object.keys(result).sort();
    expect(resultKeys).toEqual(["action", "errorCode", "retryable", "success"]);

    // Status code 503 must NOT appear as string in result
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("503");
    expect(resultStr).not.toContain("secret@leak.test");
  });
});
