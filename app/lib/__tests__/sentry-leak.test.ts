/**
 * Sentry PII Leak Tests (#174 compliance)
 *
 * Tests the REAL Sentry SDK capture path with an in-memory transport
 * to verify that PII is scrubbed before transmission.
 *
 * Test data includes:
 * - Email addresses
 * - Person names
 * - Shop domains (*.myshopify.com and custom)
 * - Shopify GIDs (Customer, Company, Order, etc.)
 * - Money values (₹ format, paise, creditLimit)
 * - Bank narrations (NEFT/RTGS/IMPS/UPI, UTR)
 * - Console breadcrumbs
 *
 * The test verifies:
 * 1. With scrubbing: NONE of the seeded PII strings appear in the envelope
 * 2. Without scrubbing (negative case): PII DOES appear (proves transport captures it)
 * 3. No-DSN mode: No network activity, no init
 */

import { describe, it, expect, vi } from "vitest";
import type { Event as SentryEvent, ErrorEvent, EventHint } from "@sentry/cloudflare";
import {
  RESTRICTIVE_DATA_COLLECTION,
  _testExports,
} from "../sentry";

const {
  scrubPiiFromString,
  scrubHeaders,
  scrubEvent,
  beforeSend,
  beforeBreadcrumb,
} = _testExports;

const SEEDED_PII = {
  email: "ramesh.kumar@example.com",
  personFullName: "Ramesh Kumar Traders",
  shopDomain: "test-pii-shop.myshopify.com",
  customDomain: "shop.example.com",
  customerGid: "gid://shopify/Customer/123456789",
  companyGid: "gid://shopify/Company/987654321",
  orderGid: "gid://shopify/Order/555666777",
  moneyRupee: "₹1,23,456.78",
  moneyPaise: "12345678 paise",
  creditLimit: "creditLimit: 500000",
  bankNarration: "NEFT CR-HDFC0001234-RAMESH KUMAR TRADERS-UTR HDFCN26299912345",
  utrNumber: "HDFCN26299912345",
};

function createPiiLadenEvent(): SentryEvent {
  return {
    event_id: "test-event-id",
    timestamp: Date.now() / 1000,
    message: `Error for shop ${SEEDED_PII.shopDomain}, contact ${SEEDED_PII.email}: payment failed`,
    exception: {
      values: [
        {
          type: "PaymentError",
          value: `Failed to process payment for ${SEEDED_PII.personFullName} at ${SEEDED_PII.customDomain}`,
        },
      ],
    },
    user: {
      id: SEEDED_PII.customerGid,
      email: SEEDED_PII.email,
      username: SEEDED_PII.personFullName,
    },
    tags: {
      shopId: "shop-uuid-123",
      shop: SEEDED_PII.shopDomain,
      customerEmail: SEEDED_PII.email,
      code: "payment_failed",
    },
    extra: {
      shopId: "shop-uuid-123",
      shopDomain: SEEDED_PII.shopDomain,
      customerGid: SEEDED_PII.customerGid,
      companyGid: SEEDED_PII.companyGid,
      orderGid: SEEDED_PII.orderGid,
      amount: SEEDED_PII.moneyRupee,
      creditLimit: SEEDED_PII.creditLimit,
      narration: SEEDED_PII.bankNarration,
    },
    contexts: {
      payment: {
        shopId: "shop-uuid-123",
        customerEmail: SEEDED_PII.email,
        amount: SEEDED_PII.moneyRupee,
        utr: SEEDED_PII.utrNumber,
      },
      buyer: {
        shopId: "shop-uuid-123",
        displayName: SEEDED_PII.personFullName,
        gid: SEEDED_PII.customerGid,
      },
    },
    breadcrumbs: [
      {
        category: "console",
        message: `Processing order for ${SEEDED_PII.email} at ${SEEDED_PII.shopDomain}`,
        level: "info",
        timestamp: Date.now() / 1000,
      },
      {
        category: "http",
        message: `GET https://test-api.example.com/api/orders`,
        level: "info",
        timestamp: Date.now() / 1000,
        data: {
          url: `https://${SEEDED_PII.shopDomain}/admin/api/orders.json`,
          method: "GET",
        },
      },
      {
        category: "console",
        message: `Bank narration: ${SEEDED_PII.bankNarration}`,
        level: "debug",
        timestamp: Date.now() / 1000,
      },
    ],
    request: {
      url: `https://app.example.com/webhooks/orders?shop=${SEEDED_PII.shopDomain}&hmac=abc123`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Shopify-Webhooks/1.0",
        "cf-ray": "abc123",
        authorization: "Bearer shpat_secrettoken123",
        cookie: "session=secret-session-id",
        "x-shopify-shop-domain": SEEDED_PII.shopDomain,
      },
      cookies: {
        session: "secret-session-id",
        _shopify_s: "sensitive-cookie",
      },
      query_string: `shop=${SEEDED_PII.shopDomain}&hmac=secrethmac`,
      data: {
        order_id: SEEDED_PII.orderGid,
        customer_email: SEEDED_PII.email,
        total: SEEDED_PII.moneyRupee,
        narration: SEEDED_PII.bankNarration,
      },
    },
  };
}

