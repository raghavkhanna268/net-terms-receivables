/**
 * Route-level scopes_update webhook tests for logging assertions.
 *
 * Tests verify that webhookId is never logged in any path.
 * Uses real console output (no log.server mock per logging guard).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionFunctionArgs } from "react-router";

const TEST_SHOP = "test-scopes.myshopify.com";

const mockVerifyWebhook = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const mockUpdateScopeForShop = vi.fn();
const mockSessionStorage = {
  updateScopeForShop: (...args: unknown[]) => mockUpdateScopeForShop(...args),
};

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
    pattern: "/webhooks/app/scopes_update",
  } as unknown as ActionFunctionArgs;
}

import { action } from "../webhooks.app.scopes_update";

describe("webhooks.app.scopes_update logging", () => {
  const originalEnv = process.env;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateScopeForShop.mockResolvedValue(1);
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

  it("received topic path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app/scopes_update",
      webhookId: "test-wh-123",
      payload: { current: ["read_products", "write_products"] },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/app/scopes_update", {
      method: "POST",
      body: JSON.stringify({ current: ["read_products"] }),
      headers: { "Content-Type": "application/json" },
    });

    await action(createMockActionArgs(request));
    assertNoWebhookIdInLogs();
  });

  it("unexpected topic path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "other/topic",
      webhookId: "test-wh-456",
      payload: {},
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });

    const request = new Request("https://example.com/webhooks/app/scopes_update", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    await action(createMockActionArgs(request));
    assertNoWebhookIdInLogs();
  });

  it("success update path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app/scopes_update",
      webhookId: "test-wh-789",
      payload: { current: ["read_products", "write_orders"] },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockUpdateScopeForShop.mockResolvedValue(2);

    const request = new Request("https://example.com/webhooks/app/scopes_update", {
      method: "POST",
      body: JSON.stringify({ current: ["read_products", "write_orders"] }),
      headers: { "Content-Type": "application/json" },
    });

    await action(createMockActionArgs(request));
    assertNoWebhookIdInLogs();
  });

  it("error path logs no webhookId", async () => {
    mockVerifyWebhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: "app/scopes_update",
      webhookId: "test-wh-error",
      payload: { current: ["read_products"] },
      apiVersion: "2026-10",
      rawBody: new ArrayBuffer(0),
    });
    mockUpdateScopeForShop.mockRejectedValue(new Error("DB error"));

    const request = new Request("https://example.com/webhooks/app/scopes_update", {
      method: "POST",
      body: JSON.stringify({ current: ["read_products"] }),
      headers: { "Content-Type": "application/json" },
    });

    await action(createMockActionArgs(request));
    assertNoWebhookIdInLogs();
  });
});
