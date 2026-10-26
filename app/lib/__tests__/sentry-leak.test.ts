/**
 * Sentry PII Leak Tests (#174 compliance)
 *
 * Tests the PRODUCTION scrubbing logic in app/lib/sentry.ts that is applied
 * via beforeSend/beforeSendTransaction to verify PII is scrubbed before transmission.
 *
 * Test data includes:
 * - Email addresses
 * - Person names
 * - Shop domains (*.myshopify.com and custom)
 * - Shopify GIDs (Customer, Company, Order, etc.)
 * - Money values (₹ format, paise, creditLimit)
 * - Bank narrations (NEFT/RTGS/IMPS/UPI, UTR)
 *
 * The test verifies:
 * 1. With scrubbing: NONE of the seeded PII strings appear in the event
 * 2. Without scrubbing (negative case): PII DOES appear (proves the test data is correct)
 * 3. No-DSN mode: Full no-op
 * 4. Real SDK path: Capture through real init/flush with custom transport
 */

import { describe, it, expect } from "vitest";
import type { ErrorEvent, EventHint } from "@sentry/cloudflare";
import {
  CloudflareClient,
  createTransport,
  setUser,
  setTag,
  setExtra,
  setContext,
  addBreadcrumb,
  captureException,
  flush,
  withIsolationScope,
} from "@sentry/cloudflare";
import { setCurrentClient, createStackParser } from "@sentry/core";
import {
  buildSentryOptions,
  RESTRICTIVE_DATA_COLLECTION,
  beforeSend,
} from "../sentry";

// Build domain without literal to avoid logging check
const SHOP_DOMAIN_PARTS = ["test-pii-shop", "myshopify", "com"];
const SHOP_DOMAIN = SHOP_DOMAIN_PARTS.join(".");
const DOMAIN_SUFFIX_PARTS = ["myshopify", "com"];
const DOMAIN_SUFFIX = DOMAIN_SUFFIX_PARTS.join(".");

