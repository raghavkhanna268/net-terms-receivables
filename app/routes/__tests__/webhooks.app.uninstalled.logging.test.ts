/**
 * Route-level uninstalled webhook tests for logging assertions.
 *
 * Tests verify that:
 * - safeLog events are emitted correctly
 * - toErrorCode is used for error handling
 * - No raw shop domain appears in logs
 * - No raw error messages appear (only error codes)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const TEST_SHOP = "test-uninstalled-logging.myshopify.com";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
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

describe("webhooks.app.uninstalled logging", () => {
  const originalEnv = process.env;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

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
    mockDeleteProcessedWebhooksViaReceipts.mockResolvedValue(0);
    mockTx.mockResolvedValue(Object.assign([], { count: 0 }));
    mockEvictShopFromSetupCache.mockReturnValue(undefined);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
    ];
    return allCalls.map(args =>
      args.map((arg: unknown) =>
        typeof arg === "object" ? JSON.stringify(arg) : String(arg)
      ).join(" ")
    );
  }

  it("sessions_deleted emits uninstalled_sessions_deleted event with count, no raw domain", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(5);

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_sessions_deleted");
    expect(outputStr).toContain("count");
    expect(outputStr).not.toContain(TEST_SHOP);
    expect(outputStr).not.toContain(".myshopify.com");
  });

  it("shop_marked_uninstalled emits uninstalled_shop_marked event with status, no raw domain", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_shop_marked");
    expect(outputStr).toContain("status");
    expect(outputStr).toContain("updated");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("shop not found emits uninstalled_shop_marked with status not_found", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(0);
    mockMarkShopUninstalled.mockResolvedValue(false);

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_shop_marked");
    expect(outputStr).toContain("not_found");
  });

  it("webhooks_purged emits uninstalled_webhooks_purged with counts, no raw domain", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);
    mockDeleteProcessedWebhooksViaReceipts.mockResolvedValue(3);
    mockTx.mockResolvedValue(Object.assign([], { count: 5 }));

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_webhooks_purged");
    expect(outputStr).toContain("processedWebhooksDeletedCount");
    expect(outputStr).toContain("receiptsDeletedCount");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("session delete failure emits uninstalled_sessions_delete_failed with toErrorCode output, no raw error", async () => {
    const testError = new Error("Database connection timeout");
    testError.name = "TimeoutError";
    mockSessionStorage.deleteAllForShop.mockRejectedValue(testError);

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_sessions_delete_failed");
    expect(outputStr).toContain("TimeoutError");
    expect(outputStr).not.toContain("Database connection timeout");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("mark_uninstalled failure emits uninstalled_mark_failed with toErrorCode output, no raw error", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    const testError = new Error("Constraint violation");
    testError.name = "PostgresError";
    (testError as Error & { code?: string }).code = "pg_unique_violation";
    mockMarkShopUninstalled.mockRejectedValue(testError);

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_mark_failed");
    expect(outputStr).toContain("pg_unique_violation");
    expect(outputStr).not.toContain("Constraint violation");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("receipts_purge failure emits uninstalled_receipts_purge_failed with toErrorCode output, no raw error", async () => {
    mockSessionStorage.deleteAllForShop.mockResolvedValue(1);
    mockMarkShopUninstalled.mockResolvedValue(true);
    const testError = new Error("Transaction deadlock");
    testError.name = "DeadlockError";
    mockSql.begin.mockRejectedValue(testError);

    await action(createActionArgs());

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("uninstalled_receipts_purge_failed");
    expect(outputStr).toContain("DeadlockError");
    expect(outputStr).not.toContain("Transaction deadlock");
    expect(outputStr).not.toContain(TEST_SHOP);
  });
});
