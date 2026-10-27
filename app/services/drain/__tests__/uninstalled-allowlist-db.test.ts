/**
 * DB-backed integration tests for ARCHIVE_SAFE_UNINSTALLED_TOPICS allowlist.
 *
 * Tests that:
 * - Topics on the allowlist are archived for uninstalled shops (zero Admin calls, no DLQ)
 * - Topics NOT on the allowlist take main's code path (handler is called)
 * - Nightly reconcile (enqueueReconcileForAllShops) picks up reinstalled shops
 * - N/A topics don't modify local state
 *
 * Uses REAL database, REAL log.server, and mocked Admin GraphQL responses.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";
import { S6_QUEUES } from "~/lib/pgmq.server";
import { ARCHIVE_SAFE_UNINSTALLED_TOPICS } from "../processor.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-ual`;
}

let sqlRef: ReturnType<typeof postgres>;

const adminGraphQLMock = vi.fn();
vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: (...args: unknown[]) => adminGraphQLMock(...args),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: vi.fn().mockResolvedValue(undefined),
    processCompanyWebhook: actual.processCompanyWebhook,
  };
});

vi.mock("~/services/sync/order.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/order.server")>();
  return {
    ...actual,
    processOrderWebhook: actual.processOrderWebhook,
  };
});

vi.mock("~/services/backstop.server", async () => {
  return {
    executeBackstop: vi.fn().mockResolvedValue(null),
    resolveInvoiceForOrder: vi.fn().mockResolvedValue(null),
    recordBackstopFailure: vi.fn().mockResolvedValue(undefined),
  };
});

describeWithDb("Allowlist: ARCHIVE_SAFE_UNINSTALLED_TOPICS", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  const testContext = {
    suffix: "",
  };

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    adminGraphQLMock.mockReset();
    testContext.suffix = makeTestId();

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

    await sqlRef`
      WITH visible AS (
        SELECT msg_id FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' NOT LIKE ${`%${testContext.suffix}%`}
      )
      SELECT pgmq.archive('s6_sync', msg_id) FROM visible WHERE msg_id IS NOT NULL
    `;
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });

  function findLogEntry(eventName: string): Record<string, unknown> | null {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    for (const args of allCalls) {
      for (const arg of args) {
        if (typeof arg === "string" && arg.includes(`"event":"${eventName}"`)) {
          try {
            return JSON.parse(arg);
          } catch {
            continue;
          }
        }
      }
    }
    return null;
  }

  async function cleanupTestData(domains: string[], suffix: string): Promise<void> {
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${suffix}%`}`;
    await sqlRef`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM order_outstanding_missing WHERE shop IN ${sqlRef(domains)}`;
    await sqlRef`DELETE FROM "Session" WHERE shop IN ${sqlRef(domains)}`;
    for (const domain of domains) {
      await sqlRef`DELETE FROM "Invoice" WHERE "shopId" IN (SELECT id FROM "Shop" WHERE domain = ${domain})`;
      await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" IN (SELECT id FROM "Shop" WHERE domain = ${domain})`;
      await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id IN (SELECT id FROM "Shop" WHERE domain = ${domain})`;
      await sqlRef`DELETE FROM s8_draft_orders WHERE shop_id IN (SELECT id FROM "Shop" WHERE domain = ${domain})`;
      await sqlRef`DELETE FROM "Shop" WHERE domain = ${domain}`;
    }
    await assertNoQueueLeftovers(sqlRef, domains, "uninstalled-allowlist-db.test.ts");
  }

  describe("Allowlist constant export", () => {
    it("exports ARCHIVE_SAFE_UNINSTALLED_TOPICS with expected topics", () => {
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS).toBeDefined();
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("ORDERS_CREATE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("ORDERS_UPDATED")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("ORDERS_PAID")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("ORDERS_CANCELLED")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("COMPANIES_CREATE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("COMPANIES_UPDATE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("COMPANIES_DELETE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("COMPANY_LOCATIONS_CREATE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("COMPANY_LOCATIONS_UPDATE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("COMPANY_LOCATIONS_DELETE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("CUSTOMERS_CREATE")).toBe(true);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("CUSTOMERS_UPDATE")).toBe(true);
    });

    it("does NOT include DRAFT_ORDERS_* or CUSTOMERS_DELETE", () => {
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("DRAFT_ORDERS_CREATE")).toBe(false);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("DRAFT_ORDERS_UPDATE")).toBe(false);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("DRAFT_ORDERS_DELETE")).toBe(false);
      expect(ARCHIVE_SAFE_UNINSTALLED_TOPICS.has("CUSTOMERS_DELETE")).toBe(false);
    });
  });

  describe("Archive behavior for allowlisted topics (uninstalled shop)", () => {
    it.each([
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "ORDERS_PAID",
      "ORDERS_CANCELLED",
      "COMPANIES_CREATE",
      "COMPANIES_UPDATE",
      "COMPANIES_DELETE",
      "COMPANY_LOCATIONS_CREATE",
      "COMPANY_LOCATIONS_UPDATE",
      "COMPANY_LOCATIONS_DELETE",
      "CUSTOMERS_CREATE",
      "CUSTOMERS_UPDATE",
    ] as const)("%s: uninstalled shop archives message, zero Admin calls, no DLQ", async (topic) => {
      const suffix = testContext.suffix;
      const domain = `test-${topic.toLowerCase()}-${suffix}.example.com`;
      const shopId = `shop-${topic.toLowerCase()}-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        const webhookId = `wh-${topic.toLowerCase()}-${suffix}`;
        const message = {
          shop: domain,
          topic,
          webhookId,
          resourceGid: `gid://shopify/Resource/${topic.toLowerCase()}-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const callsForShop = adminGraphQLMock.mock.calls.filter((c) => c[0] === domain);
        expect(callsForShop.length, `zero Admin calls for ${topic}`).toBe(0);

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(archiveCount.count, 10), `${topic} message archived`).toBe(1);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10), `no DLQ for ${topic}`).toBe(0);

        const logEntry = findLogEntry("order_webhook_uninstalled_shop_acked");
        expect(logEntry, `log entry for ${topic}`).not.toBeNull();
        expect(logEntry!.topic).toBe(topic);
        expect(logEntry!.reason).toBe("shop_uninstalled");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });
  });

  describe("Non-allowlisted topics reach handler (main's behaviour)", () => {
    it("DRAFT_ORDERS_DELETE: uninstalled shop reaches handler, local row deleted, 0 Admin calls, no DLQ", async () => {
      const suffix = testContext.suffix;
      const domain = `test-draft-delete-handler-${suffix}.example.com`;
      const shopId = `shop-draft-delete-handler-${suffix}`;
      const draftOrderGid = `gid://shopify/DraftOrder/draft-delete-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        await sqlRef`
          INSERT INTO s8_draft_orders (shop_id, draft_order_id, name, total, has_payment_terms, status, created_at)
          VALUES (${shopId}, ${draftOrderGid}, '#D001', '1000.00', true, 'open', ${now})
        `;

        const [draftBefore] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM s8_draft_orders WHERE shop_id = ${shopId} AND draft_order_id = ${draftOrderGid}
        `;
        expect(draftBefore, "draft order exists before drain").toBeDefined();

        const webhookId = `wh-draft-delete-handler-${suffix}`;
        const message = {
          shop: domain,
          topic: "DRAFT_ORDERS_DELETE",
          webhookId,
          resourceGid: draftOrderGid,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const callsForShop = adminGraphQLMock.mock.calls.filter((c) => c[0] === domain);
        expect(callsForShop.length, "zero Admin calls for DRAFT_ORDERS_DELETE").toBe(0);

        const [draftAfter] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM s8_draft_orders WHERE shop_id = ${shopId} AND draft_order_id = ${draftOrderGid}
        `;
        expect(draftAfter, "draft order deleted by handler").toBeUndefined();

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(archiveCount.count, 10), "message archived after handler success").toBe(1);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10), "no DLQ entry").toBe(0);

        const skipLog = findLogEntry("order_webhook_uninstalled_shop_acked");
        expect(skipLog, "no skip log - handler was called").toBeNull();
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("CUSTOMERS_DELETE: uninstalled shop reaches handler, tag_active=false, 0 Admin calls, no DLQ", async () => {
      const suffix = testContext.suffix;
      const domain = `test-cust-delete-handler-${suffix}.example.com`;
      const shopId = `shop-cust-delete-handler-${suffix}`;
      const customerGid = `gid://shopify/Customer/cust-delete-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        await sqlRef`
          INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at)
          VALUES (${shopId}, ${customerGid}, '["net-terms"]'::jsonb, true, ${now})
        `;

        const [custBefore] = await sqlRef<[{ tag_active: boolean }?]>`
          SELECT tag_active FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerGid}
        `;
        expect(custBefore?.tag_active, "tag_active is true before drain").toBe(true);

        const webhookId = `wh-cust-delete-handler-${suffix}`;
        const message = {
          shop: domain,
          topic: "CUSTOMERS_DELETE",
          webhookId,
          resourceGid: customerGid,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const callsForShop = adminGraphQLMock.mock.calls.filter((c) => c[0] === domain);
        expect(callsForShop.length, "zero Admin calls for CUSTOMERS_DELETE").toBe(0);

        const [custAfter] = await sqlRef<[{ tag_active: boolean; tag_deactivated_at: Date | null }?]>`
          SELECT tag_active, tag_deactivated_at FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerGid}
        `;
        expect(custAfter?.tag_active, "tag_active set to false by handler").toBe(false);
        expect(custAfter?.tag_deactivated_at, "tag_deactivated_at set by handler").not.toBeNull();

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(archiveCount.count, 10), "message archived after handler success").toBe(1);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10), "no DLQ entry").toBe(0);

        const skipLog = findLogEntry("order_webhook_uninstalled_shop_acked");
        expect(skipLog, "no skip log - handler was called").toBeNull();
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("DRAFT_ORDERS_CREATE: uninstalled shop reaches handler, DLQs after max retries (main's behaviour)", async () => {
      const suffix = testContext.suffix;
      const domain = `test-draft-create-handler-${suffix}.example.com`;
      const shopId = `shop-draft-create-handler-${suffix}`;
      const draftOrderGid = `gid://shopify/DraftOrder/draft-create-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        adminGraphQLMock.mockResolvedValue({
          success: false,
          error: "No session found",
          errorCode: "no_session",
          retryable: true,
        });

        const webhookId = `wh-draft-create-handler-${suffix}`;
        const message = {
          shop: domain,
          topic: "DRAFT_ORDERS_CREATE",
          webhookId,
          resourceGid: draftOrderGid,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`
          INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
          VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(message)}::jsonb)
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const callsForShop = adminGraphQLMock.mock.calls.filter((c) => c[0] === domain);
        expect(callsForShop.length, "Admin call attempted for DRAFT_ORDERS_CREATE").toBeGreaterThanOrEqual(1);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10), "DLQ entry exists after max retries").toBe(1);

        const skipLog = findLogEntry("order_webhook_uninstalled_shop_acked");
        expect(skipLog, "no skip log - handler was called").toBeNull();
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("DRAFT_ORDERS_UPDATE: uninstalled shop reaches handler, DLQs after max retries (main's behaviour)", async () => {
      const suffix = testContext.suffix;
      const domain = `test-draft-update-handler-${suffix}.example.com`;
      const shopId = `shop-draft-update-handler-${suffix}`;
      const draftOrderGid = `gid://shopify/DraftOrder/draft-update-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        adminGraphQLMock.mockResolvedValue({
          success: false,
          error: "No session found",
          errorCode: "no_session",
          retryable: true,
        });

        const webhookId = `wh-draft-update-handler-${suffix}`;
        const message = {
          shop: domain,
          topic: "DRAFT_ORDERS_UPDATE",
          webhookId,
          resourceGid: draftOrderGid,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`
          INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
          VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(message)}::jsonb)
        `;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const callsForShop = adminGraphQLMock.mock.calls.filter((c) => c[0] === domain);
        expect(callsForShop.length, "Admin call attempted for DRAFT_ORDERS_UPDATE").toBeGreaterThanOrEqual(1);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10), "DLQ entry exists after max retries").toBe(1);

        const skipLog = findLogEntry("order_webhook_uninstalled_shop_acked");
        expect(skipLog, "no skip log - handler was called").toBeNull();
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });
  });

  describe("N/A topics: installed shop handler changes no state", () => {
    it("COMPANIES_CREATE: installed shop handler creates no BuyerAccount", async () => {
      const suffix = testContext.suffix;
      const domain = `test-companies-create-installed-${suffix}.example.com`;
      const shopId = `shop-companies-create-installed-${suffix}`;
      const companyGid = `gid://shopify/Company/companies-create-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;

        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;

        const [buyerCountBefore] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${shopId}
        `;

        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const result = await processCompanyWebhook(
          sqlRef,
          domain,
          "COMPANIES_CREATE",
          { id: companyGid, name: "Test Company", externalId: null },
          `wh-companies-create-${suffix}`
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("BuyerAccount created from CompanyLocation");

        const [buyerCountAfter] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${shopId}
        `;
        expect(buyerCountAfter.count, "no BuyerAccount created").toBe(buyerCountBefore.count);
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("COMPANIES_UPDATE: installed shop handler changes no BuyerAccount", async () => {
      const suffix = testContext.suffix;
      const domain = `test-companies-update-installed-${suffix}.example.com`;
      const shopId = `shop-companies-update-installed-${suffix}`;
      const companyGid = `gid://shopify/Company/companies-update-${suffix}`;
      const locationGid = `gid://shopify/CompanyLocation/cl-update-${suffix}`;
      const accountId = `ba-companies-update-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyGid}, ${locationGid}, 'Original Name', ${now}, ${now})
        `;

        const [accountBefore] = await sqlRef<[{ name: string; updatedAt: Date }]>`
          SELECT name, "updatedAt" FROM "BuyerAccount" WHERE id = ${accountId}
        `;

        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const result = await processCompanyWebhook(
          sqlRef,
          domain,
          "COMPANIES_UPDATE",
          { id: companyGid, name: "Updated Company Name", externalId: null },
          `wh-companies-update-${suffix}`
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");

        const [accountAfter] = await sqlRef<[{ name: string; updatedAt: Date }]>`
          SELECT name, "updatedAt" FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(accountAfter.name, "BuyerAccount name unchanged").toBe(accountBefore.name);
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("COMPANIES_DELETE: installed shop handler changes no BuyerAccount", async () => {
      const suffix = testContext.suffix;
      const domain = `test-companies-delete-installed-${suffix}.example.com`;
      const shopId = `shop-companies-delete-installed-${suffix}`;
      const companyGid = `gid://shopify/Company/companies-delete-${suffix}`;
      const locationGid = `gid://shopify/CompanyLocation/cl-delete-${suffix}`;
      const accountId = `ba-companies-delete-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyGid}, ${locationGid}, 'Test Buyer', ${now}, ${now})
        `;

        const [accountBefore] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(accountBefore, "BuyerAccount exists before").toBeDefined();

        const { processCompanyWebhook } = await import("~/services/sync/company.server");
        const result = await processCompanyWebhook(
          sqlRef,
          domain,
          "COMPANIES_DELETE",
          { id: companyGid, name: "Test Company", externalId: null },
          `wh-companies-delete-${suffix}`
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");

        const [accountAfter] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(accountAfter, "BuyerAccount preserved (not deleted)").toBeDefined();
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("COMPANY_LOCATIONS_DELETE: installed shop handler preserves BuyerAccount", async () => {
      const suffix = testContext.suffix;
      const domain = `test-cl-delete-installed-${suffix}.example.com`;
      const shopId = `shop-cl-delete-installed-${suffix}`;
      const locationGid = `gid://shopify/CompanyLocation/cl-delete-${suffix}`;
      const companyGid = `gid://shopify/Company/company-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;

        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;

        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${`ba-${suffix}`}, ${shopId}, 'COMPANY', ${companyGid}, ${locationGid}, 'Test Buyer', ${now}, ${now})
        `;

        const [buyerBefore] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId} AND "companyLocationId" = ${locationGid}
        `;
        expect(buyerBefore, "BuyerAccount exists before").toBeDefined();

        const { processCompanyLocationWebhook } = await import("~/services/sync/company-location.server");
        const result = await processCompanyLocationWebhook(
          sqlRef,
          domain,
          "COMPANY_LOCATIONS_DELETE",
          { id: locationGid, name: "Test Location", company: { id: companyGid } },
          `wh-cl-delete-${suffix}`
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("BuyerAccount preserved");

        const [buyerAfter] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId} AND "companyLocationId" = ${locationGid}
        `;
        expect(buyerAfter, "BuyerAccount preserved for financial history").toBeDefined();
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });
  });

  describe("Nightly reconcile picks up reinstalled shops", () => {
    it("enqueueReconcileForAllShops excludes uninstalled, includes after reinstall", async () => {
      const suffix = testContext.suffix;
      const domain = `test-reconcile-reinstall-${suffix}.example.com`;
      const shopId = `shop-reconcile-reinstall-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}`;
        await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'reconcile:' + domain + '%'}`;

        const { enqueueReconcileForAllShops } = await import("~/services/drain/reconcile.server");
        await enqueueReconcileForAllShops(sqlRef);

        const [msgBeforeReinstall] = await sqlRef<[{ shop: string }?]>`
          SELECT message->>'shop' AS shop
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${domain}
            AND message->>'topic' = 'RECONCILE_COMPANIES'
        `;
        expect(msgBeforeReinstall, "uninstalled shop excluded from reconcile").toBeUndefined();

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;
        await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}`;
        await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'reconcile:' + domain + '%'}`;

        await enqueueReconcileForAllShops(sqlRef);

        const [msgAfterReinstall] = await sqlRef<[{ shop: string }?]>`
          SELECT message->>'shop' AS shop
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${domain}
            AND message->>'topic' = 'RECONCILE_COMPANIES'
        `;
        expect(msgAfterReinstall, "reinstalled shop included in reconcile").toBeDefined();
        expect(msgAfterReinstall?.shop).toBe(domain);
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });
  });

  describe("Recovery: reconcile restores state for archived topics", () => {
    it("ORDERS_PAID: archived webhook + reconcile restores same state as handler", async () => {
      const suffix = testContext.suffix;
      const domain = `test-orders-paid-recovery-${suffix}.example.com`;
      const shopId = `shop-orders-paid-recovery-${suffix}`;
      const orderId = `gid://shopify/Order/paid-recovery-${suffix}`;
      const invoiceId = `inv-paid-recovery-${suffix}`;
      const accountId = `ba-paid-recovery-${suffix}`;
      const companyId = `gid://shopify/Company/company-paid-${suffix}`;
      const companyLocationId = `gid://shopify/CompanyLocation/cl-paid-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${companyLocationId}, 'Test Buyer', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            "issuedAt", status, "createdAt", "updatedAt"
          ) VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#PAID1',
            '10000.00', '10000.00', ${now}, 'open', ${now}, ${now}
          )
        `;

        const [invoiceBefore] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceBefore.status).toBe("open");
        expect(invoiceBefore.outstanding).toBe("10000.00");

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-orders-paid-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "ORDERS_PAID",
          webhookId,
          resourceGid: orderId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [invoiceAfterArchive] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterArchive.status, "invoice unchanged after archive").toBe("open");
        expect(invoiceAfterArchive.outstanding, "outstanding unchanged after archive").toBe("10000.00");

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");
        const jsonlLine = JSON.stringify({
          id: orderId,
          name: "#PAID1",
          createdAt: now.toISOString(),
          displayFinancialStatus: "PAID",
          totalPriceSet: { shopMoney: { amount: "10000.00", currencyCode: "INR" } },
          totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "INR" } },
        });
        await processOrderLines(sqlRef, shopId, domain, [jsonlLine]);

        const [invoiceAfterReconcile] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterReconcile.status, "reconcile restores paid status").toBe("paid");
        expect(invoiceAfterReconcile.outstanding, "reconcile restores zero outstanding").toBe("0.00");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("ORDERS_CANCELLED (displayFinancialStatus=PAID, cancelledAt set): reconcile restores cancelled status", async () => {
      const suffix = testContext.suffix;
      const domain = `test-orders-cancelled-paid-${suffix}.example.com`;
      const shopId = `shop-orders-cancelled-paid-${suffix}`;
      const orderId = `gid://shopify/Order/cancelled-paid-${suffix}`;
      const invoiceId = `inv-cancelled-paid-${suffix}`;
      const accountId = `ba-cancelled-paid-${suffix}`;
      const companyId = `gid://shopify/Company/company-cancelled-paid-${suffix}`;
      const companyLocationId = `gid://shopify/CompanyLocation/cl-cancelled-paid-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${companyLocationId}, 'Test Buyer', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            "issuedAt", status, "createdAt", "updatedAt"
          ) VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#CANCELLED1',
            '5000.00', '5000.00', ${now}, 'open', ${now}, ${now}
          )
        `;

        const [invoiceBefore] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceBefore.status).toBe("open");
        expect(invoiceBefore.outstanding).toBe("5000.00");

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-orders-cancelled-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "ORDERS_CANCELLED",
          webhookId,
          resourceGid: orderId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [invoiceAfterArchive] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterArchive.status, "invoice unchanged after archive").toBe("open");
        expect(invoiceAfterArchive.outstanding, "outstanding unchanged after archive").toBe("5000.00");

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");
        const cancelledAt = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        const jsonlLine = JSON.stringify({
          id: orderId,
          name: "#CANCELLED1",
          createdAt: now.toISOString(),
          cancelledAt: cancelledAt,
          displayFinancialStatus: "PAID",
          totalPriceSet: { shopMoney: { amount: "5000.00", currencyCode: "INR" } },
          totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "INR" } },
        });
        await processOrderLines(sqlRef, shopId, domain, [jsonlLine]);

        const [invoiceAfterReconcile] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterReconcile.status, "reconcile restores cancelled status (cancelledAt takes precedence)").toBe("cancelled");
        expect(invoiceAfterReconcile.outstanding, "reconcile sets outstanding to 0 for cancelled").toBe("0.00");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("ORDERS_UPDATED: archived webhook + reconcile restores updated amounts", async () => {
      const suffix = testContext.suffix;
      const domain = `test-orders-updated-recovery-${suffix}.example.com`;
      const shopId = `shop-orders-updated-recovery-${suffix}`;
      const orderId = `gid://shopify/Order/updated-recovery-${suffix}`;
      const invoiceId = `inv-updated-recovery-${suffix}`;
      const accountId = `ba-updated-recovery-${suffix}`;
      const companyId = `gid://shopify/Company/company-updated-${suffix}`;
      const companyLocationId = `gid://shopify/CompanyLocation/cl-updated-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${companyLocationId}, 'Test Buyer', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            "issuedAt", status, "createdAt", "updatedAt"
          ) VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#UPDATED1',
            '8000.00', '8000.00', ${now}, 'open', ${now}, ${now}
          )
        `;

        const [invoiceBefore] = await sqlRef<[{ total: string; outstanding: string }]>`
          SELECT total::text, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceBefore.total).toBe("8000.00");
        expect(invoiceBefore.outstanding).toBe("8000.00");

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-orders-updated-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "ORDERS_UPDATED",
          webhookId,
          resourceGid: orderId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [invoiceAfterArchive] = await sqlRef<[{ total: string; outstanding: string }]>`
          SELECT total::text, outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterArchive.total, "total unchanged after archive").toBe("8000.00");
        expect(invoiceAfterArchive.outstanding, "outstanding unchanged after archive").toBe("8000.00");

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");
        const jsonlLine = JSON.stringify({
          id: orderId,
          name: "#UPDATED1",
          createdAt: now.toISOString(),
          displayFinancialStatus: "PARTIALLY_PAID",
          totalPriceSet: { shopMoney: { amount: "8000.00", currencyCode: "INR" } },
          totalOutstandingSet: { shopMoney: { amount: "5000.00", currencyCode: "INR" } },
        });
        await processOrderLines(sqlRef, shopId, domain, [jsonlLine]);

        const [invoiceAfterReconcile] = await sqlRef<[{ total: string; outstanding: string; status: string }]>`
          SELECT total::text, outstanding::text, status::"InvoiceStatus" FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterReconcile.total, "reconcile preserves total").toBe("8000.00");
        expect(invoiceAfterReconcile.outstanding, "reconcile restores partial payment outstanding").toBe("5000.00");
        expect(invoiceAfterReconcile.status, "status remains open for partial payment").toBe("open");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("ORDERS_CREATE: archived webhook + reconcile creates invoice matching handler", async () => {
      const suffix = testContext.suffix;
      const domain = `test-orders-create-recovery-${suffix}.example.com`;
      const shopId = `shop-orders-create-recovery-${suffix}`;
      const orderId = `gid://shopify/Order/create-recovery-${suffix}`;
      const accountId = `ba-create-recovery-${suffix}`;
      const companyId = `gid://shopify/Company/company-create-${suffix}`;
      const companyLocationId = `gid://shopify/CompanyLocation/cl-create-${suffix}`;

      try {
        const now = new Date();
        const orderCreatedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${companyLocationId}, 'Test Buyer', ${now}, ${now})
        `;

        const orderData = {
          id: orderId,
          name: "#CREATE1",
          createdAt: orderCreatedAt.toISOString(),
          displayFinancialStatus: "PENDING",
          totalPriceSet: { shopMoney: { amount: "15000.00", currencyCode: "INR" } },
          totalOutstandingSet: { shopMoney: { amount: "15000.00", currencyCode: "INR" } },
          purchasingEntity: {
            __typename: "PurchasingCompany",
            company: { id: companyId },
            location: { id: companyLocationId },
          },
          paymentTerms: {
            id: "gid://shopify/PaymentTerms/pt-create-" + suffix,
            paymentSchedules: {
              edges: [{ node: { id: "gid://shopify/PaymentSchedule/ps-create-" + suffix, dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() } }],
            },
          },
        };

        const [invoiceBefore] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "Invoice" WHERE "shopId" = ${shopId} AND "orderId" = ${orderId}
        `;
        expect(invoiceBefore, "no invoice before").toBeUndefined();

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-orders-create-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "ORDERS_CREATE",
          webhookId,
          resourceGid: orderId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [invoiceAfterArchive] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "Invoice" WHERE "shopId" = ${shopId} AND "orderId" = ${orderId}
        `;
        expect(invoiceAfterArchive, "no invoice created after archive").toBeUndefined();

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");
        await processOrderLines(sqlRef, shopId, domain, [JSON.stringify(orderData)]);

        const [invoiceAfterReconcile] = await sqlRef<[{ status: string; total: string; outstanding: string; buyerAccountId: string }]>`
          SELECT status::"InvoiceStatus", total::text, outstanding::text, "buyerAccountId"
          FROM "Invoice" WHERE "shopId" = ${shopId} AND "orderId" = ${orderId}
        `;
        expect(invoiceAfterReconcile, "reconcile creates invoice").toBeDefined();
        expect(invoiceAfterReconcile.status, "status is open for PENDING order").toBe("open");
        expect(invoiceAfterReconcile.total, "total matches order").toBe("15000.00");
        expect(invoiceAfterReconcile.outstanding, "outstanding matches order").toBe("15000.00");
        expect(invoiceAfterReconcile.buyerAccountId, "buyer account linked").toBe(accountId);
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("ORDERS_CANCELLED (displayFinancialStatus=PENDING, cancelledAt set): reconcile restores cancelled status", async () => {
      const suffix = testContext.suffix;
      const domain = `test-orders-cancelled-pending-${suffix}.example.com`;
      const shopId = `shop-orders-cancelled-pending-${suffix}`;
      const orderId = `gid://shopify/Order/cancelled-pending-${suffix}`;
      const invoiceId = `inv-cancelled-pending-${suffix}`;
      const accountId = `ba-cancelled-pending-${suffix}`;
      const companyId = `gid://shopify/Company/company-cancelled-pending-${suffix}`;
      const companyLocationId = `gid://shopify/CompanyLocation/cl-cancelled-pending-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${companyLocationId}, 'Test Buyer', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            "issuedAt", status, "createdAt", "updatedAt"
          ) VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#CANCELLED_PENDING',
            '3000.00', '3000.00', ${now}, 'open', ${now}, ${now}
          )
        `;

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-orders-cancelled-pending-${suffix}`;
        const message = {
          shop: domain,
          topic: "ORDERS_CANCELLED",
          webhookId,
          resourceGid: orderId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [invoiceAfterArchive] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterArchive.status, "invoice unchanged after archive").toBe("open");

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");
        const cancelledAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const jsonlLine = JSON.stringify({
          id: orderId,
          name: "#CANCELLED_PENDING",
          createdAt: now.toISOString(),
          cancelledAt: cancelledAt,
          displayFinancialStatus: "PENDING",
          totalPriceSet: { shopMoney: { amount: "3000.00", currencyCode: "INR" } },
          totalOutstandingSet: { shopMoney: { amount: "3000.00", currencyCode: "INR" } },
        });
        await processOrderLines(sqlRef, shopId, domain, [jsonlLine]);

        const [invoiceAfterReconcile] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterReconcile.status, "reconcile restores cancelled (cancelledAt takes precedence over PENDING)").toBe("cancelled");
        expect(invoiceAfterReconcile.outstanding, "outstanding zeroed for cancelled").toBe("0.00");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("COMPANY_LOCATIONS_CREATE: archived webhook + reconcile creates BuyerAccount", async () => {
      const suffix = testContext.suffix;
      const domain = `test-cl-create-recovery-${suffix}.example.com`;
      const shopId = `shop-cl-create-recovery-${suffix}`;
      const locationId = `gid://shopify/CompanyLocation/cl-create-recovery-${suffix}`;
      const companyId = `gid://shopify/Company/company-cl-create-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;

        const [accountBefore] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId} AND "companyLocationId" = ${locationId}
        `;
        expect(accountBefore, "no BuyerAccount before").toBeUndefined();

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-cl-create-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "COMPANY_LOCATIONS_CREATE",
          webhookId,
          resourceGid: locationId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [accountAfterArchive] = await sqlRef<[{ id: string }?]>`
          SELECT id FROM "BuyerAccount" WHERE "shopId" = ${shopId} AND "companyLocationId" = ${locationId}
        `;
        expect(accountAfterArchive, "no BuyerAccount created after archive").toBeUndefined();

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { mapCompanyLocationToBuyerAccount, bulkUpsertBuyerAccounts } = await import("~/services/sync/company-location.server");
        const mappedAccount = mapCompanyLocationToBuyerAccount(shopId, {
          id: locationId,
          name: "New Location",
          company: { id: companyId },
        }, {}, true);
        await bulkUpsertBuyerAccounts(sqlRef, [mappedAccount]);

        const [accountAfterReconcile] = await sqlRef<[{ id: string; name: string; companyId: string }?]>`
          SELECT id, name, "companyId" FROM "BuyerAccount"
          WHERE "shopId" = ${shopId} AND "companyLocationId" = ${locationId}
        `;
        expect(accountAfterReconcile, "reconcile creates BuyerAccount").toBeDefined();
        expect(accountAfterReconcile!.name).toBe("New Location");
        expect(accountAfterReconcile!.companyId).toBe(companyId);
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("CUSTOMERS_CREATE: archived webhook + reconcile creates customer row", async () => {
      const suffix = testContext.suffix;
      const domain = `test-customers-create-recovery-${suffix}.example.com`;
      const shopId = `shop-customers-create-recovery-${suffix}`;
      const customerId = `gid://shopify/Customer/cust-create-recovery-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
          VALUES (${'as-create-' + suffix}, ${shopId}, 'wholesale', 30, ${now}, ${now})
        `;

        const [custBefore] = await sqlRef<[{ id: string }?]>`
          SELECT customer_id as id FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        `;
        expect(custBefore, "no customer row before").toBeUndefined();

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-customers-create-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "CUSTOMERS_CREATE",
          webhookId,
          resourceGid: customerId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [custAfterArchive] = await sqlRef<[{ id: string }?]>`
          SELECT customer_id as id FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        `;
        expect(custAfterArchive, "no customer row created after archive").toBeUndefined();

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processBulkCustomer } = await import("~/services/sync/customer.server");
        await processBulkCustomer(sqlRef, domain, {
          id: customerId,
          displayName: "New Wholesale Customer",
          email: "wholesale@example.com",
          tags: ["wholesale", "preferred"],
        });

        const [custAfterReconcile] = await sqlRef<[{ tag_active: boolean; tags: unknown }?]>`
          SELECT tag_active, tags FROM s8_tagged_customers
          WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        `;
        expect(custAfterReconcile, "reconcile creates customer row").toBeDefined();
        expect(custAfterReconcile!.tag_active, "tag_active is true").toBe(true);
        const tags = custAfterReconcile!.tags as string[];
        expect(tags).toContain("wholesale");
      } finally {
        await sqlRef`DELETE FROM "AccountSource" WHERE id = ${'as-create-' + suffix}`;
        await cleanupTestData([domain], suffix);
      }
    });

    it("CUSTOMERS_UPDATE: archived webhook + reconcile restores tag_active state", async () => {
      const suffix = testContext.suffix;
      const domain = `test-customers-update-recovery-${suffix}.example.com`;
      const shopId = `shop-customers-update-recovery-${suffix}`;
      const customerId = `gid://shopify/Customer/cust-update-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at)
          VALUES (${shopId}, ${customerId}, '["net-terms"]'::jsonb, true, ${now})
        `;
        await sqlRef`
          INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
          VALUES (${'as-' + suffix}, ${shopId}, 'net-terms', 30, ${now}, ${now})
        `;

        const [custBefore] = await sqlRef<[{ tag_active: boolean }]>`
          SELECT tag_active FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        `;
        expect(custBefore.tag_active).toBe(true);

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-customers-update-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "CUSTOMERS_UPDATE",
          webhookId,
          resourceGid: customerId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [custAfterArchive] = await sqlRef<[{ tag_active: boolean }]>`
          SELECT tag_active FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        `;
        expect(custAfterArchive.tag_active, "tag_active unchanged after archive").toBe(true);

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { processBulkCustomer } = await import("~/services/sync/customer.server");
        await processBulkCustomer(sqlRef, domain, {
          id: customerId,
          displayName: "Test Customer",
          email: "test@example.com",
          tags: ["net-terms", "vip"],
        });

        const [custAfterReconcile] = await sqlRef<[{ tag_active: boolean; tags: unknown }]>`
          SELECT tag_active, tags FROM s8_tagged_customers WHERE shop_id = ${shopId} AND customer_id = ${customerId}
        `;
        expect(custAfterReconcile.tag_active, "reconcile preserves tag_active").toBe(true);
        const tags = custAfterReconcile.tags as string[];
        expect(tags, "reconcile updates tags").toContain("net-terms");
        expect(tags, "reconcile includes new tags").toContain("vip");
      } finally {
        await sqlRef`DELETE FROM "AccountSource" WHERE id = ${'as-' + suffix}`;
        await cleanupTestData([domain], suffix);
      }
    });

    it("COMPANY_LOCATIONS_UPDATE: archived webhook + reconcile restores BuyerAccount name", async () => {
      const suffix = testContext.suffix;
      const domain = `test-cl-update-recovery-${suffix}.example.com`;
      const shopId = `shop-cl-update-recovery-${suffix}`;
      const locationId = `gid://shopify/CompanyLocation/cl-update-${suffix}`;
      const companyId = `gid://shopify/Company/company-${suffix}`;
      const accountId = `ba-cl-update-recovery-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (
            id, "shopId", kind, "companyId", "companyLocationId", name,
            "createdAt", "updatedAt"
          ) VALUES (
            ${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${locationId}, 'Old Location Name',
            ${now}, ${now}
          )
        `;

        const [accountBefore] = await sqlRef<[{ name: string }]>`
          SELECT name FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(accountBefore.name).toBe("Old Location Name");

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-cl-update-recovery-${suffix}`;
        const message = {
          shop: domain,
          topic: "COMPANY_LOCATIONS_UPDATE",
          webhookId,
          resourceGid: locationId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [accountAfterArchive] = await sqlRef<[{ name: string }]>`
          SELECT name FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(accountAfterArchive.name, "name unchanged after archive").toBe("Old Location Name");

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const { mapCompanyLocationToBuyerAccount, bulkUpsertBuyerAccounts } = await import("~/services/sync/company-location.server");
        const mappedAccount = mapCompanyLocationToBuyerAccount(shopId, {
          id: locationId,
          name: "Updated Location Name",
          company: { id: companyId },
        }, {}, true);
        await bulkUpsertBuyerAccounts(sqlRef, [mappedAccount]);

        const [accountAfterReconcile] = await sqlRef<[{ name: string }]>`
          SELECT name FROM "BuyerAccount" WHERE id = ${accountId}
        `;
        expect(accountAfterReconcile.name, "reconcile restores updated name").toBe("Updated Location Name");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });

    it("Revert evidence: ORDERS_PAID recovery fails without reconcile step", async () => {
      const suffix = testContext.suffix;
      const domain = `test-orders-paid-revert-${suffix}.example.com`;
      const shopId = `shop-orders-paid-revert-${suffix}`;
      const orderId = `gid://shopify/Order/paid-revert-${suffix}`;
      const invoiceId = `inv-paid-revert-${suffix}`;
      const accountId = `ba-paid-revert-${suffix}`;
      const companyId = `gid://shopify/Company/company-paid-revert-${suffix}`;
      const companyLocationId = `gid://shopify/CompanyLocation/cl-paid-revert-${suffix}`;

      try {
        const now = new Date();

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
          VALUES (${'offline_' + domain}, ${domain}, 'test-state', false, 'test-token')
        `;
        await sqlRef`
          INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
          VALUES (${accountId}, ${shopId}, 'COMPANY', ${companyId}, ${companyLocationId}, 'Test Buyer', ${now}, ${now})
        `;
        await sqlRef`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            "issuedAt", status, "createdAt", "updatedAt"
          ) VALUES (
            ${invoiceId}, ${shopId}, ${accountId}, ${orderId}, '#REVERT1',
            '7500.00', '7500.00', ${now}, 'open', ${now}, ${now}
          )
        `;

        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = ${uninstalledAt} WHERE id = ${shopId}`;

        const webhookId = `wh-orders-paid-revert-${suffix}`;
        const message = {
          shop: domain,
          topic: "ORDERS_PAID",
          webhookId,
          resourceGid: orderId,
          enqueuedAt: new Date().toISOString(),
        };
        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        await sqlRef`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}`;

        const [invoiceWithoutReconcile] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceWithoutReconcile.status, "without reconcile: status stuck at open").toBe("open");
        expect(invoiceWithoutReconcile.outstanding, "without reconcile: outstanding not zeroed").toBe("7500.00");

        const { processOrderLines } = await import("~/services/sync/bulk-jsonl-processor.server");
        const jsonlLine = JSON.stringify({
          id: orderId,
          name: "#REVERT1",
          createdAt: now.toISOString(),
          displayFinancialStatus: "PAID",
          totalPriceSet: { shopMoney: { amount: "7500.00", currencyCode: "INR" } },
          totalOutstandingSet: { shopMoney: { amount: "0.00", currencyCode: "INR" } },
        });
        await processOrderLines(sqlRef, shopId, domain, [jsonlLine]);

        const [invoiceAfterReconcile] = await sqlRef<[{ status: string; outstanding: string }]>`
          SELECT status::"InvoiceStatus", outstanding::text FROM "Invoice" WHERE id = ${invoiceId}
        `;
        expect(invoiceAfterReconcile.status, "with reconcile: status updated to paid").toBe("paid");
        expect(invoiceAfterReconcile.outstanding, "with reconcile: outstanding zeroed").toBe("0.00");
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });
  });
});
