/**
 * Tests for merchant Reply-To and email footer (S18 PR D).
 *
 * Tests:
 * - Footer renders with the store display name
 * - Reply sentence appears only when hasReplyTo is true
 * - replyTo is passed through to Resend as reply_to
 * - Fetch failure falls back gracefully
 * - Module-level cache means one fetch per shop (per isolate)
 * - Chained unsubscribe proof (generate token, verify, record opt-out)
 * - List-Unsubscribe headers are present
 * - Real sendPaymentReminder/sendCatchupReminder paths test Reply-To and footer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Sql } from "~/lib/db-light.server";
import { renderPaymentReminderEmail } from "../../emails/PaymentReminderEmail";
import {
  isValidEmail,
  fetchMerchantInfo,
  _resetMerchantInfoCacheForTests,
  _getMerchantInfoCacheSizeForTests,
} from "../reminders.server";
import { generateUnsubscribeToken, verifyUnsubscribeToken } from "../reminder-unsubscribe-token.server";

const FAKE_SECRET = "test-secret-obviously-fake-for-tests-only";

const mockShopifyGraphQLQueue = vi.fn();

vi.mock("../shopify-client.server", () => ({
  shopifyGraphQLQueue: (...args: unknown[]) => mockShopifyGraphQLQueue(...args),
}));

/**
 * Create a mock SQL client that returns appropriate data for reminder send tests.
 * Tracks calls to verify ordering (shopify call before sql.begin).
 */
function createMockSql() {
  const mockResults = new Map<string, unknown>();
  const allCalls: string[] = [];

  const createQueryHandler = () => async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    allCalls.push(query);

    // Invoice lookup with joins
    if (query.includes("FROM \"Invoice\"") && query.includes("INNER JOIN")) {
      return mockResults.get("invoice") ?? [];
    }

    // Customer PII lookup
    if (query.includes("FROM s8_tagged_customers")) {
      return mockResults.get("customer") ?? [];
    }

    // getBuyerAccountId lookup
    if (query.includes("buyerAccountId") && query.includes("FROM \"Invoice\"") && !query.includes("INNER JOIN")) {
      return mockResults.get("buyer_account_id") ?? [{ buyerAccountId: "buyer-test-123" }];
    }

    // isBuyerOptedOut check
    if (query.includes("reminderOptOutAt") && query.includes("FROM \"BuyerAccount\"")) {
      return mockResults.get("buyer_opted_out") ?? [{ optedOut: false }];
    }

    // hasReminderSentToday check
    if (query.includes("sentToday") && query.includes("ReminderLog")) {
      return mockResults.get("sent_today") ?? [{ sentToday: false }];
    }

    // ReminderLog INSERT (claim slot)
    if (query.includes("INSERT INTO \"ReminderLog\"") && query.includes("RETURNING")) {
      return mockResults.get("claim_slot") ?? [{ id: "new-log-id" }];
    }

    // ReminderLog DELETE (release slot)
    if (query.includes("DELETE FROM \"ReminderLog\"")) {
      return [];
    }

    // ReminderLog status lookup for catchup
    if (query.includes("status") && query.includes("firstCappedAt") && query.includes("FROM \"ReminderLog\"")) {
      return mockResults.get("log_status") ?? [{ status: "delayed", firstCappedAt: new Date() }];
    }

    // ReminderLog UPDATE for catchup
    if (query.includes("UPDATE \"ReminderLog\"") && query.includes("SET status")) {
      return [];
    }

    // Advisory lock for global send cap
    if (query.includes("pg_advisory_xact_lock")) {
      return [];
    }

    // Global sends count query
    if (query.includes("dailyCount") && query.includes("monthlyTotal") && query.includes("s18_global_sends")) {
      return mockResults.get("global_counts") ?? [{ dailyCount: 0, monthlyTotal: 0 }];
    }

    // Global sends INSERT...ON CONFLICT (reservation increment)
    if (query.includes("INSERT INTO s18_global_sends") && query.includes("ON CONFLICT")) {
      return mockResults.get("global_increment") ?? [{ dailyCount: 1 }];
    }

    // Global sends release (decrement)
    if (query.includes("GREATEST(0, daily_count - 1)")) {
      return [];
    }

    // Shop reminder settings
    if (query.includes("FROM s18_shop_reminder_settings")) {
      return mockResults.get("settings") ?? [{ enabled: true }];
    }

    // ReminderRule lookup
    if (query.includes("FROM \"ReminderRule\"") && query.includes("WHERE id")) {
      return mockResults.get("rule") ?? [{ id: "rule-test-123", offsetDays: 0, channel: "email", enabled: true }];
    }

    // hasNewerStageForInvoice check
    if (query.includes("hasNewer") && query.includes("ReminderLog") && query.includes("offsetDays")) {
      return mockResults.get("has_newer_stage") ?? [{ hasNewer: false }];
    }

    // hasNewerStageDueToday check
    if (query.includes("hasNewer") && query.includes("ReminderRule") && !query.includes("ReminderLog")) {
      return mockResults.get("has_newer_stage_due") ?? [{ hasNewer: false }];
    }

    // Shop currency check
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
      clearMockResults: () => { mockResults.clear(); allCalls.length = 0; },
      begin: vi.fn(async <T>(callback: (tx: typeof mockTx) => Promise<T>): Promise<T> => {
        allCalls.push("BEGIN");
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

describe("PaymentReminderEmail footer", () => {
  it("renders footer with store display name", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-shop",
      reminderType: "Payment due today",
      storeDisplayName: "My Awesome Store",
      hasReplyTo: false,
    });

    expect(html).toContain("You're receiving this because you have an open invoice with My Awesome Store.");
    expect(html).not.toContain("Questions about this invoice? Just reply to this email.");
  });

  it("renders reply sentence only when hasReplyTo is true", () => {
    const htmlWithReplyTo = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-shop",
      reminderType: "Payment due today",
      storeDisplayName: "My Awesome Store",
      hasReplyTo: true,
    });

    expect(htmlWithReplyTo).toContain("Questions about this invoice? Just reply to this email.");

    const htmlWithoutReplyTo = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-shop",
      reminderType: "Payment due today",
      storeDisplayName: "My Awesome Store",
      hasReplyTo: false,
    });

    expect(htmlWithoutReplyTo).not.toContain("Questions about this invoice? Just reply to this email.");
  });

  it("falls back to merchantName when storeDisplayName is not provided", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "fallback-handle",
      reminderType: "Payment due today",
    });

    expect(html).toContain("You're receiving this because you have an open invoice with fallback-handle.");
  });

  it("escapes HTML in store display name", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-shop",
      reminderType: "Payment due today",
      storeDisplayName: "Store <script>alert('xss')</script>",
      hasReplyTo: false,
    });

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });
});

