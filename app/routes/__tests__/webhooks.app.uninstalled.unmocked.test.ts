/**
 * Route-level app/uninstalled webhook tests with REAL HMAC signatures.
 *
 * These tests call the uninstalled route action with a synthetic test secret,
 * WITHOUT mocking the webhook verifier. This ensures the full HMAC verification
 * path is exercised end-to-end.
 *
 * Test cases:
 * - Missing HMAC returns 401
 * - Bad HMAC returns 401
 * - Valid HMAC with missing header returns 400
 * - Valid HMAC with all headers returns 200 (happy path)
 *
 * Pattern follows webhooks.compliance.unmocked.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

const SYNTHETIC_TEST_SECRET = "synthetic-test-secret-uninstalled";
const TEST_SHOP = "uninstall-test.myshopify.com";

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function createSignedRequest(
  body: string,
  topic: string,
  secret: string,
  options: {
    method?: string;
    shopDomain?: string;
    omitHmac?: boolean;
    wrongHmac?: string;
    omitTopic?: boolean;
    omitShop?: boolean;
    webhookId?: string;
  } = {}
): Request {
  const hmac = options.wrongHmac ?? (options.omitHmac ? undefined : generateShopifyHmac(body, secret));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Shopify-API-Version": "2026-10",
    "X-Shopify-Webhook-Id": options.webhookId ?? `unmocked-${Date.now()}`,
  };

  if (!options.omitTopic) {
    headers["X-Shopify-Topic"] = topic;
  }
  if (!options.omitShop) {
    headers["X-Shopify-Shop-Domain"] = options.shopDomain ?? TEST_SHOP;
  }
  if (hmac) {
    headers["X-Shopify-Hmac-Sha256"] = hmac;
  }

  return new Request("https://example.com/webhooks/app/uninstalled", {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : body,
  });
}

const mockSessionStorage = {
  deleteAllForShop: vi.fn().mockResolvedValue(0),
};

const mockSql = Object.assign(
  vi.fn().mockResolvedValue([]),
  { json: vi.fn((v) => v) }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockMarkShopUninstalled = vi.fn().mockResolvedValue(true);
vi.mock("~/services/compliance", () => ({
  markShopUninstalled: (...args: unknown[]) => mockMarkShopUninstalled(...args),
}));

const mockEvictShopFromSetupCache = vi.fn();
vi.mock("~/lib/after-auth.server", () => ({
  evictShopFromSetupCache: (...args: unknown[]) => mockEvictShopFromSetupCache(...args),
}));

const mockDeleteWebhookReceiptsForShop = vi.fn().mockResolvedValue(0);
vi.mock("~/lib/webhook-receipts.server", () => ({
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

import { action } from "../webhooks.app.uninstalled";

function createMockActionArgs(request: Request): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: {}, ctx: {} },
      shopify: {},
      sessionStorage: mockSessionStorage,
    },
    url: new URL(request.url),
    pattern: "/webhooks/app/uninstalled",
  } as unknown as ActionFunctionArgs;
}

describe("webhooks.app.uninstalled unmocked HMAC tests", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue([]);
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("HMAC verification (real signatures)", () => {
    it("returns 401 when HMAC header is missing", async () => {
      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        omitHmac: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when HMAC signature is wrong", async () => {
      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        wrongHmac,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when body is tampered after signing", async () => {
      const originalPayload = { shop_id: 123 };
      const originalBody = JSON.stringify(originalPayload);
      const hmac = generateShopifyHmac(originalBody, SYNTHETIC_TEST_SECRET);

      const tamperedPayload = { shop_id: 999 };
      const tamperedBody = JSON.stringify(tamperedPayload);

      const request = new Request("https://example.com/webhooks/app/uninstalled", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Topic": "app/uninstalled",
          "X-Shopify-Shop-Domain": TEST_SHOP,
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Webhook-Id": "test-123",
          "X-Shopify-API-Version": "2026-10",
        },
        body: tamperedBody,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe("valid HMAC with missing headers returns 400", () => {
    it("returns 400 when topic header is missing (after valid HMAC)", async () => {
      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        omitTopic: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });
    });

    it("returns 400 when shop domain header is missing (after valid HMAC)", async () => {
      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        omitShop: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe("E9 HMAC-first verification (security)", () => {
    it("returns 401 when HMAC missing, even if other headers also missing", async () => {
      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        omitHmac: true,
        omitTopic: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });

    it("returns 401 when HMAC wrong, even if shop header missing", async () => {
      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const wrongHmac = generateShopifyHmac(body, "wrong-secret");
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET, {
        wrongHmac,
        omitShop: true,
      });

      await expect(action(createMockActionArgs(request))).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe("happy path with valid HMAC and all headers", () => {
    it("returns 200 and processes uninstall with valid signature", async () => {
      mockSessionStorage.deleteAllForShop.mockResolvedValue(2);
      mockMarkShopUninstalled.mockResolvedValue(true);

      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET);

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
      expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
      expect(mockMarkShopUninstalled).toHaveBeenCalled();
      expect(mockEvictShopFromSetupCache).toHaveBeenCalledWith(TEST_SHOP);
    });

    it("returns 200 even when no sessions exist (idempotent)", async () => {
      mockSessionStorage.deleteAllForShop.mockResolvedValue(0);
      mockMarkShopUninstalled.mockResolvedValue(false);

      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET);

      const response = await action(createMockActionArgs(request));

      expect(response.status).toBe(200);
    });
  });

  describe("logs do not contain shop domain", () => {
    it("success path does not log shop domain", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockSessionStorage.deleteAllForShop.mockResolvedValue(1);

      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET);

      await action(createMockActionArgs(request));

      for (const call of consoleSpy.mock.calls) {
        const logMessage = call.join(" ");
        expect(logMessage).not.toContain(".myshopify.com");
      }

      consoleSpy.mockRestore();
    });

    it("error path does not log shop domain", async () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockSessionStorage.deleteAllForShop.mockRejectedValue(new Error("DB error"));

      const payload = { shop_id: 123 };
      const body = JSON.stringify(payload);
      const request = createSignedRequest(body, "app/uninstalled", SYNTHETIC_TEST_SECRET);

      await action(createMockActionArgs(request));

      for (const call of consoleErrorSpy.mock.calls) {
        const logMessage = call.join(" ");
        expect(logMessage).not.toContain(".myshopify.com");
      }

      consoleErrorSpy.mockRestore();
    });
  });
});
