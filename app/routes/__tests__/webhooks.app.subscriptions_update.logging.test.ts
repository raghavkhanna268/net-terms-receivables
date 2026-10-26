/**
 * Route-level subscriptions_update webhook tests for logging assertions.
 *
 * Tests verify that webhookId is never logged in any path.
 * Uses real console output (no log.server mock per logging guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const TEST_SHOP = "test-subscriptions.myshopify.com";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => v) }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

const mockRefreshPlanCache = vi.fn();
const mockResolvePlan = vi.fn();
vi.mock("~/services/plan.server", () => ({
  refreshPlanCache: (...args: unknown[]) => mockRefreshPlanCache(...args),
  resolvePlan: (...args: unknown[]) => mockResolvePlan(...args),
}));

const mockReactivateGatedAccounts = vi.fn();
vi.mock("~/services/gating.server", () => ({
  reactivateGatedAccounts: (...args: unknown[]) => mockReactivateGatedAccounts(...args),
}));

function createMockActionArgs(request: Request): ActionFunctionArgs {
  const waitUntilFn = vi.fn((p: Promise<unknown>) => p.catch(() => {}));
  return {
    request,
    params: {},
    context: {
      cloudflare: { env: {}, ctx: { waitUntil: waitUntilFn } },
      shopify: {},
    },
    url: new URL(request.url),
    pattern: "/webhooks/app/subscriptions_update",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.app.subscriptions_update";

describe("webhooks.app.subscriptions_update logging", () => {
  const originalEnv = process.env;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshPlanCache.mockResolvedValue(undefined);
    mockResolvePlan.mockResolvedValue({ plan: { key: "starter" } });
    mockReactivateGatedAccounts.mockResolvedValue(0);
    mockSql.mockResolvedValue([{ id: "shop-123" }]);
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

  function assertNoWebhookIdInLogs(testWebhookId?: string): void {
    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");
    expect(outputStr).not.toContain("webhookId");
    expect(outputStr).not.toContain("wh=");
    if (testWebhookId) {
      expect(outputStr).not.toContain(testWebhookId);
    }
  }

  it("unexpected topic path logs no webhookId", async () => {
    const testWebhookId = "test-wh-123";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "other/topic",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);
    assertNoWebhookIdInLogs(testWebhookId);
  });

  it("success path with plan refresh logs no webhookId", async () => {
    const testWebhookId = "test-wh-456";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app_subscriptions/update",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));
    assertNoWebhookIdInLogs(testWebhookId);
  });

  it("success path with reactivated accounts logs no webhookId", async () => {
    const testWebhookId = "test-wh-789";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app_subscriptions/update",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockReactivateGatedAccounts.mockResolvedValue(5);

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));
    assertNoWebhookIdInLogs(testWebhookId);
  });

  it("error path logs no webhookId", async () => {
    const testWebhookId = "test-wh-error";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app_subscriptions/update",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockRefreshPlanCache.mockRejectedValue(new Error("DB error"));

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));
    assertNoWebhookIdInLogs(testWebhookId);
  });

  it("plan refresh emits subscriptions_update_plan_refreshed event", async () => {
    const testWebhookId = "test-wh-plan-event";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app_subscriptions/update",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));
    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("subscriptions_update_plan_refreshed");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("reactivated accounts emits subscriptions_update_accounts_reactivated with shopId, no raw domain", async () => {
    const testWebhookId = "test-wh-reactivate-event";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app_subscriptions/update",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockReactivateGatedAccounts.mockResolvedValue(3);

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));
    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("subscriptions_update_accounts_reactivated");
    expect(outputStr).toContain("shopId");
    expect(outputStr).toContain("reactivatedCount");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("error path emits subscriptions_update_failed with toErrorCode output, no raw error", async () => {
    const testWebhookId = "test-wh-error-event";
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app_subscriptions/update",
      webhookId: testWebhookId,
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    const testError = new Error("Database connection failed");
    testError.name = "ConnectionError";
    mockRefreshPlanCache.mockRejectedValue(testError);

    const request = new Request("https://example.com/webhooks/app/subscriptions_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    await new Promise(resolve => setTimeout(resolve, 10));
    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    expect(outputStr).toContain("subscriptions_update_failed");
    expect(outputStr).toContain("ConnectionError");
    expect(outputStr).not.toContain("Database connection failed");
    expect(outputStr).not.toContain(TEST_SHOP);
  });
});
