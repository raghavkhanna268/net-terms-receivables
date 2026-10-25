/**
 * Route-level compliance webhook tests with REAL logging.
 *
 * These tests verify that shop/redact logs contain shopHash and counts,
 * and that no log output contains the raw shop domain (.myshopify.com).
 *
 * Unlike other compliance tests, this does NOT mock log.server - it uses
 * the real safeLog and shopHash functions to verify PII-safe logging.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import type { ActionFunctionArgs } from "react-router";

const SYNTHETIC_TEST_SECRET = "synthetic-test-secret-s22-logging";
const TEST_SHOP = "test-logging-shop.myshopify.com";

function generateShopifyHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function createSignedRequest(
  body: string,
  topic: string,
  secret: string,
  shopDomain: string = TEST_SHOP
): Request {
  const hmac = generateShopifyHmac(body, secret);
  return new Request("https://example.com/webhooks/compliance", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": `logging-test-${Date.now()}`,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shopDomain,
      "X-Shopify-Hmac-Sha256": hmac,
    },
    body,
  });
}

const mockSessionStorage = {
  deleteAllForShop: vi.fn().mockResolvedValue(0),
};

const mockTx = vi.fn().mockResolvedValue(Object.assign([], { count: 0 }));
const mockSqlResult = Object.assign([], { count: 0 });
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

const mockDeleteWebhookReceiptsForShop = vi.fn().mockResolvedValue(0);
vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: vi.fn().mockResolvedValue(true),
  parseTriggeredAt: vi.fn().mockReturnValue(null),
  deleteWebhookReceiptsForShop: (...args: unknown[]) => mockDeleteWebhookReceiptsForShop(...args),
}));

const mockGraphql = vi.fn().mockResolvedValue({
  json: async () => ({ data: { shop: { email: "owner@shop.com", contactEmail: null } } }),
});
const mockUnauthenticatedAdmin = vi.fn().mockResolvedValue({ admin: { graphql: mockGraphql } });
vi.mock("~/shopify.server", () => ({
  getShopifyApp: () => ({
    unauthenticated: {
      admin: mockUnauthenticatedAdmin,
    },
  }),
}));

import { action } from "../webhooks.compliance";

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
    pattern: "/webhooks/compliance",
  } as unknown as ActionFunctionArgs;
}

describe("webhooks.compliance real logging (no log.server mock)", () => {
  const originalEnv = process.env;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockResolvedValue(mockSqlResult);
    mockTx.mockResolvedValue(Object.assign([], { count: 0 }));
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    return allCalls.map(args => args.map((arg: unknown) => 
      typeof arg === "object" ? JSON.stringify(arg) : String(arg)
    ).join(" "));
  }

  it("shop/redact deleted logs shop_redact_deleted with shopHash and counts, no raw domain", async () => {
    // Setup mocks for successful deletion
    // Transaction operations:
    // 0. SELECT FOR UPDATE with uninstalledAt (reinstall guard #291)
    const uninstalledDate = new Date();
    mockTx.mockResolvedValueOnce([{ id: "shop-logging-test", uninstalledAt: uninstalledDate }]);
    // 1. DELETE s10b_order_refetch_null
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
    // 2. DELETE s6_bulk_operations
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
    // 3. DELETE order_outstanding_missing
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 3 }));
    // 4. DELETE s10b_customer_pii_fallback
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
    // 5. DELETE pgmq.q_s6_sync
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 4 }));
    // 6. DELETE pgmq.q_s6_bulk
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
    // 7. DELETE pgmq.a_s6_sync
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
    // 8. DELETE pgmq.a_s6_bulk
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 }));
    // 9. DELETE s6_dead_letter
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 1 }));
    // 10. DELETE s6_processed_webhooks (reconcile prefix)
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 2 }));
    // 11. DELETE s6_processed_webhooks (receipts join)
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 3 }));
    // 12. DELETE webhook_receipts
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 5 }));
    // 13. DELETE Shop (returns deleted shop)
    mockTx.mockResolvedValueOnce([{ id: "shop-logging-test" }]);

    const payload = { shop_id: 123, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    // Assert shop_redact_deleted event appears
    expect(outputStr).toContain("shop_redact_deleted");

    // Assert shopHash is present (12-char truncated hex SHA-256)
    // shopHash() in log.server.ts returns hashHex.slice(0, 12)
    expect(outputStr).toMatch(/shopHash[":]+[a-f0-9]{12}/i);

    // Assert count fields are logged (safeLog may show <redacted> but fields must exist)
    expect(outputStr).toContain("refetchNullPurged");
    expect(outputStr).toContain("bulkOperationsPurged");
    expect(outputStr).toContain("pgmqSyncQueuePurged");
    expect(outputStr).toContain("deadLetterPurged");
    expect(outputStr).toContain("processedWebhooksPurged");
    expect(outputStr).toContain("webhookReceiptsPurged");

    // Assert NO raw shop domain appears in any output
    expect(outputStr).not.toContain(".myshopify.com");
    expect(outputStr).not.toContain(TEST_SHOP);
  });

  it("shop/redact skipped reinstall logs shop_redact_skipped_reinstalled with shopHash only, no raw domain", async () => {
    // Setup mocks for reinstalled shop (uninstalledAt is NULL)
    // Transaction returns shop with uninstalledAt: null - this triggers the skip path
    mockTx.mockResolvedValueOnce([{ id: "shop-reinstalled-test", uninstalledAt: null }]);

    const payload = { shop_id: 123, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    // Assert shop_redact_skipped_reinstalled event appears
    expect(outputStr).toContain("shop_redact_skipped_reinstalled");

    // Assert shopHash is present (12-char truncated hex SHA-256)
    expect(outputStr).toMatch(/shopHash[":]+[a-f0-9]{12}/i);

    // Assert NO raw shop domain appears in any output
    expect(outputStr).not.toContain(".myshopify.com");
    expect(outputStr).not.toContain(TEST_SHOP);

    // Assert no other fields are logged (only shopHash)
    expect(outputStr).not.toContain("webhookId");
    expect(outputStr).not.toContain("refetchNullPurged");
  });

  it("shop/redact not found logs shop_redact_not_found with shopHash, no raw domain", async () => {
    // Setup mocks for shop not found (all deletes return 0, shop delete returns empty)
    // Transaction operations:
    mockTx.mockResolvedValueOnce([]); // SELECT FOR UPDATE (shop not found)
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // s10b_order_refetch_null
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // s6_bulk_operations
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // order_outstanding_missing
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // s10b_customer_pii_fallback
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // pgmq.q_s6_sync
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // pgmq.q_s6_bulk
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // pgmq.a_s6_sync
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // pgmq.a_s6_bulk
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // s6_dead_letter
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // s6_processed_webhooks (reconcile)
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // s6_processed_webhooks (receipts)
    mockTx.mockResolvedValueOnce(Object.assign([], { count: 0 })); // webhook_receipts
    mockTx.mockResolvedValueOnce([]); // Shop (empty - not found)

    const payload = { shop_id: 999, shop_domain: TEST_SHOP };
    const body = JSON.stringify(payload);
    const request = createSignedRequest(body, "shop/redact", SYNTHETIC_TEST_SECRET);

    const response = await action(createMockActionArgs(request));
    expect(response.status).toBe(200);

    const allOutput = getAllConsoleOutput();
    const outputStr = allOutput.join("\n");

    // Assert shop_redact_not_found event appears
    expect(outputStr).toContain("shop_redact_not_found");

    // Assert shopHash is present (12-char truncated hex SHA-256)
    expect(outputStr).toMatch(/shopHash[":]+[a-f0-9]{12}/i);

    // Assert NO raw shop domain appears in any output
    expect(outputStr).not.toContain(".myshopify.com");
    expect(outputStr).not.toContain(TEST_SHOP);
  });
});
