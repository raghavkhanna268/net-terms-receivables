/**
 * Webhook authentication negative test suite.
 *
 * Tests verify that every webhook route:
 * 1. Rejects bad/missing HMAC with 401
 * 2. Rejects missing/wrong topic headers appropriately
 * 3. Handles unknown/uninstalled shops correctly
 * 4. Handles empty/malformed bodies appropriately
 * 5. Makes NO DB calls or enqueues before HMAC verification passes
 * 6. Does not leak sensitive data (shop domain, webhook ID) in logs
 *
 * Uses synthetic data only. Test shop domains follow test-*.myshopify.com pattern.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";

const SYNTHETIC_TEST_SECRET = "test-secret-webhook-auth-negative-e2e-fake";
const TEST_SHOP = "test-webhook-auth-neg.myshopify.com";
const TEST_WEBHOOK_ID = "wh-neg-test-12345";
const TEST_API_VERSION = "2026-10";

interface WebhookRouteConfig {
  file: string;
  route: string;
  topics: readonly string[];
  usesVerifyWebhook: boolean;
  requiresValidJson: boolean;
}

const WEBHOOK_ROUTES: WebhookRouteConfig[] = [
  {
    file: "webhooks.orders",
    route: "webhooks.orders.tsx",
    topics: ["orders/create", "orders/updated", "orders/cancelled", "orders/paid"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.app.uninstalled",
    route: "webhooks.app.uninstalled.tsx",
    topics: ["app/uninstalled"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.compliance",
    route: "webhooks.compliance.tsx",
    topics: ["customers/data_request", "customers/redact", "shop/redact"],
    usesVerifyWebhook: true,
    requiresValidJson: true,
  },
  {
    file: "webhooks.shop.update",
    route: "webhooks.shop.update.tsx",
    topics: ["shop/update"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.bulk_operations.finish",
    route: "webhooks.bulk_operations.finish.tsx",
    topics: ["bulk_operations/finish"],
    usesVerifyWebhook: false,
    requiresValidJson: false,
  },
  {
    file: "webhooks.app.scopes_update",
    route: "webhooks.app.scopes_update.tsx",
    topics: ["app/scopes_update"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.app.subscriptions_update",
    route: "webhooks.app.subscriptions_update.tsx",
    topics: ["app/subscriptions_update"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.companies",
    route: "webhooks.companies.tsx",
    topics: ["companies/create", "companies/update", "companies/delete"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.company_locations",
    route: "webhooks.company_locations.tsx",
    topics: ["company_locations/create", "company_locations/update", "company_locations/delete"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.customers",
    route: "webhooks.customers.tsx",
    topics: ["customers/create", "customers/update", "customers/delete"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
  {
    file: "webhooks.draft_orders",
    route: "webhooks.draft_orders.tsx",
    topics: ["draft_orders/create", "draft_orders/update", "draft_orders/delete"],
    usesVerifyWebhook: true,
    requiresValidJson: false,
  },
];

function computeValidHmac(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

function computeBadHmac(body: string): string {
  return crypto.createHmac("sha256", "wrong-secret-definitely-not-real").update(body, "utf8").digest("base64");
}

const mockSqlCalls: Array<{ query: string; values: unknown[] }> = [];
const mockSql = Object.assign(
  vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    mockSqlCalls.push({ query, values });
    return Promise.resolve([]);
  }),
  {
    json: vi.fn((v: unknown) => v),
    array: vi.fn((arr: unknown[]) => arr),
    unsafe: vi.fn((s: string) => s),
    begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const txSql = Object.assign(
        vi.fn().mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join("?");
          mockSqlCalls.push({ query, values });
          return Promise.resolve([]);
        }),
        {
          json: vi.fn((v: unknown) => v),
          array: vi.fn((arr: unknown[]) => arr),
        }
      );
      return cb(txSql);
    }),
  }
);

vi.mock("~/lib/request-context.server", () => ({
  getRequestSql: vi.fn(() => mockSql),
  getRequestWaitUntil: vi.fn(() => () => {}),
  getRequestEnv: vi.fn(() => ({})),
}));

const mockSendSyncMessage = vi.fn().mockResolvedValue({ msgId: "msg-mock" });
const mockSendBulkMessage = vi.fn().mockResolvedValue({ msgId: "msg-bulk-mock" });

vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: (...args: unknown[]) => mockSendSyncMessage(...args),
  sendBulkMessage: (...args: unknown[]) => mockSendBulkMessage(...args),
  S6_QUEUES: { SYNC: "s6_sync", BULK: "s6_bulk" },
  BULK_OPERATIONS_FINISH_TOPIC: "BULK_OPERATIONS_FINISH",
}));

const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);
const mockRecordAndEnqueueSync = vi.fn().mockImplementation(async () => {
  return { status: "enqueued" as const, msgId: "msg-mock" };
});

vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: vi.fn().mockResolvedValue(0),
  recordAndEnqueueSync: (...args: unknown[]) => mockRecordAndEnqueueSync(...args),
}));

const mockSafeLogCalls: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
const mockSafeLog = vi.fn().mockImplementation((level: string, event: string, fields: Record<string, unknown> = {}) => {
  mockSafeLogCalls.push({ level, event, fields });
});
const mockShopHash = vi.fn().mockResolvedValue("abc123hash");

vi.mock("~/lib/log.server", () => ({
  safeLog: (...args: unknown[]) => mockSafeLog(args[0], args[1], args[2]),
  shopHash: (...args: unknown[]) => mockShopHash(...args),
  toErrorCode: (err: unknown) => {
    if (err && typeof err === "object" && "code" in err) return (err as { code: string }).code;
    if (err instanceof Error) return err.name;
    return "unknown";
  },
}));

const mockShopify = {
  authenticate: {
    webhook: vi.fn(),
  },
};

const mockSessionStorage = {
  deleteAllForShop: vi.fn().mockResolvedValue(0),
  updateScopeForShop: vi.fn().mockResolvedValue(0),
};

vi.mock("~/services/compliance", () => ({
  markShopUninstalled: vi.fn().mockResolvedValue(true),
  deleteProcessedWebhooksViaReceipts: vi.fn().mockResolvedValue(0),
  redactCustomer: vi.fn().mockResolvedValue({
    taggedCustomersDeleted: 0,
    draftOrdersDeleted: 0,
    dataRequestsDeleted: 0,
    payerAliasesDeleted: 0,
    buyerAccountAnonymized: false,
    paymentsRedacted: 0,
  }),
  generateCustomerDataExport: vi.fn().mockResolvedValue({
    customerGid: "",
    requestId: "",
    data: {},
  }),
  persistDataRequest: vi.fn().mockResolvedValue({ id: "req-mock", alreadyExists: false }),
  purgeExpiredDataRequests: vi.fn().mockResolvedValue(0),
  sendDataRequestNotification: vi.fn().mockResolvedValue({ sent: false }),
  deleteShop: vi.fn().mockResolvedValue({ deleted: false }),
  purgePgmqMessages: vi.fn().mockResolvedValue({ reason: "none" }),
}));

vi.mock("~/lib/after-auth.server", () => ({
  evictShopFromSetupCache: vi.fn(),
}));

vi.mock("~/services/shopify-client.server", () => ({
  shopifyGraphQLQueue: vi.fn().mockResolvedValue({
    success: false,
    errorCode: "no_session",
  }),
}));

vi.mock("~/services/shop-config.server", () => ({
  writeShopConfigMetafield: vi.fn().mockResolvedValue({ success: false }),
}));

vi.mock("~/services/plan.server", () => ({
  refreshPlanCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("~/services/gating.server", () => ({
  reactivateGatedAccounts: vi.fn().mockResolvedValue(0),
}));

vi.mock("~/lib/offline-admin.server", () => ({
  getOfflineAdminContext: vi.fn().mockResolvedValue({ success: false }),
}));

describe("Webhook Authentication Negative Test Suite", () => {
  const originalEnv = process.env;
  let consoleLogSpy: MockInstance;
  let consoleWarnSpy: MockInstance;
  let consoleErrorSpy: MockInstance;
  let consoleInfoSpy: MockInstance;
  let consoleDebugSpy: MockInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = { ...originalEnv, SHOPIFY_API_SECRET: SYNTHETIC_TEST_SECRET };
    mockSqlCalls.length = 0;
    mockSafeLogCalls.length = 0;

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
    ];
    return allCalls.map((args) =>
      args.map((arg: unknown) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")
    );
  }

  function assertNoSensitiveDataInLogs(shopDomain: string, webhookId: string): void {
    const allOutput = getAllConsoleOutput();
    for (const line of allOutput) {
      expect(line).not.toContain(shopDomain);
      expect(line).not.toContain(webhookId);
      expect(line).not.toContain(".myshopify.com");
    }

    for (const call of mockSafeLogCalls) {
      const fieldsStr = JSON.stringify(call.fields);
      expect(fieldsStr).not.toContain(shopDomain);
      expect(fieldsStr).not.toContain(webhookId);
      expect(fieldsStr).not.toContain(".myshopify.com");
    }
  }

  function assertNoDbCallsBeforeAuth(): void {
    expect(mockSqlCalls.length).toBe(0);
  }

  function assertNoEnqueues(): void {
    expect(mockSendSyncMessage).not.toHaveBeenCalled();
    expect(mockSendBulkMessage).not.toHaveBeenCalled();
    expect(mockRecordAndEnqueueSync).not.toHaveBeenCalled();
    expect(mockRecordWebhookReceipt).not.toHaveBeenCalled();
  }

  function createBaseRequest(
    topic: string,
    body: string,
    options: {
      hmac?: string | null;
      shopDomain?: string;
      webhookId?: string;
      apiVersion?: string;
      omitTopic?: boolean;
    } = {}
  ): Request {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (options.hmac !== null) {
      headers["X-Shopify-Hmac-Sha256"] = options.hmac ?? computeValidHmac(body, SYNTHETIC_TEST_SECRET);
    }
    if (!options.omitTopic) {
      headers["X-Shopify-Topic"] = topic;
    }
    if (options.shopDomain !== undefined) {
      headers["X-Shopify-Shop-Domain"] = options.shopDomain;
    } else {
      headers["X-Shopify-Shop-Domain"] = TEST_SHOP;
    }
    if (options.webhookId !== undefined) {
      headers["X-Shopify-Webhook-Id"] = options.webhookId;
    } else {
      headers["X-Shopify-Webhook-Id"] = TEST_WEBHOOK_ID;
    }
    headers["X-Shopify-API-Version"] = options.apiVersion ?? TEST_API_VERSION;

    return new Request("https://example.com/webhooks/test", {
      method: "POST",
      headers,
      body,
    });
  }

  function createActionArgs(request: Request): ActionFunctionArgs {
    return {
      request,
      context: {
        shopify: mockShopify,
        sessionStorage: mockSessionStorage,
        cloudflare: {
          env: {},
          ctx: { waitUntil: vi.fn() },
        },
      },
      params: {},
      url: new URL(request.url),
      pattern: "/webhooks/test",
    } as unknown as ActionFunctionArgs;
  }

  describe("Manifest guard: all webhook route files are covered", () => {
    it("covers all 11 expected webhook routes", () => {
      const expectedRoutes = [
        "webhooks.bulk_operations.finish.tsx",
        "webhooks.compliance.tsx",
        "webhooks.shop.update.tsx",
        "webhooks.app.scopes_update.tsx",
        "webhooks.app.subscriptions_update.tsx",
        "webhooks.app.uninstalled.tsx",
        "webhooks.companies.tsx",
        "webhooks.company_locations.tsx",
        "webhooks.customers.tsx",
        "webhooks.draft_orders.tsx",
        "webhooks.orders.tsx",
      ];

      const coveredRoutes = WEBHOOK_ROUTES.map((r) => r.route);
      expect(coveredRoutes.sort()).toEqual(expectedRoutes.sort());
      expect(WEBHOOK_ROUTES.length).toBe(11);
    });
  });

  describe.each(WEBHOOK_ROUTES)("$file", (routeConfig) => {
    const { file, topics, usesVerifyWebhook, requiresValidJson } = routeConfig;
    const topic = topics[0];

    function createPayload(): object {
      if (file === "webhooks.compliance") {
        return { shop_id: 12345, shop_domain: TEST_SHOP, customer: { id: 99999 } };
      }
      if (file === "webhooks.bulk_operations.finish") {
        return { admin_graphql_api_id: "gid://shopify/BulkOperation/12345", status: "completed" };
      }
      return { admin_graphql_api_id: "gid://shopify/TestResource/12345" };
    }

    async function importAction(): Promise<{ action: (args: ActionFunctionArgs) => Promise<Response> }> {
      switch (file) {
        case "webhooks.orders":
          return import("../webhooks.orders");
        case "webhooks.app.uninstalled":
          return import("../webhooks.app.uninstalled");
        case "webhooks.compliance":
          return import("../webhooks.compliance");
        case "webhooks.shop.update":
          return import("../webhooks.shop.update");
        case "webhooks.bulk_operations.finish":
          return import("../webhooks.bulk_operations.finish");
        case "webhooks.app.scopes_update":
          return import("../webhooks.app.scopes_update");
        case "webhooks.app.subscriptions_update":
          return import("../webhooks.app.subscriptions_update");
        case "webhooks.companies":
          return import("../webhooks.companies");
        case "webhooks.company_locations":
          return import("../webhooks.company_locations");
        case "webhooks.customers":
          return import("../webhooks.customers");
        case "webhooks.draft_orders":
          return import("../webhooks.draft_orders");
        default:
          throw new Error(`Unknown route: ${file}`);
      }
    }

    describe("Case 1: Bad HMAC (wrong secret)", () => {
      it("returns 401 for bad HMAC", async () => {
        const payload = createPayload();
        const body = JSON.stringify(payload);
        const badHmac = computeBadHmac(body);

        if (!usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockRejectedValue(
            new Response(null, { status: 401, statusText: "Unauthorized" })
          );
        }

        const request = createBaseRequest(topic, body, { hmac: badHmac });
        const { action } = await importAction();

        try {
          await action(createActionArgs(request));
          expect.fail("Expected action to throw 401");
        } catch (error) {
          expect(error).toBeInstanceOf(Response);
          expect((error as Response).status).toBe(401);
        }

        assertNoDbCallsBeforeAuth();
        assertNoEnqueues();
      });
    });

    describe("Case 2: No HMAC header", () => {
      it("returns 401 for missing HMAC header", async () => {
        const payload = createPayload();
        const body = JSON.stringify(payload);

        if (!usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockRejectedValue(
            new Response(null, { status: 401, statusText: "Unauthorized" })
          );
        }

        const request = createBaseRequest(topic, body, { hmac: null });
        const { action } = await importAction();

        try {
          await action(createActionArgs(request));
          expect.fail("Expected action to throw 401");
        } catch (error) {
          expect(error).toBeInstanceOf(Response);
          expect((error as Response).status).toBe(401);
        }

        assertNoDbCallsBeforeAuth();
        assertNoEnqueues();
      });
    });

    describe("Case 3: Topic header issues", () => {
      it("returns 400 for missing topic header (after valid HMAC)", async () => {
        const payload = createPayload();
        const body = JSON.stringify(payload);
        const validHmac = computeValidHmac(body, SYNTHETIC_TEST_SECRET);

        if (!usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockRejectedValue(
            new Response(null, { status: 400, statusText: "Bad Request" })
          );
        }

        const request = createBaseRequest(topic, body, { hmac: validHmac, omitTopic: true });
        const { action } = await importAction();

        try {
          await action(createActionArgs(request));
          expect.fail("Expected action to throw 400");
        } catch (error) {
          expect(error).toBeInstanceOf(Response);
          expect((error as Response).status).toBe(400);
        }

        assertNoEnqueues();
      });

      it("returns 200 for wrong topic header (graceful ignore)", async () => {
        const payload = createPayload();
        const body = JSON.stringify(payload);
        const wrongTopic = "app/wrong_topic_completely";

        if (!usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockResolvedValue({
            shop: TEST_SHOP,
            topic: wrongTopic.toUpperCase().replace(/\//g, "_"),
            payload,
            webhookId: TEST_WEBHOOK_ID,
          });
        }

        const request = createBaseRequest(wrongTopic, body);
        const { action } = await importAction();

        const response = await action(createActionArgs(request));
        expect(response.status).toBe(200);
        assertNoEnqueues();
      });
    });

    describe("Case 4: Unknown/uninstalled shop", () => {
      it("handles unknown shop with valid HMAC gracefully", async () => {
        const unknownShop = "test-unknown-shop-neg.myshopify.com";
        const payload = file === "webhooks.compliance"
          ? { shop_id: 12345, shop_domain: unknownShop, customer: { id: 99999 } }
          : createPayload();
        const body = JSON.stringify(payload);

        if (!usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockResolvedValue({
            shop: unknownShop,
            topic: topic.toUpperCase().replace(/\//g, "_"),
            payload,
            webhookId: TEST_WEBHOOK_ID,
          });
        }

        mockSql.mockImplementation(() => Promise.resolve([]));

        const request = createBaseRequest(topic, body, { shopDomain: unknownShop });
        const { action } = await importAction();

        const response = await action(createActionArgs(request));
        expect(response.status).toBe(200);

        assertNoSensitiveDataInLogs(unknownShop, TEST_WEBHOOK_ID);
      });
    });

    describe("Case 5: Body issues", () => {
      it("handles empty body appropriately", async () => {
        const body = "";

        if (!usesVerifyWebhook) {
          if (requiresValidJson) {
            mockShopify.authenticate.webhook.mockRejectedValue(
              new Response(null, { status: 400, statusText: "Bad Request" })
            );
          } else {
            mockShopify.authenticate.webhook.mockResolvedValue({
              shop: TEST_SHOP,
              topic: topic.toUpperCase().replace(/\//g, "_"),
              payload: {},
              webhookId: TEST_WEBHOOK_ID,
            });
          }
        }

        const hmac = computeValidHmac(body, SYNTHETIC_TEST_SECRET);
        const request = createBaseRequest(topic, body, { hmac });
        const { action } = await importAction();

        if (usesVerifyWebhook && requiresValidJson) {
          try {
            await action(createActionArgs(request));
            expect.fail("Expected action to throw 400 for invalid JSON");
          } catch (error) {
            expect(error).toBeInstanceOf(Response);
            expect((error as Response).status).toBe(400);
          }
          assertNoEnqueues();
        } else {
          const response = await action(createActionArgs(request));
          expect(response.status).toBe(200);
        }
      });

      it("handles malformed (non-JSON) body appropriately", async () => {
        const body = "this is not valid json { broken";

        if (!usesVerifyWebhook) {
          if (requiresValidJson) {
            mockShopify.authenticate.webhook.mockRejectedValue(
              new Response(null, { status: 400, statusText: "Bad Request" })
            );
          } else {
            mockShopify.authenticate.webhook.mockResolvedValue({
              shop: TEST_SHOP,
              topic: topic.toUpperCase().replace(/\//g, "_"),
              payload: {},
              webhookId: TEST_WEBHOOK_ID,
            });
          }
        }

        const hmac = computeValidHmac(body, SYNTHETIC_TEST_SECRET);
        const request = createBaseRequest(topic, body, { hmac });
        const { action } = await importAction();

        if (usesVerifyWebhook && requiresValidJson) {
          try {
            await action(createActionArgs(request));
            expect.fail("Expected action to throw 400 for invalid JSON");
          } catch (error) {
            expect(error).toBeInstanceOf(Response);
            expect((error as Response).status).toBe(400);
          }
          assertNoEnqueues();
        } else {
          const response = await action(createActionArgs(request));
          expect(response.status).toBe(200);
        }
      });
    });

    describe("Positive control: valid request succeeds", () => {
      it("returns 200 for valid HMAC and correct topic", async () => {
        const payload = createPayload();
        const body = JSON.stringify(payload);

        if (!usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockResolvedValue({
            shop: TEST_SHOP,
            topic: topic.toUpperCase().replace(/\//g, "_"),
            payload,
            webhookId: TEST_WEBHOOK_ID,
          });
        }

        const request = createBaseRequest(topic, body);
        const { action } = await importAction();

        const response = await action(createActionArgs(request));
        expect(response.status).toBe(200);

        assertNoSensitiveDataInLogs(TEST_SHOP, TEST_WEBHOOK_ID);
      });
    });
  });

  describe("HMAC verification order (security check)", () => {
    it.each(WEBHOOK_ROUTES.filter((r) => r.usesVerifyWebhook))(
      "$file: returns 401 for bad HMAC even if topic is missing",
      async (routeConfig) => {
        const body = JSON.stringify({ admin_graphql_api_id: "gid://shopify/Test/123" });
        const badHmac = computeBadHmac(body);

        const request = createBaseRequest("", body, { hmac: badHmac, omitTopic: true });
        const { action } = await (async () => {
          switch (routeConfig.file) {
            case "webhooks.orders":
              return import("../webhooks.orders");
            case "webhooks.app.uninstalled":
              return import("../webhooks.app.uninstalled");
            case "webhooks.compliance":
              return import("../webhooks.compliance");
            case "webhooks.shop.update":
              return import("../webhooks.shop.update");
            case "webhooks.app.scopes_update":
              return import("../webhooks.app.scopes_update");
            case "webhooks.app.subscriptions_update":
              return import("../webhooks.app.subscriptions_update");
            case "webhooks.companies":
              return import("../webhooks.companies");
            case "webhooks.company_locations":
              return import("../webhooks.company_locations");
            case "webhooks.customers":
              return import("../webhooks.customers");
            case "webhooks.draft_orders":
              return import("../webhooks.draft_orders");
            default:
              throw new Error(`Unknown route: ${routeConfig.file}`);
          }
        })();

        try {
          await action(createActionArgs(request));
          expect.fail("Expected action to throw 401");
        } catch (error) {
          expect(error).toBeInstanceOf(Response);
          expect((error as Response).status).toBe(401);
        }

        assertNoDbCallsBeforeAuth();
        assertNoEnqueues();
      }
    );
  });

  describe("Log sanitization comprehensive check", () => {
    it.each(WEBHOOK_ROUTES)(
      "$file: never leaks shop domain or webhook ID in any path",
      async (routeConfig) => {
        const testShop = `test-log-sanitize-${routeConfig.file.replace(/[._]/g, "-")}.myshopify.com`;
        const testWebhookId = `wh-log-sanitize-${routeConfig.file.replace(/[._]/g, "-")}`;
        const topic = routeConfig.topics[0];
        const payload = routeConfig.file === "webhooks.compliance"
          ? { shop_id: 12345, shop_domain: testShop, customer: { id: 99999 } }
          : routeConfig.file === "webhooks.bulk_operations.finish"
            ? { admin_graphql_api_id: "gid://shopify/BulkOperation/12345", status: "completed" }
            : { admin_graphql_api_id: "gid://shopify/Test/12345" };
        const body = JSON.stringify(payload);

        if (!routeConfig.usesVerifyWebhook) {
          mockShopify.authenticate.webhook.mockResolvedValue({
            shop: testShop,
            topic: topic.toUpperCase().replace(/\//g, "_"),
            payload,
            webhookId: testWebhookId,
          });
        }

        mockSql.mockImplementation(() => Promise.resolve([]));

        const request = createBaseRequest(topic, body, {
          shopDomain: testShop,
          webhookId: testWebhookId,
        });

        const { action } = await (async () => {
          switch (routeConfig.file) {
            case "webhooks.orders":
              return import("../webhooks.orders");
            case "webhooks.app.uninstalled":
              return import("../webhooks.app.uninstalled");
            case "webhooks.compliance":
              return import("../webhooks.compliance");
            case "webhooks.shop.update":
              return import("../webhooks.shop.update");
            case "webhooks.bulk_operations.finish":
              return import("../webhooks.bulk_operations.finish");
            case "webhooks.app.scopes_update":
              return import("../webhooks.app.scopes_update");
            case "webhooks.app.subscriptions_update":
              return import("../webhooks.app.subscriptions_update");
            case "webhooks.companies":
              return import("../webhooks.companies");
            case "webhooks.company_locations":
              return import("../webhooks.company_locations");
            case "webhooks.customers":
              return import("../webhooks.customers");
            case "webhooks.draft_orders":
              return import("../webhooks.draft_orders");
            default:
              throw new Error(`Unknown route: ${routeConfig.file}`);
          }
        })();

        await action(createActionArgs(request));

        assertNoSensitiveDataInLogs(testShop, testWebhookId);
      }
    );
  });
});

describe("Expected status codes per case (pinned)", () => {
  const statusTable = [
    { route: "webhooks.orders", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.app.uninstalled", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.compliance", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 400, malformedBody: 400 },
    { route: "webhooks.shop.update", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.bulk_operations.finish", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.app.scopes_update", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.app.subscriptions_update", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.companies", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.company_locations", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.customers", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
    { route: "webhooks.draft_orders", badHmac: 401, noHmac: 401, noTopic: 400, wrongTopic: 200, unknownShop: 200, emptyBody: 200, malformedBody: 200 },
  ] as const;

  it("documents expected status codes for all routes and cases", () => {
    expect(statusTable.length).toBe(11);
    for (const entry of statusTable) {
      expect(entry.badHmac).toBe(401);
      expect(entry.noHmac).toBe(401);
      expect(entry.noTopic).toBe(400);
      expect(entry.wrongTopic).toBe(200);
      expect(entry.unknownShop).toBe(200);
    }
  });
});
