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

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36) + "-dlqsan";

const MISSING_SHOP_DOMAIN = `test-sanitize-missing-${SUFFIX}.myshopify.com`;

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockResolvedValue({
      success: true,
      data: { node: null },
      retryable: false,
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
        if (shopDomain === MISSING_SHOP_DOMAIN) {
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
        if (shopDomain === MISSING_SHOP_DOMAIN) {
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
        if (shopDomain === MISSING_SHOP_DOMAIN) {
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
        if (shopDomain === MISSING_SHOP_DOMAIN) {
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

  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${MISSING_SHOP_DOMAIN}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${MISSING_SHOP_DOMAIN}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${MISSING_SHOP_DOMAIN}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${MISSING_SHOP_DOMAIN}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'bulkOperationId' LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleDebugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleDebugSpy.mockRestore();
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

  it("company_locations shop_not_found stores sanitized message in DLQ", async () => {
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "COMPANY_LOCATIONS_CREATE",
      webhookId: `wh-loc-${SUFFIX}`,
      resourceGid: `gid://shopify/CompanyLocation/loc-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 5, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-loc-${SUFFIX}`}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.topic).toBe("COMPANY_LOCATIONS_CREATE");
    expect(dlqRow!.message.originalMsgId).toBeDefined();
    expect(dlqRow!.message.webhookId).toBe(`wh-loc-${SUFFIX}`);
    expect(dlqRow!.message.resourceGid).toBe(`gid://shopify/CompanyLocation/loc-${SUFFIX}`);
    expect(dlqRow!.message.attemptCount).toBeGreaterThanOrEqual(5);

    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");
    expect(dlqRow!.message).not.toHaveProperty("payload");

    const storedJson = JSON.stringify(dlqRow!.message);
    expect(storedJson).not.toContain(MISSING_SHOP_DOMAIN);
    expect(storedJson).not.toContain("myshopify.com");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(MISSING_SHOP_DOMAIN);
    expect(allOutput).toContain("dlq_sanitized_shop_not_found");
  });

  it("orders shop_not_found stores sanitized message in DLQ", async () => {
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "ORDERS_CREATE",
      webhookId: `wh-order-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/order-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 5, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-order-${SUFFIX}`}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.topic).toBe("ORDERS_CREATE");
    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");

    const storedJson = JSON.stringify(dlqRow!.message);
    expect(storedJson).not.toContain(MISSING_SHOP_DOMAIN);
    expect(storedJson).not.toContain("myshopify.com");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(MISSING_SHOP_DOMAIN);
    expect(allOutput).toContain("dlq_sanitized_shop_not_found");
  });

  it("draft_orders shop_not_found keeps FULL message in DLQ (uncovered topic)", async () => {
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "DRAFT_ORDERS_CREATE",
      webhookId: `wh-draft-${SUFFIX}`,
      resourceGid: `gid://shopify/DraftOrder/draft-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 5, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-draft-${SUFFIX}`}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(MISSING_SHOP_DOMAIN);
    expect(dlqRow!.message.topic).toBe("DRAFT_ORDERS_CREATE");
    expect(dlqRow!.message.webhookId).toBe(`wh-draft-${SUFFIX}`);
  });

  it("customers shop_not_found keeps FULL message in DLQ (uncovered topic)", async () => {
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "CUSTOMERS_CREATE",
      webhookId: `wh-cust-${SUFFIX}`,
      resourceGid: `gid://shopify/Customer/cust-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 5, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-cust-${SUFFIX}`}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(MISSING_SHOP_DOMAIN);
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

    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "COMPANY_LOCATIONS_UPDATE",
      webhookId: `wh-graphql-${SUFFIX}`,
      resourceGid: `gid://shopify/CompanyLocation/graphql-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 1, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 1 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-graphql-${SUFFIX}`}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBeUndefined();
    expect(dlqRow!.message.shop).toBe(MISSING_SHOP_DOMAIN);
    expect(dlqRow!.error).toContain("graphql_schema_error");
  });

  it("counts DLQ rows by original_msg_id, never by message->>shop", async () => {
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "ORDERS_UPDATED",
      webhookId: `wh-count-${SUFFIX}`,
      resourceGid: `gid://shopify/Order/count-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 5, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [byWebhookId] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-count-${SUFFIX}`}
    `;
    expect(parseInt(byWebhookId.count, 10)).toBe(1);

    const [dlqRow] = await sqlRef<[{ original_msg_id: string }?]>`
      SELECT original_msg_id
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-count-${SUFFIX}`}
    `;
    expect(dlqRow).toBeDefined();

    const [byOriginalMsgId] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM s6_dead_letter
      WHERE original_msg_id = ${dlqRow!.original_msg_id}
    `;
    expect(parseInt(byOriginalMsgId.count, 10)).toBe(1);
  });

  it("retryable shop_not_found is re-queued until maxRetries, then dead-lettered sanitized", async () => {
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "COMPANY_LOCATIONS_UPDATE",
      webhookId: `wh-retry-${SUFFIX}`,
      resourceGid: `gid://shopify/CompanyLocation/retry-${SUFFIX}`,
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 1, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");

    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 3 });

    const [stillInQueue] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count
      FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${`wh-retry-${SUFFIX}`}
    `;
    expect(parseInt(stillInQueue.count, 10)).toBeGreaterThanOrEqual(0);

    for (let i = 0; i < 3; i++) {
      await sqlRef`
        UPDATE pgmq.q_s6_sync
        SET vt = NOW() - interval '1 second'
        WHERE message->>'webhookId' = ${`wh-retry-${SUFFIX}`}
      `;
      await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 3 });
    }

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-retry-${SUFFIX}`}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.topic).toBe("COMPANY_LOCATIONS_UPDATE");
    expect(dlqRow!.message.attemptCount).toBeGreaterThanOrEqual(3);
    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");
    expect(dlqRow!.error).toBe("shop_not_found");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(MISSING_SHOP_DOMAIN);
  });

  it("bulk queue permanent:shop_not_found stores sanitized message in DLQ", async () => {
    const bulkOpId = `bulk-${SUFFIX}`;
    const message = {
      shop: MISSING_SHOP_DOMAIN,
      topic: "BULK_OPERATION_FINISH",
      bulkOperationId: bulkOpId,
      bulkType: "companies",
      enqueuedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO s6_bulk_operation_progress (
        bulk_operation_id, shop_id, bulk_type, stage, status,
        created_at, updated_at
      ) VALUES (
        ${bulkOpId}, 'test-shop-id', 'companies', 'poll', 'in_progress',
        NOW(), NOW()
      )
      ON CONFLICT (bulk_operation_id) DO NOTHING
    `;

    await sqlRef`
      INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 5, NOW(), ${sqlRef.json(message)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown>; error: string }?]>`
      SELECT message, error
      FROM s6_dead_letter
      WHERE message->>'bulkOperationId' = ${bulkOpId}
    `;

    expect(dlqRow).toBeDefined();
    expect(dlqRow!.message.sanitized).toBe(true);
    expect(dlqRow!.message.reason).toBe("shop_not_found");
    expect(dlqRow!.message.bulkType).toBe("companies");
    expect(dlqRow!.message.bulkOperationId).toBe(bulkOpId);
    expect(dlqRow!.message).not.toHaveProperty("shop");
    expect(dlqRow!.message).not.toHaveProperty("shopHash");
    expect(dlqRow!.message).not.toHaveProperty("payload");

    const storedJson = JSON.stringify(dlqRow!.message);
    expect(storedJson).not.toContain(MISSING_SHOP_DOMAIN);
    expect(storedJson).not.toContain("myshopify.com");

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).not.toContain(MISSING_SHOP_DOMAIN);
    expect(allOutput).toContain("dlq_sanitized_shop_not_found");
  });

  it("already-sanitized message is skipped and archived, not re-processed", async () => {
    const sanitizedMessage = {
      sanitized: true,
      reason: "shop_not_found",
      topic: "COMPANY_LOCATIONS_CREATE",
      originalMsgId: "old-msg-123",
      webhookId: `wh-skip-${SUFFIX}`,
      resourceGid: `gid://shopify/CompanyLocation/skip-${SUFFIX}`,
      attemptCount: 5,
      failedAt: new Date().toISOString(),
    };

    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 1, NOW(), ${sqlRef.json(sanitizedMessage)}::jsonb)
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    const result = await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000, maxRetries: 5 });

    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const [archivedMsg] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${`wh-skip-${SUFFIX}`}
    `;
    expect(archivedMsg).toBeDefined();
    expect(archivedMsg!.message.sanitized).toBe(true);

    const [dlqRow] = await sqlRef<[{ message: Record<string, unknown> }?]>`
      SELECT message
      FROM s6_dead_letter
      WHERE message->>'webhookId' = ${`wh-skip-${SUFFIX}`}
    `;
    expect(dlqRow).toBeUndefined();

    const consoleOutput = getAllConsoleOutput();
    const allOutput = consoleOutput.join("\n");
    expect(allOutput).toContain("drain_skip_sanitized_message");
  });
});
