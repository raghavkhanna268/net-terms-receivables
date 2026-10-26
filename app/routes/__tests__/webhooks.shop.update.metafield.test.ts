import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

/**
 * #342 G2: Tests for real writeShopConfigMetafield with mocked shopifyGraphQLQueue.
 *
 * These tests verify that:
 * 1. When metafieldsSet returns top-level errors, no Shop.currency UPDATE runs
 * 2. When metafieldsSet returns userErrors, no Shop.currency UPDATE runs
 *
 * Unlike the main test file, this file does NOT mock shop-config.server,
 * so we exercise the real writeShopConfigMetafield adapter-to-writer flow.
 */

const TEST_SHOP = "test-shop-g2.myshopify.com";
const TEST_SHOP_ID = "shop-test-g2-342";
const TEST_SHOP_GID = "gid://shopify/Shop/342342";
const API_SECRET = "test-api-secret-g2-342";

const createMockSqlFn = () =>
  vi.fn().mockImplementation(() => Promise.resolve([]));

const mockSql = Object.assign(createMockSqlFn(), {
  json: vi.fn((v: unknown) => v),
  array: vi.fn((arr: unknown[]) => arr),
  unsafe: vi.fn((s: string) => s),
  begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(createMockSqlFn(), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  }),
});

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
}));

const mockShopifyGraphQLQueue = vi.fn();
vi.mock("~/services/shopify-client.server", () => ({
  shopifyGraphQLQueue: (...args: unknown[]) => mockShopifyGraphQLQueue(...args),
}));

describe("webhooks.shop.update G2: real writeShopConfigMetafield (#342)", () => {
  const originalEnv = process.env;
  let sqlCalls: Array<{ query: string; values: unknown[] }>;
  let consoleSpy: { log: MockInstance; warn: MockInstance; error: MockInstance };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: API_SECRET };
    sqlCalls = [];

    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });
      return Promise.resolve([]);
    });

    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleSpy.log.mockRestore();
    consoleSpy.warn.mockRestore();
    consoleSpy.error.mockRestore();
  });

  function computeHmac(secret: string, body: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("base64");
  }

  function createMockRequest(body: object, topic: string): Request {
    const bodyStr = JSON.stringify(body);
    const hmac = computeHmac(API_SECRET, bodyStr);

    return new Request("https://example.com/webhooks/shop/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Hmac-Sha256": hmac,
        "X-Shopify-Shop-Domain": TEST_SHOP,
        "X-Shopify-Topic": topic,
        "X-Shopify-Webhook-Id": "wh-g2-342",
        "X-Shopify-API-Version": "2026-10",
      },
      body: bodyStr,
    });
  }

  function createActionArgs(request: Request): ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> } {
    const mockWaitUntil = vi.fn();

    return {
      request,
      context: {
        cloudflare: {
          env: {},
          ctx: { waitUntil: mockWaitUntil },
        },
      },
      params: {},
      url: new URL(request.url),
      pattern: new URL(request.url).pathname,
      _waitUntil: mockWaitUntil,
    } as unknown as ActionFunctionArgs & { _waitUntil: ReturnType<typeof vi.fn> };
  }

  function setupShopInDb(currency: string) {
    mockSql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlCalls.push({ query, values });

      if (query.includes("SELECT id, currency FROM")) {
        return Promise.resolve([{ id: TEST_SHOP_ID, currency }]);
      }
      if (query.includes("SELECT EXISTS")) {
        return Promise.resolve([{ has_rows: false }]);
      }
      if (query.includes("UPDATE")) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    });
  }

  function findLogWithEvent(eventKey: string): unknown[] | undefined {
    const allLogCalls = [
      ...consoleSpy.log.mock.calls,
      ...consoleSpy.warn.mock.calls,
      ...consoleSpy.error.mock.calls,
    ];
    return allLogCalls.find((call) => {
      const msg = String(call[0] ?? "");
      return msg.includes(eventKey);
    });
  }

  it("G2a: metafieldsSet top-level errors response causes metafield_failed, no Shop.currency UPDATE", async () => {
    setupShopInDb("INR");

    let callCount = 0;
    mockShopifyGraphQLQueue.mockImplementation(async (_shop: string, query: string) => {
      callCount++;
      if (query.includes("ShopCurrencyForUpdate")) {
        return {
          success: true,
          data: { shop: { id: TEST_SHOP_GID, currencyCode: "USD" } },
          retryable: false,
        };
      }
      if (query.includes("metafieldsSet")) {
        return {
          success: false,
          error: "Internal server error",
          errorCode: "internal_error",
          retryable: true,
        };
      }
      return { success: false, errorCode: "unknown_query", retryable: false };
    });

    const { action } = await import("../webhooks.shop.update");
    const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
    const args = createActionArgs(request);

    const response = await action(args);
    expect(response.status).toBe(200);

    await args._waitUntil.mock.calls[0][0];

    expect(callCount).toBe(2);

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    const metafieldFailedLog = findLogWithEvent("shop_update_webhook_metafield_failed");
    expect(metafieldFailedLog).toBeDefined();
    const logJson = JSON.parse(String(metafieldFailedLog![0]));
    expect(logJson.event).toBe("shop_update_webhook_metafield_failed");
    expect(logJson.shopHash).toBeDefined();
    expect(logJson.err).toBe("graphql_errors");
  });

  it("G2b: metafieldsSet userErrors response causes metafield_failed, no Shop.currency UPDATE", async () => {
    setupShopInDb("INR");

    let callCount = 0;
    mockShopifyGraphQLQueue.mockImplementation(async (_shop: string, query: string) => {
      callCount++;
      if (query.includes("ShopCurrencyForUpdate")) {
        return {
          success: true,
          data: { shop: { id: TEST_SHOP_GID, currencyCode: "USD" } },
          retryable: false,
        };
      }
      if (query.includes("metafieldsSet")) {
        return {
          success: true,
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [{ field: ["ownerId"], message: "Shop not found" }],
            },
          },
          retryable: false,
        };
      }
      return { success: false, errorCode: "unknown_query", retryable: false };
    });

    const { action } = await import("../webhooks.shop.update");
    const request = createMockRequest({ id: TEST_SHOP_GID }, "shop/update");
    const args = createActionArgs(request);

    const response = await action(args);
    expect(response.status).toBe(200);

    await args._waitUntil.mock.calls[0][0];

    expect(callCount).toBe(2);

    const updateCalls = sqlCalls.filter((c) => c.query.includes("UPDATE") && c.query.includes("currency"));
    expect(updateCalls.length).toBe(0);

    const metafieldFailedLog = findLogWithEvent("shop_update_webhook_metafield_failed");
    expect(metafieldFailedLog).toBeDefined();
    const logJson = JSON.parse(String(metafieldFailedLog![0]));
    expect(logJson.event).toBe("shop_update_webhook_metafield_failed");
    expect(logJson.shopHash).toBeDefined();
    expect(logJson.err).toBe("user_errors");
  });
});
