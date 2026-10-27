/**
 * Webhook handled summary tests.
 *
 * Verifies that every webhook route emits EXACTLY ONE `webhook_handled` summary
 * line on EVERY exit path, that the summary field object has EXACTLY the keys
 * {topic, status, ms} with integer status/ms, and that the topic is the declared
 * (normalized) topic when known or the literal "unexpected" otherwise.
 *
 * Uses the real safeLog (no logger mock) and asserts against real console
 * output. Synthetic data only: example.com URLs, test-*.myshopify.com shops,
 * no real tokens, no gid:// strings.
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

const SECRET = "test-secret-webhook-summary-synthetic";
const TEST_SHOP = "test-summary.myshopify.com";
const TEST_WEBHOOK_ID = "wh-summary-test-1";
const TEST_API_VERSION = "2026-10";
const SYNTHETIC_GID = "synthetic-resource-id-1";

// ---------------------------------------------------------------------------
// Downstream mocks (DB, queue, services). verifyWebhook and log.server stay
// REAL: real HMAC verification and real redaction/output.
// ---------------------------------------------------------------------------

const mockSql = Object.assign(
  vi.fn().mockImplementation(() => Promise.resolve([])),
  {
    json: vi.fn((v: unknown) => v),
    array: vi.fn((arr: unknown[]) => arr),
    unsafe: vi.fn((s: string) => s),
    begin: vi.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const txSql = Object.assign(
        vi.fn().mockImplementation(() => Promise.resolve([])),
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

const mockSendSyncMessage = vi.fn().mockResolvedValue({ msgId: "msg-sync" });
const mockSendBulkMessage = vi.fn().mockResolvedValue({ msgId: "msg-bulk" });

vi.mock("~/lib/pgmq.server", () => ({
  sendSyncMessage: (...args: unknown[]) => mockSendSyncMessage(...args),
  sendBulkMessage: (...args: unknown[]) => mockSendBulkMessage(...args),
  S6_QUEUES: { SYNC: "s6_sync", BULK: "s6_bulk" },
  BULK_OPERATIONS_FINISH_TOPIC: "BULK_OPERATIONS_FINISH",
}));

const mockRecordWebhookReceipt = vi.fn().mockResolvedValue(true);
const mockParseTriggeredAt = vi.fn().mockReturnValue(null);
const mockRecordAndEnqueueSync = vi.fn();

vi.mock("~/lib/webhook-receipts.server", () => ({
  recordWebhookReceipt: (...args: unknown[]) => mockRecordWebhookReceipt(...args),
  parseTriggeredAt: (...args: unknown[]) => mockParseTriggeredAt(...args),
  deleteWebhookReceiptsForShop: vi.fn().mockResolvedValue(0),
  recordAndEnqueueSync: (...args: unknown[]) => mockRecordAndEnqueueSync(...args),
}));

const mockDeleteAllForShop = vi.fn().mockResolvedValue(0);
const mockUpdateScopeForShop = vi.fn().mockResolvedValue(0);
const mockSessionStorage = {
  deleteAllForShop: (...args: unknown[]) => mockDeleteAllForShop(...args),
  updateScopeForShop: (...args: unknown[]) => mockUpdateScopeForShop(...args),
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
  generateCustomerDataExport: vi.fn().mockResolvedValue({ data: {} }),
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
  shopifyGraphQLQueue: vi.fn().mockResolvedValue({ success: false, errorCode: "no_session" }),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validHmac(body: string): string {
  return crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
}

function badHmac(body: string): string {
  return crypto
    .createHmac("sha256", "wrong-secret-definitely-not-real")
    .update(body, "utf8")
    .digest("base64");
}

interface RequestOptions {
  hmac?: string | null;
  omitTopic?: boolean;
  omitApiVersion?: boolean;
  shopDomain?: string;
  webhookId?: string;
  apiVersion?: string;
}

function createRequest(topic: string, body: string, opts: RequestOptions = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.hmac !== null) {
    headers["X-Shopify-Hmac-Sha256"] = opts.hmac ?? validHmac(body);
  }
  if (!opts.omitTopic) {
    headers["X-Shopify-Topic"] = topic;
  }
  headers["X-Shopify-Shop-Domain"] = opts.shopDomain ?? TEST_SHOP;
  headers["X-Shopify-Webhook-Id"] = opts.webhookId ?? TEST_WEBHOOK_ID;
  if (!opts.omitApiVersion) {
    headers["X-Shopify-API-Version"] = opts.apiVersion ?? TEST_API_VERSION;
  }
  return new Request("https://example.com/webhooks/test", { method: "POST", headers, body });
}

let consoleLogSpy: MockInstance;
let consoleWarnSpy: MockInstance;
let consoleErrorSpy: MockInstance;
let consoleInfoSpy: MockInstance;
let consoleDebugSpy: MockInstance;
let pendingWaitUntil: Promise<unknown>[];

const mockShopify = { authenticate: { webhook: vi.fn() } };

function createActionArgs(request: Request): ActionFunctionArgs {
  return {
    request,
    params: {},
    context: {
      shopify: mockShopify,
      sessionStorage: mockSessionStorage,
      cloudflare: {
        env: {},
        ctx: {
          waitUntil: vi.fn((p: Promise<unknown>) => {
            pendingWaitUntil.push(p);
          }),
        },
      },
    },
    url: new URL(request.url),
    pattern: "/webhooks/test",
  } as unknown as ActionFunctionArgs;
}

/**
 * Parse every console line into webhook_handled summary field objects.
 * The summary is emitted at info level (console.log); other events are ignored.
 */