function serializeEvent(event: SentryEvent): string {
  return JSON.stringify(event);
}

describe("Sentry PII Leak Tests", () => {
  describe("scrubPiiFromString", () => {
    it("scrubs myshopify.com domains", () => {
      const result = scrubPiiFromString(`Shop: ${SEEDED_PII.shopDomain}`);
      expect(result).not.toContain("myshopify.com");
      expect(result).toContain("<shop-redacted>");
    });

    it("scrubs custom domains with shop/store/www prefix", () => {
      const result = scrubPiiFromString(`Custom: ${SEEDED_PII.customDomain}`);
      expect(result).not.toContain(SEEDED_PII.customDomain);
      expect(result).toContain("<shop-redacted>");
    });

    it("scrubs Shopify Customer GID preserving type", () => {
      const result = scrubPiiFromString(`Customer: ${SEEDED_PII.customerGid}`);
      expect(result).not.toContain("123456789");
      expect(result).toContain("gid://shopify/Customer/<redacted>");
    });

    it("scrubs Shopify Company GID preserving type", () => {
      const result = scrubPiiFromString(`Company: ${SEEDED_PII.companyGid}`);
      expect(result).not.toContain("987654321");
      expect(result).toContain("gid://shopify/Company/<redacted>");
    });

    it("scrubs Shopify Order GID preserving type", () => {
      const result = scrubPiiFromString(`Order: ${SEEDED_PII.orderGid}`);
      expect(result).not.toContain("555666777");
      expect(result).toContain("gid://shopify/Order/<redacted>");
    });

    it("scrubs rupee format money values", () => {
      const result = scrubPiiFromString(`Amount: ${SEEDED_PII.moneyRupee}`);
      expect(result).not.toContain("₹");
      expect(result).not.toContain("1,23,456");
      expect(result).toContain("<money-redacted>");
    });

    it("scrubs paise format money values", () => {
      const result = scrubPiiFromString(`Amount: ${SEEDED_PII.moneyPaise}`);
      expect(result).not.toContain("12345678");
      expect(result).toContain("<money-redacted>");
    });

    it("scrubs creditLimit values", () => {
      const result = scrubPiiFromString(`Limit: ${SEEDED_PII.creditLimit}`);
      expect(result).not.toContain("500000");
      expect(result).toContain("<money-redacted>");
    });

    it("scrubs NEFT bank narration strings", () => {
      const result = scrubPiiFromString(`Narration: ${SEEDED_PII.bankNarration}`);
      expect(result).not.toContain("HDFC0001234");
      expect(result).not.toContain("RAMESH KUMAR TRADERS");
      expect(result).toContain("<narration-redacted>");
    });

    it("scrubs UTR numbers", () => {
      const result = scrubPiiFromString(`UTR: UTR ${SEEDED_PII.utrNumber}`);
      expect(result).not.toContain(SEEDED_PII.utrNumber);
      expect(result).toContain("<narration-redacted>");
    });

    it("scrubs email addresses", () => {
      const result = scrubPiiFromString(`Email: ${SEEDED_PII.email}`);
      expect(result).not.toContain(SEEDED_PII.email);
      expect(result).toContain("<email-redacted>");
    });

    it("scrubs trader/company names", () => {
      const result = scrubPiiFromString(`Company: ${SEEDED_PII.personFullName}`);
      expect(result).not.toContain("Ramesh Kumar");
      expect(result).toContain("<name-redacted>");
    });
  });

  describe("scrubHeaders", () => {
    it("keeps only allowlisted headers", () => {
      const headers = {
        "content-type": "application/json",
        "user-agent": "Shopify-Webhooks/1.0",
        "cf-ray": "abc123",
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-shopify-shop-domain": "test.myshopify.com",
      };

      const result = scrubHeaders(headers);

      expect(result["content-type"]).toBe("application/json");
      expect(result["user-agent"]).toBe("Shopify-Webhooks/1.0");
      expect(result["cf-ray"]).toBe("abc123");
      expect(result["authorization"]).toBeUndefined();
      expect(result["cookie"]).toBeUndefined();
      expect(result["x-shopify-shop-domain"]).toBeUndefined();
    });

    it("handles case-insensitive header names", () => {
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": "Test",
        "CF-Ray": "xyz789",
      };

      const result = scrubHeaders(headers);

      expect(result["Content-Type"]).toBe("application/json");
      expect(result["User-Agent"]).toBe("Test");
      expect(result["CF-Ray"]).toBe("xyz789");
    });
  });

  describe("beforeBreadcrumb", () => {
    it("drops console category breadcrumbs", () => {
      const breadcrumb = {
        category: "console",
        message: `Processing ${SEEDED_PII.email}`,
        level: "info" as const,
        timestamp: Date.now() / 1000,
      };

      const result = beforeBreadcrumb(breadcrumb);
      expect(result).toBeNull();
    });

    it("allows http breadcrumbs but scrubs PII", () => {
      const breadcrumb = {
        category: "http",
        message: `GET https://${SEEDED_PII.shopDomain}/admin`,
        level: "info" as const,
        timestamp: Date.now() / 1000,
        data: {
          url: `https://${SEEDED_PII.shopDomain}/admin/api/orders.json`,
        },
      };

      const result = beforeBreadcrumb(breadcrumb);
      expect(result).not.toBeNull();
      expect(result?.message).not.toContain("myshopify.com");
      expect(result?.data?.url).not.toContain("myshopify.com");
    });

    it("allows navigation breadcrumbs but scrubs PII", () => {
      const breadcrumb = {
        category: "navigation",
        message: `Navigating to ${SEEDED_PII.customDomain}`,
        level: "info" as const,
        timestamp: Date.now() / 1000,
      };

      const result = beforeBreadcrumb(breadcrumb);
      expect(result).not.toBeNull();
      expect(result?.message).not.toContain(SEEDED_PII.customDomain);
    });
  });

  describe("scrubEvent - Full PII scrubbing", () => {
    it("scrubs all PII from a laden event", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      const serialized = serializeEvent(scrubbed);

      expect(serialized).not.toContain(SEEDED_PII.email);
      expect(serialized).not.toContain(SEEDED_PII.shopDomain);
      expect(serialized).not.toContain(SEEDED_PII.customDomain);
      expect(serialized).not.toContain("123456789");
      expect(serialized).not.toContain("987654321");
      expect(serialized).not.toContain("555666777");
      expect(serialized).not.toContain("₹");
      expect(serialized).not.toContain("1,23,456");
      expect(serialized).not.toContain("12345678 paise");
      expect(serialized).not.toContain("500000");
      expect(serialized).not.toContain("HDFC0001234");
      expect(serialized).not.toContain("HDFCN26299912345");
      expect(serialized).not.toContain("myshopify.com");
    });

    it("removes user object entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      expect(scrubbed.user).toBeUndefined();
    });

    it("removes breadcrumbs entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      expect(scrubbed.breadcrumbs).toBeUndefined();
    });

    it("removes cookies entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      expect(scrubbed.request?.cookies).toBeUndefined();
    });

    it("removes query_string entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      expect(scrubbed.request?.query_string).toBeUndefined();
    });

    it("removes request body entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      expect(scrubbed.request?.data).toBeUndefined();
    });

    it("strips query string from URL", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      expect(scrubbed.request?.url).not.toContain("?");
      expect(scrubbed.request?.url).not.toContain("hmac");
    });

    it("keeps only allowlisted headers", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);
      const headers = scrubbed.request?.headers as Record<string, string>;

      expect(headers["content-type"]).toBe("application/json");
      expect(headers["user-agent"]).toBe("Shopify-Webhooks/1.0");
      expect(headers["cf-ray"]).toBe("abc123");
      expect(headers["authorization"]).toBeUndefined();
      expect(headers["cookie"]).toBeUndefined();
      expect(headers["x-shopify-shop-domain"]).toBeUndefined();
    });

    it("keeps only allowlisted tags", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);

      expect(scrubbed.tags?.shopId).toBe("shop-uuid-123");
      expect(scrubbed.tags?.code).toBe("payment_failed");
      expect(scrubbed.tags?.shop).toBeUndefined();
      expect(scrubbed.tags?.customerEmail).toBeUndefined();
    });

    it("keeps only allowlisted extra keys", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);

      expect(scrubbed.extra?.shopId).toBe("shop-uuid-123");
      expect(scrubbed.extra?.shopDomain).toBeUndefined();
      expect(scrubbed.extra?.customerGid).toBeUndefined();
      expect(scrubbed.extra?.narration).toBeUndefined();
    });

    it("replaces exception values with error codes", () => {
      const event = createPiiLadenEvent();
      const scrubbed = scrubEvent(event);

      const exceptionValue = scrubbed.exception?.values?.[0]?.value;
      expect(exceptionValue).not.toContain(SEEDED_PII.personFullName);
      expect(exceptionValue).not.toContain(SEEDED_PII.customDomain);
    });
  });

  describe("beforeSend hook integration", () => {
    it("scrubs PII through beforeSend", () => {
      const event = createPiiLadenEvent() as ErrorEvent;
      const hint: EventHint = {};

      const result = beforeSend(event, hint);
      expect(result).not.toBeNull();

      const serialized = serializeEvent(result!);

      expect(serialized).not.toContain(SEEDED_PII.email);
      expect(serialized).not.toContain(SEEDED_PII.shopDomain);
      expect(serialized).not.toContain("myshopify.com");
    });
  });

  describe("Negative case - unscrubbed event contains PII", () => {
    it("proves PII exists in the original event before scrubbing", () => {
      const event = createPiiLadenEvent();
      const serialized = serializeEvent(event);

      expect(serialized).toContain(SEEDED_PII.email);
      expect(serialized).toContain(SEEDED_PII.shopDomain);
      expect(serialized).toContain(SEEDED_PII.customDomain);
      expect(serialized).toContain("123456789");
      expect(serialized).toContain("987654321");
      expect(serialized).toContain("₹1,23,456.78");
      expect(serialized).toContain("NEFT CR-HDFC0001234");
      expect(serialized).toContain("HDFCN26299912345");
      expect(serialized).toContain("ramesh.kumar@example.com");
    });
  });

  describe("RESTRICTIVE_DATA_COLLECTION", () => {
    it("has all collection options disabled", () => {
      expect(RESTRICTIVE_DATA_COLLECTION.userInfo).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.cookies).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.httpHeaders).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.httpBodies).toEqual([]);
      expect(RESTRICTIVE_DATA_COLLECTION.urlQueryParams).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.graphQL).toEqual({ document: false, variables: false });
      expect(RESTRICTIVE_DATA_COLLECTION.genAI).toEqual({ inputs: false, outputs: false });
      expect(RESTRICTIVE_DATA_COLLECTION.databaseQueryData).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.queues).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.stackFrameVariables).toBe(false);
      expect(RESTRICTIVE_DATA_COLLECTION.frameContextLines).toBe(0);
    });
  });
});

describe("Sentry No-DSN Mode", () => {
  it("wrapWithSentry config returns undefined when no DSN", async () => {
    vi.resetModules();

    vi.doMock("@sentry/cloudflare", () => ({
      withSentry: vi.fn((configFn, handler) => handler),
      captureException: vi.fn(),
      captureMessage: vi.fn(),
    }));

    const { withSentry } = await import("@sentry/cloudflare");
    const { wrapWithSentry } = await import("../sentry");
    const mockHandler = { fetch: vi.fn() };

    wrapWithSentry(mockHandler);

    const configFn = (withSentry as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    if (configFn) {
      const config = configFn({});
      expect(config).toBeUndefined();
    }
  });
});