describe("fetchMerchantInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMerchantInfoCacheForTests();
  });

  afterEach(() => {
    _resetMerchantInfoCacheForTests();
  });

  it("returns name and contactEmail on success", async () => {
    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: true,
      data: {
        shop: {
          name: "Acme Store",
          contactEmail: "contact@example.com",
        },
      },
    });

    const result = await fetchMerchantInfo("shop-123", "test-shop.myshopify.com");

    expect(result.name).toBe("Acme Store");
    expect(result.contactEmail).toBe("contact@example.com");
  });

  it("returns null values on GraphQL failure", async () => {
    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: false,
      error: "some_error",
    });

    const result = await fetchMerchantInfo("shop-456", "test-shop.myshopify.com");

    expect(result.name).toBeNull();
    expect(result.contactEmail).toBeNull();
  });

  it("returns null contactEmail when email is invalid", async () => {
    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: true,
      data: {
        shop: {
          name: "Acme Store",
          contactEmail: "not-an-email",
        },
      },
    });

    const result = await fetchMerchantInfo("shop-789", "test-shop.myshopify.com");

    expect(result.name).toBe("Acme Store");
    expect(result.contactEmail).toBeNull();
  });

  it("returns null contactEmail when email is empty", async () => {
    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: true,
      data: {
        shop: {
          name: "Acme Store",
          contactEmail: "",
        },
      },
    });

    const result = await fetchMerchantInfo("shop-empty", "test-shop.myshopify.com");

    expect(result.name).toBe("Acme Store");
    expect(result.contactEmail).toBeNull();
  });

  it("returns null values on exception", async () => {
    mockShopifyGraphQLQueue.mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchMerchantInfo("shop-error", "test-shop.myshopify.com");

    expect(result.name).toBeNull();
    expect(result.contactEmail).toBeNull();
  });

  it("trims whitespace from name and email", async () => {
    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: true,
      data: {
        shop: {
          name: "  Acme Store  ",
          contactEmail: "  contact@example.com  ",
        },
      },
    });

    const result = await fetchMerchantInfo("shop-trim", "test-shop.myshopify.com");

    expect(result.name).toBe("Acme Store");
    expect(result.contactEmail).toBe("contact@example.com");
  });
});