function getSummaries(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const calls = [
    ...consoleLogSpy.mock.calls,
    ...consoleInfoSpy.mock.calls,
    ...consoleWarnSpy.mock.calls,
    ...consoleErrorSpy.mock.calls,
    ...consoleDebugSpy.mock.calls,
  ];
  for (const call of calls) {
    const first = call[0];
    if (typeof first !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(first);
    } catch {
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).event === "webhook_handled"
    ) {
      const { event: _event, ...fields } = parsed as Record<string, unknown>;
      out.push(fields);
    }
  }
  return out;
}

function expectExactlyOneSummary(expectedStatus: number, expectedTopic: string): void {
  const summaries = getSummaries();
  expect(summaries).toHaveLength(1);
  const fields = summaries[0];
  // EXACTLY the keys {topic, status, ms}, nothing more, nothing less.
  expect(Object.keys(fields).sort()).toStrictEqual(["ms", "status", "topic"]);
  // Integer types.
  expect(typeof fields.status).toBe("number");
  expect(Number.isInteger(fields.status)).toBe(true);
  expect(typeof fields.ms).toBe("number");
  expect(Number.isInteger(fields.ms)).toBe(true);
  expect(fields.ms as number).toBeGreaterThanOrEqual(0);
  // Right status and topic.
  expect(fields.status).toBe(expectedStatus);
  expect(fields.topic).toBe(expectedTopic);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  process.env = { ...process.env, SHOPIFY_API_SECRET: SECRET };
  pendingWaitUntil = [];

  // Re-establish default mock behaviors after clearAllMocks.
  mockSql.mockImplementation(() => Promise.resolve([]));
  mockSql.begin.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const txSql = Object.assign(vi.fn().mockImplementation(() => Promise.resolve([])), {
      json: vi.fn((v: unknown) => v),
      array: vi.fn((arr: unknown[]) => arr),
    });
    return cb(txSql);
  });
  mockParseTriggeredAt.mockReturnValue(null);
  mockRecordWebhookReceipt.mockResolvedValue(true);
  mockRecordAndEnqueueSync.mockResolvedValue({ status: "enqueued", msgId: "msg-sync" });
  mockSendSyncMessage.mockResolvedValue({ msgId: "msg-sync" });
  mockSendBulkMessage.mockResolvedValue({ msgId: "msg-bulk" });
  mockDeleteAllForShop.mockResolvedValue(0);
  mockUpdateScopeForShop.mockResolvedValue(0);

  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.allSettled(pendingWaitUntil);
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleInfoSpy.mockRestore();
  consoleDebugSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Sync routes: full exit-path matrix
// ---------------------------------------------------------------------------

interface SyncRoute {
  name: string;
  importAction: () => Promise<{ action: (a: ActionFunctionArgs) => Promise<Response> }>;
  topic: string;
  normalized: string;
  unexpectedTopic: string;
}

const SYNC_ROUTES: SyncRoute[] = [
  {
    name: "webhooks.orders",
    importAction: () => import("../webhooks.orders"),
    topic: "orders/create",
    normalized: "ORDERS_CREATE",
    unexpectedTopic: "orders/not_a_real_topic",
  },
  {
    name: "webhooks.companies",
    importAction: () => import("../webhooks.companies"),
    topic: "companies/create",
    normalized: "COMPANIES_CREATE",
    unexpectedTopic: "companies/not_a_real_topic",
  },
  {
    name: "webhooks.company_locations",
    importAction: () => import("../webhooks.company_locations"),
    topic: "company_locations/create",
    normalized: "COMPANY_LOCATIONS_CREATE",
    unexpectedTopic: "company_locations/not_a_real_topic",
  },
  {
    name: "webhooks.customers",
    importAction: () => import("../webhooks.customers"),
    topic: "customers/create",
    normalized: "CUSTOMERS_CREATE",
    unexpectedTopic: "customers/not_a_real_topic",
  },
  {
    name: "webhooks.draft_orders",
    importAction: () => import("../webhooks.draft_orders"),
    topic: "draft_orders/create",
    normalized: "DRAFT_ORDERS_CREATE",
    unexpectedTopic: "draft_orders/not_a_real_topic",
  },
];

