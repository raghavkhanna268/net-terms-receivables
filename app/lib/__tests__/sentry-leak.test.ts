/**
 * Sentry PII Leak Tests (#174 compliance)
 *
 * Tests the scrubbing logic that is applied via beforeSend/beforeSendTransaction
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
 * 1. With scrubbing: NONE of the seeded PII strings appear in the event
 * 2. Without scrubbing (negative case): PII DOES appear (proves the test data is correct)
 * 3. No-DSN mode: Full no-op
 */

import { describe, it, expect } from "vitest";
import type { ErrorEvent, EventHint } from "@sentry/cloudflare";
import { buildSentryOptions, RESTRICTIVE_DATA_COLLECTION } from "../sentry";
import {
  scrubPiiFromString,
  scrubHeaders,
  scrubRecord,
  scrubEvent,
  beforeSend,
  beforeBreadcrumb,
} from "../sentry-scrub";

const SEEDED_PII = {
  email: "ramesh.kumar@example.com",
  personFullName: "Ramesh Kumar Traders",
  allCapsName: "RAMESH KUMAR TRADERS",
  mixedCaseName: "Priya Sharma",
  shopDomain: "test-pii-shop.myshopify.com",
  customDomain: "shop.example.com",
  customerGid: "gid://shopify/Customer/123456789",
  companyGid: "gid://shopify/Company/987654321",
  orderGid: "gid://shopify/Order/555666777",
  moneyRupee: "₹1,23,456.78",
  moneyPaise: "12345678 paise",
  creditLimitValue: "500000",
  bankNarration: "NEFT CR-HDFC0001234-RAMESH KUMAR TRADERS-UTR HDFCN26299912345",
  utrNumber: "HDFCN26299912345",
  queryValue: "secret-query-param-value",
  cookieValue: "secret-session-cookie-abc123",
};

const ALL_PII_STRINGS = [
  SEEDED_PII.email,
  "RAMESH KUMAR TRADERS",
  "myshopify.com",
  "123456789",
  "987654321",
  "555666777",
  "₹1,23,456.78",
  "12345678",
  "500000",
  "HDFC0001234",
  SEEDED_PII.utrNumber,
  SEEDED_PII.queryValue,
  SEEDED_PII.cookieValue,
];

