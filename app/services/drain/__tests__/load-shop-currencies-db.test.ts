/**
 * DB-backed tests for loadShopCurrencies IN-list query behavior.
 *
 * Tests the `IN ${sql(uniqueDomains)}` query path in loadShopCurrencies
 * (processor.server.ts ~:1320) through the exported runDrain entry point.
 *
 * Since loadShopCurrencies is private, we test it via runDrain which calls it
 * at lines ~:1355 (sync queue) and ~:1638 (bulk queue).
 *
 * Cases:
 * - Several shops with different currencies are loaded correctly
 * - Duplicate domains in message batch are deduplicated
 * - Unknown domain (shop not in DB) results in message deletion
 *
 * Uses the shared sqlOptions (fetch_types:false) to exercise the real query behavior.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Archive all s6_sync messages that don't belong to this file's test shops.
 * Prevents batch pollution from other Sequential DB test files' leftover messages.
 */
async function archiveStaleQueueMessages(
  sql: ReturnType<typeof postgres>,
  ourDomains: string[]
): Promise<number> {
  const [result] = await sql<[{ archived: string }]>`
    SELECT count(*)::text AS archived
    FROM pgmq.archive('s6_sync', (
      SELECT array_agg(msg_id)
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' IS NULL
         OR message->>'shop' NOT IN ${sql(ourDomains)}
    ))
  `;
  return parseInt(result.archived, 10);
}

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async (_shop: string, query: string, variables?: Record<string, unknown>) => {
      if (query.includes("OrderById") && variables?.id) {
        return {
          success: true,
          data: {
            node: {
              id: variables.id as string,
              name: "#TEST-CURR",
              createdAt: new Date().toISOString(),
              processedAt: null,
              cancelledAt: null,
              closedAt: null,
              displayFinancialStatus: "PENDING",
              totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
              totalOutstandingSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
              paymentTerms: {
                id: "gid://shopify/PaymentTerms/test-curr",
                paymentTermsName: "Net 30",
                paymentTermsType: "NET",
                dueInDays: 30,
              },
              purchasingEntity: null,
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
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
  };
});

describeWithDb("loadShopCurrencies IN-list query (DB-backed via runDrain)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `curr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  
  const SHOP_INR_ID = `shop-inr-${TEST_SUFFIX}`;
  const SHOP_INR_DOMAIN = `test-inr-${TEST_SUFFIX}.example.com`;
  
  const SHOP_USD_ID = `shop-usd-${TEST_SUFFIX}`;
  const SHOP_USD_DOMAIN = `test-usd-${TEST_SUFFIX}.example.com`;
  
  const SHOP_XXX_ID = `shop-xxx-${TEST_SUFFIX}`;
  const SHOP_XXX_DOMAIN = `test-xxx-${TEST_SUFFIX}.example.com`;
  
  const UNKNOWN_DOMAIN = `test-unknown-${TEST_SUFFIX}.example.com`;

  const testShopDomains = [SHOP_INR_DOMAIN, SHOP_USD_DOMAIN, SHOP_XXX_DOMAIN];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES 
        (${SHOP_INR_ID}, ${SHOP_INR_DOMAIN}, 'INR', NOW(), NOW()),
        (${SHOP_USD_ID}, ${SHOP_USD_DOMAIN}, 'USD', NOW(), NOW()),
        (${SHOP_XXX_ID}, ${SHOP_XXX_DOMAIN}, 'XXX', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    for (const domain of [...testShopDomains, UNKNOWN_DOMAIN]) {
      await sql`
        SELECT pgmq.archive('s6_sync', ARRAY(
          SELECT msg_id FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}
        ))
      `;
      await sql`
        DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${domain}
      `;
    }

    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`wh-curr-${TEST_SUFFIX}%`}`;
    await sql`DELETE FROM "Shop" WHERE id IN ${sql([SHOP_INR_ID, SHOP_USD_ID, SHOP_XXX_ID])}`;

    await assertNoQueueLeftovers(sql, testShopDomains, "load-shop-currencies-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Archive foreign queue rows to ensure runDrain processes only this file's messages
    await archiveStaleQueueMessages(sql, [...testShopDomains, UNKNOWN_DOMAIN]);
  });

  afterEach(async () => {
    for (const domain of [...testShopDomains, UNKNOWN_DOMAIN]) {
      await sql`
        SELECT pgmq.archive('s6_sync', ARRAY(
          SELECT msg_id FROM pgmq.q_s6_sync WHERE message->>'shop' = ${domain}
        ))
      `;
      await sql`
        DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${domain}
      `;
    }
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`wh-curr-${TEST_SUFFIX}%`}`;
  });

  it("INR and non-INR in same batch: INR processed (mock called), non-INR skipped", async () => {
    const { runDrain } = await import("../processor.server");
    const { adminGraphQL } = await import("~/services/drain/admin-client.server");
    const mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;

    const inrWebhookId = `wh-curr-inr-${Date.now()}-${TEST_SUFFIX}`;
    const usdWebhookId = `wh-curr-usd-${Date.now()}-${TEST_SUFFIX}`;
    const inrOrderGid = `gid://shopify/Order/inr-batch-${TEST_SUFFIX}`;
    const usdOrderGid = `gid://shopify/Order/usd-batch-${TEST_SUFFIX}`;

    const inrMessage = {
      shop: SHOP_INR_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: inrOrderGid,
      webhookId: inrWebhookId,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    const usdMessage = {
      shop: SHOP_USD_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: usdOrderGid,
      webhookId: usdWebhookId,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    await sql`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES
        (NOW() - interval '1 second', 0, NOW(), ${sql.json(inrMessage)}::jsonb),
        (NOW() - interval '1 second', 0, NOW(), ${sql.json(usdMessage)}::jsonb)
    `;

    await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

    const inrCalls = mockAdminGraphQL.mock.calls.filter(
      (call: unknown[]) => call[0] === SHOP_INR_DOMAIN
    );
    expect(inrCalls.length).toBeGreaterThanOrEqual(1);

    const usdCalls = mockAdminGraphQL.mock.calls.filter(
      (call: unknown[]) => call[0] === SHOP_USD_DOMAIN
    );
    expect(usdCalls.length).toBe(0);

    const [usdArchived] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${usdWebhookId}
    `;
    expect(parseInt(usdArchived.count, 10)).toBe(1);

    const [inrInQueue] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${inrWebhookId}
    `;
    const [inrArchived] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${inrWebhookId}
    `;
    const inrTotal = parseInt(inrInQueue.count, 10) + parseInt(inrArchived.count, 10);
    expect(inrTotal).toBeGreaterThanOrEqual(1);
  });

  it("duplicate domains in message batch are deduplicated", async () => {
    const { runDrain } = await import("../processor.server");

    const webhookId1 = `wh-curr-dup1-${Date.now()}-${TEST_SUFFIX}`;
    const webhookId2 = `wh-curr-dup2-${Date.now()}-${TEST_SUFFIX}`;
    const webhookId3 = `wh-curr-dup3-${Date.now()}-${TEST_SUFFIX}`;

    const message1 = {
      shop: SHOP_USD_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: `gid://shopify/Order/dup1-${TEST_SUFFIX}`,
      webhookId: webhookId1,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    const message2 = {
      shop: SHOP_USD_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: `gid://shopify/Order/dup2-${TEST_SUFFIX}`,
      webhookId: webhookId2,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    const message3 = {
      shop: SHOP_USD_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: `gid://shopify/Order/dup3-${TEST_SUFFIX}`,
      webhookId: webhookId3,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    await sql`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES
        (NOW() - interval '1 second', 0, NOW(), ${sql.json(message1)}::jsonb),
        (NOW() - interval '1 second', 0, NOW(), ${sql.json(message2)}::jsonb),
        (NOW() - interval '1 second', 0, NOW(), ${sql.json(message3)}::jsonb)
    `;

    const result = await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

    expect(result.skipped).toBeGreaterThanOrEqual(3);

    const allWebhookIds = [webhookId1, webhookId2, webhookId3];
    for (const whId of allWebhookIds) {
      const [archived] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM pgmq.a_s6_sync
        WHERE message->>'webhookId' = ${whId}
      `;
      expect(parseInt(archived.count, 10)).toBe(1);
    }
  });

  it("unknown domain (shop not in DB) message is deleted", async () => {
    const { runDrain } = await import("../processor.server");

    const webhookId = `wh-curr-unknown-${Date.now()}-${TEST_SUFFIX}`;

    const unknownMessage = {
      shop: UNKNOWN_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: `gid://shopify/Order/unknown-${TEST_SUFFIX}`,
      webhookId: webhookId,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    await sql`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sql.json(unknownMessage)}::jsonb)
    `;

    const [beforeCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(beforeCount.count, 10)).toBe(1);

    await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

    const [afterCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(afterCount.count, 10)).toBe(0);

    const [archivedCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(archivedCount.count, 10)).toBe(0);
  });

  it("shop with XXX currency is treated as non-INR (fail-closed)", async () => {
    const { runDrain } = await import("../processor.server");

    const webhookId = `wh-curr-xxx-${Date.now()}-${TEST_SUFFIX}`;

    const xxxCurrencyMessage = {
      shop: SHOP_XXX_DOMAIN,
      topic: "ORDERS_CREATE",
      resourceGid: `gid://shopify/Order/xxx-${TEST_SUFFIX}`,
      webhookId: webhookId,
      enqueuedAt: new Date().toISOString(),
      triggeredAt: new Date().toISOString(),
    };

    await sql`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 0, NOW(), ${sql.json(xxxCurrencyMessage)}::jsonb)
    `;

    await runDrain(sql, { batchSize: 10, timeBudgetMs: 5000 });

    const [remaining] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(remaining.count, 10)).toBe(0);

    const [archived] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(archived.count, 10)).toBe(1);
  });
});
