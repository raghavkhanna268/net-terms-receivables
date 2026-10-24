import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { requestContext } from "~/lib/request-context.server";

/**
 * S20 Idempotency Integration Tests
 *
 * Tests the ACTUAL production code paths for:
 * 1. Edge-level replay dedupe (webhook_receipts table)
 * 2. Drain-level replay dedupe (s6_processed_webhooks table)
 * 3. Receipt+enqueue atomicity through the real recordAndEnqueueSync helper
 * 4. Full webhook route action with HMAC-signed requests
 *
 * These tests exercise real database transactions and production code to prove
 * the S20 idempotency guarantees actually work.
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const sqlOptions = {
  max: 5,
  prepare: true,
  transform: { undefined: null },
  connect_timeout: 10,
  fetch_types: false,
};

/**
 * Helper to compute HMAC-SHA256 signature for test requests.
 * Uses the same algorithm as verifyWebhook.
 */
async function computeTestHmac(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Create an HMAC-signed webhook request for testing.
 */
async function createSignedWebhookRequest(
  secret: string,
  params: {
    shop: string;
    topic: string;
    webhookId: string;
    payload: object;
    apiVersion?: string;
  }
): Promise<Request> {
  const body = JSON.stringify(params.payload);
  const hmac = await computeTestHmac(secret, body);

  return new Request("http://localhost/webhooks/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Shop-Domain": params.shop,
      "X-Shopify-Topic": params.topic,
      "X-Shopify-Webhook-Id": params.webhookId,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-API-Version": params.apiVersion ?? "2025-01",
    },
    body,
  });
}

describeWithDb("S20 Idempotency: Edge-level replay dedupe (webhook_receipts)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SHOP = "s20-edge-test.myshopify.com";

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
  });

  afterEach(async () => {
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    await sql.end();
  });

  it("recordWebhookReceipt returns true for new webhook", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-edge-1-${Date.now()}`;
    const result = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");

    expect(result).toBe(true);

    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });

  it("recordWebhookReceipt returns false for duplicate webhook (Shopify retry)", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-edge-2-${Date.now()}`;

    const first = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(first).toBe(true);

    const second = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(second).toBe(false);

    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });

  it("recordWebhookReceipt stores triggeredAt timestamp", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-edge-3-${Date.now()}`;
    const triggeredAt = new Date("2026-10-20T10:30:00Z");

    await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE", triggeredAt);

    const rows = await sql<Array<{ triggered_at: Date | null }>>`
      SELECT triggered_at FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].triggered_at?.toISOString()).toBe("2026-10-20T10:30:00.000Z");
  });

  it("deleteWebhookReceiptsForShop removes all receipts for shop", async () => {
    const { recordWebhookReceipt, deleteWebhookReceiptsForShop } = await import(
      "~/lib/webhook-receipts.server"
    );

    await recordWebhookReceipt(sql, TEST_SHOP, `test-edge-4a-${Date.now()}`, "ORDERS_CREATE");
    await recordWebhookReceipt(sql, TEST_SHOP, `test-edge-4b-${Date.now()}`, "ORDERS_PAID");
    await recordWebhookReceipt(sql, TEST_SHOP, `test-edge-4c-${Date.now()}`, "COMPANIES_CREATE");

    const before = await sql`SELECT COUNT(*) as count FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    expect(Number(before[0].count)).toBe(3);

    const deleted = await deleteWebhookReceiptsForShop(sql, TEST_SHOP);
    expect(deleted).toBe(3);

    const after = await sql`SELECT COUNT(*) as count FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    expect(Number(after[0].count)).toBe(0);
  });
});