describe("isValidEmail", () => {
  it("returns true for valid email addresses", () => {
    expect(isValidEmail("test@example.com")).toBe(true);
    expect(isValidEmail("user.name@example.com")).toBe(true);
    expect(isValidEmail("name+tag@example.com")).toBe(true);
  });

  it("returns false for invalid email addresses", () => {
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("test@")).toBe(false);
    expect(isValidEmail("test")).toBe(false);
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail(null)).toBe(false);
    expect(isValidEmail(undefined)).toBe(false);
  });
});

describe("Module-level merchant info cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMerchantInfoCacheForTests();
  });

  afterEach(() => {
    _resetMerchantInfoCacheForTests();
  });

  it("caches result so second call for same shop does not fetch", async () => {
    mockShopifyGraphQLQueue.mockResolvedValue({
      success: true,
      data: {
        shop: {
          name: "Cached Store",
          contactEmail: "cached@example.com",
        },
      },
    });

    const shopId = "shop-cache-test";
    const shopDomain = "test-cache.myshopify.com";

    const result1 = await fetchMerchantInfo(shopId, shopDomain);
    expect(result1.name).toBe("Cached Store");
    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);

    const result2 = await fetchMerchantInfo(shopId, shopDomain);
    expect(result2.name).toBe("Cached Store");
    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);

    expect(_getMerchantInfoCacheSizeForTests()).toBe(1);
  });

  it("fetches separately for different shops", async () => {
    mockShopifyGraphQLQueue
      .mockResolvedValueOnce({
        success: true,
        data: { shop: { name: "Store A", contactEmail: "a@example.com" } },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { shop: { name: "Store B", contactEmail: "b@example.com" } },
      });

    const infoA = await fetchMerchantInfo("shop-a", "test-shop-a.myshopify.com");
    const infoB = await fetchMerchantInfo("shop-b", "test-shop-b.myshopify.com");

    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(2);
    expect(infoA.name).toBe("Store A");
    expect(infoB.name).toBe("Store B");
    expect(_getMerchantInfoCacheSizeForTests()).toBe(2);
  });

  it("one fetch for two sends to same shop, second shop causes second fetch", async () => {
    mockShopifyGraphQLQueue
      .mockResolvedValueOnce({
        success: true,
        data: { shop: { name: "First Shop", contactEmail: "first@example.com" } },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { shop: { name: "Second Shop", contactEmail: "second@example.com" } },
      });

    await fetchMerchantInfo("shop-1", "test-shop-1.myshopify.com");
    await fetchMerchantInfo("shop-1", "test-shop-1.myshopify.com");
    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);

    await fetchMerchantInfo("shop-2", "test-shop-2.myshopify.com");
    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(2);
  });
});

describe("Unsubscribe token functions", () => {
  it("generates and verifies unsubscribe token correctly", () => {
    const shopId = "shop-unsub-test";
    const buyerAccountId = "buyer-unsub-test";

    const token = generateUnsubscribeToken(shopId, buyerAccountId, FAKE_SECRET);
    expect(token).not.toBeNull();
    expect(token!.length).toBeGreaterThan(20);

    const payload = verifyUnsubscribeToken(token!, FAKE_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.shopId).toBe(shopId);
    expect(payload!.buyerAccountId).toBe(buyerAccountId);
  });

  it("returns null for invalid token", () => {
    const payload = verifyUnsubscribeToken("invalid-token", FAKE_SECRET);
    expect(payload).toBeNull();
  });

  it("returns null for wrong secret", () => {
    const token = generateUnsubscribeToken("shop-1", "buyer-1", FAKE_SECRET);
    const payload = verifyUnsubscribeToken(token!, "wrong-secret");
    expect(payload).toBeNull();
  });
});

