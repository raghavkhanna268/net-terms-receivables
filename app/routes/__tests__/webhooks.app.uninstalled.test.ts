import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockRecordWebhookReceipt = vi.fn();
const mockParseTriggeredAt = vi.fn();
const mockDeleteWebhookReceiptsForShop = vi.fn();
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

const mockMarkShopUninstalled = vi.fn();
vi.mock("~/services/compliance", () => ({
  markShopUninstalled: (...args: unknown[]) => mockMarkShopUninstalled(...args),
}));

const mockEvictShopFromSetupCache = vi.fn();
vi.mock("~/lib/after-auth.server", () => ({
  evictShopFromSetupCache: (...args: unknown[]) => mockEvictShopFromSetupCache(...args),
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
    mockRecordWebhookReceipt.mockResolvedValue(true);
    mockParseTriggeredAt.mockReturnValue(null);
    mockDeleteWebhookReceiptsForShop.mockResolvedValue(0);
    mockEvictShopFromSetupCache.mockReturnValue(undefined);
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

  it("evicts shop from setup cache after successful uninstall", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);

    await action(createActionArgs());

    expect(mockEvictShopFromSetupCache).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("evicts shop from setup cache even if shop not found in DB", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(0);
    mockMarkShopUninstalled.mockResolvedValue(false);

    await action(createActionArgs());

    expect(mockEvictShopFromSetupCache).toHaveBeenCalledWith(TEST_SHOP);
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

  it("session delete failure returns 5xx", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockRejectedValue(new Error("DB error"));

    const response = await action(createActionArgs());

    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("uninstalledAt write failure returns 5xx", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockRejectedValue(new Error("DB error"));

    const response = await action(createActionArgs());

    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("retry after success is idempotent", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(0);
    mockMarkShopUninstalled.mockResolvedValue(false);
    mockDeleteWebhookReceiptsForShop.mockResolvedValue(0);

    const response1 = await action(createActionArgs());
    expect(response1.status).toBe(200);

    const response2 = await action(createActionArgs());
    expect(response2.status).toBe(200);

    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledTimes(2);
    expect(mockMarkShopUninstalled).toHaveBeenCalledTimes(2);
  });

  it("webhook receipt purge failure is non-fatal", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);
    mockDeleteWebhookReceiptsForShop.mockRejectedValue(new Error("Receipt purge failed"));

    const response = await action(createActionArgs());

    expect(response.status).toBe(200);
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
        expect.stringContaining("topic_ignored")
      );
      consoleSpy.mockRestore();
    });
  });
});