describeWithDb("S20 Idempotency: Drain-level replay dedupe (s6_processed_webhooks)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SHOP = "s20-drain-test.myshopify.com";

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE 'test-drain-%'`;
  });

  afterEach(async () => {
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE 'test-drain-%'`;
    await sql.end();
  });

  it("isWebhookProcessed returns false for new webhook", async () => {
    const { isWebhookProcessed } = await import("~/services/sync/company.server");

    const webhookId = `test-drain-1-${Date.now()}`;
    const result = await isWebhookProcessed(sql, webhookId, TEST_SHOP);

    expect(result).toBe(false);
  });

  it("isWebhookProcessed returns true after markWebhookProcessed", async () => {
    const { isWebhookProcessed, markWebhookProcessed } = await import(
      "~/services/sync/company.server"
    );

    const webhookId = `test-drain-2-${Date.now()}`;

    const before = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(before).toBe(false);

    await markWebhookProcessed(sql, webhookId, "ORDERS_CREATE", "gid://shopify/Order/123", TEST_SHOP);

    const after = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(after).toBe(true);
  });

  it("markWebhookProcessed is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const { markWebhookProcessed } = await import("~/services/sync/company.server");

    const webhookId = `test-drain-3-${Date.now()}`;

    await markWebhookProcessed(sql, webhookId, "ORDERS_CREATE", "gid://shopify/Order/123", TEST_SHOP);
    await markWebhookProcessed(sql, webhookId, "ORDERS_CREATE", "gid://shopify/Order/123", TEST_SHOP);

    const rows = await sql`
      SELECT webhook_id FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });
});

describeWithDb("S20 Idempotency: recordAndEnqueueSync atomicity", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SHOP = "s20-atomic-test.myshopify.com";

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    // Clean up only THIS file's messages from s6_sync queue (filter by TEST_SHOP)
    // Never use pgmq.purge on shared queues - other test files run in parallel
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP}`.catch(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP}`.catch(() => {});
    await sql.end();
  });

  it("success: exactly 1 receipt AND 1 s6_sync message", async () => {
    const { recordAndEnqueueSync } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-success-${Date.now()}`;
    const result = await recordAndEnqueueSync(sql, {
      shop: TEST_SHOP,
      webhookId,
      topic: "ORDERS_CREATE",
      resourceGid: "gid://shopify/Order/123",
    });

    expect(result.status).toBe("enqueued");
    if (result.status === "enqueued") {
      expect(result.msgId).toBeDefined();
    }

    // Verify exactly 1 receipt
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(1);

    // Verify exactly 1 message in s6_sync queue (read without deleting)
    const messages = await sql<Array<{ msg_id: string; message: object }>>`
      SELECT msg_id, message FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
  });

  it("enqueue failure: 0 receipts, 0 messages, error returned (Shopify retries)", async () => {
    // Mock sendSyncMessage to throw
    const pgmqModule = await import("~/lib/pgmq.server");
    vi.spyOn(pgmqModule, "sendSyncMessage").mockRejectedValueOnce(
      new Error("Simulated pgmq failure")
    );

    const { recordAndEnqueueSync } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-fail-${Date.now()}`;
    const result = await recordAndEnqueueSync(sql, {
      shop: TEST_SHOP,
      webhookId,
      topic: "ORDERS_CREATE",
      resourceGid: "gid://shopify/Order/123",
    });

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe("pgmq_send_failed");
    }

    // Verify 0 receipts (rolled back)
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(0);

    // Verify 0 messages (never sent)
    const messages = await sql<Array<{ msg_id: string }>>`
      SELECT msg_id FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(0);
  });

  it("retry after failure: enqueues exactly once", async () => {
    const pgmqModule = await import("~/lib/pgmq.server");
    const sendSyncSpy = vi.spyOn(pgmqModule, "sendSyncMessage");

    // First call fails
    sendSyncSpy.mockRejectedValueOnce(new Error("Simulated pgmq failure"));

    const { recordAndEnqueueSync } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-retry-${Date.now()}`;

    // First attempt fails
    const firstResult = await recordAndEnqueueSync(sql, {
      shop: TEST_SHOP,
      webhookId,
      topic: "ORDERS_CREATE",
      resourceGid: "gid://shopify/Order/123",
    });
    expect(firstResult.status).toBe("error");

    // Verify rolled back - no receipt
    const afterFail = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(afterFail.length).toBe(0);

    // Second attempt (Shopify retry) succeeds
    sendSyncSpy.mockRestore();
    const secondResult = await recordAndEnqueueSync(sql, {
      shop: TEST_SHOP,
      webhookId,
      topic: "ORDERS_CREATE",
      resourceGid: "gid://shopify/Order/123",
    });
    expect(secondResult.status).toBe("enqueued");

    // Verify exactly 1 receipt
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(1);

    // Verify exactly 1 message
    const messages = await sql<Array<{ msg_id: string }>>`
      SELECT msg_id FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
  });

  it("duplicate delivery: still exactly 1 message", async () => {
    const { recordAndEnqueueSync } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-dup-${Date.now()}`;

    // First delivery
    const first = await recordAndEnqueueSync(sql, {
      shop: TEST_SHOP,
      webhookId,
      topic: "ORDERS_CREATE",
      resourceGid: "gid://shopify/Order/123",
    });
    expect(first.status).toBe("enqueued");

    // Second delivery (duplicate from Shopify)
    const second = await recordAndEnqueueSync(sql, {
      shop: TEST_SHOP,
      webhookId,
      topic: "ORDERS_CREATE",
      resourceGid: "gid://shopify/Order/123",
    });
    expect(second.status).toBe("duplicate");

    // Verify exactly 1 receipt
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(1);

    // Verify exactly 1 message (no duplicate enqueue)
    const messages = await sql<Array<{ msg_id: string }>>`
      SELECT msg_id FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
  });

  /**
   * Concurrent duplicate webhooks deduplicate correctly.
   *
   * NOTE: The setTimeout ordering here is safe because the unique index on
   * (shop, webhook_id) in webhook_receipts will block the second INSERT
   * until the first transaction commits. The 10ms/50ms delays just ensure
   * the concurrent execution starts in a predictable order - the actual
   * serialization happens at the database level via the unique constraint.
   */
  it("concurrent duplicates: exactly one winner", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-concurrent-${Date.now()}`;
    const results: boolean[] = [];

    await Promise.all([
      sql.begin(async (tx) => {
        const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
        results.push(isNew);
        await new Promise((r) => setTimeout(r, 50));
      }),
      sql.begin(async (tx) => {
        await new Promise((r) => setTimeout(r, 10));
        const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
        results.push(isNew);
      }),
    ]);

    const successes = results.filter((r) => r === true);
    expect(successes.length).toBe(1);

    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });
});