describe("Resend reply_to integration", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-123" }),
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sendViaResend includes reply_to when replyTo is set", async () => {
    const { sendViaResend } = await import("../resend-client.server");

    await sendViaResend(
      {
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Test",
        html: "<p>Test</p>",
        replyTo: "reply@example.com",
      },
      {
        RESEND_API_KEY: "test-key",
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBe("reply@example.com");
  });

  it("sendViaResend omits reply_to when replyTo is not set", async () => {
    const { sendViaResend } = await import("../resend-client.server");

    await sendViaResend(
      {
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Test",
        html: "<p>Test</p>",
      },
      {
        RESEND_API_KEY: "test-key",
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBeUndefined();
  });

  it("sendViaResend omits reply_to when replyTo is empty string", async () => {
    const { sendViaResend } = await import("../resend-client.server");

    await sendViaResend(
      {
        from: "sender@example.com",
        to: ["recipient@example.com"],
        subject: "Test",
        html: "<p>Test</p>",
        replyTo: "",
      },
      {
        RESEND_API_KEY: "test-key",
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBeUndefined();
  });
});

describe("Email footer exact strings with Reply-To and List-Unsubscribe", () => {
  it("Reply-To set: footer has shop.name and reply sentence (exact string)", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-handle",
      reminderType: "Payment due today",
      storeDisplayName: "Acme Corp",
      hasReplyTo: true,
    });

    expect(html).toContain(
      "You're receiving this because you have an open invoice with Acme Corp. Questions about this invoice? Just reply to this email."
    );
  });

  it("Fetch failure (no shop.name, no email): footer uses handle label, no reply sentence (exact string)", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-handle",
      reminderType: "Payment due today",
      storeDisplayName: "test-handle",
      hasReplyTo: false,
    });

    expect(html).toContain(
      "You're receiving this because you have an open invoice with test-handle."
    );
    expect(html).not.toContain("Questions about this invoice? Just reply to this email.");
  });

  it("shop.name present but contactEmail empty/invalid: footer uses shop.name, no reply sentence (exact string)", () => {
    const html = renderPaymentReminderEmail({
      invoiceName: "INV-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 26, 2026",
      merchantName: "test-handle",
      reminderType: "Payment due today",
      storeDisplayName: "Acme Corp",
      hasReplyTo: false,
    });

    expect(html).toContain(
      "You're receiving this because you have an open invoice with Acme Corp."
    );
    expect(html).not.toContain("Questions about this invoice? Just reply to this email.");
  });

  it("List-Unsubscribe headers are generated correctly", async () => {
    const { buildUnsubscribeHeaders } = await import("../reminder-headers.server");

    const headers = buildUnsubscribeHeaders(
      "https://example.com",
      "shop-list-unsub",
      "buyer-list-unsub",
      FAKE_SECRET
    );

    expect(headers).not.toBeNull();
    expect(headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/example\.com\/unsubscribe\?token=.+>$/);
    expect(headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});

/**
 * P2: Real-path tests that call sendPaymentReminder and sendCatchupReminder.
 * Verifies:
 * - reply_to === contactEmail when merchant info fetch succeeds
 * - Exact footer with shop.name and reply sentence on success
 * - No reply_to on fetch failure, handle label used, no reply sentence
 * - Ordering: shopify call before sql.begin
 * - List-Unsubscribe headers present
 * - Cache: one fetch for two sends to same shop
 */
describe("Real sendPaymentReminder path", () => {
  let mockSql: ReturnType<typeof createMockSql>;
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let callOrder: string[];

  const validEnv = {
    RESEND_API_KEY: "re_test_1234",
    RESEND_FROM: "noreply@example.com",
    REMINDER_UNSUBSCRIBE_SECRET: FAKE_SECRET,
    SHOPIFY_APP_URL: "https://app.example.com",
    RESEND_TEST_RECIPIENTS: "buyer@example.test",
    RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
  };

  const mockInvoice = {
    invoiceId: "inv-real-test",
    shopId: "shop-real-test",
    shopDomain: "fake-test-shop.myshopify.com",
    shopTimezone: "Asia/Kolkata",
    invoiceName: "#TEST-001",
    total: "5000.00",
    outstanding: "5000.00",
    currency: "INR",
    dueAt: new Date(),
    status: "open",
    buyerAccountId: "buyer-real-test",
    accountKind: "TAGGED_CUSTOMER",
    customerId: "gid://shopify/Customer/123",
    mainContactEmail: null,
    mainContactDisplayName: null,
    buyerAccountGatedAt: null,
    shopUninstalledAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T06:30:00Z"));
    _resetMerchantInfoCacheForTests();
    callOrder = [];

    mockSql = createMockSql();
    mockSql.setMockResult("invoice", [mockInvoice]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-456" }),
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    mockShopifyGraphQLQueue.mockImplementation(async () => {
      callOrder.push("shopifyGraphQLQueue");
      return {
        success: true,
        data: {
          shop: {
            name: "Test Store Display",
            contactEmail: "merchant@example.com",
          },
        },
      };
    });

    const originalBegin = mockSql.begin;
    mockSql.begin = vi.fn(async (callback: (tx: Sql) => Promise<unknown>): Promise<unknown> => {
      callOrder.push("sql.begin");
      return originalBegin(callback);
    }) as unknown as typeof originalBegin;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    _resetMerchantInfoCacheForTests();
  });

  it("success: reply_to === contactEmail and footer has shop.name + reply sentence", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const result = await sendPaymentReminder(
      mockSql,
      "shop-real-test",
      "inv-real-test",
      "rule-real-test",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBe("merchant@example.com");

    expect(body.html).toContain(
      "You're receiving this because you have an open invoice with Test Store Display. Questions about this invoice? Just reply to this email."
    );

    expect(body.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.example\.com\/unsubscribe\?token=.+>$/);
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("fetch failure: no reply_to, footer uses handle label, no reply sentence", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: false,
      error: "some_error",
    });

    const result = await sendPaymentReminder(
      mockSql,
      "shop-real-test",
      "inv-real-test",
      "rule-real-test",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBeUndefined();

    expect(body.html).toContain(
      "You're receiving this because you have an open invoice with fake-test-shop."
    );
    expect(body.html).not.toContain("Questions about this invoice? Just reply to this email.");
  });

  it("ordering: shopify call happens before sql.begin", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    await sendPaymentReminder(
      mockSql,
      "shop-real-test",
      "inv-real-test",
      "rule-real-test",
      0,
      "Asia/Kolkata",
      validEnv
    );

    const shopifyIndex = callOrder.indexOf("shopifyGraphQLQueue");
    const beginIndex = callOrder.indexOf("sql.begin");

    expect(shopifyIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeGreaterThan(-1);
    expect(shopifyIndex).toBeLessThan(beginIndex);
  });

  it("cache: one fetch for two sends to same shop", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    mockSql.clearMockResults();
    mockSql.setMockResult("invoice", [mockInvoice]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

    await sendPaymentReminder(
      mockSql,
      "shop-real-test",
      "inv-real-test",
      "rule-1",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);

    mockSql.clearMockResults();
    mockSql.setMockResult("invoice", [{ ...mockInvoice, invoiceId: "inv-real-test-2" }]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);

    await sendPaymentReminder(
      mockSql,
      "shop-real-test",
      "inv-real-test-2",
      "rule-2",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);
    expect(_getMerchantInfoCacheSizeForTests()).toBe(1);
  });

  it("opted-out buyer: skips send, no shopifyGraphQLQueue call, no Resend fetch", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    mockSql.clearMockResults();
    mockSql.setMockResult("invoice", [mockInvoice]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Test Buyer" }]);
    mockSql.setMockResult("buyer_opted_out", [{ optedOut: true }]);

    const result = await sendPaymentReminder(
      mockSql,
      "shop-real-test",
      "inv-real-test",
      "rule-optout",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("Buyer opted out of reminders");

    expect(mockShopifyGraphQLQueue).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("Real sendCatchupReminder path", () => {
  let mockSql: ReturnType<typeof createMockSql>;
  let mockFetch: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let callOrder: string[];

  const validEnv = {
    RESEND_API_KEY: "re_test_1234",
    RESEND_FROM: "noreply@example.com",
    REMINDER_UNSUBSCRIBE_SECRET: FAKE_SECRET,
    SHOPIFY_APP_URL: "https://app.example.com",
    RESEND_TEST_RECIPIENTS: "buyer@example.test",
    RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
  };

  const mockInvoice = {
    invoiceId: "inv-catchup-test",
    shopId: "shop-catchup-test",
    shopDomain: "fake-catchup-shop.myshopify.com",
    shopTimezone: "Asia/Kolkata",
    invoiceName: "#CATCHUP-001",
    total: "3000.00",
    outstanding: "3000.00",
    currency: "INR",
    dueAt: new Date("2026-10-24T00:00:00+05:30"),
    status: "open",
    buyerAccountId: "buyer-catchup-test",
    accountKind: "TAGGED_CUSTOMER",
    customerId: "gid://shopify/Customer/789",
    mainContactEmail: null,
    mainContactDisplayName: null,
    buyerAccountGatedAt: null,
    shopUninstalledAt: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T06:30:00Z"));
    _resetMerchantInfoCacheForTests();
    callOrder = [];

    mockSql = createMockSql();
    mockSql.setMockResult("invoice", [mockInvoice]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Catchup Buyer" }]);
    mockSql.setMockResult("log_status", [{ status: "delayed", firstCappedAt: new Date("2026-10-25T10:00:00Z") }]);

    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-catchup-789" }),
    });
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as typeof globalThis.fetch;

    mockShopifyGraphQLQueue.mockImplementation(async () => {
      callOrder.push("shopifyGraphQLQueue");
      return {
        success: true,
        data: {
          shop: {
            name: "Catchup Store",
            contactEmail: "catchup@example.com",
          },
        },
      };
    });

    const originalBegin = mockSql.begin;
    mockSql.begin = vi.fn(async (callback: (tx: Sql) => Promise<unknown>): Promise<unknown> => {
      callOrder.push("sql.begin");
      return originalBegin(callback);
    }) as unknown as typeof originalBegin;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    _resetMerchantInfoCacheForTests();
  });

  it("success: reply_to === contactEmail and footer has shop.name + reply sentence", async () => {
    const { sendCatchupReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    const result = await sendCatchupReminder(
      mockSql,
      "shop-catchup-test",
      "inv-catchup-test",
      "rule-catchup-test",
      "log-catchup-test",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBe("catchup@example.com");

    expect(body.html).toContain(
      "You're receiving this because you have an open invoice with Catchup Store. Questions about this invoice? Just reply to this email."
    );

    expect(body.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.example\.com\/unsubscribe\?token=.+>$/);
    expect(body.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("fetch failure: no reply_to, footer uses handle label, no reply sentence", async () => {
    const { sendCatchupReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    mockShopifyGraphQLQueue.mockResolvedValueOnce({
      success: false,
      error: "graphql_error",
    });

    const result = await sendCatchupReminder(
      mockSql,
      "shop-catchup-test",
      "inv-catchup-test",
      "rule-catchup-test",
      "log-catchup-test",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("sent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body as string);

    expect(body.reply_to).toBeUndefined();

    expect(body.html).toContain(
      "You're receiving this because you have an open invoice with fake-catchup-shop."
    );
    expect(body.html).not.toContain("Questions about this invoice? Just reply to this email.");
  });

  it("ordering: shopify call happens before sql.begin", async () => {
    const { sendCatchupReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    await sendCatchupReminder(
      mockSql,
      "shop-catchup-test",
      "inv-catchup-test",
      "rule-catchup-test",
      "log-catchup-test",
      0,
      "Asia/Kolkata",
      validEnv
    );

    const shopifyIndex = callOrder.indexOf("shopifyGraphQLQueue");
    const beginIndex = callOrder.indexOf("sql.begin");

    expect(shopifyIndex).toBeGreaterThan(-1);
    expect(beginIndex).toBeGreaterThan(-1);
    expect(shopifyIndex).toBeLessThan(beginIndex);
  });

  it("cache: one fetch for two catchup sends to same shop", async () => {
    const { sendCatchupReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    await sendCatchupReminder(
      mockSql,
      "shop-catchup-test",
      "inv-catchup-test",
      "rule-catchup-1",
      "log-catchup-1",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);

    mockSql.clearMockResults();
    mockSql.setMockResult("invoice", [{ ...mockInvoice, invoiceId: "inv-catchup-test-2" }]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Catchup Buyer" }]);
    mockSql.setMockResult("log_status", [{ status: "delayed", firstCappedAt: new Date("2026-10-25T10:00:00Z") }]);

    await sendCatchupReminder(
      mockSql,
      "shop-catchup-test",
      "inv-catchup-test-2",
      "rule-catchup-2",
      "log-catchup-2",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(mockShopifyGraphQLQueue).toHaveBeenCalledTimes(1);
    expect(_getMerchantInfoCacheSizeForTests()).toBe(1);
  });

  it("opted-out buyer: skips send, no shopifyGraphQLQueue call, no Resend fetch", async () => {
    const { sendCatchupReminder } = await import("../reminders.server");
    const { DateTime } = await import("luxon");
    const mockNow = DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
    vi.spyOn(DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof DateTime.now>);

    mockSql.clearMockResults();
    mockSql.setMockResult("invoice", [mockInvoice]);
    mockSql.setMockResult("customer", [{ email: "buyer@example.test", displayName: "Catchup Buyer" }]);
    mockSql.setMockResult("log_status", [{ status: "delayed", firstCappedAt: new Date("2026-10-25T10:00:00Z") }]);
    mockSql.setMockResult("buyer_opted_out", [{ optedOut: true }]);

    const result = await sendCatchupReminder(
      mockSql,
      "shop-catchup-test",
      "inv-catchup-test",
      "rule-catchup-optout",
      "log-catchup-optout",
      0,
      "Asia/Kolkata",
      validEnv
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("Buyer opted out of reminders");

    expect(mockShopifyGraphQLQueue).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
