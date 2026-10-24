import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

// Mock SQL client for S8 compliance redaction functions
// Returns an empty array (for SELECT queries) with count property (for DELETE queries)
const mockSqlResult = Object.assign([], { count: 0 });
const mockSql = Object.assign(
  vi.fn().mockResolvedValue(mockSqlResult),
  { json: vi.fn((v) => v) }
);

// Mock the request context module for compliance webhook tests
vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
}));

/**
 * Tests that non-document routes (webhooks, loaders, actions) receive
 * session storage from the Worker entry's loadContext, NOT from module imports.
 *
 * This verifies:
 * 1. Routes use context.sessionStorage (injected per-request in workers/app.ts)
 * 2. No module-level mutable state is set per request (no setNamespace calls)
 * 3. The uninstall webhook and app loaders call the correct storage methods
 *
 * These tests use mocked context to verify the contract without needing
 * a real database or Shopify credentials.
 */

// Mock verifyWebhook for webhook routes (they now use lightweight verification)
const mockVerifyWebhook = vi.fn();
const mockVerifyPayloadShopMatch = vi.fn((headerShop: string, _payload?: unknown) => headerShop);
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (request: Request, secret: string) => mockVerifyWebhook(request, secret),
  verifyPayloadShopMatch: (headerShop: string, payload: unknown) => mockVerifyPayloadShopMatch(headerShop, payload),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

// Mock webhook receipts for S20 idempotency
const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);
const mockDeleteWebhookReceiptsForShop = vi.fn().mockResolvedValue(0);
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

// Mock session storage that tracks method calls (matches PrismaSessionStorage interface)
function createMockSessionStorage() {
  return {
    storeSession: vi.fn().mockResolvedValue(true),
    loadSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(true),
    deleteSessions: vi.fn().mockResolvedValue(true),
    findSessionsByShop: vi.fn().mockResolvedValue([]),
    deleteAllForShop: vi.fn().mockResolvedValue(0),
    updateScopeForShop: vi.fn().mockResolvedValue(0),
  };
}

// Mock Shopify app that tracks authenticate calls (still needed for non-webhook routes)
function createMockShopify() {
  return {
    authenticate: {
      admin: vi.fn().mockResolvedValue({
        session: { shop: "test.myshopify.com", id: "test-session" },
      }),
      webhook: vi.fn().mockResolvedValue({
        shop: "test.myshopify.com",
        topic: "APP_UNINSTALLED",
        webhookId: "webhook-123",
        payload: {},
      }),
    },
    login: vi.fn().mockResolvedValue({ errors: {} }),
    addDocumentResponseHeaders: vi.fn(),
  };
}

// Create mock LoaderFunctionArgs/ActionFunctionArgs with context
function createMockArgs(
  overrides: {
    sessionStorage?: ReturnType<typeof createMockSessionStorage>;
    shopify?: ReturnType<typeof createMockShopify>;
  } = {}
) {
  const sessionStorage = overrides.sessionStorage ?? createMockSessionStorage();
  const shopify = overrides.shopify ?? createMockShopify();

  return {
    request: new Request("https://example.com/test"),
    params: {},
    context: {
      cloudflare: { env: {}, ctx: { waitUntil: vi.fn() } },
      sessionStorage,
      shopify,
    },
  } as unknown as LoaderFunctionArgs & ActionFunctionArgs;
}

