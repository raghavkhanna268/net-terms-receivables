import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockRecordWebhookReceipt = vi.fn();
const mockParseTriggeredAt = vi.fn();
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
}));

const mockMarkShopUninstalled = vi.fn();
const mockDeleteProcessedWebhooksViaReceipts = vi.fn();
vi.mock("~/services/compliance", () => ({
  markShopUninstalled: (...args: unknown[]) => mockMarkShopUninstalled(...args),
  deleteProcessedWebhooksViaReceipts: (...args: unknown[]) =>
    mockDeleteProcessedWebhooksViaReceipts(...args),
}));

const mockEvictShopFromSetupCache = vi.fn();
vi.mock("~/lib/after-auth.server", () => ({
  evictShopFromSetupCache: (...args: unknown[]) => mockEvictShopFromSetupCache(...args),
}));

const mockTx = vi.fn();
const mockSql = Object.assign(vi.fn(), {
  begin: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    return callback(mockTx);
  }),
});
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
    mockDeleteProcessedWebhooksViaReceipts.mockResolvedValue(0);
    mockTx.mockResolvedValue(Object.assign([], { count: 0 }));
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
    mockDeleteProcessedWebhooksViaReceipts.mockResolvedValue(0);
    mockTx.mockResolvedValue(Object.assign([], { count: 0 }));

    const response1 = await action(createActionArgs());
    expect(response1.status).toBe(200);

    const response2 = await action(createActionArgs());
    expect(response2.status).toBe(200);

    expect(mockSessionStorage.deleteAllForShop).toHaveBeenCalledTimes(2);
    expect(mockMarkShopUninstalled).toHaveBeenCalledTimes(2);
  });

  it("processed webhooks and receipts purge runs helper before receipts delete in transaction", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);

    const callOrder: string[] = [];
    mockDeleteProcessedWebhooksViaReceipts.mockImplementation(async () => {
      callOrder.push("helper");
      return 3;
    });
    mockTx.mockImplementation(async () => {
      callOrder.push("receiptsDelete");
      return Object.assign([], { count: 5 });
    });

    await action(createActionArgs());

    expect(mockSql.begin).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["helper", "receiptsDelete"]);
    expect(mockDeleteProcessedWebhooksViaReceipts).toHaveBeenCalledWith(mockTx, TEST_SHOP);
  });

  it("receipts purge transaction failure is non-fatal, logs count and code only", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);
    mockSql.begin.mockRejectedValue(new Error("Transaction failed"));

    const response = await action(createActionArgs());

    expect(response.status).toBe(200);
    expect(consoleSpy).toHaveBeenCalled();
    const errorCall = consoleSpy.mock.calls[0][0] as string;
    expect(errorCall).toContain("receipts_purge_failed");
    expect(errorCall).toContain("reason=db_error");
    expect(errorCall).toContain("err=");
    expect(errorCall).not.toContain(".myshopify.com");
    expect(errorCall).not.toContain(TEST_SHOP);
    consoleSpy.mockRestore();
    consoleLogSpy.mockRestore();
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

  describe("E9 HMAC-first verification (security)", () => {
    it("returns 401 when verifyWebhook throws 401 (missing HMAC)", async () => {
      const unauthorizedResponse = new Response(null, {
        status: 401,
        statusText: "Unauthorized",
      });
      mockVerifyWebhook.mockRejectedValue(unauthorizedResponse);

      try {
        await action(createActionArgs());
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
        expect((error as Response).statusText).toBe("Unauthorized");
      }

      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
      expect(mockMarkShopUninstalled).not.toHaveBeenCalled();
    });

    it("returns 401 when verifyWebhook throws 401 (invalid HMAC)", async () => {
      const unauthorizedResponse = new Response(null, {
        status: 401,
        statusText: "Unauthorized",
      });
      mockVerifyWebhook.mockRejectedValue(unauthorizedResponse);

      try {
        await action(createActionArgs());
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(401);
      }

      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
    });

    it("returns 400 when verifyWebhook throws 400 (missing header after valid HMAC)", async () => {
      const badRequestResponse = new Response(null, {
        status: 400,
        statusText: "Bad Request",
      });
      mockVerifyWebhook.mockRejectedValue(badRequestResponse);

      try {
        await action(createActionArgs());
        expect.fail("Expected action to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(400);
        expect((error as Response).statusText).toBe("Bad Request");
      }

      expect(mockSessionStorage.deleteAllForShop).not.toHaveBeenCalled();
    });
  });
});
