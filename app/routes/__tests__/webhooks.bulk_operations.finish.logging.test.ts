/**
 * Route-level bulk_operations.finish webhook tests for logging assertions.
 *
 * Tests verify that webhookId is never logged while dedupe/idempotency
 * still works correctly (webhookId is passed to recordWebhookReceipt and sendBulkMessage for DB).
 * Uses real console output (no log.server mock per logging guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const TEST_SHOP = "test-bulk-ops.myshopify.com";

const mockSqlResult = Object.assign([], { count: 0 });
const mockTx = vi.fn().mockResolvedValue(mockSqlResult);
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  {
    json: vi.fn((v) => v),
    begin: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
      return callback(mockTx);
    }),
  }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockRecordWebhookReceipt = vi.fn();
const mockParseTriggeredAt = vi.fn();
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
}));

const mockSendBulkMessage = vi.fn();
vi.mock("~/lib/pgmq.server", () => ({
  sendBulkMessage: (...args: unknown[]) => mockSendBulkMessage(...args),
}));

const mockAuthenticateWebhook = vi.fn();

function createMockActionArgs(request: Request): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: {}, ctx: {} },
      shopify: {
        authenticate: {
          webhook: mockAuthenticateWebhook,
        },
      },
    },
    url: new URL(request.url),
    pattern: "/webhooks/bulk_operations/finish",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.bulk_operations.finish";

describe("webhooks.bulk_operations.finish logging", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseTriggeredAt.mockReturnValue(null);
    mockRecordWebhookReceipt.mockResolvedValue(true);
    mockSendBulkMessage.mockResolvedValue(undefined);
    mockSql.mockResolvedValue([{ bulk_type: "orders" }]);
    mockTx.mockResolvedValue(mockSqlResult);

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
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

  it("missing admin_graphql_api_id path logs no webhookId", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "bulk_operations/finish",
      webhookId: "test-wh-123",
      payload: { status: "COMPLETED" },
    });

    const request = new Request("https://example.com/webhooks/bulk_operations/finish", {
      method: "POST",
      body: JSON.stringify({ status: "COMPLETED" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();
  });

  it("non-completed status path logs no webhookId", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "bulk_operations/finish",
      webhookId: "test-wh-456",
      payload: {
        admin_graphql_api_id: "gid://shopify/BulkOperation/123",
        status: "RUNNING",
      },
    });

    const request = new Request("https://example.com/webhooks/bulk_operations/finish", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/BulkOperation/123", status: "RUNNING" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();
  });

  it("unknown bulk operation path logs no webhookId", async () => {
    mockAuthenticateWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "bulk_operations/finish",
      webhookId: "test-wh-789",
      payload: {
        admin_graphql_api_id: "gid://shopify/BulkOperation/999",
        status: "COMPLETED",
      },
    });
    mockSql.mockResolvedValue([]);

    const request = new Request("https://example.com/webhooks/bulk_operations/finish", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/BulkOperation/999", status: "COMPLETED" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();
  });

  it("duplicate webhook path logs no webhookId but still passes it to DB", async () => {
    const testWebhookId = "test-wh-dup";
    mockAuthenticateWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "bulk_operations/finish",
      webhookId: testWebhookId,
      payload: {
        admin_graphql_api_id: "gid://shopify/BulkOperation/123",
        status: "COMPLETED",
      },
    });
    mockSql.mockResolvedValue([{ bulk_type: "orders" }]);
    mockRecordWebhookReceipt.mockResolvedValue(false);

    const request = new Request("https://example.com/webhooks/bulk_operations/finish", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/BulkOperation/123", status: "COMPLETED" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();

    expect(mockRecordWebhookReceipt).toHaveBeenCalledWith(
      expect.anything(),
      TEST_SHOP,
      testWebhookId,
      "BULK_OPERATIONS_FINISH",
      null
    );
  });

  it("success enqueue path logs no webhookId but still passes it to DB", async () => {
    const testWebhookId = "test-wh-success";
    mockAuthenticateWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "bulk_operations/finish",
      webhookId: testWebhookId,
      payload: {
        admin_graphql_api_id: "gid://shopify/BulkOperation/456",
        status: "COMPLETED",
      },
    });
    mockSql.mockResolvedValue([{ bulk_type: "companies" }]);
    mockRecordWebhookReceipt.mockResolvedValue(true);

    const request = new Request("https://example.com/webhooks/bulk_operations/finish", {
      method: "POST",
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/BulkOperation/456", status: "COMPLETED" }),
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs();

    expect(mockSendBulkMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ webhookId: testWebhookId })
    );
  });
});
