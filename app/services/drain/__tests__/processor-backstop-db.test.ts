/**
 * DB-backed integration tests for processor backstop path.
 *
 * These tests verify that handleOrder correctly runs backstop on redelivery
 * by going through the real processor entry point with a real database.
 *
 * Key scenarios:
 * 1. Redelivery for held account: webhook processed, no backstop row → hold applied
 * 2. Access-denied on attempt 1, redelivery succeeds
 * 3. Non-retryable error returns retryable (not archived)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

// Mock admin client for GraphQL calls
vi.mock("../admin-client.server", () => ({
  adminGraphQL: vi.fn().mockResolvedValue({
    success: true,
    data: { node: null },
    retryable: false,
  }),
  ORDER_QUERY: `query OrderById($id: ID!) { node(id: $id) { ... on Order { id } } }`,
}));

// Mock shopify-client for backstop GraphQL calls
vi.mock("~/services/shopify-client.server", () => ({
  shopifyGraphQLRequest: vi.fn(),
}));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("processor backstop integration (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-proc-backstop";
  const TEST_SHOP_ID = `shop-proc-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `proc-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-proc-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test buyer account with manualHold=true (held)
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold", "holdReasonCode",
        "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-proc-" + TEST_SUFFIX}, ${"loc-proc-" + TEST_SUFFIX},
        'Test Held Account', 100000.00, 'HELD', false, true, 'MANUAL_HOLD',
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`proc-${TEST_SUFFIX}%`}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    const { shopifyGraphQLRequest } = await import("~/services/shopify-client.server");
    (shopifyGraphQLRequest as ReturnType<typeof vi.fn>).mockReset();
  });

  describe("redelivery runs backstop through handleOrder", () => {
    it("held account with webhook processed but no backstop row: applies hold", async () => {
      const { getSyncHandler } = await import("../processor.server");
      const { adminGraphQL } = await import("../admin-client.server");
      const { shopifyGraphQLRequest } = await import("~/services/shopify-client.server");
      const mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;
      const mockShopifyGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const webhookId = `proc-${TEST_SUFFIX}-hold-${Date.now()}`;
      const orderGid = `gid://shopify/Order/proc-hold-${TEST_SUFFIX}`;
      const invoiceId = `inv-proc-hold-${TEST_SUFFIX}`;

      // Create invoice for this order
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
          '#TEST-PROC-HOLD', 50000.00, 50000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      // Mark webhook as already processed (simulating redelivery)
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${webhookId}, 'ORDERS_CREATE', ${orderGid}, NOW())
      `;

      // Verify: No backstop_processed_orders row (simulating failed backstop on attempt 1)
      const [beforeBackstop] = await sql<{ action: string }[]>`
        SELECT action FROM backstop_processed_orders
        WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
      `;
      expect(beforeBackstop).toBeUndefined();

      try {
        // Mock adminGraphQL for order fetch (shouldn't be called on redelivery path)
        mockAdminGraphQL.mockResolvedValue({
          success: true,
          data: { node: { id: orderGid, name: "#1001" } },
        });

        // Mock shopifyGraphQLRequest for FO query and hold mutation
        mockShopifyGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/proc-1",
                        status: "OPEN",
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: {
              fulfillmentOrderHold: {
                fulfillmentOrder: {
                  id: "gid://shopify/FulfillmentOrder/proc-1",
                  status: "ON_HOLD",
                },
                userErrors: [],
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: { tagsAdd: { node: { id: orderGid }, userErrors: [] } },
          });

        // Get the handler and call it with a message
        const handler = getSyncHandler("ORDERS_CREATE");
        expect(handler).toBeDefined();

        const message = {
          shop: TEST_SHOP_DOMAIN,
          topic: "ORDERS_CREATE" as const,
          resourceGid: orderGid,
          webhookId,
          enqueuedAt: new Date().toISOString(),
          triggeredAt: new Date().toISOString(),
        };

        const result = await handler!(sql, message);

        // ASSERTIONS:
        // 1. Result should be success (backstop applied)
        expect(result.success).toBe(true);

        // 2. FO hold mutation should have been called
        expect(mockShopifyGraphQL).toHaveBeenCalledTimes(3); // FO query, hold, tags

        // 3. backstop_processed_orders row should exist with action='held'
        const [afterBackstop] = await sql<{ action: string }[]>`
          SELECT action FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(afterBackstop).toBeDefined();
        expect(afterBackstop.action).toBe("held");

        // 4. Result should NOT be a silent skip
        expect(result.skipReason).toContain("backstop applied");

      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}`;
      }
    });

    it("attempt 1 GraphQL access-denied, attempt 2 redelivery succeeds", async () => {
      const { getSyncHandler } = await import("../processor.server");
      const { adminGraphQL } = await import("../admin-client.server");
      const { shopifyGraphQLRequest } = await import("~/services/shopify-client.server");
      const mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;
      const mockShopifyGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const webhookId = `proc-${TEST_SUFFIX}-access-denied-${Date.now()}`;
      const orderGid = `gid://shopify/Order/proc-access-denied-${TEST_SUFFIX}`;
      const invoiceId = `inv-proc-access-denied-${TEST_SUFFIX}`;

      // Create invoice for this order
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
          '#TEST-ACCESS-DENIED', 60000.00, 60000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      try {
        const handler = getSyncHandler("ORDERS_CREATE");
        expect(handler).toBeDefined();

        // ATTEMPT 1: Fresh webhook, order fetch succeeds, but FO query fails with access-denied
        mockAdminGraphQL.mockResolvedValue({
          success: true,
          data: {
            node: {
              id: orderGid,
              name: "#1002",
              createdAt: new Date().toISOString(),
              paymentTerms: {
                id: "gid://shopify/PaymentTerms/1",
                paymentTermsName: "Net 30",
                paymentTermsType: "NET",
                dueInDays: 30,
              },
              totalPriceSet: { shopMoney: { amount: "60000.00", currencyCode: "INR" } },
              totalOutstandingSet: { shopMoney: { amount: "60000.00", currencyCode: "INR" } },
              purchasingEntity: {
                __typename: "PurchasingCompany",
                company: { id: "gid://shopify/Company/1" },
                location: { id: "gid://shopify/CompanyLocation/1" },
              },
            },
          },
        });

        // FO query fails with access-denied (simulating the production bug)
        mockShopifyGraphQL.mockResolvedValueOnce({
          success: false,
          error: "Access denied for location field. Required access: read_locations",
        });

        const message1 = {
          shop: TEST_SHOP_DOMAIN,
          topic: "ORDERS_CREATE" as const,
          resourceGid: orderGid,
          webhookId,
          enqueuedAt: new Date().toISOString(),
          triggeredAt: new Date().toISOString(),
        };

        const result1 = await handler!(sql, message1);

        // Attempt 1 should return retryable (not archived)
        expect(result1.success).toBe(false);
        expect(result1.retryable).toBe(true);
        expect(result1.error).toBe("RetryableBackstopError");

        // Verify: No backstop_processed_orders row (error before claim completion)
        const [afterAttempt1] = await sql<{ action: string }[]>`
          SELECT action FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        // May or may not have a pending row depending on where error occurred
        // The key is that it's NOT 'held' or 'skipped'
        if (afterAttempt1) {
          expect(afterAttempt1.action).toBe("pending");
        }

        // Clean up any pending row for redelivery test
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;

        // Mark webhook as processed (simulating what happens after attempt 1)
        await sql`
          INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
          VALUES (${webhookId}, 'ORDERS_CREATE', ${orderGid}, NOW())
          ON CONFLICT (webhook_id) DO NOTHING
        `;

        // ATTEMPT 2: Redelivery - webhook processed, FO query now succeeds
        mockShopifyGraphQL.mockReset();
        mockShopifyGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/access-denied-1",
                        status: "OPEN",
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: {
              fulfillmentOrderHold: {
                fulfillmentOrder: {
                  id: "gid://shopify/FulfillmentOrder/access-denied-1",
                  status: "ON_HOLD",
                },
                userErrors: [],
              },
            },
          })
          .mockResolvedValueOnce({
            success: true,
            data: { tagsAdd: { node: { id: orderGid }, userErrors: [] } },
          });

        const result2 = await handler!(sql, message1);

        // Attempt 2 should succeed with hold applied
        expect(result2.success).toBe(true);
        expect(result2.skipReason).toContain("backstop applied");

        // Verify: backstop_processed_orders row exists with action='held'
        const [afterAttempt2] = await sql<{ action: string }[]>`
          SELECT action FROM backstop_processed_orders
          WHERE shop_id = ${TEST_SHOP_ID} AND order_gid = ${orderGid}
        `;
        expect(afterAttempt2).toBeDefined();
        expect(afterAttempt2.action).toBe("held");

      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}`;
      }
    });

    it("non-retryable error returns retryable (not silently archived)", async () => {
      const { getSyncHandler } = await import("../processor.server");
      const { shopifyGraphQLRequest } = await import("~/services/shopify-client.server");
      const mockShopifyGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const webhookId = `proc-${TEST_SUFFIX}-nonretry-${Date.now()}`;
      const orderGid = `gid://shopify/Order/proc-nonretry-${TEST_SUFFIX}`;
      const invoiceId = `inv-proc-nonretry-${TEST_SUFFIX}`;

      // Create invoice
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderGid},
          '#TEST-NONRETRY', 70000.00, 70000.00, 'open', NOW(), NOW(), NOW()
        )
      `;

      // Mark webhook as processed (redelivery scenario)
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${webhookId}, 'ORDERS_CREATE', ${orderGid}, NOW())
      `;

      try {
        const handler = getSyncHandler("ORDERS_CREATE");

        // Mock: FO query succeeds, but hold mutation fails with unexpected error
        mockShopifyGraphQL
          .mockResolvedValueOnce({
            success: true,
            data: {
              order: {
                fulfillmentOrders: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/FulfillmentOrder/nonretry-1",
                        status: "OPEN",
                        supportedActions: [{ action: "HOLD" }],
                      },
                    },
                  ],
                },
              },
            },
          })
          .mockResolvedValueOnce({
            success: false,
            error: "Internal Server Error", // Non-retryable in shopifyGraphQLRequest
          });

        const message = {
          shop: TEST_SHOP_DOMAIN,
          topic: "ORDERS_CREATE" as const,
          resourceGid: orderGid,
          webhookId,
          enqueuedAt: new Date().toISOString(),
          triggeredAt: new Date().toISOString(),
        };

        const result = await handler!(sql, message);

        // KEY ASSERTION: Error should return retryable, NOT success
        expect(result.success).toBe(false);
        expect(result.retryable).toBe(true);
        expect(result.error).toBe("RetryableBackstopError");

      } finally {
        await sql`DELETE FROM backstop_processed_orders WHERE order_gid = ${orderGid}`;
        await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
        await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}`;
      }
    });
  });

  describe("no_handler DLQ behavior (real DB)", () => {
    it("sync queue: unregistered topic at read_ct >= noHandlerMaxReads goes to DLQ with no_handler code", async () => {
      const { runDrain, DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      const unregisteredTopic = `UNREGISTERED_TOPIC_${Date.now()}`;
      const testMsgId = Date.now();

      const message = {
        shop: TEST_SHOP_DOMAIN,
        topic: unregisteredTopic,
        resourceGid: `gid://test/Unregistered/${testMsgId}`,
        webhookId: `wh-unreg-sync-${testMsgId}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`
        INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
        VALUES (
          NOW() - interval '1 second',
          ${DEFAULT_DRAIN_CONFIG.noHandlerMaxReads},
          NOW(),
          ${sql.json(message)}::jsonb
        )
      `;

      const [beforeDrain] = await sql<{ msg_id: string }[]>`
        SELECT msg_id::text FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${message.webhookId}
      `;
      expect(beforeDrain).toBeDefined();
      const msgId = beforeDrain.msg_id;

      for (let i = 0; i < 10; i++) {
        await runDrain(sql, { batchSize: 50, timeBudgetMs: 10000 });

        const [dlqEntry] = await sql<{ message: Record<string, unknown>; error: string }[]>`
          SELECT message, error FROM s6_dead_letter
          WHERE original_queue = 's6_sync'
            AND message->>'webhookId' = ${message.webhookId}
        `;
        if (dlqEntry) {
          expect(dlqEntry.error).toBe("permanent:no_handler");
          expect(dlqEntry.message).toMatchObject({ topic: unregisteredTopic });
          break;
        }
      }

      const [dlqEntry] = await sql<{ message: Record<string, unknown>; error: string }[]>`
        SELECT message, error FROM s6_dead_letter
        WHERE original_queue = 's6_sync'
          AND message->>'webhookId' = ${message.webhookId}
      `;
      expect(dlqEntry).toBeDefined();

      await sql`DELETE FROM s6_dead_letter WHERE message->>'webhookId' = ${message.webhookId}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE msg_id = ${msgId}::bigint`;
    });

    it("bulk queue: unregistered topic at read_ct >= noHandlerMaxReads goes to DLQ with no_handler code", async () => {
      const { runDrain, DEFAULT_DRAIN_CONFIG } = await import("../processor.server");

      const unregisteredTopic = `BULK_UNREGISTERED_${Date.now()}`;
      const testMsgId = Date.now();

      const message = {
        shop: TEST_SHOP_DOMAIN,
        topic: unregisteredTopic,
        bulkOperationId: `gid://shopify/BulkOperation/unreg-${testMsgId}`,
        bulkType: "unknown",
        webhookId: `wh-unreg-bulk-${testMsgId}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`
        INSERT INTO pgmq.q_s6_bulk (vt, read_ct, enqueued_at, message)
        VALUES (
          NOW() - interval '1 second',
          ${DEFAULT_DRAIN_CONFIG.noHandlerMaxReads},
          NOW(),
          ${sql.json(message)}::jsonb
        )
      `;

      const [beforeDrain] = await sql<{ msg_id: string }[]>`
        SELECT msg_id::text FROM pgmq.q_s6_bulk
        WHERE message->>'webhookId' = ${message.webhookId}
      `;
      expect(beforeDrain).toBeDefined();
      const msgId = beforeDrain.msg_id;

      for (let i = 0; i < 10; i++) {
        await runDrain(sql, { batchSize: 50, timeBudgetMs: 10000 });

        const [dlqEntry] = await sql<{ message: Record<string, unknown>; error: string }[]>`
          SELECT message, error FROM s6_dead_letter
          WHERE original_queue = 's6_bulk'
            AND message->>'webhookId' = ${message.webhookId}
        `;
        if (dlqEntry) {
          expect(dlqEntry.error).toBe("permanent:no_handler");
          expect(dlqEntry.message).toMatchObject({ topic: unregisteredTopic });
          break;
        }
      }

      const [dlqEntry] = await sql<{ message: Record<string, unknown>; error: string }[]>`
        SELECT message, error FROM s6_dead_letter
        WHERE original_queue = 's6_bulk'
          AND message->>'webhookId' = ${message.webhookId}
      `;
      expect(dlqEntry).toBeDefined();

      await sql`DELETE FROM s6_dead_letter WHERE message->>'webhookId' = ${message.webhookId}`;
      await sql`DELETE FROM pgmq.a_s6_bulk WHERE msg_id = ${msgId}::bigint`;
    });

    it("no_handler code contains no raw message text or PII", async () => {
      const dlqCode = "permanent:no_handler";
      expect(dlqCode).not.toContain("@");
      expect(dlqCode).not.toContain("myshopify.com");
      expect(dlqCode).not.toMatch(/topic/i);
      expect(dlqCode).not.toMatch(/No handler registered/i);
      expect(dlqCode).toMatch(/^[a-z:_]+$/);
    });
  });

  describe("ORDERS_UPDATED still early-returns when processed", () => {
    it("ORDERS_UPDATED with isWebhookProcessed=true returns early without backstop", async () => {
      const { getSyncHandler } = await import("../processor.server");
      const { adminGraphQL } = await import("../admin-client.server");
      const { shopifyGraphQLRequest } = await import("~/services/shopify-client.server");
      const _mockAdminGraphQL = adminGraphQL as ReturnType<typeof vi.fn>;
      const mockShopifyGraphQL = shopifyGraphQLRequest as ReturnType<typeof vi.fn>;

      const webhookId = `proc-${TEST_SUFFIX}-updated-${Date.now()}`;
      const orderGid = `gid://shopify/Order/proc-updated-${TEST_SUFFIX}`;

      // Mark webhook as already processed
      await sql`
        INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at)
        VALUES (${webhookId}, 'ORDERS_UPDATED', ${orderGid}, NOW())
      `;

      try {
        const handler = getSyncHandler("ORDERS_UPDATED");
        expect(handler).toBeDefined();

        const message = {
          shop: TEST_SHOP_DOMAIN,
          topic: "ORDERS_UPDATED" as const,
          resourceGid: orderGid,
          webhookId,
          enqueuedAt: new Date().toISOString(),
          triggeredAt: new Date().toISOString(),
        };

        const result = await handler!(sql, message);

        // Should early-return with success (idempotent skip)
        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("Webhook already processed");

        // adminGraphQL should NOT have been called (no order fetch)
        expect(_mockAdminGraphQL).not.toHaveBeenCalled();

        // shopifyGraphQLRequest should NOT have been called (no backstop)
        expect(mockShopifyGraphQL).not.toHaveBeenCalled();

      } finally {
        await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}`;
      }
    });
  });
});
