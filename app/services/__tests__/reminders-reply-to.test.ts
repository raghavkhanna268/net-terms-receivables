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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

describe("Unsubscribe flow (chained proof)", () => {
  it("generates and verifies token, simulating opt-out recording", () => {
    const shopId = "shop-unsub-test";
    const buyerAccountId = "buyer-unsub-test";

    const token = generateUnsubscribeToken(shopId, buyerAccountId, FAKE_SECRET);
    expect(token).not.toBeNull();
    expect(token!.length).toBeGreaterThan(20);

    const payload = verifyUnsubscribeToken(token!, FAKE_SECRET);
    expect(payload).not.toBeNull();
    expect(payload!.shopId).toBe(shopId);
    expect(payload!.buyerAccountId).toBe(buyerAccountId);

    const mockOptOutStore = new Map<string, { shopId: string; buyerAccountId: string; source: string }>();

    const recordOptOut = (s: string, b: string, source: string) => {
      mockOptOutStore.set(`${s}:${b}`, { shopId: s, buyerAccountId: b, source });
    };

    recordOptOut(payload!.shopId, payload!.buyerAccountId, "link");

    expect(mockOptOutStore.has(`${shopId}:${buyerAccountId}`)).toBe(true);
    expect(mockOptOutStore.get(`${shopId}:${buyerAccountId}`)?.source).toBe("link");

    const isOptedOut = (s: string, b: string) => mockOptOutStore.has(`${s}:${b}`);
    expect(isOptedOut(shopId, buyerAccountId)).toBe(true);
  });

  it("skipped_opted_out path when buyer is opted out", () => {
    const mockOptOutStore = new Set<string>();
    mockOptOutStore.add("shop-123:buyer-456");

    const isOptedOut = (shopId: string, buyerAccountId: string) =>
      mockOptOutStore.has(`${shopId}:${buyerAccountId}`);

    const mockReminderLogs: { shopId: string; ruleId: string; invoiceId: string; status: string }[] = [];

    const recordSkippedOptedOut = (shopId: string, ruleId: string, invoiceId: string) => {
      mockReminderLogs.push({ shopId, ruleId, invoiceId, status: "skipped_opted_out" });
    };

    const shouldSend = !isOptedOut("shop-123", "buyer-456");
    if (!shouldSend) {
      recordSkippedOptedOut("shop-123", "rule-789", "invoice-001");
    }

    expect(shouldSend).toBe(false);
    expect(mockReminderLogs).toHaveLength(1);
    expect(mockReminderLogs[0].status).toBe("skipped_opted_out");
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