describeWithDb("S20 Idempotency: Full webhook route with HMAC-signed request", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SECRET = "test-secret-for-hmac-signing";
  const TEST_SHOP = "s20-route-test.myshopify.com";

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    // Clean up only THIS file's messages from s6_sync queue (filter by TEST_SHOP)
    // Never use pgmq.purge on shared queues - other test files run in parallel
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP}`.catch(() => {});
    vi.stubEnv("SHOPIFY_API_SECRET", TEST_SECRET);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP}`.catch(() => {});
    await sql.end();
  });

  it("orders webhook: success gives 1 receipt + 1 s6_sync message", async () => {
    const { action } = await import("~/routes/webhooks.orders");

    const webhookId = `test-route-success-${Date.now()}`;
    const request = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP,
      topic: "orders/create",
      webhookId,
      payload: { admin_graphql_api_id: "gid://shopify/Order/123" },
    });

    // Run action inside request context with test SQL
    const url = new URL(request.url);
    const response = await requestContext.run({ getSql: () => sql }, () =>
      action({ request, params: {}, context: {} as never, url, pattern: "/webhooks/orders" })
    );

    expect(response.status).toBe(200);

    // Verify exactly 1 receipt
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(1);

    // Verify exactly 1 message
    const messages = await sql<Array<{ msg_id: string }>>`
      SELECT msg_id FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
  });

  it("orders webhook: enqueue failure returns error, 0 receipts, 0 messages", async () => {
    const pgmqModule = await import("~/lib/pgmq.server");
    vi.spyOn(pgmqModule, "sendSyncMessage").mockRejectedValue(
      new Error("Simulated pgmq failure")
    );

    const { action } = await import("~/routes/webhooks.orders");

    const webhookId = `test-route-fail-${Date.now()}`;
    const request = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP,
      topic: "orders/create",
      webhookId,
      payload: { admin_graphql_api_id: "gid://shopify/Order/123" },
    });

    // Action should throw when enqueue fails - error code is pgmq_send_failed
    const url = new URL(request.url);
    await expect(
      requestContext.run({ getSql: () => sql }, () =>
        action({ request, params: {}, context: {} as never, url, pattern: "/webhooks/orders" })
      )
    ).rejects.toThrow("pgmq_send_failed");

    // Verify 0 receipts (rolled back)
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(0);

    // Verify 0 messages
    const messages = await sql<Array<{ msg_id: string }>>`
      SELECT msg_id FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(0);
  });

  it("orders webhook: duplicate delivery returns 200, no additional message", async () => {
    const { action } = await import("~/routes/webhooks.orders");

    const webhookId = `test-route-dup-${Date.now()}`;
    const request1 = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP,
      topic: "orders/create",
      webhookId,
      payload: { admin_graphql_api_id: "gid://shopify/Order/123" },
    });
    const request2 = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP,
      topic: "orders/create",
      webhookId,
      payload: { admin_graphql_api_id: "gid://shopify/Order/123" },
    });

    // First delivery
    const url1 = new URL(request1.url);
    const response1 = await requestContext.run({ getSql: () => sql }, () =>
      action({ request: request1, params: {}, context: {} as never, url: url1, pattern: "/webhooks/orders" })
    );
    expect(response1.status).toBe(200);

    // Second delivery (duplicate)
    const url2 = new URL(request2.url);
    const response2 = await requestContext.run({ getSql: () => sql }, () =>
      action({ request: request2, params: {}, context: {} as never, url: url2, pattern: "/webhooks/orders" })
    );
    expect(response2.status).toBe(200);

    // Verify exactly 1 receipt
    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(1);

    // Verify exactly 1 message (no duplicate)
    const messages = await sql<Array<{ msg_id: string }>>`
      SELECT msg_id FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
  });
});

describeWithDb("S20 Idempotency: Two-level deduplication", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SHOP = "s20-twolevel-test.myshopify.com";

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE 'test-twolevel-%'`;
  });

  afterEach(async () => {
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE 'test-twolevel-%'`;
    await sql.end();
  });

  it("edge and drain use separate tables", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");
    const { isWebhookProcessed, markWebhookProcessed } = await import(
      "~/services/sync/company.server"
    );

    const webhookId = `test-twolevel-1-${Date.now()}`;

    await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");

    const beforeDrain = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(beforeDrain).toBe(false);

    await markWebhookProcessed(
      sql,
      webhookId,
      "ORDERS_CREATE",
      "gid://shopify/Order/123",
      TEST_SHOP
    );

    const afterDrain = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(afterDrain).toBe(true);

    const edgeRows = await sql`
      SELECT 1 FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    const drainRows = await sql`
      SELECT 1 FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}
    `;
    expect(edgeRows.length).toBe(1);
    expect(drainRows.length).toBe(1);
  });

  it("replay at edge blocks duplicate enqueues (Shopify retry)", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-twolevel-2-${Date.now()}`;

    const first = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(first).toBe(true);

    const retry = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(retry).toBe(false);
  });

  it("replay at drain blocks duplicate processing (pgmq duplicate)", async () => {
    const { isWebhookProcessed, markWebhookProcessed } = await import(
      "~/services/sync/company.server"
    );

    const webhookId = `test-twolevel-3-${Date.now()}`;

    const firstCheck = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(firstCheck).toBe(false);

    await markWebhookProcessed(
      sql,
      webhookId,
      "ORDERS_CREATE",
      "gid://shopify/Order/123",
      TEST_SHOP
    );

    const secondCheck = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(secondCheck).toBe(true);
  });
});