describe.each(SYNC_ROUTES)("$name webhook_handled summary", (route) => {
  it("success (enqueued) -> one summary, status 200", async () => {
    mockRecordAndEnqueueSync.mockResolvedValue({ status: "enqueued", msgId: "m" });
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID });
    const { action } = await route.importAction();

    const res = await action(createActionArgs(createRequest(route.topic, body)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, route.normalized);
  });

  it("duplicate -> one summary, status 200", async () => {
    mockRecordAndEnqueueSync.mockResolvedValue({ status: "duplicate" });
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID });
    const { action } = await route.importAction();

    const res = await action(createActionArgs(createRequest(route.topic, body)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, route.normalized);
  });

  it("unexpected topic -> one summary, status 200, topic 'unexpected'", async () => {
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID });
    const { action } = await route.importAction();

    const res = await action(createActionArgs(createRequest(route.unexpectedTopic, body)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, "unexpected");
    expect(mockRecordAndEnqueueSync).not.toHaveBeenCalled();
  });

  it("missing admin_graphql_api_id -> one summary, status 200", async () => {
    const body = JSON.stringify({});
    const { action } = await route.importAction();

    const res = await action(createActionArgs(createRequest(route.topic, body)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, route.normalized);
    expect(mockRecordAndEnqueueSync).not.toHaveBeenCalled();
  });

  it("bad HMAC -> one summary, status 401", async () => {
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID });
    const { action } = await route.importAction();

    await expect(
      action(createActionArgs(createRequest(route.topic, body, { hmac: badHmac(body) })))
    ).rejects.toMatchObject({ status: 401 });
    expectExactlyOneSummary(401, route.normalized);
    expect(mockRecordAndEnqueueSync).not.toHaveBeenCalled();
  });

  it("bad request (missing required header after HMAC) -> one summary, status 400", async () => {
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID });
    const { action } = await route.importAction();

    await expect(
      action(createActionArgs(createRequest(route.topic, body, { omitApiVersion: true })))
    ).rejects.toMatchObject({ status: 400 });
    expectExactlyOneSummary(400, route.normalized);
    expect(mockRecordAndEnqueueSync).not.toHaveBeenCalled();
  });

  it("enqueue failure (thrown error) -> one summary, status 500, rethrows", async () => {
    mockRecordAndEnqueueSync.mockResolvedValue({ status: "error", code: "DB_ERROR" });
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID });
    const { action } = await route.importAction();

    await expect(
      action(createActionArgs(createRequest(route.topic, body)))
    ).rejects.toThrow("DB_ERROR");
    expectExactlyOneSummary(500, route.normalized);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook-based non-sync routes: success / unexpected / 401
// ---------------------------------------------------------------------------

interface NonSyncRoute {
  name: string;
  importAction: () => Promise<{ action: (a: ActionFunctionArgs) => Promise<Response> }>;
  topic: string;
  normalized: string;
  unexpectedTopic: string;
  successBody: string;
}

const NONSYNC_ROUTES: NonSyncRoute[] = [
  {
    name: "webhooks.compliance",
    importAction: () => import("../webhooks.compliance"),
    topic: "customers/data_request",
    normalized: "CUSTOMERS_DATA_REQUEST",
    unexpectedTopic: "customers/not_a_real_topic",
    successBody: JSON.stringify({
      shop_domain: TEST_SHOP,
      customer: { id: 123 },
      data_request: { id: 456 },
    }),
  },
  {
    name: "webhooks.app.uninstalled",
    importAction: () => import("../webhooks.app.uninstalled"),
    topic: "app/uninstalled",
    normalized: "APP_UNINSTALLED",
    unexpectedTopic: "app/not_a_real_topic",
    successBody: JSON.stringify({}),
  },
  {
    name: "webhooks.shop.update",
    importAction: () => import("../webhooks.shop.update"),
    topic: "shop/update",
    normalized: "SHOP_UPDATE",
    unexpectedTopic: "shop/not_a_real_topic",
    successBody: JSON.stringify({}),
  },
  {
    name: "webhooks.app.scopes_update",
    importAction: () => import("../webhooks.app.scopes_update"),
    topic: "app/scopes_update",
    normalized: "APP_SCOPES_UPDATE",
    unexpectedTopic: "app/not_a_real_scope_topic",
    successBody: JSON.stringify({ current: ["read_orders"] }),
  },
  {
    name: "webhooks.app.subscriptions_update",
    importAction: () => import("../webhooks.app.subscriptions_update"),
    topic: "app/subscriptions_update",
    normalized: "APP_SUBSCRIPTIONS_UPDATE",
    unexpectedTopic: "app/not_a_real_sub_topic",
    successBody: JSON.stringify({}),
  },
];

