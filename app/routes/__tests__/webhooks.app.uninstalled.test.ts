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

const mockMarkUninstalledAndDeleteSessions = vi.fn();
const mockPurgeReceiptsAndProcessedWebhooks = vi.fn();
vi.mock("~/services/compliance", () => ({
  markUninstalledAndDeleteSessions: (...args: unknown[]) => mockMarkUninstalledAndDeleteSessions(...args),
  purgeReceiptsAndProcessedWebhooks: (...args: unknown[]) =>
    mockPurgeReceiptsAndProcessedWebhooks(...args),
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
    context: { cloudflare: { env: {}, ctx: {} } },
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
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 1 });
    mockRecordWebhookReceipt.mockResolvedValue(true);
    mockParseTriggeredAt.mockReturnValue(null);
    mockPurgeReceiptsAndProcessedWebhooks.mockResolvedValue({
      processedWebhooksDeleted: 0,
      receiptsDeleted: 0,
    });
    mockEvictShopFromSetupCache.mockReturnValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("calls markUninstalledAndDeleteSessions with shop domain", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 5 });

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockMarkUninstalledAndDeleteSessions).toHaveBeenCalledWith(mockSql, TEST_SHOP);
  });

  it("marks shop as uninstalled and deletes sessions atomically (S22, #258)", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 3 });

    await action(createActionArgs());

    expect(mockMarkUninstalledAndDeleteSessions).toHaveBeenCalledWith(expect.anything(), TEST_SHOP);
  });

  it("evicts shop from setup cache after successful uninstall", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 1 });

    await action(createActionArgs());

    expect(mockEvictShopFromSetupCache).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("evicts shop from setup cache even if shop not found in DB", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: false, sessionsDeleted: 0 });

    await action(createActionArgs());

    expect(mockEvictShopFromSetupCache).toHaveBeenCalledWith(TEST_SHOP);
  });

  it("handles shops with no sessions gracefully", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 0 });

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockMarkUninstalledAndDeleteSessions).toHaveBeenCalledWith(mockSql, TEST_SHOP);
  });

  it("deletes more than 25 sessions (bypasses findSessionsByShop limit)", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 50 });

    const response = await action(createActionArgs());

    expect(response).toBeInstanceOf(Response);
    expect(mockMarkUninstalledAndDeleteSessions).toHaveBeenCalledTimes(1);
  });

  it("helper failure returns 5xx", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockMarkUninstalledAndDeleteSessions.mockRejectedValue(new Error("DB error"));

    const response = await action(createActionArgs());

    expect(response.status).toBe(500);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("retry after success is idempotent", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: false, sessionsDeleted: 0 });
    mockPurgeReceiptsAndProcessedWebhooks.mockResolvedValue({
      processedWebhooksDeleted: 0,
      receiptsDeleted: 0,
    });

    const response1 = await action(createActionArgs());
    expect(response1.status).toBe(200);

    const response2 = await action(createActionArgs());
    expect(response2.status).toBe(200);

    expect(mockMarkUninstalledAndDeleteSessions).toHaveBeenCalledTimes(2);
  });

  it("processed webhooks and receipts purge calls purgeReceiptsAndProcessedWebhooks", async () => {
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 1 });
    mockPurgeReceiptsAndProcessedWebhooks.mockResolvedValue({
      processedWebhooksDeleted: 3,
      receiptsDeleted: 5,
    });

    await action(createActionArgs());

    expect(mockPurgeReceiptsAndProcessedWebhooks).toHaveBeenCalledTimes(1);
    expect(mockPurgeReceiptsAndProcessedWebhooks).toHaveBeenCalledWith(mockSql, TEST_SHOP);
  });

  it("receipts purge failure is non-fatal, logs count and code only", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 1 });
    mockPurgeReceiptsAndProcessedWebhooks.mockRejectedValue(
      new Error("Transaction failed")
    );

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
    mockMarkUninstalledAndDeleteSessions.mockResolvedValue({ shopFound: true, sessionsDeleted: 1 });
    const args = createActionArgs();

    await action(args);

    expect(mockVerifyWebhook).toHaveBeenCalledWith(args.request, "test-secret");
  });

  describe("topic guard", () => {
    it("does NOT process uninstall when topic is app/scopes_update", async () => {
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
      expect(mockMarkUninstalledAndDeleteSessions).not.toHaveBeenCalled();
    });

    it("does NOT process uninstall when topic is shop/redact", async () => {
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
      expect(mockMarkUninstalledAndDeleteSessions).not.toHaveBeenCalled();
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
      expect(mockMarkUninstalledAndDeleteSessions).not.toHaveBeenCalled();
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

      expect(mockMarkUninstalledAndDeleteSessions).not.toHaveBeenCalled();
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

      expect(mockMarkUninstalledAndDeleteSessions).not.toHaveBeenCalled();
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

      expect(mockMarkUninstalledAndDeleteSessions).not.toHaveBeenCalled();
    });
  });
});