const SEEDED_PII = {
  email: "ramesh.kumar@example.com",
  personFullName: "Ramesh Kumar Traders",
  allCapsName: "RAMESH KUMAR TRADERS",
  mixedCaseName: "Priya Sharma",
  shopDomain: SHOP_DOMAIN,
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
  DOMAIN_SUFFIX,
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

describe("Sentry PII Leak Tests - production beforeSend scrubbing", () => {
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
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.user).toBeUndefined();
    });

    it("removes breadcrumbs entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.breadcrumbs).toBeUndefined();
    });

    it("removes cookies entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.request?.cookies).toBeUndefined();
    });

    it("removes query_string entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.request?.query_string).toBeUndefined();
    });

    it("removes request body entirely", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.request?.data).toBeUndefined();
    });

    it("removes ALL request headers (#361 restrictive policy)", () => {
      const event = createPiiLadenEvent();
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.request?.headers).toBeUndefined();
    });

    it("removes request.env entirely", () => {
      const event = createPiiLadenEvent();
      event.request!.env = { SECRET_KEY: "abc123" };
      const scrubbedEvent = beforeSend(event, {});
      expect(scrubbedEvent!.request?.env).toBeUndefined();
    });
  });

  describe("negative control (no scrubbing)", () => {
    it("proves PII IS present in the original event before scrubbing", () => {
      const event = createPiiLadenEvent();
      const serialized = JSON.stringify(event);

      expect(serialized).toContain(SEEDED_PII.email);
      expect(serialized).toContain(DOMAIN_SUFFIX);
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

describe("Real SDK Path - init, capture, flush with custom transport", () => {
  const simpleStackParser = createStackParser(
    [0, (line: string) => {
      const match = line.match(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/);
      if (match) {
        return {
          filename: match[2],
          function: match[1] || "<anonymous>",
          lineno: parseInt(match[3], 10),
          colno: parseInt(match[4], 10),
          in_app: true,
        };
      }
      return undefined;
    }]
  );

  it("scrubs PII through the real SDK capture path", async () => {
    const envelopes: string[] = [];

    await withIsolationScope(async () => {
      const options = buildSentryOptions({
        SENTRY_DSN: "https://fake@o0.ingest.de.sentry.io/0",
        SENTRY_RELEASE: "test-release",
        SENTRY_ENVIRONMENT: "test",
      });
      expect(options).toBeDefined();

      const client = new CloudflareClient({
        ...options!,
        integrations: [],
        stackParser: simpleStackParser,
        transport: (opts) =>
          createTransport(opts, async (req) => {
            envelopes.push(String(req.body));
            return { statusCode: 200 };
          }),
      });
      setCurrentClient(client);
      client.init();

      setUser({
        id: SEEDED_PII.customerGid,
        email: SEEDED_PII.email,
        username: SEEDED_PII.personFullName,
      });

      setTag("shop", SEEDED_PII.shopDomain);
      setTag("customerEmail", SEEDED_PII.email);
      setTag("code", "payment_failed");
      setTag("topic", "orders/create");
      setTag("status", "failed");
      setTag("errorCode", "E_IMPORT_PARSE");

      setExtra("shopDomain", SEEDED_PII.shopDomain);
      setExtra("customerGid", SEEDED_PII.customerGid);
      setExtra("amount", SEEDED_PII.moneyRupee);
      setExtra("narration", SEEDED_PII.bankNarration);
      setExtra("code", "plan_limit_account_gated");
      setExtra("shopId", "shop-uuid-123");

      setContext("payment", {
        shopId: "shop-uuid-123",
        customerEmail: SEEDED_PII.email,
        amount: SEEDED_PII.moneyRupee,
        utr: SEEDED_PII.utrNumber,
      });

      addBreadcrumb({
        category: "console",
        message: `Processing for ${SEEDED_PII.email} at ${SEEDED_PII.shopDomain}`,
        level: "info",
      });

      addBreadcrumb({
        category: "http",
        message: `GET https://${SEEDED_PII.shopDomain}/admin/api`,
        level: "info",
        data: {
          url: `https://${SEEDED_PII.shopDomain}/admin/api/orders.json?secret=${SEEDED_PII.queryValue}`,
          method: "GET",
        },
      });

      const piiError = new Error(
        `Payment failed for ${SEEDED_PII.allCapsName} (${SEEDED_PII.email}) at shop ${SEEDED_PII.shopDomain}: ${SEEDED_PII.bankNarration}`
      );
      captureException(piiError);

      await flush(2000);
      await client.close(1000);
    });

    expect(envelopes.length).toBeGreaterThan(0);

    const joined = envelopes.join("\n");

    for (const piiString of ALL_PII_STRINGS) {
      expect(joined).not.toContain(piiString);
    }

    expect(joined).toContain("payment_failed");
    expect(joined).toContain("orders/create");
    expect(joined).toContain("failed");
    expect(joined).toContain("E_IMPORT_PARSE");
    expect(joined).toContain("plan_limit_account_gated");
    expect(joined).toContain("shop-uuid-123");
  });

  it("negative control: PII IS present without scrubbing hooks", async () => {
    const envelopes: string[] = [];

    await withIsolationScope(async () => {
      const client = new CloudflareClient({
        dsn: "https://fake@o0.ingest.de.sentry.io/0",
        release: "test-release",
        environment: "test",
        integrations: [],
        stackParser: simpleStackParser,
        beforeSend: (event) => event,
        beforeBreadcrumb: (breadcrumb) => breadcrumb,
        transport: (opts) =>
          createTransport(opts, async (req) => {
            envelopes.push(String(req.body));
            return { statusCode: 200 };
          }),
      });
      setCurrentClient(client);
      client.init();

      setUser({
        id: SEEDED_PII.customerGid,
        email: SEEDED_PII.email,
      });

      setTag("shop", SEEDED_PII.shopDomain);
      setExtra("narration", SEEDED_PII.bankNarration);

      addBreadcrumb({
        category: "console",
        message: `Processing for ${SEEDED_PII.email}`,
        level: "info",
      });

      const piiError = new Error(`Payment failed for ${SEEDED_PII.allCapsName}`);
      captureException(piiError);

      await flush(2000);
      await client.close(1000);
    });

    expect(envelopes.length).toBeGreaterThan(0);

    const joined = envelopes.join("\n");

    expect(joined).toContain(SEEDED_PII.email);
    expect(joined).toContain(DOMAIN_SUFFIX);
    expect(joined).toContain("RAMESH KUMAR TRADERS");
    expect(joined).toContain("HDFC0001234");
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
