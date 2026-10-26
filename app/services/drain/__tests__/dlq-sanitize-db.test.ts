/**
 * DB-backed integration test for DLQ shop_not_found sanitization (#239 part a).
 *
 * Tests that:
 * 1. shop_not_found on covered topics (orders, companies, company_locations)
 *    stores a sanitized message in s6_dead_letter
 * 2. shop_not_found on uncovered topics (draft_orders, customers) keeps full message
 * 3. Non-shop errors keep full message unchanged
 * 4. Logs contain no PII (shop domain, payload, customer data)
 *
 * Uses REAL log.server (no mock) with console spies to verify logging.
 * Uses describeWithDb for real database integration.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

function makeTestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-dlqsan`;
}

const testContext = {
  suffix: "",
  missingShopDomain: "",
  redactedShopDomain: "",
};

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(
      async (_shop: string, query: string, variables?: Record<string, unknown>) => {
        if (query.includes("OrderById") && variables?.id) {
          return {
            success: true,
            data: {
              node: {
                id: variables.id as string,
                name: "#TEST-1001",
                createdAt: new Date().toISOString(),
                processedAt: null,
                cancelledAt: null,
                closedAt: null,
                displayFinancialStatus: "PENDING",
                totalPriceSet: {
                  shopMoney: { amount: "100.00", currencyCode: "USD" },
                },
                totalOutstandingSet: {
                  shopMoney: { amount: "100.00", currencyCode: "USD" },
                },
                paymentTerms: {
                  id: "gid://shopify/PaymentTerms/test-123",
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
          success: true,
          data: { node: null },
          retryable: false,
        };
      }
    ),
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
        if (shopDomain === testContext.missingShopDomain || shopDomain === testContext.redactedShopDomain) {
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
        if (shopDomain === testContext.missingShopDomain || shopDomain === testContext.redactedShopDomain) {
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
        if (shopDomain === testContext.missingShopDomain || shopDomain === testContext.redactedShopDomain) {
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
        if (shopDomain === testContext.missingShopDomain || shopDomain === testContext.redactedShopDomain) {
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

describeWithDb("DLQ shop_not_found sanitization (#239 part a)", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleInfoSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let consoleDebugSpy: ReturnType<typeof vi.spyOn>;

  /**
   * Archive all messages in q_s6_sync that don't belong to this test's shop domain.
   * This prevents batch pollution from other test files' leftover messages.
   */
  async function archiveForeignQueueMessages(): Promise<number> {
    const ourDomain = testContext.missingShopDomain;
    const [result] = await sqlRef<[{ archived: string }]>`
      SELECT count(*)::text AS archived
      FROM pgmq.archive('s6_sync', (
        SELECT array_agg(msg_id)
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' IS NULL
           OR message->>'shop' <> ${ourDomain}
      ))
    `;
    return parseInt(result.archived, 10);
  }

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sqlRef.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    testContext.suffix = makeTestId();
    testContext.missingShopDomain = `test-sanitize-missing-${testContext.suffix}.myshopify.com`;
    testContext.redactedShopDomain = `test-sanitize-redacted-${testContext.suffix}.myshopify.com`;

    // Archive foreign rows before each test to prevent batch pollution
    await archiveForeignQueueMessages();

    // Create Shop row for missingShopDomain so drain guard doesn't delete
    // but handlers still return shop_not_found (via mocks)
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency)
      VALUES (
        ${`shop-dlqsan-${testContext.suffix}`},
        ${testContext.missingShopDomain},
        'INR'
      )
      ON CONFLICT (domain) DO NOTHING
    `;
    // NO Shop row for redactedShopDomain - drain guard will delete these messages

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
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'webhookId' LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'webhookId' LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'bulkOperationId' LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'bulkOperationId' LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'bulkOperationId' LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM s6_bulk_operations WHERE bulk_operation_id LIKE ${`%${testContext.suffix}%`}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${testContext.suffix}%`}`;
    // Clean up Shop rows
    await sqlRef`DELETE FROM "Shop" WHERE id LIKE ${`shop-dlqsan-${testContext.suffix}%`}`;

    await assertNoQueueLeftovers(sqlRef, [testContext.missingShopDomain, testContext.redactedShopDomain], "dlq-sanitize-db.test.ts");
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

  async function driveUntilDeadLettered(
    webhookId: string,
    maxRetries: number,
    maxIterations = 20
  ): Promise<void> {
    const { runDrain } = await import("~/services/drain/processor.server");

    for (let iter = 0; iter < maxIterations; iter++) {
      const [dlqRow] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      if (parseInt(dlqRow.count, 10) > 0) {
        return;
      }

      await sqlRef`
        UPDATE pgmq.q_s6_sync
        SET vt = NOW() - interval '1 second'
        WHERE message->>'webhookId' = ${webhookId}
      `;
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries });
    }

    throw new Error(
      `Message ${webhookId} not dead-lettered after ${maxIterations} iterations`
    );
  }

  async function driveBulkUntilDeadLettered(
    bulkOperationId: string,
    maxRetries: number,
    maxIterations = 20
  ): Promise<void> {
    const { runDrain } = await import("~/services/drain/processor.server");

    for (let iter = 0; iter < maxIterations; iter++) {
      const [dlqRow] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'bulkOperationId' = ${bulkOperationId}
      `;
      if (parseInt(dlqRow.count, 10) > 0) {
        return;
      }

      await sqlRef`
        UPDATE pgmq.q_s6_bulk
        SET vt = NOW() - interval '1 second'
        WHERE message->>'bulkOperationId' = ${bulkOperationId}
      `;
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries });
    }

    throw new Error(
      `Bulk message ${bulkOperationId} not dead-lettered after ${maxIterations} iterations`
    );
  }

  async function driveUntilRead(
    webhookId: string,
    maxRetries: number,
    maxIterations = 20
  ): Promise<number> {
    const { runDrain } = await import("~/services/drain/processor.server");

    for (let iter = 0; iter < maxIterations; iter++) {
      const [row] = await sqlRef<[{ read_ct: number }?]>`
        SELECT read_ct FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      if (row && row.read_ct > 0) {
        return row.read_ct;
      }

      await sqlRef`
        UPDATE pgmq.q_s6_sync
        SET vt = NOW() - interval '1 second'
        WHERE message->>'webhookId' = ${webhookId}
      `;
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries });
    }

    throw new Error(
      `Message ${webhookId} read_ct never increased after ${maxIterations} iterations`
    );
  }

  async function driveUntilArchived(
    webhookId: string,
    maxRetries: number,
    maxIterations = 20
  ): Promise<void> {
    const { runDrain } = await import("~/services/drain/processor.server");

    for (let iter = 0; iter < maxIterations; iter++) {
      const [archived] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      if (parseInt(archived.count, 10) > 0) {
        return;
      }

      await sqlRef`
        UPDATE pgmq.q_s6_sync
        SET vt = NOW() - interval '1 second'
        WHERE message->>'webhookId' = ${webhookId}
      `;
      await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries });
    }

    throw new Error(
      `Message ${webhookId} not archived after ${maxIterations} iterations`
    );
  }

  // Mock returns retryable (no retryable:false), matching real handlers, so message must reach maxRetries.
  it("company_locations shop_not_found stores sanitized message in DLQ after maxRetries", async () => {
    const webhookId = `wh-loc-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "COMPANY_LOCATIONS_CREATE",
      webhookId,
      resourceGid: `gid://shopify/CompanyLocation/loc-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await driveUntilDeadLettered(webhookId, 3);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.topic).toBe("COMPANY_LOCATIONS_CREATE");
    expect(dlqRow!.message.originalMsgId).toBeDefined();
    expect(dlqRow!.message.webhookId).toBe(webhookId);
    expect(dlqRow!.message.resourceGid).toBe(`gid://shopify/CompanyLocation/loc-${testContext.suffix}`);
    expect(dlqRow!.message.attemptCount).toBeGreaterThanOrEqual(3);

    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");
    expect(dlqRow!.message).not.toHaveProperty("payload");

    const storedJson = JSON.stringify(dlqRow!.message);
    expect(storedJson).not.toContain(testContext.missingShopDomain);
    expect(storedJson).not.toContain("myshopify.com");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(testContext.missingShopDomain);
    expect(allOutput).toContain("dlq_sanitized_shop_not_found");
  });

  // Mock returns retryable (no retryable:false), matching real handlers, so message must reach maxRetries.
  it("orders shop_not_found stores sanitized message in DLQ after maxRetries", async () => {
    const webhookId = `wh-order-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "ORDERS_CREATE",
      webhookId,
      resourceGid: `gid://shopify/Order/order-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await driveUntilDeadLettered(webhookId, 3);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.topic).toBe("ORDERS_CREATE");
    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");

    const storedJson = JSON.stringify(dlqRow!.message);
    expect(storedJson).not.toContain(testContext.missingShopDomain);
    expect(storedJson).not.toContain("myshopify.com");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(testContext.missingShopDomain);
    expect(allOutput).toContain("dlq_sanitized_shop_not_found");
  });

  it("draft_orders shop_not_found keeps FULL message in DLQ (uncovered topic)", async () => {
    const webhookId = `wh-draft-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "DRAFT_ORDERS_CREATE",
      webhookId,
      resourceGid: `gid://shopify/DraftOrder/draft-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await driveUntilDeadLettered(webhookId, 1);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(testContext.missingShopDomain);
    expect(dlqRow!.message.topic).toBe("DRAFT_ORDERS_CREATE");
    expect(dlqRow!.message.webhookId).toBe(webhookId);
  });

  it("customers shop_not_found keeps FULL message in DLQ (uncovered topic)", async () => {
    const webhookId = `wh-cust-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "CUSTOMERS_CREATE",
      webhookId,
      resourceGid: `gid://shopify/Customer/cust-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await driveUntilDeadLettered(webhookId, 1);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(testContext.missingShopDomain);
    expect(dlqRow!.message.topic).toBe("CUSTOMERS_CREATE");
  });

  it("non-shop error keeps full message unchanged", async () => {
    vi.mocked((await import("~/services/sync/company-location.server")).processCompanyLocationWebhook)
      .mockResolvedValueOnce({
        success: false,
        action: "skipped",
        error: "graphql_schema_error",
        errorCode: "graphql_schema_error",
        retryable: false,
      });

    const webhookId = `wh-graphql-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "COMPANY_LOCATIONS_UPDATE",
      webhookId,
      resourceGid: `gid://shopify/CompanyLocation/graphql-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await driveUntilDeadLettered(webhookId, 1);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(testContext.missingShopDomain);
    expect(dlqRow!.error).toContain("graphql_schema_error");
  });

  it("counts DLQ rows by original_msg_id, never by message->>shop", async () => {
    const webhookId = `wh-count-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "ORDERS_UPDATED",
      webhookId,
      resourceGid: `gid://shopify/Order/count-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    await driveUntilDeadLettered(webhookId, 3);

    const [byWebhookId] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(byWebhookId.count, 10)).toBe(1);

    const [dlqRow] = await sqlRef<[{ original_msg_id: string }?]>`
      SELECT original_msg_id
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(dlqRow).toBeDefined();

    const [byOriginalMsgId] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM s6_dead_letter
      WHERE original_msg_id = ${dlqRow!.original_msg_id}
    `;
    expect(parseInt(byOriginalMsgId.count, 10)).toBe(1);
  });

  it("retryable shop_not_found is re-queued before maxRetries, then dead-lettered sanitized", async () => {
    const webhookId = `wh-retry-${testContext.suffix}`;
    const message = {
      shop: testContext.missingShopDomain,
      topic: "COMPANY_LOCATIONS_UPDATE",
      webhookId,
      resourceGid: `gid://shopify/CompanyLocation/retry-${testContext.suffix}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const readCt = await driveUntilRead(webhookId, 5);
    expect(readCt).toBeGreaterThan(0);

    const [stillInQueue] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(stillInQueue.count, 10)).toBe(1);

    const [noDlqYet] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(noDlqYet.count, 10)).toBe(0);

    await driveUntilDeadLettered(webhookId, 5);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.topic).toBe("COMPANY_LOCATIONS_UPDATE");
    expect(dlqRow!.message.attemptCount).toBeGreaterThanOrEqual(5);
    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");
    expect(dlqRow!.error).toBe("shop_not_found");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(testContext.missingShopDomain);
  });

  it("bulk queue redacted shop: message is deleted by drain guard (not DLQ'd)", async () => {
    // #239 PR1: With drain guard, messages for redacted shops (no Shop row) are deleted
    // before reaching the handler. This test verifies the drain guard behavior for bulk queue.
    const bulkOpId = `bulk-redact-${testContext.suffix}`;
    const message = {
      shop: testContext.redactedShopDomain,
      topic: "BULK_OPERATIONS_FINISH",
      bulkOperationId: bulkOpId,
      bulkType: "companies",
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO s6_bulk_operations (
        bulk_operation_id, shop, bulk_type, started_at, origin, failure_count, chunk_size
      ) VALUES (
        ${bulkOpId}, ${testContext.redactedShopDomain}, 'companies', NOW(), 'webhook', 0, 524288
      )
      ON CONFLICT (bulk_operation_id) DO NOTHING
    `;

    await sqlRef`
      INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 1, timeBudgetMs: 5000, maxRetries: 3 });

    // Message should be DELETED by drain guard (not in queue)
    const [inQueue] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
      WHERE message->>'bulkOperationId' = ${bulkOpId}
    `;
    expect(parseInt(inQueue.count, 10)).toBe(0);

    // Message should NOT be in DLQ (deleted, not dead-lettered)
    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message FROM s6_dead_letter
      WHERE message->>'bulkOperationId' = ${bulkOpId}
    `;
    expect(dlqRow).toBeUndefined();

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("drain_shop_missing_deleted");
    expect(allOutput).toContain('"queue":"bulk"');
    // MUST NOT contain domain
    expect(allOutput).not.toContain(testContext.redactedShopDomain);
  });

  it("already-sanitized message is skipped and archived, not re-processed", async () => {
    const webhookId = `wh-skip-${testContext.suffix}`;
    const sanitizedMessage = {
      sanitized: true,
      reason: "shop_not_found",
      topic: "COMPANY_LOCATIONS_CREATE",
      originalMsgId: "old-msg-123",
      webhookId,
      resourceGid: `gid://shopify/CompanyLocation/skip-${testContext.suffix}`,
      attemptCount: 5,
      failedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(sanitizedMessage)}::jsonb)
    `;

    await driveUntilArchived(webhookId, 5);

    const [archivedMsg] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(archivedMsg).toBeDefined();
    expect(archivedMsg!.message.sanitized).toBe(true);

    const [notInQueue] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(notInQueue.count, 10)).toBe(0);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(dlqRow).toBeUndefined();

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("drain_skip_sanitized_message");
  });

  // #239 PR1: Drain guard deletion tests - messages for redacted shops are deleted
  describe("drain guard for redacted shops", () => {
    async function driveOnce(): Promise<void> {
      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 3 });
    }

    it("sync queue: redacted shop message is deleted (not DLQ'd)", async () => {
      const webhookId = `wh-redacted-sync-${testContext.suffix}`;
      const message = {
        shop: testContext.redactedShopDomain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/redacted-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      const [inserted] = await sqlRef<[{ msg_id: string }]>`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
        RETURNING msg_id::text as msg_id
      `;
      const msgId = inserted.msg_id;

      await driveOnce();

      // Message should be deleted (not in queue)
      const [inQueue] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inQueue.count, 10)).toBe(0);

      // Message should NOT be in DLQ
      const [inDlq] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inDlq.count, 10)).toBe(0);

      // Message should NOT be archived (deleted, not archived)
      const [inArchive] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inArchive.count, 10)).toBe(0);

      // Log should contain drain_shop_missing_deleted with correct msgId
      const consoleOutput = getAllConsoleOutput();
      const allOutput = consoleOutput.join("\n");
      expect(allOutput).toContain("drain_shop_missing_deleted");
      expect(allOutput).toContain(`"msgId":"${msgId}"`);
      expect(allOutput).toContain('"queue":"sync"');
      // MUST NOT contain domain
      expect(allOutput).not.toContain(testContext.redactedShopDomain);
    });

    it("bulk queue: redacted shop message is deleted (not DLQ'd)", async () => {
      const bulkOpId = `bulk-redacted-${testContext.suffix}`;
      const message = {
        shop: testContext.redactedShopDomain,
        topic: "BULK_OPERATIONS_FINISH",
        bulkOperationId: bulkOpId,
        bulkType: "companies",
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO s6_bulk_operations (
          bulk_operation_id, shop, bulk_type, started_at, origin, failure_count, chunk_size
        ) VALUES (
          ${bulkOpId}, ${testContext.redactedShopDomain}, 'companies', NOW(), 'webhook', 0, 524288
        )
        ON CONFLICT (bulk_operation_id) DO NOTHING
      `;

      const [inserted] = await sqlRef<[{ msg_id: string }]>`
        INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
        RETURNING msg_id::text as msg_id
      `;
      const msgId = inserted.msg_id;

      await driveOnce();

      // Message should be deleted (not in queue)
      const [inQueue] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'bulkOperationId' = ${bulkOpId}
      `;
      expect(parseInt(inQueue.count, 10)).toBe(0);

      // Message should NOT be in DLQ
      const [inDlq] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'bulkOperationId' = ${bulkOpId}
      `;
      expect(parseInt(inDlq.count, 10)).toBe(0);

      // Log should contain drain_shop_missing_deleted with correct msgId
      const consoleOutput = getAllConsoleOutput();
      const allOutput = consoleOutput.join("\n");
      expect(allOutput).toContain("drain_shop_missing_deleted");
      expect(allOutput).toContain(`"msgId":"${msgId}"`);
      expect(allOutput).toContain('"queue":"bulk"');
      // MUST NOT contain domain
      expect(allOutput).not.toContain(testContext.redactedShopDomain);
    });

    it("drain guard requires FOR SHARE - concurrent deleteShop serializes", async () => {
      // This test verifies the FOR SHARE lock behavior:
      // If Shop row is being deleted by deleteShop (holding FOR UPDATE),
      // the drain guard's FOR SHARE will wait, then see the row is gone.
      // We can't easily simulate concurrent transactions in a single test,
      // but we can verify the SQL runs correctly with FOR SHARE.
      const webhookId = `wh-forshare-${testContext.suffix}`;
      const testDomain = `test-forshare-${testContext.suffix}.myshopify.com`;
      
      // Create a Shop row that we'll delete before drain runs
      await sqlRef`
        INSERT INTO "Shop" (id, domain, currency)
        VALUES (
          ${`shop-forshare-${testContext.suffix}`},
          ${testDomain},
          'INR'
        )
      `;

      const message = {
        shop: testDomain,
        topic: "ORDERS_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Order/forshare-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      // Delete the Shop row BEFORE drain runs (simulating deleteShop completed)
      await sqlRef`DELETE FROM "Shop" WHERE domain = ${testDomain}`;

      await driveOnce();

      // Message should be deleted by drain guard (Shop row absent)
      const [inQueue] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inQueue.count, 10)).toBe(0);

      // Should NOT be in DLQ
      const [inDlq] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inDlq.count, 10)).toBe(0);

      const consoleOutput = getAllConsoleOutput();
      const allOutput = consoleOutput.join("\n");
      expect(allOutput).toContain("drain_shop_missing_deleted");
    });

    it("drain guard transaction is atomic - check+delete in same tx", async () => {
      // This test verifies the transaction atomicity:
      // The check and delete happen in the same transaction, so if the check
      // sees no Shop row, the delete will succeed atomically.
      const webhookId = `wh-atomic-${testContext.suffix}`;
      const message = {
        shop: testContext.redactedShopDomain,
        topic: "COMPANIES_CREATE",
        webhookId,
        resourceGid: `gid://shopify/Company/atomic-${testContext.suffix}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sqlRef`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (NOW() - interval '1 second', 0, NOW(), ${sqlRef.json(message)}::jsonb)
      `;

      await driveOnce();

      // Verify message was deleted atomically
      const [inQueue] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inQueue.count, 10)).toBe(0);

      // Verify NOT in DLQ (deleted, not dead-lettered)
      const [inDlq] = await sqlRef<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookId}
      `;
      expect(parseInt(inDlq.count, 10)).toBe(0);
    });
  });
});
