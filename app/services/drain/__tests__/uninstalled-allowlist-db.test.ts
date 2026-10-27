/**
 * DB-backed integration tests for ARCHIVE_SAFE_UNINSTALLED_TOPICS allowlist.
 *
 * Tests that:
 * - Topics on the allowlist are archived for uninstalled shops (zero Admin calls, no DLQ)
 * - Topics NOT on the allowlist take main's code path (handler is called)
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

  describe("N/A topics: no local state change", () => {
    it("COMPANIES_CREATE: uninstalled shop archives, no BuyerAccount created", async () => {
      const suffix = testContext.suffix;
      const domain = `test-companies-create-na-${suffix}.example.com`;
      const shopId = `shop-companies-create-na-${suffix}`;

      try {
        const now = new Date();
        const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

        await sqlRef`
          INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
          VALUES (${shopId}, ${domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
        `;

        const [buyerAccountCountBefore] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${shopId}
        `;

        const webhookId = `wh-companies-create-na-${suffix}`;
        const message = {
          shop: domain,
          topic: "COMPANIES_CREATE",
          webhookId,
          resourceGid: `gid://shopify/Company/companies-create-${suffix}`,
          enqueuedAt: new Date().toISOString(),
        };

        await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

        const { runDrain } = await import("~/services/drain/processor.server");
        await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

        const [archiveCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(archiveCount.count, 10), "message archived").toBe(1);

        const [dlqCount] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM s6_dead_letter
          WHERE message->>'webhookId' = ${webhookId}
        `;
        expect(parseInt(dlqCount.count, 10), "no DLQ").toBe(0);

        const [buyerAccountCountAfter] = await sqlRef<[{ count: string }]>`
          SELECT COUNT(*)::text as count FROM "BuyerAccount" WHERE "shopId" = ${shopId}
        `;
        expect(buyerAccountCountAfter.count).toBe(buyerAccountCountBefore.count);
      } finally {
        await cleanupTestData([domain], suffix);
      }
    });
  });
});