describe("Route context storage verification", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("webhooks.app.uninstalled route", () => {
    it("uses sessionStorage.deleteAllForShop (bypasses 25-session limit)", async () => {
      const sessionStorage = createMockSessionStorage();
      sessionStorage.deleteAllForShop.mockResolvedValue(5);

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-uninstall.myshopify.com",
        topic: "app/uninstalled",
        webhookId: "webhook-456",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const args = createMockArgs({ sessionStorage });

      const { action } = await import(
        "../../routes/webhooks.app.uninstalled"
      );
      await action(args);

      expect(sessionStorage.deleteAllForShop).toHaveBeenCalledWith(
        "test-uninstall.myshopify.com"
      );
    });

    it("uses context.sessionStorage, not a module-level import", async () => {
      const storage1 = createMockSessionStorage();
      const storage2 = createMockSessionStorage();
      storage1.deleteAllForShop.mockResolvedValue(3);
      storage2.deleteAllForShop.mockResolvedValue(7);

      mockVerifyWebhook
        .mockResolvedValueOnce({
          shop: "shop1.myshopify.com",
          topic: "app/uninstalled",
          webhookId: "w1",
          payload: {},
          apiVersion: "2026-10",
          rawBody: new ArrayBuffer(0),
        })
        .mockResolvedValueOnce({
          shop: "shop2.myshopify.com",
          topic: "app/uninstalled",
          webhookId: "w2",
          payload: {},
          apiVersion: "2026-10",
          rawBody: new ArrayBuffer(0),
        });

      const args1 = createMockArgs({ sessionStorage: storage1 });
      const args2 = createMockArgs({ sessionStorage: storage2 });

      const { action } = await import(
        "../../routes/webhooks.app.uninstalled"
      );

      await Promise.all([action(args1), action(args2)]);

      expect(storage1.deleteAllForShop).toHaveBeenCalledWith("shop1.myshopify.com");
      expect(storage2.deleteAllForShop).toHaveBeenCalledWith("shop2.myshopify.com");
    });
  });

  describe("webhooks.app.scopes_update route", () => {
    it("uses sessionStorage.updateScopeForShop to update all sessions", async () => {
      const sessionStorage = createMockSessionStorage();
      sessionStorage.updateScopeForShop.mockResolvedValue(2);

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-scopes.myshopify.com",
        topic: "app/scopes_update",
        webhookId: "webhook-789",
        payload: { current: ["read_orders", "read_customers", "write_orders"] },
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const args = createMockArgs({ sessionStorage });

      const { action } = await import(
        "../../routes/webhooks.app.scopes_update"
      );
      await action(args);

      expect(sessionStorage.updateScopeForShop).toHaveBeenCalledWith(
        "test-scopes.myshopify.com",
        "read_orders,read_customers,write_orders"
      );
    });

    it("does NOT update scopes when topic is app/uninstalled", async () => {
      const sessionStorage = createMockSessionStorage();

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-scopes.myshopify.com",
        topic: "app/uninstalled",
        webhookId: "webhook-wrong",
        payload: { current: ["read_orders"] },
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const args = createMockArgs({ sessionStorage });

      const { action } = await import(
        "../../routes/webhooks.app.scopes_update"
      );
      await action(args);

      expect(sessionStorage.updateScopeForShop).not.toHaveBeenCalled();
    });
  });

  describe("webhooks.compliance route", () => {
    it("uses sessionStorage.deleteAllForShop for shop/redact (idempotent)", async () => {
      const sessionStorage = createMockSessionStorage();
      sessionStorage.deleteAllForShop.mockResolvedValue(2);

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-compliance.myshopify.com",
        topic: "shop/redact",
        webhookId: "compliance-webhook-123",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const args = createMockArgs({ sessionStorage });

      const { action } = await import("../../routes/webhooks.compliance");
      await action(args);

      expect(sessionStorage.deleteAllForShop).toHaveBeenCalledWith(
        "test-compliance.myshopify.com"
      );
    });

    it("returns 200 even when no sessions exist (idempotent)", async () => {
      const sessionStorage = createMockSessionStorage();
      sessionStorage.deleteAllForShop.mockResolvedValue(0);

      mockVerifyWebhook.mockResolvedValue({
        shop: "test-empty-shop.myshopify.com",
        topic: "shop/redact",
        webhookId: "compliance-webhook-empty",
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const args = createMockArgs({ sessionStorage });

      const { action } = await import("../../routes/webhooks.compliance");
      const response = await action(args);

      expect(response.status).toBe(200);
    });
  });

  describe("app.tsx loader (non-webhook route)", () => {
    it("receives shopify from context and calls authenticate.admin", async () => {
      const shopify = createMockShopify();
      const args = createMockArgs({ shopify });

      const { loader } = await import("../../routes/app");
      await loader(args as LoaderFunctionArgs);

      // Verify authenticate.admin was called
      expect(shopify.authenticate.admin).toHaveBeenCalledWith(args.request);
    });
  });

  describe("Module-level state verification", () => {
    it("lib/scopes.ts exports parseScopes without side effects", async () => {
      // This module should be importable without env vars
      const scopesModule = await import("../../lib/scopes");

      expect(typeof scopesModule.parseScopes).toBe("function");
      expect(scopesModule.parseScopes("")).toEqual([]);
      expect(scopesModule.parseScopes("a,b")).toEqual(["a", "b"]);
    });

    it("lib/db.server.ts exports createPrismaClient factory", async () => {
      // This module should be importable without env vars
      const dbModule = await import("../../lib/db.server");

      expect(typeof dbModule.createPrismaClient).toBe("function");
    });

    it("routes do not call setNamespace (verified by file content)", async () => {
      // Verify that no route files contain setNamespace calls
      // This ensures routes use context.sessionStorage instead of module-level state
      const routeFiles = [
        "app/routes/app.tsx",
        "app/routes/app._index.tsx",
        "app/routes/auth.$.tsx",
        "app/routes/auth.login/route.tsx",
        "app/routes/webhooks.app.uninstalled.tsx",
        "app/routes/webhooks.app.scopes_update.tsx",
        "app/routes/webhooks.compliance.tsx",
      ];

      for (const routeFile of routeFiles) {
        const filePath = join(process.cwd(), routeFile);
        const content = readFileSync(filePath, "utf-8");
        expect(content).not.toContain("setNamespace");
        expect(content).not.toContain(".setNamespace(");
      }
    });
  });
});