describe.each(NONSYNC_ROUTES)("$name webhook_handled summary", (route) => {
  it("success -> one summary, status 200", async () => {
    const { action } = await route.importAction();
    const res = await action(createActionArgs(createRequest(route.topic, route.successBody)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, route.normalized);
  });

  it("unexpected topic -> one summary, status 200, topic 'unexpected'", async () => {
    const { action } = await route.importAction();
    const body = JSON.stringify({});
    const res = await action(createActionArgs(createRequest(route.unexpectedTopic, body)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, "unexpected");
  });

  it("bad HMAC -> one summary, status 401", async () => {
    const { action } = await route.importAction();
    const body = route.successBody;
    await expect(
      action(createActionArgs(createRequest(route.topic, body, { hmac: badHmac(body) })))
    ).rejects.toMatchObject({ status: 401 });
    expectExactlyOneSummary(401, route.normalized);
  });
});

// ---------------------------------------------------------------------------
// Compliance: additional bad-request (400) path
// ---------------------------------------------------------------------------

describe("webhooks.compliance extra paths", () => {
  it("payload shop mismatch (thrown 400) -> one summary, status 400", async () => {
    const { action } = await import("../webhooks.compliance");
    // Missing shop_domain in payload makes verifyPayloadShopMatch throw 400.
    const body = JSON.stringify({ customer: { id: 123 }, data_request: { id: 456 } });
    await expect(
      action(createActionArgs(createRequest("customers/data_request", body)))
    ).rejects.toMatchObject({ status: 400 });
    expectExactlyOneSummary(400, "CUSTOMERS_DATA_REQUEST");
  });
});

// ---------------------------------------------------------------------------
// Uninstalled: 500-return path (session delete failure)
// ---------------------------------------------------------------------------

describe("webhooks.app.uninstalled extra paths", () => {
  it("session delete failure -> one summary, status 500", async () => {
    mockDeleteAllForShop.mockRejectedValue(new Error("db down"));
    const { action } = await import("../webhooks.app.uninstalled");
    const body = JSON.stringify({});
    const res = await action(createActionArgs(createRequest("app/uninstalled", body)));
    expect(res.status).toBe(500);
    expectExactlyOneSummary(500, "APP_UNINSTALLED");
  });
});

// ---------------------------------------------------------------------------
// Bulk operations finish: uses shopify.authenticate.webhook (wiring-only)
// ---------------------------------------------------------------------------

describe("webhooks.bulk_operations.finish webhook_handled summary", () => {
  const topic = "bulk_operations/finish";
  const normalized = "BULK_OPERATIONS_FINISH";

  it("missing id (200) -> one summary, status 200", async () => {
    mockShopify.authenticate.webhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: normalized,
      payload: { status: "completed" },
      webhookId: TEST_WEBHOOK_ID,
    });
    const body = JSON.stringify({ status: "completed" });
    const { action } = await import("../webhooks.bulk_operations.finish");
    const res = await action(createActionArgs(createRequest(topic, body)));
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, normalized);
  });

  it("bad HMAC (authenticate rejects 401) -> one summary, status 401", async () => {
    mockShopify.authenticate.webhook.mockRejectedValue(
      new Response(null, { status: 401, statusText: "Unauthorized" })
    );
    const body = JSON.stringify({ admin_graphql_api_id: SYNTHETIC_GID, status: "completed" });
    const { action } = await import("../webhooks.bulk_operations.finish");
    await expect(
      action(createActionArgs(createRequest(topic, body, { hmac: badHmac(body) })))
    ).rejects.toMatchObject({ status: 401 });
    expectExactlyOneSummary(401, normalized);
  });

  it("unexpected topic header -> one summary, status 200, topic 'unexpected'", async () => {
    mockShopify.authenticate.webhook.mockResolvedValue({
      shop: TEST_SHOP,
      topic: normalized,
      payload: { status: "completed" },
      webhookId: TEST_WEBHOOK_ID,
    });
    const body = JSON.stringify({ status: "completed" });
    const { action } = await import("../webhooks.bulk_operations.finish");
    const res = await action(
      createActionArgs(createRequest("bulk_operations/not_a_real_topic", body))
    );
    expect(res.status).toBe(200);
    expectExactlyOneSummary(200, "unexpected");
  });
});
