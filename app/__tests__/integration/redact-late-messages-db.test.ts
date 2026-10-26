/**
 * DB-backed integration test for #239 PR1: drain guard deletes messages for redacted shops.
 *
 * Tests that late or in-flight queue messages for shops that have been redacted (Shop row
 * deleted via deleteShop) are deleted from the queue rather than being processed, archived,
 * or dead-lettered. This prevents post-redact data from being written or retained.
 *
 * PR1 Cases (late messages - enqueued after deleteShop commits):
 * 1. COMPANIES_DELETE
 * 2. COMPANIES_UPDATE null-node
 * 3. CUSTOMERS_CREATE
 * 4. CUSTOMERS_DELETE
 * 5. DRAFT_ORDERS_UPDATE
 * 6. DRAFT_ORDERS_DELETE
 * 7. ORDERS_UPDATED no_session ACK
 * 8. ORDERS_CREATE redelivery
 * 9. CREDIT_STATUS_RECOMPUTE
 * 10. RECONCILE_CUSTOMERS
 * 11. REMINDER_SEND
 * 12. BULK_OPERATIONS_FINISH (bulk queue)
 *
 * PR2 Cases (out of scope, in-flight counters):
 * 13. ORDERS null-refetch counter
 * 14. recompute enqueue race
 * 15. Edge: late webhook through route
 *
 * Additional required tests:
 * - DB error during the Shop check stays retryable (message not deleted)
 * - Uninstalled-but-not-redacted shop handled as today (not deleted)
 * - Leak test: no domain, shop, or webhookId in any logged value
 *
 * Uses describeWithDb for real Postgres integration.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-rlt`;
}

const testContext = {
  suffix: "",
  shopA: {
    id: "",
    domain: "",
  },
  shopB: {
    id: "",
    domain: "",
  },
  nearMissX: {
    id: "",
    domain: "",
  },
  nearMissUpper: {
    id: "",
    domain: "",
  },
};

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (shop: string, query: string) => {
      if (shop === testContext.shopA.domain) {
        return {
          success: false,
          error: "no_session",
          errorCode: "no_session",
          retryable: false,
        };
      }
      if (query.includes("bulkOperationRunQuery")) {
        return {
          success: false,
          error: "no_session",
          errorCode: "no_session",
          retryable: false,
        };
      }
      return { success: true, data: { node: null } };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
    processCompanyWebhook: actual.processCompanyWebhook,
  };
});

vi.mock("~/services/sync/company-location.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company-location.server")>();
  return {
    ...actual,
    processCompanyLocationWebhook: vi.fn().mockImplementation(
      async (_sql: unknown, shopDomain: string) => {
        if (shopDomain === testContext.shopA.domain) {
          return {
            success: false,
            action: "skipped",
            error: "shop_not_found",
            errorCode: "shop_not_found",
          };
        }
        return { success: true, action: "created" };
      }
    ),
  };
});

vi.mock("~/services/sync/order.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/order.server")>();
  return {
    ...actual,
    processOrderWebhook: vi.fn().mockImplementation(
      async (_sql: unknown, shopDomain: string) => {
        if (shopDomain === testContext.shopA.domain) {
          return {
            success: false,
            action: "skipped",
            error: "shop_not_found",
            errorCode: "shop_not_found",
          };
        }
        return { success: true, action: "created" };
      }
    ),
  };
});

vi.mock("~/services/sync/draft-order.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/draft-order.server")>();
  return {
    ...actual,
    processDraftOrderWebhook: vi.fn().mockImplementation(
      async (_sql: unknown, shopDomain: string) => {
        if (shopDomain === testContext.shopA.domain) {
          return {
            success: false,
            action: "skipped",
            error: `Shop not found: ${shopDomain}`,
            retryable: false,
          };
        }
        return { success: true, action: "created" };
      }
    ),
  };
});

vi.mock("~/services/sync/customer.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/customer.server")>();
  return {
    ...actual,
    processCustomerWebhook: vi.fn().mockImplementation(
      async (_sql: unknown, shopDomain: string) => {
        if (shopDomain === testContext.shopA.domain) {
          return {
            success: false,
            action: "skipped",
            error: `Shop not found: ${shopDomain}`,
            retryable: false,
          };
        }
        return { success: true, action: "created" };
      }
    ),
    getTagRules: vi.fn().mockResolvedValue([]),
  };
});

vi.mock("~/services/sync/bulk-jsonl-processor.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/bulk-jsonl-processor.server")>();
  return {
    ...actual,
    processBulkOperation: vi.fn().mockImplementation(async (_sql: unknown, message: { shop: string }) => {
      if (message.shop === testContext.shopA.domain) {
        return {
          success: false,
          error: "shop_not_found",
          errorCode: "shop_not_found",
          errorType: "permanent" as const,
        };
      }
      return { success: true, action: "skipped" };
    }),
    markNextStageEnqueued: actual.markNextStageEnqueued,
  };
});

describeWithDb("redact-late-messages: drain guard deletes messages for redacted shops (#239 PR1)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    testContext.suffix = makeTestId();

    testContext.shopA = {
      id: `shop-a-${testContext.suffix}`,
      domain: `test-redact-late-a-${testContext.suffix}.myshopify.com`,
    };
    testContext.shopB = {
      id: `shop-b-${testContext.suffix}`,
      domain: `test-redact-late-b-${testContext.suffix}.myshopify.com`,
    };
    testContext.nearMissX = {
      id: `shop-x-${testContext.suffix}`,
      domain: `test-redact-late-ax-${testContext.suffix}.myshopify.com`,
    };
    testContext.nearMissUpper = {
      id: `shop-upper-${testContext.suffix}`,
      domain: `TEST-REDACT-LATE-A-${testContext.suffix}.myshopify.com`,
    };

    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();

    const allDomains = [
      testContext.shopA.domain,
      testContext.shopB.domain,
      testContext.nearMissX.domain,
      testContext.nearMissUpper.domain,
    ];
    const allIds = [
      testContext.shopA.id,
      testContext.shopB.id,
      testContext.nearMissX.id,
      testContext.nearMissUpper.id,
    ];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_bulk_operations WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM order_outstanding_missing WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_reconcile_stage_claims WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM webhook_receipts WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM "Session" WHERE shop IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM "Shop" WHERE id IN ${sqlRef(allIds)}`;

    await assertNoQueueLeftovers(sqlRef, allDomains, "redact-late-messages-db.test.ts");
  });

  function getAllConsoleOutput(): string[] {
    const allCalls = [
      ...consoleLogSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
    ];
    return allCalls.map(args =>
      args.map((arg: unknown) =>
        typeof arg === "object" ? JSON.stringify(arg) : String(arg)
      ).join(" ")
    );
  }

  async function setupShops(): Promise<void> {
    const now = new Date();
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${testContext.shopA.id}, ${testContext.shopA.domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
    `;
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${testContext.shopB.id}, ${testContext.shopB.domain}, 'INR', ${now}, ${now})
    `;
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${testContext.nearMissX.id}, ${testContext.nearMissX.domain}, 'INR', ${now}, ${now})
    `;

    await sqlRef`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + testContext.shopB.domain}, ${testContext.shopB.domain}, 'test-state', false, 'test-token')
    `;
    await sqlRef`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + testContext.nearMissX.domain}, ${testContext.nearMissX.domain}, 'test-state', false, 'test-token')
    `;
  }

  async function deleteShopA(): Promise<void> {
    const { deleteShop } = await import("~/services/compliance/compliance.server");
    await deleteShop(sqlRef, testContext.shopA.domain);
  }

  async function assertShopAZeroRows(): Promise<void> {
    const domain = testContext.shopA.domain;

    const [qSync] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}
    `;
    expect(parseInt(qSync.count, 10), "q_s6_sync for shop A").toBe(0);

    const [qBulk] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${domain}
    `;
    expect(parseInt(qBulk.count, 10), "q_s6_bulk for shop A").toBe(0);

    const [aSync] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE message->>'shop' = ${domain}
    `;
    expect(parseInt(aSync.count, 10), "a_s6_sync for shop A").toBe(0);

    const [aBulk] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${domain}
    `;
    expect(parseInt(aBulk.count, 10), "a_s6_bulk for shop A").toBe(0);

    const [dlq] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE message->>'shop' = ${domain}
    `;
    expect(parseInt(dlq.count, 10), "s6_dead_letter for shop A").toBe(0);

    const reconcilePrefix = `reconcile:${domain}:`;
    const [processed] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_processed_webhooks 
      WHERE left(webhook_id, length(${reconcilePrefix})) = ${reconcilePrefix}
    `;
    expect(parseInt(processed.count, 10), "s6_processed_webhooks reconcile for shop A").toBe(0);

    const [refetch] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s10b_order_refetch_null WHERE shop = ${domain}
    `;
    expect(parseInt(refetch.count, 10), "s10b_order_refetch_null for shop A").toBe(0);

    const [bulkOps] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_bulk_operations WHERE shop = ${domain}
    `;
    expect(parseInt(bulkOps.count, 10), "s6_bulk_operations for shop A").toBe(0);

    const [outstanding] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM order_outstanding_missing WHERE shop = ${domain}
    `;
    expect(parseInt(outstanding.count, 10), "order_outstanding_missing for shop A").toBe(0);

    const [piiFallback] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s10b_customer_pii_fallback WHERE shop = ${domain}
    `;
    expect(parseInt(piiFallback.count, 10), "s10b_customer_pii_fallback for shop A").toBe(0);

    const [claims] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_reconcile_stage_claims WHERE shop = ${domain}
    `;
    expect(parseInt(claims.count, 10), "s6_reconcile_stage_claims for shop A").toBe(0);

    const [shop] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${testContext.shopA.id}
    `;
    expect(parseInt(shop.count, 10), "Shop row for shop A").toBe(0);
  }

  async function assertShopBUntouched(): Promise<void> {
    const [shop] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${testContext.shopB.id}
    `;
    expect(parseInt(shop.count, 10), "Shop B should remain").toBe(1);
  }

  async function assertNearMissXUntouched(): Promise<void> {
    const [shop] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${testContext.nearMissX.id}
    `;
    expect(parseInt(shop.count, 10), "Near-miss X shop should remain").toBe(1);
  }

  describe("Late message cases (enqueued after deleteShop)", () => {
    it("Case 1: COMPANIES_DELETE late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `wh-companies-delete-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "COMPANIES_DELETE",
        webhookId,
        resourceGid: `gid://shopify/Company/comp-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
      await assertShopBUntouched();
      await assertNearMissXUntouched();

      const output = getAllConsoleOutput().join("\n");
      expect(output).toContain("drain_shop_missing_deleted");
    });

    it("Case 3: CUSTOMERS_CREATE late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `wh-customers-create-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "CUSTOMERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Customer/cust-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
      await assertShopBUntouched();
    });

    it("Case 5: DRAFT_ORDERS_UPDATE late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `wh-draft-update-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "DRAFT_ORDERS_UPDATE",
        webhookId,
        resourceGid: `gid://shopify/DraftOrder/draft-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
    });

    it("Case 7: ORDERS_UPDATED late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `wh-orders-updated-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "ORDERS_UPDATED",
        webhookId,
        resourceGid: `gid://shopify/Order/order-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
    });

    it("Case 9: CREDIT_STATUS_RECOMPUTE late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `credit_recompute:${testContext.shopA.domain}:${Date.now()}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "CREDIT_STATUS_RECOMPUTE",
        webhookId,
        resourceGid: `buyer-${testContext.suffix}`,
        buyerAccountId: `buyer-${testContext.suffix}`,
        source: "invoice_change",
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
    });

    it("Case 10: RECONCILE_CUSTOMERS late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const today = new Date().toISOString().split("T")[0];
      const webhookId = `reconcile:${testContext.shopA.domain}:${today}:customers`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "RECONCILE_CUSTOMERS",
        webhookId,
        resourceGid: testContext.shopA.id,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
    });

    it("Case 11: REMINDER_SEND late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `reminder:${testContext.shopA.domain}:${Date.now()}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "REMINDER_SEND",
        webhookId,
        resourceGid: `invoice-${testContext.suffix}`,
        ruleId: `rule-${testContext.suffix}`,
        invoiceId: `invoice-${testContext.suffix}`,
        buyerAccountId: `buyer-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();
    });

    it("Case 12: BULK_OPERATIONS_FINISH late message is deleted", async () => {
      await setupShops();
      await deleteShopA();

      const bulkOpId = `gid://shopify/BulkOperation/bulk-${testContext.suffix}`;
      const webhookId = `wh-bulk-finish-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "BULK_OPERATIONS_FINISH",
        webhookId,
        bulkOperationId: bulkOpId,
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      const [qBulk] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk 
        WHERE message->>'shop' = ${testContext.shopA.domain}
      `;
      expect(parseInt(qBulk.count, 10)).toBe(0);

      const [dlq] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter 
        WHERE message->>'shop' = ${testContext.shopA.domain}
      `;
      expect(parseInt(dlq.count, 10)).toBe(0);

      const output = getAllConsoleOutput().join("\n");
      expect(output).toContain("drain_shop_missing_deleted");
      expect(output).toContain('"queue":"bulk"');
    });
  });

  describe("Error handling and edge cases", () => {
    it("Message for existing shop (uninstalled but not redacted) proceeds to handler", async () => {
      const now = new Date();
      const uninstalledAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
      
      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${testContext.shopA.id}, ${testContext.shopA.domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;

      const webhookId = `wh-exists-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/order-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      const [shopRow] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${testContext.shopA.id}
      `;
      expect(parseInt(shopRow.count, 10), "Shop row should still exist").toBe(1);

      const output = getAllConsoleOutput().join("\n");
      expect(output).not.toContain("drain_shop_missing_deleted");
    });

    it("Shop B and near-miss X messages are NOT affected when shop A is redacted", async () => {
      await setupShops();

      const webhookIdA = `wh-a-${testContext.suffix}`;
      const webhookIdB = `wh-b-${testContext.suffix}`;
      const webhookIdX = `wh-x-${testContext.suffix}`;

      const messageA = {
        shop: testContext.shopA.domain,
        topic: "ORDERS_CREATE",
        webhookId: webhookIdA,
        resourceGid: `gid://shopify/Order/a-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };
      const messageB = {
        shop: testContext.shopB.domain,
        topic: "ORDERS_CREATE",
        webhookId: webhookIdB,
        resourceGid: `gid://shopify/Order/b-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };
      const messageX = {
        shop: testContext.nearMissX.domain,
        topic: "ORDERS_CREATE",
        webhookId: webhookIdX,
        resourceGid: `gid://shopify/Order/x-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(messageB)}, 3600)`;
      await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(messageX)}, 3600)`;

      await deleteShopA();

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(messageA)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

      await assertShopAZeroRows();

      const [bQueue] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync 
        WHERE message->>'webhookId' = ${webhookIdB}
      `;
      expect(parseInt(bQueue.count, 10), "Shop B message should remain").toBe(1);

      const [xQueue] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync 
        WHERE message->>'webhookId' = ${webhookIdX}
      `;
      expect(parseInt(xQueue.count, 10), "Near-miss X message should remain").toBe(1);

      await assertShopBUntouched();
      await assertNearMissXUntouched();
    });

    it("Reinstall race: Shop row reappears before re-check - message NOT deleted", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `wh-reinstall-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/reinstall-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() + interval '10 seconds', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const now = new Date();
      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
        VALUES (${testContext.shopA.id}, ${testContext.shopA.domain}, 'INR', ${now}, ${now})
      `;

      await sqlRef`
        UPDATE pgmq.q_s6_sync
        SET vt = NOW() - interval '1 second'
        WHERE message->>'webhookId' = ${webhookId}
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      const output = getAllConsoleOutput().join("\n");
      expect(output).not.toContain("drain_shop_missing_deleted");

      const [shopRow] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM "Shop" WHERE id = ${testContext.shopA.id}
      `;
      expect(parseInt(shopRow.count, 10), "Shop A should exist after reinstall").toBe(1);
    });
  });

  describe("Logging leak test (real safeLog, no mocks)", () => {
    it("drain_shop_missing_deleted log contains no domain, shop, or webhookId", async () => {
      await setupShops();
      await deleteShopA();

      const webhookId = `wh-leak-test-${testContext.suffix}`;
      const message = {
        shop: testContext.shopA.domain,
        topic: "COMPANIES_DELETE",
        webhookId,
        resourceGid: `gid://shopify/Company/leak-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 5 });

      const allOutput = getAllConsoleOutput();
      
      const drainShopMissingLogs = allOutput.filter(line => 
        line.includes("drain_shop_missing_deleted")
      );
      expect(drainShopMissingLogs.length).toBeGreaterThan(0);

      for (const logLine of drainShopMissingLogs) {
        expect(logLine).not.toContain(testContext.shopA.domain);
        expect(logLine).not.toContain("myshopify.com");
        expect(logLine).not.toContain(webhookId);
        expect(logLine).not.toContain("wh-leak-test");
        expect(logLine).not.toContain("payload");
        expect(logLine).not.toContain("shpat_");
        expect(logLine).not.toContain("shpua_");
        
        expect(logLine).toContain('"queue":"sync"');
        expect(logLine).toContain('"topic":"COMPANIES_DELETE"');
        expect(logLine).toContain('"msg_id"');
        expect(logLine).toContain('"count":1');
        
        const parsed = JSON.parse(logLine);
        const allowedKeys = ["event", "queue", "topic", "msg_id", "count"];
        const actualKeys = Object.keys(parsed);
        expect(actualKeys.sort()).toEqual(allowedKeys.sort());
      }

      for (const logLine of allOutput) {
        expect(logLine).not.toContain(testContext.shopA.domain);
      }
    });
  });
});
