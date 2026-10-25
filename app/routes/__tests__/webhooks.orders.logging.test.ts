/**
 * Route-level orders webhook tests for logging assertions.
 *
 * Tests verify that webhookId is never logged while dedupe/idempotency
 * still works correctly (webhookId is passed to recordAndEnqueueSync for DB).
 * Uses real console output (no log.server mock per logging guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const TEST_SHOP = "test-orders.myshopify.com";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockRecordAndEnqueueSync = vi.fn();
const mockParseTriggeredAt = vi.fn();
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordAndEnqueueSync: (...args: unknown[]) => mockRecordAndEnqueueSync(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
}));

const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => v) }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

function createMockActionArgs(request: Request): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: {}, ctx: {} },
      shopify: {},
    },
    url: new URL(request.url),
    pattern: "/webhooks/orders",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.orders";

describe("webhooks.orders logging", () => {
  const originalEnv = process.env;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseTriggeredAt.mockReturnValue(null);
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };

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

  function assertNoWebhookIdInLogs(): void {
    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).not.toContain("webhookId");
    expect(outputStr).not.toContain("wh=");
  }

  it("unexpected topic path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "customers/create",
      webhookId: "test-wh-123",
      payload: { admin_graphql_api_id: "gid://shopify/Customer/123" },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/orders", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();
  });

  it("missing admin_graphql_api_id path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "orders/create",
      webhookId: "test-wh-456",
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/orders", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();
  });

  it("duplicate webhook path logs no webhookId but still passes it to DB", async () => {
    const testWebhookId = "test-wh-789";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "orders/create",
      webhookId: testWebhookId,
      payload: { admin_graphql_api_id: "gid://shopify/Order/123" },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockRecordAndEnqueueSync.mockResolvedValue({ status: "duplicate" });

    const request = new Request("https://example.com/webhooks/orders", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/123" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();

    expect(mockRecordAndEnqueueSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webhookId: testWebhookId })
    );
  });

  it("error path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "orders/updated",
      webhookId: "test-wh-error",
      payload: { admin_graphql_api_id: "gid://shopify/Order/456" },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockRecordAndEnqueueSync.mockResolvedValue({ status: "error", code: "DB_ERROR" });

    const request = new Request("https://example.com/webhooks/orders", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/456" }),
      headers: { "Content-Type": "application/json" },
    });

    await expect(action(createMockActionArgs(request))).rejects.toThrow("DB_ERROR");
    assertNoWebhookIdInLogs();
  });

  it("success enqueue path logs no webhookId but still passes it to DB", async () => {
    const testWebhookId = "test-wh-success";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "orders/paid",
      webhookId: testWebhookId,
      payload: { admin_graphql_api_id: "gid://shopify/Order/789" },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockRecordAndEnqueueSync.mockResolvedValue({ status: "enqueued", msgId: "msg-123" });

    const request = new Request("https://example.com/webhooks/orders", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/789" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();

    expect(mockRecordAndEnqueueSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webhookId: testWebhookId })
    );
  });
});
