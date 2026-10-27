/**
 * DB-backed integration tests for skipping s6_sync drain work for uninstalled shops.
 *
 * Tests that s6_sync messages for uninstalled shops (Shop.uninstalledAt IS NOT NULL)
 * are skipped BEFORE any Admin GraphQL call:
 * - Zero Admin API calls made
 * - Message is archived (ACKed)
 * - No DLQ entry created
 * - Log has reason 'shop_uninstalled' with no domain or webhookId
 *
 * Also tests positive controls:
 * - Reinstalled shop (uninstalledAt cleared) processes normally
 * - Race condition: message enqueued before uninstall, drained after
 * - Second installed shop in same batch still processes
 *
 * Uses REAL log.server (no mock) with console spies to verify logging.
 * Uses describeWithDb for real database integration.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";
import { S6_QUEUES } from "~/lib/pgmq.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-dus`;
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
    processOrderWebhook: vi.fn().mockResolvedValue({
      success: true,
      action: "created",
      entityId: "test-invoice-id",
    }),
  };
});

vi.mock("~/services/backstop.server", async () => {
  return {
    executeBackstop: vi.fn().mockResolvedValue(null),
    resolveInvoiceForOrder: vi.fn().mockResolvedValue(null),
    recordBackstopFailure: vi.fn().mockResolvedValue(undefined),
  };
});

describeWithDb("Drain: skip work for uninstalled shops", () => {
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

  function getAllLogOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
    ];
    return allCalls.map((args) =>
      args.map((arg: unknown) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg))).join(" ")
    );
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
      await sqlRef`DELETE FROM "Shop" WHERE domain = ${domain}`;
    }
    await assertNoQueueLeftovers(sqlRef, domains, "drain-uninstalled-shop-db.test.ts");
  }

  it("uninstalled shop s6_sync message: 0 Admin calls, acked, 0 DLQ, log has reason shop_uninstalled", async () => {
    const suffix = testContext.suffix;
    const uninstalledDomain = `test-uninstalled-${suffix}.example.com`;
    const shopId = `shop-uninstalled-${suffix}`;

    try {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${shopId}, ${uninstalledDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const webhookId = `wh-uninstalled-sync-${suffix}`;
      const message = {
        shop: uninstalledDomain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/uninstalled-${suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

      const adminCalls = adminGraphQLMock.mock.calls;
      const callsForShop = adminCalls.filter((call) => call[0] === uninstalledDomain);
      expect(callsForShop.length, "zero Admin calls for uninstalled shop").toBe(0);

      const [queueCount] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(queueCount.count, 10), "message removed from queue").toBe(0);

      const [archiveCount] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(archiveCount.count, 10), "message archived").toBe(1);

      const [dlqCount] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(dlqCount.count, 10), "no DLQ entry").toBe(0);

      // Reuses existing order_webhook_uninstalled_shop_acked event code with reason 'shop_uninstalled'
      const logEntry = findLogEntry("order_webhook_uninstalled_shop_acked");
      expect(logEntry, "log entry exists with order_webhook_uninstalled_shop_acked event").not.toBeNull();
      expect(logEntry!.reason).toBe("shop_uninstalled");
      expect(logEntry!.topic).toBe("ORDERS_CREATE");
      expect(typeof logEntry!.shopHash).toBe("string");

      // Verify no domain, GID, or webhookId in any log line
      const allLogs = getAllLogOutput().join("\n");
      expect(allLogs, "no domain in logs").not.toContain(uninstalledDomain);
      expect(allLogs, "no webhookId in logs").not.toContain(webhookId);
      expect(allLogs, "no resourceGid in logs").not.toContain(`gid://shopify/Order/uninstalled-${suffix}`);
    } finally {
      await cleanupTestData([uninstalledDomain], suffix);
    }
  });

  it("reinstalled shop (uninstalledAt was set, then cleared) processes normally with Admin call", async () => {
    const suffix = testContext.suffix;
    const reinstalledDomain = `test-reinstalled-${suffix}.example.com`;
    const shopId = `shop-reinstalled-${suffix}`;

    try {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      // Step 1: Create shop WITH uninstalledAt set (was uninstalled)
      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${shopId}, ${reinstalledDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      // Step 2: Clear uninstalledAt (simulates reinstall via afterAuth/upsertShopOnAuth)
      await sqlRef`
        UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${shopId}
      `;

      // Add session for the reinstalled shop
      await sqlRef`
        INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
        VALUES (${'offline_' + reinstalledDomain}, ${reinstalledDomain}, 'test-state', false, 'test-token')
      `;

      adminGraphQLMock.mockResolvedValue({
        success: true,
        data: {
          node: {
            id: `gid://shopify/Order/reinstalled-${suffix}`,
            name: "#TEST-1001",
            createdAt: new Date().toISOString(),
            processedAt: null,
            cancelledAt: null,
            closedAt: null,
            displayFinancialStatus: "PENDING",
            totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
            totalOutstandingSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
            paymentTerms: {
              id: "gid://shopify/PaymentTerms/test-123",
              paymentTermsName: "Net 30",
              paymentTermsType: "NET",
              dueInDays: 30,
            },
          },
        },
        retryable: false,
      });

      const webhookId = `wh-reinstalled-sync-${suffix}`;
      const message = {
        shop: reinstalledDomain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/reinstalled-${suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

      const { runDrain } = await import("~/services/drain/processor.server");
      const { processOrderWebhook } = await import("~/services/sync/order.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

      // Verify Admin client was called (message reached handler, not skipped)
      const adminCalls = adminGraphQLMock.mock.calls;
      const callsForShop = adminCalls.filter((call) => call[0] === reinstalledDomain);
      expect(callsForShop.length, "at least 1 Admin call for reinstalled shop").toBeGreaterThanOrEqual(1);

      // Verify handler mock was called with this message
      const orderWebhookMock = vi.mocked(processOrderWebhook);
      const handlerCalls = orderWebhookMock.mock.calls.filter(
        (call) => call[1] === reinstalledDomain
      );
      expect(handlerCalls.length, "processOrderWebhook called for reinstalled shop").toBeGreaterThanOrEqual(1);

      const [archiveCount] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(archiveCount.count, 10), "message archived").toBe(1);

      // Verify NO skip log for this shop
      const skipLog = findLogEntry("order_webhook_uninstalled_shop_acked");
      if (skipLog) {
        // If there's a skip log, it must NOT be for this shop (could be from another test's cleanup)
        expect(skipLog.reason).not.toBe("shop_uninstalled");
      }
    } finally {
      await cleanupTestData([reinstalledDomain], suffix);
    }
  });

  it("race: message enqueued BEFORE uninstall, drained AFTER uninstalledAt set gives 0 Admin calls", async () => {
    const suffix = testContext.suffix;
    const raceDomain = `test-race-${suffix}.example.com`;
    const shopId = `shop-race-${suffix}`;

    try {
      const now = new Date();

      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${shopId}, ${raceDomain}, 'INR', ${now}, ${now}, NULL)
      `;
      await sqlRef`
        INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
        VALUES (${'offline_' + raceDomain}, ${raceDomain}, 'test-state', false, 'test-token')
      `;

      const webhookId = `wh-race-sync-${suffix}`;
      const message = {
        shop: raceDomain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/race-${suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(message)})`;

      const uninstalledAt = new Date();
      await sqlRef`
        UPDATE "Shop"
        SET "uninstalledAt" = ${uninstalledAt}, "updatedAt" = ${uninstalledAt}
        WHERE id = ${shopId}
      `;
      await sqlRef`DELETE FROM "Session" WHERE shop = ${raceDomain}`;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

      const adminCalls = adminGraphQLMock.mock.calls;
      const callsForShop = adminCalls.filter((call) => call[0] === raceDomain);
      expect(callsForShop.length, "zero Admin calls for race condition").toBe(0);

      const [archiveCount] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(archiveCount.count, 10), "message archived").toBe(1);

      const [dlqCount] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(dlqCount.count, 10), "no DLQ entry").toBe(0);

      // Reuses existing order_webhook_uninstalled_shop_acked event code with reason 'shop_uninstalled'
      const logEntry = findLogEntry("order_webhook_uninstalled_shop_acked");
      expect(logEntry, "log entry exists with order_webhook_uninstalled_shop_acked event").not.toBeNull();
      expect(logEntry!.reason).toBe("shop_uninstalled");
    } finally {
      await cleanupTestData([raceDomain], suffix);
    }
  });

  it("installed second shop in same batch still processes", async () => {
    const suffix = testContext.suffix;
    const uninstalledDomain = `test-batch-uninstalled-${suffix}.example.com`;
    const installedDomain = `test-batch-installed-${suffix}.example.com`;
    const uninstalledShopId = `shop-batch-uninstalled-${suffix}`;
    const installedShopId = `shop-batch-installed-${suffix}`;

    try {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${uninstalledShopId}, ${uninstalledDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${installedShopId}, ${installedDomain}, 'INR', ${now}, ${now}, NULL)
      `;
      await sqlRef`
        INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
        VALUES (${'offline_' + installedDomain}, ${installedDomain}, 'test-state', false, 'test-token')
      `;

      adminGraphQLMock.mockImplementation(async (shop: string) => {
        if (shop === installedDomain) {
          return {
            success: true,
            data: {
              node: {
                id: `gid://shopify/Order/installed-${suffix}`,
                name: "#TEST-1002",
                createdAt: new Date().toISOString(),
                processedAt: null,
                cancelledAt: null,
                closedAt: null,
                displayFinancialStatus: "PENDING",
                totalPriceSet: { shopMoney: { amount: "200.00", currencyCode: "INR" } },
                totalOutstandingSet: { shopMoney: { amount: "200.00", currencyCode: "INR" } },
                paymentTerms: {
                  id: "gid://shopify/PaymentTerms/test-456",
                  paymentTermsName: "Net 30",
                  paymentTermsType: "NET",
                  dueInDays: 30,
                },
              },
            },
            retryable: false,
          };
        }
        return {
          success: false,
          error: "Should not be called",
          errorCode: "unexpected_call",
          retryable: false,
        };
      });

      const uninstalledWebhookId = `wh-batch-uninstalled-${suffix}`;
      const installedWebhookId = `wh-batch-installed-${suffix}`;

      const uninstalledMessage = {
        shop: uninstalledDomain,
        topic: "ORDERS_CREATE",
        webhookId: uninstalledWebhookId,
        resourceGid: `gid://shopify/Order/batch-uninstalled-${suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      const installedMessage = {
        shop: installedDomain,
        topic: "ORDERS_CREATE",
        webhookId: installedWebhookId,
        resourceGid: `gid://shopify/Order/batch-installed-${suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(uninstalledMessage)})`;
      await sqlRef`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sqlRef.json(installedMessage)})`;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

      const adminCalls = adminGraphQLMock.mock.calls;
      const callsForUninstalled = adminCalls.filter((call) => call[0] === uninstalledDomain);
      const callsForInstalled = adminCalls.filter((call) => call[0] === installedDomain);
      expect(callsForUninstalled.length, "zero Admin calls for uninstalled shop").toBe(0);
      expect(callsForInstalled.length, "at least 1 Admin call for installed shop").toBeGreaterThanOrEqual(1);

      const [uninstalledArchive] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${uninstalledWebhookId}
      `;
      expect(parseInt(uninstalledArchive.count, 10), "uninstalled message archived").toBe(1);

      const [installedArchive] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${installedWebhookId}
      `;
      expect(parseInt(installedArchive.count, 10), "installed message archived").toBe(1);

      const [uninstalledDlq] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${uninstalledWebhookId}
      `;
      expect(parseInt(uninstalledDlq.count, 10), "no DLQ for uninstalled shop").toBe(0);
    } finally {
      await cleanupTestData([uninstalledDomain, installedDomain], suffix);
    }
  });
});
