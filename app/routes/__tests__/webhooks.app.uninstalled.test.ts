import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockMarkShopUninstalled = vi.fn();
vi.mock("~/services/compliance", () => ({
  markShopUninstalled: (...args: unknown[]) => mockMarkShopUninstalled(...args),
}));

const mockSql = vi.fn();
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

import { action } from "../webhooks.app.uninstalled";

describe("webhooks.app.uninstalled", () => {
  const TEST_SHOP = "test-shop.myshopify.com";
  const originalEnv = process.env;

  const mockSessionStorage = {
    deleteAllForShop: vi.fn(),
  };

  const createMockContext = () => ({
    shopify: {},
    sessionStorage: mockSessionStorage,
    cloudflare: { env: {}, ctx: {} },
  });

  const createMockRequest = () =>
    new Request("https://example.com/webhooks/app/uninstalled", {
      method: "POST",
      headers: {
        "X-Shopify-Topic": "app/uninstalled",
        "X-Shopify-Hmac-Sha256": "test-hmac",
        "X-Shopify-Shop-Domain": TEST_SHOP,
      },
      body: JSON.stringify({}),
    });

  const createActionArgs = (): ActionFunctionArgs => ({
    request: createMockRequest(),
    context: createMockContext(),
    params: {},
    url: new URL("https://example.com/webhooks/app/uninstalled"),
    pattern: "/webhooks/app/uninstalled",
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app/uninstalled",
      webhookId: "test-webhook-id",
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockMarkShopUninstalled.mockResolvedValue(true);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("deletes all sessions for the shop using deleteAllForShop", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(5);

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("marks shop as uninstalled (S22)", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);

    await action(createActionArgs());

    expect(mockMarkShopUninstalled).toHaveBeenCalledWith(expect.anything(), TEST_SHOP);
  });

  it("handles shops with no sessions gracefully", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(0);

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
    expect(mockMarkShopUninstalled).toHaveBeenCalled();
  });

  it("deletes more than 25 sessions (bypasses findSessionsByShop limit)", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(50);

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledTimes(1);
    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("logs but does not fail on session database errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockRejectedValue(new Error("DB error"));

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("logs but does not fail on mark uninstalled database errors", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockRejectedValue(new Error("DB error"));

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("returns 500 when SHOPIFY_API_SECRET is not configured", async () => {
    delete process.env.SHOPIFY_API_SECRET;

    const response = await action(createActionArgs());

    expect(response.status).toBe(500);
    expect(mockVerifyWebhook).not.toHaveBeenCalled();
  });

  it("uses lightweight verifyWebhook instead of authenticate.webhook", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    const args = createActionArgs();

    await action(args);

    expect(mockVerifyWebhook).toHaveBeenCalledWith(args.request, "test-secret");
  });

  describe("topic guard", () => {
    it("does NOT delete sessions when topic is app/scopes_update", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "app/scopes_update",
        webhookId: "test-webhook-id",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const response = await action(createActionArgs());

      expect(response).toBeInstanceOf(Response);
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();
    });

    it("does NOT delete sessions when topic is shop/redact", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "shop/redact",
        webhookId: "test-webhook-id",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const response = await action(createActionArgs());

      expect(response).toBeInstanceOf(Response);
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();
    });

    it("returns 200 even for unexpected topics (logs and no-ops)", async () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      mockVerifyWebhook.mockResolvedValue({
        shop: TEST_SHOP,
        topic: "orders/create",
        webhookId: "test-webhook-id",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const response = await action(createActionArgs());

      expect(response).toBeInstanceOf(Response);
      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring unexpected topic")
      );
      consoleSpy.mockRestore();
    });
  });
});
