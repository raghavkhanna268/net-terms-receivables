/**
 * DB-backed integration tests for customer redaction queue cleanup and
 * isCustomerRedacted check in customer sync handlers.
 *
 * Tests:
 * - Queue purge: redactCustomer removes customer-scoped messages from
 *   pgmq.q_s6_sync, pgmq.a_s6_sync, s6_dead_letter
 * - isCustomerRedacted check: processCustomerWebhook and processBulkCustomer
 *   skip processing for redacted customers
 *
 * Uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36) + "-redact-queues";

const SHOP_A = {
  id: `shop-a-${SUFFIX}`,
  domain: `test-redact-a-${SUFFIX}.myshopify.com`,
};
const SHOP_B = {
  id: `shop-b-${SUFFIX}`,
  domain: `test-redact-b-${SUFFIX}.myshopify.com`,
};

const CUSTOMER_X_GID = `gid://shopify/Customer/9000000001${SUFFIX.slice(0, 6)}`;
const CUSTOMER_Y_GID = `gid://shopify/Customer/9000000002${SUFFIX.slice(0, 6)}`;

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async () => {
      return {
        success: true,
        data: {
          node: {
            id: CUSTOMER_X_GID,
            tags: ["net-terms"],
            email: "test-buyer@example.com",
            displayName: "Test Buyer",
          },
        },
      };
    }),
  };
});

describeWithDb("redactCustomer queue cleanup", () => {
  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A.id}, ${SHOP_A.domain}, 'INR', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B.id}, ${SHOP_B.domain}, 'INR', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    await sqlRef`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${SHOP_A.id}, 'net-terms', 30, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;
    await sqlRef`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${SHOP_B.id}, 'net-terms', 30, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;
  });

  afterAll(async () => {
    const allDomains = [SHOP_A.domain, SHOP_B.domain];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A.id}, ${SHOP_B.id})`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A.id}, ${SHOP_B.id})`;
    await sqlRef`DELETE FROM "AccountSource" WHERE "shopId" IN (${SHOP_A.id}, ${SHOP_B.id})`;
    await sqlRef`DELETE FROM "Shop" WHERE id IN (${SHOP_A.id}, ${SHOP_B.id})`;

    await assertNoQueueLeftovers(sqlRef, allDomains, "redact-customer-queues-db.test.ts");

    await sqlRef.end();
  });

  beforeEach(async () => {
    const allDomains = [SHOP_A.domain, SHOP_B.domain];
    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A.id}, ${SHOP_B.id})`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A.id}, ${SHOP_B.id})`;
  });

  async function seedQueuesForPurgeTest(): Promise<{
    queueMsgIds: Map<string, bigint>;
    archiveMsgIds: Map<string, bigint>;
    dlqIds: Map<string, string>;
    bulkMsgIds: Map<string, bigint>;
  }> {
    const now = new Date();
    const queueMsgIds = new Map<string, bigint>();
    const archiveMsgIds = new Map<string, bigint>();
    const dlqIds = new Map<string, string>();
    const bulkMsgIds = new Map<string, bigint>();

    const messages = [
      { key: "X@A-queue", shop: SHOP_A.domain, gid: CUSTOMER_X_GID, topic: "CUSTOMERS_UPDATE" },
      { key: "Y@A-queue", shop: SHOP_A.domain, gid: CUSTOMER_Y_GID, topic: "CUSTOMERS_UPDATE" },
      { key: "X@B-queue", shop: SHOP_B.domain, gid: CUSTOMER_X_GID, topic: "CUSTOMERS_UPDATE" },
      { key: "CL@A-queue", shop: SHOP_A.domain, gid: `gid://shopify/CompanyLocation/${SUFFIX}`, topic: "COMPANY_LOCATIONS_UPDATE" },
    ];

    for (const m of messages) {
      const [result] = await sqlRef<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sqlRef.json({
          shop: m.shop,
          topic: m.topic,
          webhookId: `wh-q-${m.key}-${SUFFIX}`,
          resourceGid: m.gid,
          enqueuedAt: now.toISOString(),
        })})
      `;
      queueMsgIds.set(m.key, BigInt(result.send));
    }

    for (const m of messages) {
      const [result] = await sqlRef<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sqlRef.json({
          shop: m.shop,
          topic: m.topic,
          webhookId: `wh-a-${m.key}-${SUFFIX}`,
          resourceGid: m.gid,
          enqueuedAt: now.toISOString(),
        })})
      `;
      await sqlRef`SELECT pgmq.archive('s6_sync', ${result.send}::bigint)`;
      archiveMsgIds.set(m.key, BigInt(result.send));
    }

    const dlqMessages = [
      { key: "X@A-dlq", shop: SHOP_A.domain, gid: CUSTOMER_X_GID, topic: "CUSTOMERS_UPDATE", queue: "s6_sync" },
      { key: "Y@A-dlq", shop: SHOP_A.domain, gid: CUSTOMER_Y_GID, topic: "CUSTOMERS_UPDATE", queue: "s6_sync" },
      { key: "X@B-dlq", shop: SHOP_B.domain, gid: CUSTOMER_X_GID, topic: "CUSTOMERS_UPDATE", queue: "s6_sync" },
      { key: "sanitized-dlq", shop: SHOP_A.domain, gid: "sanitized", topic: "ORDERS_CREATE", queue: "s6_sync" },
    ];

    for (const m of dlqMessages) {
      const [result] = await sqlRef<[{ id: string }]>`
        INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
        VALUES (
          ${m.queue},
          ${`msg-dlq-${m.key}-${SUFFIX}`},
          ${sqlRef.json({
            shop: m.shop,
            topic: m.topic,
            webhookId: `wh-dlq-${m.key}-${SUFFIX}`,
            resourceGid: m.gid,
            enqueuedAt: now.toISOString(),
          })}::jsonb,
          'test_error',
          ${now}
        )
        RETURNING id
      `;
      dlqIds.set(m.key, result.id);
    }

    const [bulkResult] = await sqlRef<[{ send: string }]>`
      SELECT pgmq.send('s6_bulk', ${sqlRef.json({
        shop: SHOP_A.domain,
        topic: "BULK_OPERATIONS_FINISH",
        webhookId: `wh-bulk-${SUFFIX}`,
        bulkOperationId: `gid://shopify/BulkOperation/bulk-${SUFFIX}`,
        bulkType: "customers",
        enqueuedAt: now.toISOString(),
      })})
    `;
    bulkMsgIds.set("bulk@A", BigInt(bulkResult.send));

    return { queueMsgIds, archiveMsgIds, dlqIds, bulkMsgIds };
  }

  async function seedTaggedCustomerForRedaction(): Promise<string> {
    await sqlRef`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
      VALUES (${SHOP_A.id}, ${CUSTOMER_X_GID}, '["net-terms"]'::jsonb, true, 'test-buyer@example.com', 'Test Buyer')
    `;

    const [result] = await sqlRef<[{ id: string }]>`
      INSERT INTO "BuyerAccount" (
        "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${SHOP_A.id}, 'TAGGED_CUSTOMER', 'Test Buyer', ${CUSTOMER_X_GID}, NOW(), NOW()
      )
      RETURNING id
    `;
    return result.id;
  }

  it("1. redactCustomer purges exactly X@A rows, counts 1/1/1", async () => {
    const { queueMsgIds, archiveMsgIds, dlqIds, bulkMsgIds } = await seedQueuesForPurgeTest();
    await seedTaggedCustomerForRedaction();

    const { redactCustomer } = await import("../compliance.server");
    const result = await redactCustomer(sqlRef, SHOP_A.id, CUSTOMER_X_GID);

    expect(result.pgmqSyncQueuePurged).toBe(1);
    expect(result.pgmqSyncArchivePurged).toBe(1);
    expect(result.deadLetterPurged).toBe(1);

    const [qXA] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE msg_id = ${queueMsgIds.get("X@A-queue")!.toString()}::bigint
    `;
    expect(parseInt(qXA.count, 10)).toBe(0);

    const [aXA] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE msg_id = ${archiveMsgIds.get("X@A-queue")!.toString()}::bigint
    `;
    expect(parseInt(aXA.count, 10)).toBe(0);

    const [dXA] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE id = ${dlqIds.get("X@A-dlq")!}
    `;
    expect(parseInt(dXA.count, 10)).toBe(0);

    const [qYA] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE msg_id = ${queueMsgIds.get("Y@A-queue")!.toString()}::bigint
    `;
    expect(parseInt(qYA.count, 10)).toBe(1);

    const [qXB] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE msg_id = ${queueMsgIds.get("X@B-queue")!.toString()}::bigint
    `;
    expect(parseInt(qXB.count, 10)).toBe(1);

    const [qCL] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE msg_id = ${queueMsgIds.get("CL@A-queue")!.toString()}::bigint
    `;
    expect(parseInt(qCL.count, 10)).toBe(1);

    const [dSanitized] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE id = ${dlqIds.get("sanitized-dlq")!}
    `;
    expect(parseInt(dSanitized.count, 10)).toBe(1);

    const [bulkCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk WHERE msg_id = ${bulkMsgIds.get("bulk@A")!.toString()}::bigint
    `;
    expect(parseInt(bulkCount.count, 10)).toBe(1);
  });

  it("2. second run: counts 0/0/0, no error", async () => {
    await seedTaggedCustomerForRedaction();

    const { redactCustomer } = await import("../compliance.server");

    const result1 = await redactCustomer(sqlRef, SHOP_A.id, CUSTOMER_X_GID);
    expect(result1.buyerAccountAnonymized).toBe(true);

    const result2 = await redactCustomer(sqlRef, SHOP_A.id, CUSTOMER_X_GID);

    expect(result2.pgmqSyncQueuePurged).toBe(0);
    expect(result2.pgmqSyncArchivePurged).toBe(0);
    expect(result2.deadLetterPurged).toBe(0);
    expect(result2.buyerAccountAnonymized).toBe(false);
  });

  it("3. shopId with no Shop row: no throw, counts 0/0/0, redaction still runs", async () => {
    const accountId = await seedTaggedCustomerForRedaction();

    const { redactCustomer } = await import("../compliance.server");

    const fakeShopId = `fake-shop-${SUFFIX}`;

    let error: Error | null = null;
    let result;
    try {
      result = await redactCustomer(sqlRef, fakeShopId, CUSTOMER_X_GID);
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeNull();
    expect(result!.pgmqSyncQueuePurged).toBe(0);
    expect(result!.pgmqSyncArchivePurged).toBe(0);
    expect(result!.deadLetterPurged).toBe(0);

    const [accountStillExists] = await sqlRef<[{ name: string }?]>`
      SELECT name FROM "BuyerAccount" WHERE id = ${accountId}
    `;
    expect(accountStillExists).toBeDefined();

    const result2 = await redactCustomer(sqlRef, SHOP_A.id, CUSTOMER_X_GID);
    expect(result2.buyerAccountAnonymized).toBe(true);

    const [accountAnonymized] = await sqlRef<[{ name: string; customerId: string }?]>`
      SELECT name, "customerId" FROM "BuyerAccount" WHERE id = ${accountId}
    `;
    expect(accountAnonymized?.name).toBe("Redacted Customer");
    expect(accountAnonymized?.customerId).toContain("_redacted_");
  });
});

describeWithDb("isCustomerRedacted check in customer sync", () => {
  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_A.id}, ${SHOP_A.domain}, 'INR', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sqlRef`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${SHOP_A.id}, 'net-terms', 30, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;
  });

  afterAll(async () => {
    const allDomains = [SHOP_A.domain];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A.id}`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A.id}`;
    await sqlRef`DELETE FROM "AccountSource" WHERE "shopId" = ${SHOP_A.id}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${SHOP_A.id}`;

    await assertNoQueueLeftovers(sqlRef, allDomains, "redact-customer-queues-db.test.ts (check)");

    await sqlRef.end();
  });

  beforeEach(async () => {
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A.id}`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A.id}`;
  });

  async function redactCustomerX(): Promise<void> {
    await sqlRef`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, email, display_name)
      VALUES (${SHOP_A.id}, ${CUSTOMER_X_GID}, '["net-terms"]'::jsonb, true, 'test-buyer@example.com', 'Test Buyer')
    `;
    await sqlRef`
      INSERT INTO "BuyerAccount" (
        "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${SHOP_A.id}, 'TAGGED_CUSTOMER', 'Test Buyer', ${CUSTOMER_X_GID}, NOW(), NOW()
      )
    `;

    const { redactCustomer } = await import("../compliance.server");
    await redactCustomer(sqlRef, SHOP_A.id, CUSTOMER_X_GID);
  }

  it("4. queue live re-fetch: enqueue after redaction, drain skips, no new rows created", async () => {
    await redactCustomerX();

    const webhookId = `wh-live-refetch-${SUFFIX}`;
    const now = new Date();
    await sqlRef`
      SELECT pgmq.send('s6_sync', ${sqlRef.json({
        shop: SHOP_A.domain,
        topic: "CUSTOMERS_UPDATE",
        webhookId,
        resourceGid: CUSTOMER_X_GID,
        enqueuedAt: now.toISOString(),
      })})
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    const drainResult = await runDrain(sqlRef, { batchSize: 50, timeBudgetMs: 10000 });

    expect(drainResult.skipped).toBeGreaterThanOrEqual(1);

    const [taggedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s8_tagged_customers
      WHERE shop_id = ${SHOP_A.id} AND customer_id = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(taggedCount.count, 10)).toBe(0);

    const [accountCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount"
      WHERE "shopId" = ${SHOP_A.id} AND "customerId" = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(accountCount.count, 10)).toBe(0);

    const [archivedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(archivedCount.count, 10)).toBe(1);

    const [processedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_processed_webhooks
      WHERE webhook_id = ${webhookId}
    `;
    expect(parseInt(processedCount.count, 10)).toBe(0);
  });

  it("5. in-flight: read message, run redaction, handler skips, no new rows", async () => {
    await sqlRef`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active)
      VALUES (${SHOP_A.id}, ${CUSTOMER_X_GID}, '["net-terms"]'::jsonb, true)
    `;
    await sqlRef`
      INSERT INTO "BuyerAccount" (
        "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${SHOP_A.id}, 'TAGGED_CUSTOMER', 'Test Buyer', ${CUSTOMER_X_GID}, NOW(), NOW()
      )
    `;

    const { processCustomerWebhook } = await import("~/services/sync/customer.server");
    const { redactCustomer } = await import("../compliance.server");

    await redactCustomer(sqlRef, SHOP_A.id, CUSTOMER_X_GID);

    const result = await processCustomerWebhook(
      sqlRef,
      SHOP_A.domain,
      "CUSTOMERS_UPDATE",
      { id: CUSTOMER_X_GID, tags: ["net-terms"], email: "test-buyer@example.com", displayName: "Test Buyer" },
      `wh-inflight-${SUFFIX}`,
      "fetched"
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(result.skipReason).toBe("Customer redacted");

    const [taggedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s8_tagged_customers
      WHERE shop_id = ${SHOP_A.id} AND customer_id = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(taggedCount.count, 10)).toBe(0);

    const [dlqCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter
      WHERE message->>'resourceGid' = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(dlqCount.count, 10)).toBe(0);
  });

  it("6. redrive: put DLQ message back on queue after redaction, nothing re-created", async () => {
    await redactCustomerX();

    const webhookId = `wh-redrive-${SUFFIX}`;
    await sqlRef`
      SELECT pgmq.send('s6_sync', ${sqlRef.json({
        shop: SHOP_A.domain,
        topic: "CUSTOMERS_UPDATE",
        webhookId,
        resourceGid: CUSTOMER_X_GID,
        enqueuedAt: new Date().toISOString(),
      })})
    `;

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 50, timeBudgetMs: 10000 });

    const [taggedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s8_tagged_customers
      WHERE shop_id = ${SHOP_A.id} AND customer_id = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(taggedCount.count, 10)).toBe(0);

    const [accountCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount"
      WHERE "shopId" = ${SHOP_A.id} AND "customerId" = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(accountCount.count, 10)).toBe(0);
  });

  it("7. bulk: processBulkCustomer skips redacted customer X, processes Y normally", async () => {
    await redactCustomerX();

    const { processBulkCustomer } = await import("~/services/sync/customer.server");

    const resultX = await processBulkCustomer(sqlRef, SHOP_A.domain, {
      id: CUSTOMER_X_GID,
      tags: ["net-terms"],
      email: "test-buyer@example.com",
      displayName: "Test Buyer",
    }, "fetched");

    expect(resultX.success).toBe(true);
    expect(resultX.action).toBe("skipped");
    expect(resultX.skipReason).toBe("Customer redacted");

    const [xAccountCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount"
      WHERE "shopId" = ${SHOP_A.id} AND "customerId" = ${CUSTOMER_X_GID}
    `;
    expect(parseInt(xAccountCount.count, 10)).toBe(0);

    const resultY = await processBulkCustomer(sqlRef, SHOP_A.domain, {
      id: CUSTOMER_Y_GID,
      tags: ["net-terms"],
      email: "other-buyer@example.com",
      displayName: "Other Buyer",
    }, "fetched");

    expect(resultY.success).toBe(true);
    expect(["created", "updated"]).toContain(resultY.action);

    const [yAccountCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount"
      WHERE "shopId" = ${SHOP_A.id} AND "customerId" = ${CUSTOMER_Y_GID}
    `;
    expect(parseInt(yAccountCount.count, 10)).toBe(1);
  });

  it("8. other customers unaffected: Y@A and X@B drain normally", async () => {
    await redactCustomerX();

    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_B.id}, ${SHOP_B.domain}, 'INR', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;
    await sqlRef`
      INSERT INTO "AccountSource" ("shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${SHOP_B.id}, 'net-terms', 30, NOW(), NOW())
      ON CONFLICT DO NOTHING
    `;

    const { processCustomerWebhook } = await import("~/services/sync/customer.server");

    const resultYA = await processCustomerWebhook(
      sqlRef,
      SHOP_A.domain,
      "CUSTOMERS_UPDATE",
      { id: CUSTOMER_Y_GID, tags: ["net-terms"], email: "y-buyer@example.com", displayName: "Y Buyer" },
      `wh-y-a-${SUFFIX}`,
      "fetched"
    );
    expect(resultYA.success).toBe(true);
    expect(["created", "updated"]).toContain(resultYA.action);

    const resultXB = await processCustomerWebhook(
      sqlRef,
      SHOP_B.domain,
      "CUSTOMERS_UPDATE",
      { id: CUSTOMER_X_GID, tags: ["net-terms"], email: "x-b-buyer@example.com", displayName: "X B Buyer" },
      `wh-x-b-${SUFFIX}`,
      "fetched"
    );
    expect(resultXB.success).toBe(true);
    expect(["created", "updated"]).toContain(resultXB.action);

    await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_B.id}`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_B.id}`;
    await sqlRef`DELETE FROM "AccountSource" WHERE "shopId" = ${SHOP_B.id}`;
    await sqlRef`DELETE FROM "Shop" WHERE id = ${SHOP_B.id}`;
  });

  it("9. prefix exactness: suffix row for .../Customer/12 does not block .../Customer/123", async () => {
    const CUSTOMER_12_GID = `gid://shopify/Customer/12`;
    const CUSTOMER_123_GID = `gid://shopify/Customer/123`;

    await sqlRef`
      INSERT INTO "BuyerAccount" (
        "shopId", kind, name, "customerId", "createdAt", "updatedAt"
      ) VALUES (
        ${SHOP_A.id}, 'TAGGED_CUSTOMER', 'Redacted 12', ${CUSTOMER_12_GID + '_redacted_1234567890'}, NOW(), NOW()
      )
    `;

    const { isCustomerRedacted, processBulkCustomer } = await import("~/services/sync/customer.server");

    const is12Redacted = await isCustomerRedacted(sqlRef, SHOP_A.id, CUSTOMER_12_GID);
    expect(is12Redacted).toBe(true);

    const is123Redacted = await isCustomerRedacted(sqlRef, SHOP_A.id, CUSTOMER_123_GID);
    expect(is123Redacted).toBe(false);

    const result123 = await processBulkCustomer(sqlRef, SHOP_A.domain, {
      id: CUSTOMER_123_GID,
      tags: ["net-terms"],
      email: "customer123@example.com",
      displayName: "Customer 123",
    }, "fetched");

    expect(result123.success).toBe(true);
    expect(["created", "updated"]).toContain(result123.action);

    const [accountCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "BuyerAccount"
      WHERE "shopId" = ${SHOP_A.id} AND "customerId" = ${CUSTOMER_123_GID}
    `;
    expect(parseInt(accountCount.count, 10)).toBe(1);

    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A.id} AND "customerId" = ${CUSTOMER_123_GID}`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A.id} AND "customerId" LIKE ${CUSTOMER_12_GID + '%'}`;
    await sqlRef`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A.id} AND customer_id = ${CUSTOMER_123_GID}`;
  });
});