function createPiiLadenEvent(): ErrorEvent {
  return {
    type: undefined,
    event_id: "test-event-id",
    timestamp: Date.now() / 1000,
    message: `Error for shop ${SEEDED_PII.shopDomain}, contact ${SEEDED_PII.email}: payment failed`,
    exception: {
      values: [
        {
          type: "PaymentError",
          value: `Failed to process payment for ${SEEDED_PII.allCapsName} at ${SEEDED_PII.customDomain}`,
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
      topic: "orders/create",
      status: "failed",
      errorCode: "E_IMPORT_PARSE",
    },
    extra: {
      shopId: "shop-uuid-123",
      shopDomain: SEEDED_PII.shopDomain,
      customerGid: SEEDED_PII.customerGid,
      companyGid: SEEDED_PII.companyGid,
      orderGid: SEEDED_PII.orderGid,
      amount: SEEDED_PII.moneyRupee,
      creditLimit: `creditLimit: ${SEEDED_PII.creditLimitValue}`,
      narration: SEEDED_PII.bankNarration,
      code: "plan_limit_account_gated",
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
        displayName: SEEDED_PII.allCapsName,
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
        message: `GET https://api.example.com/api/orders`,
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
      url: `https://app.example.com/webhooks/orders?shop=${SEEDED_PII.shopDomain}&secret=${SEEDED_PII.queryValue}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Shopify-Webhooks/1.0",
        "cf-ray": "abc123",
        authorization: "Bearer shpat_secrettoken123",
        cookie: `session=${SEEDED_PII.cookieValue}`,
        "x-shopify-shop-domain": SEEDED_PII.shopDomain,
      },
      cookies: {
        session: SEEDED_PII.cookieValue,
        _shopify_s: "sensitive-cookie",
      },
      query_string: `shop=${SEEDED_PII.shopDomain}&secret=${SEEDED_PII.queryValue}`,
      data: {
        order_id: SEEDED_PII.orderGid,
        customer_email: SEEDED_PII.email,
        total: SEEDED_PII.moneyRupee,
        narration: SEEDED_PII.bankNarration,
      },
    },
  };
}

describe("Sentry PII Leak Tests - beforeSend scrubbing", () => {
  describe("with PII scrubbing (production config)", () => {
    it("scrubs ALL seeded PII from captured events via beforeSend", () => {
      const event = createPiiLadenEvent();
      const hint: EventHint = {};

      const scrubbedEvent = beforeSend(event, hint);
      expect(scrubbedEvent).not.toBeNull();

      const serialized = JSON.stringify(scrubbedEvent);

      for (const piiString of ALL_PII_STRINGS) {
        expect(serialized).not.toContain(piiString);
      }
    });

    it("preserves allowlisted tag values", () => {
      const event = createPiiLadenEvent();
      const hint: EventHint = {};

      const scrubbedEvent = beforeSend(event, hint);
      expect(scrubbedEvent).not.toBeNull();

      expect(scrubbedEvent!.tags?.shopId).toBe("shop-uuid-123");
      expect(scrubbedEvent!.tags?.code).toBe("payment_failed");
      expect(scrubbedEvent!.tags?.topic).toBe("orders/create");
      expect(scrubbedEvent!.tags?.status).toBe("failed");
      expect(scrubbedEvent!.tags?.errorCode).toBe("E_IMPORT_PARSE");

      expect(scrubbedEvent!.tags?.shop).toBeUndefined();
      expect(scrubbedEvent!.tags?.customerEmail).toBeUndefined();
    });

    it("preserves allowlisted extra values", () => {
      const event = createPiiLadenEvent();
      const hint: EventHint = {};

      const scrubbedEvent = beforeSend(event, hint);
      expect(scrubbedEvent).not.toBeNull();

      expect(scrubbedEvent!.extra?.shopId).toBe("shop-uuid-123");
      expect(scrubbedEvent!.extra?.code).toBe("plan_limit_account_gated");

      expect(scrubbedEvent!.extra?.shopDomain).toBeUndefined();
      expect(scrubbedEvent!.extra?.narration).toBeUndefined();
    });

    it("removes user object entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = scrubEvent(event);
      expect(scrubbedEvent.user).toBeUndefined();
    });

    it("removes breadcrumbs entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = scrubEvent(event);
      expect(scrubbedEvent.breadcrumbs).toBeUndefined();
    });

    it("removes cookies entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = scrubEvent(event);
      expect(scrubbedEvent.request?.cookies).toBeUndefined();
    });

    it("removes query_string entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = scrubEvent(event);
      expect(scrubbedEvent.request?.query_string).toBeUndefined();
    });

    it("removes request body entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = scrubEvent(event);
      expect(scrubbedEvent.request?.data).toBeUndefined();
    });

    it("keeps only allowlisted headers (content-type, cf-ray)", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = scrubEvent(event);
      const headers = scrubbedEvent.request?.headers as Record<string, string>;

      expect(headers["content-type"]).toBe("application/json");
      expect(headers["cf-ray"]).toBe("abc123");
      expect(headers["user-agent"]).toBeUndefined();
      expect(headers["authorization"]).toBeUndefined();
      expect(headers["cookie"]).toBeUndefined();
      expect(headers["x-shopify-shop-domain"]).toBeUndefined();
    });
  });

  describe("negative control (no scrubbing)", () => {
    it("proves PII IS present in the original event before scrubbing", () => {
      const event = createPiiLadenEvent();
      const serialized = JSON.stringify(event);

      expect(serialized).toContain(SEEDED_PII.email);
      expect(serialized).toContain("myshopify.com");
      expect(serialized).toContain("123456789");
      expect(serialized).toContain("987654321");
      expect(serialized).toContain("₹1,23,456.78");
      expect(serialized).toContain("NEFT CR-HDFC0001234");
      expect(serialized).toContain(SEEDED_PII.utrNumber);
      expect(serialized).toContain(SEEDED_PII.queryValue);
      expect(serialized).toContain(SEEDED_PII.cookieValue);
    });
  });

  describe("no-DSN mode", () => {
    it("returns undefined options when no DSN is set", () => {
      const options = buildSentryOptions({});
      expect(options).toBeUndefined();
    });

    it("returns undefined options when DSN is empty string", () => {
      const options = buildSentryOptions({ SENTRY_DSN: "" });
      expect(options).toBeUndefined();
    });
  });
});

describe("buildSentryOptions", () => {
  it("returns correct options with DSN", () => {
    const options = buildSentryOptions({
      SENTRY_DSN: "https://test@sentry.io/123",
      SENTRY_RELEASE: "abc123",
      SENTRY_ENVIRONMENT: "production",
      SENTRY_TRACES_SAMPLE_RATE: "0.5",
    });

    expect(options).toBeDefined();
    expect(options!.dsn).toBe("https://test@sentry.io/123");
    expect(options!.release).toBe("abc123");
    expect(options!.environment).toBe("production");
    expect(options!.tracesSampleRate).toBe(0.5);
    expect(options!.dataCollection).toEqual(RESTRICTIVE_DATA_COLLECTION);
    expect(options!.enhanceFetchErrorMessages).toBe(false);
    expect(options!.beforeSend).toBeDefined();
    expect(options!.beforeSendTransaction).toBeDefined();
    expect(options!.beforeBreadcrumb).toBeDefined();
  });

  it("uses defaults for missing optional env vars", () => {
    const options = buildSentryOptions({
      SENTRY_DSN: "https://test@sentry.io/123",
    });

    expect(options).toBeDefined();
    expect(options!.release).toBeUndefined();
    expect(options!.environment).toBe("development");
    expect(options!.tracesSampleRate).toBe(0);
  });
});

describe("Unit tests - scrubbing functions", () => {
  describe("scrubPiiFromString", () => {
    it("scrubs myshopify.com domains", () => {
      const result = scrubPiiFromString(`Shop: ${SEEDED_PII.shopDomain}`);
      expect(result).not.toContain("myshopify.com");
      expect(result).toContain("<shop-redacted>");
    });

    it("scrubs Shopify GIDs preserving type", () => {
      const result = scrubPiiFromString(`Customer: ${SEEDED_PII.customerGid}`);
      expect(result).not.toContain("123456789");
      expect(result).toContain("gid://shopify/Customer/<redacted>");
    });

    it("scrubs money values", () => {
      const result = scrubPiiFromString(`Amount: ${SEEDED_PII.moneyRupee}`);
      expect(result).not.toContain("₹");
      expect(result).toContain("<money-redacted>");
    });

    it("scrubs bank narrations", () => {
      const result = scrubPiiFromString(`Narration: ${SEEDED_PII.bankNarration}`);
      expect(result).not.toContain("HDFC0001234");
      expect(result).toContain("<narration-redacted>");
    });

    it("scrubs email addresses", () => {
      const result = scrubPiiFromString(`Email: ${SEEDED_PII.email}`);
      expect(result).not.toContain(SEEDED_PII.email);
      expect(result).toContain("<email-redacted>");
    });

    it("scrubs RAMESH KUMAR TRADERS (company name pattern)", () => {
      const result = scrubPiiFromString(`Payer: ${SEEDED_PII.allCapsName}`);
      expect(result).not.toContain("RAMESH KUMAR TRADERS");
      expect(result).toContain("<name-redacted>");
    });

    it("does NOT scrub ordinary allowlisted values", () => {
      expect(scrubPiiFromString("orders/create")).toBe("orders/create");
      expect(scrubPiiFromString("plan_limit_account_gated")).toBe("plan_limit_account_gated");
      expect(scrubPiiFromString("E_IMPORT_PARSE")).toBe("E_IMPORT_PARSE");
      expect(scrubPiiFromString("failed")).toBe("failed");
      expect(scrubPiiFromString("success")).toBe("success");
      expect(scrubPiiFromString("pending")).toBe("pending");
    });
  });

  describe("scrubRecord - allowlisted values survive", () => {
    it("preserves topic value like orders/create", () => {
      const result = scrubRecord({ topic: "orders/create", other: "secret" });
      expect(result.topic).toBe("orders/create");
      expect(result.other).toBeUndefined();
    });

    it("preserves code value like plan_limit_account_gated", () => {
      const result = scrubRecord({ code: "plan_limit_account_gated" });
      expect(result.code).toBe("plan_limit_account_gated");
    });

    it("preserves errorCode value like E_IMPORT_PARSE", () => {
      const result = scrubRecord({ errorCode: "E_IMPORT_PARSE" });
      expect(result.errorCode).toBe("E_IMPORT_PARSE");
    });

    it("preserves status value like failed", () => {
      const result = scrubRecord({ status: "failed" });
      expect(result.status).toBe("failed");
    });

    it("preserves shopId value", () => {
      const result = scrubRecord({ shopId: "shop-uuid-123" });
      expect(result.shopId).toBe("shop-uuid-123");
    });

    it("scrubs PII even in allowlisted keys", () => {
      const result = scrubRecord({ shopId: "test.myshopify.com" });
      expect(result.shopId).toContain("<shop-redacted>");
    });
  });

  describe("scrubHeaders", () => {
    it("keeps only allowlisted headers (content-type, cf-ray)", () => {
      const headers = {
        "content-type": "application/json",
        "user-agent": "Test/1.0",
        "cf-ray": "abc123",
        authorization: "Bearer secret",
        cookie: "session=secret",
      };

      const result = scrubHeaders(headers);

      expect(result["content-type"]).toBe("application/json");
      expect(result["cf-ray"]).toBe("abc123");
      expect(result["user-agent"]).toBeUndefined();
      expect(result["authorization"]).toBeUndefined();
      expect(result["cookie"]).toBeUndefined();
    });
  });

  describe("beforeBreadcrumb", () => {
    it("drops console category breadcrumbs", () => {
      const result = beforeBreadcrumb({
        category: "console",
        message: "test",
        level: "info",
        timestamp: Date.now() / 1000,
      });
      expect(result).toBeNull();
    });

    it("allows http breadcrumbs but scrubs PII", () => {
      const result = beforeBreadcrumb({
        category: "http",
        message: `GET https://${SEEDED_PII.shopDomain}/api`,
        level: "info",
        timestamp: Date.now() / 1000,
      });
      expect(result).not.toBeNull();
      expect(result?.message).not.toContain("myshopify.com");
    });
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
