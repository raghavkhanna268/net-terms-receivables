import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { requestContext } from "~/lib/request-context.server";

/**
 * S8 Draft Order Delete with id-only payload - DB Integration Tests (#272)
 *
 * Tests verify:
 * 1. Delete with only numeric `id` (no admin_graphql_api_id) enqueues correctly
 * 2. End-to-end: id-only webhook -> enqueue -> process -> row removed, exposure drops
 * 3. Payload with neither field returns 200, logs warning, changes nothing
 * 4. End-to-end idempotent: second id-only delete is no-op, exposure stays lowered
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

async function createSignedWebhookRequest(
  secret: string,
  params: {
    shop: string;
    topic: string;
    webhookId: string;
    payload: object;
  }
): Promise<Request> {
  const body = JSON.stringify(params.payload);
  const hmac = await computeTestHmac(secret, body);

  return new Request("http://localhost/webhooks/draft_orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Shop-Domain": params.shop,
      "X-Shopify-Topic": params.topic,
      "X-Shopify-Webhook-Id": params.webhookId,
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-API-Version": "2026-10",
    },
    body,
  });
}

describeWithDb("S8 Draft Order Delete: id-only payload (#272)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SECRET = "test-secret-for-s8-tests";
  const TEST_SUFFIX = Date.now().toString(36);
  const TEST_SHOP_ID = `shop-s8-del-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s8-del-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `account-s8-del-${TEST_SUFFIX}`;
  const TEST_COMPANY_ID = `gid://shopify/Company/co-s8-del-${TEST_SUFFIX}`;
  const TEST_LOCATION_ID = `gid://shopify/CompanyLocation/loc-s8-del-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    vi.stubEnv("SHOPIFY_API_SECRET", TEST_SECRET);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", "createdAt", "updatedAt"
      ) VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY', ${TEST_COMPANY_ID}, ${TEST_LOCATION_ID}, 'Test Company',
        '100000.00', 'OK', NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`.catch(() => {});
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`.catch(() => {});
  });

  it("delete with id-only: enqueues with built GID and returns 200", async () => {
    const { action } = await import("~/routes/webhooks.draft_orders");

    const numericId = 123456789;
    const webhookId = `wh-del-idonly-${TEST_SUFFIX}`;
    const request = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP_DOMAIN,
      topic: "draft_orders/delete",
      webhookId,
      payload: { id: numericId },
    });

    const url = new URL(request.url);
    const response = await requestContext.run({ getSql: () => sql }, () =>
      action({ request, params: {}, context: {} as never, url, pattern: "/webhooks/draft_orders" })
    );

    expect(response.status).toBe(200);

    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP_DOMAIN} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(1);

    const messages = await sql<Array<{ message: { resourceGid: string } }>>`
      SELECT message FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
    expect(messages[0].message.resourceGid).toBe(`gid://shopify/DraftOrder/${numericId}`);
  });

  it("end-to-end id-only: webhook enqueues, processor deletes, exposure drops", async () => {
    const { action } = await import("~/routes/webhooks.draft_orders");
    const { processDraftOrderWebhook, getPendingExposure } = await import("~/services/sync/draft-order.server");

    const numericId = 987654321;
    const expectedGid = `gid://shopify/DraftOrder/${numericId}`;
    const webhookId = `wh-del-e2e-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO s8_draft_orders (
        shop_id, draft_order_id, buyer_account_id, name, total,
        has_payment_terms, status, created_at, updated_at
      ) VALUES (
        ${TEST_SHOP_ID}, ${expectedGid}, ${TEST_ACCOUNT_ID}, '#D1', '25000.00',
        true, 'open', NOW(), NOW()
      )
    `;

    const beforeExposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
    expect(beforeExposure).toBe("25000.00");

    const request = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP_DOMAIN,
      topic: "draft_orders/delete",
      webhookId,
      payload: { id: numericId },
    });

    const url = new URL(request.url);
    const response = await requestContext.run({ getSql: () => sql }, () =>
      action({ request, params: {}, context: {} as never, url, pattern: "/webhooks/draft_orders" })
    );
    expect(response.status).toBe(200);

    const messages = await sql<Array<{ message: { resourceGid: string; topic: string } }>>`
      SELECT message FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(1);
    const enqueuedGid = messages[0].message.resourceGid;
    expect(enqueuedGid).toBe(expectedGid);

    const result = await processDraftOrderWebhook(
      sql,
      TEST_SHOP_DOMAIN,
      "DRAFT_ORDERS_DELETE",
      { id: enqueuedGid, name: "#D1", createdAt: new Date().toISOString() },
      `wh-del-proc-${TEST_SUFFIX}`
    );

    expect(result.success).toBe(true);
    expect(result.action).toBe("deleted");

    const rows = await sql`
      SELECT * FROM s8_draft_orders WHERE draft_order_id = ${enqueuedGid}
    `;
    expect(rows.length).toBe(0);

    const afterExposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
    expect(afterExposure).toBe("0.00");
  });

  it("payload with neither field: returns 200, logs warning, changes nothing", async () => {
    const { action } = await import("~/routes/webhooks.draft_orders");

    await sql`
      INSERT INTO s8_draft_orders (
        shop_id, draft_order_id, buyer_account_id, name, total,
        has_payment_terms, status, created_at, updated_at
      ) VALUES (
        ${TEST_SHOP_ID}, 'gid://shopify/DraftOrder/keep-this-123', ${TEST_ACCOUNT_ID}, '#KEEP', '50000.00',
        true, 'open', NOW(), NOW()
      )
    `;

    const countBefore = await sql`SELECT COUNT(*) as count FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    expect(Number(countBefore[0].count)).toBe(1);

    const webhookId = `wh-del-empty-${TEST_SUFFIX}`;
    const request = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP_DOMAIN,
      topic: "draft_orders/delete",
      webhookId,
      payload: {},
    });

    const url = new URL(request.url);
    const response = await requestContext.run({ getSql: () => sql }, () =>
      action({ request, params: {}, context: {} as never, url, pattern: "/webhooks/draft_orders" })
    );

    expect(response.status).toBe(200);

    const receipts = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP_DOMAIN} AND webhook_id = ${webhookId}
    `;
    expect(receipts.length).toBe(0);

    const messages = await sql`
      SELECT msg_id FROM pgmq.q_s6_sync WHERE message->>'webhookId' = ${webhookId}
    `;
    expect(messages.length).toBe(0);

    const countAfter = await sql`SELECT COUNT(*) as count FROM s8_draft_orders WHERE shop_id = ${TEST_SHOP_ID}`;
    expect(Number(countAfter[0].count)).toBe(1);
  });

  it("end-to-end idempotent: second id-only delete is no-op, exposure stays lowered", async () => {
    const { action } = await import("~/routes/webhooks.draft_orders");
    const { processDraftOrderWebhook, getPendingExposure } = await import("~/services/sync/draft-order.server");

    const numericId = 111222333;
    const expectedGid = `gid://shopify/DraftOrder/${numericId}`;
    const webhookId1 = `wh-del-idem1-${TEST_SUFFIX}`;
    const webhookId2 = `wh-del-idem2-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO s8_draft_orders (
        shop_id, draft_order_id, buyer_account_id, name, total,
        has_payment_terms, status, created_at, updated_at
      ) VALUES (
        ${TEST_SHOP_ID}, ${expectedGid}, ${TEST_ACCOUNT_ID}, '#D2', '30000.00',
        true, 'open', NOW(), NOW()
      )
    `;

    const beforeExposure = await getPendingExposure(sql, TEST_ACCOUNT_ID);
    expect(beforeExposure).toBe("30000.00");

    const request1 = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP_DOMAIN,
      topic: "draft_orders/delete",
      webhookId: webhookId1,
      payload: { id: numericId },
    });

    const url1 = new URL(request1.url);
    const response1 = await requestContext.run({ getSql: () => sql }, () =>
      action({ request: request1, params: {}, context: {} as never, url: url1, pattern: "/webhooks/draft_orders" })
    );
    expect(response1.status).toBe(200);

    const messages1 = await sql<Array<{ message: { resourceGid: string } }>>`
      SELECT message FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId1}
    `;
    expect(messages1.length).toBe(1);
    const enqueuedGid = messages1[0].message.resourceGid;
    expect(enqueuedGid).toBe(expectedGid);

    const result1 = await processDraftOrderWebhook(
      sql,
      TEST_SHOP_DOMAIN,
      "DRAFT_ORDERS_DELETE",
      { id: enqueuedGid, name: "#D2", createdAt: new Date().toISOString() },
      `wh-del-proc1-${TEST_SUFFIX}`
    );
    expect(result1.success).toBe(true);
    expect(result1.action).toBe("deleted");

    const afterFirst = await getPendingExposure(sql, TEST_ACCOUNT_ID);
    expect(afterFirst).toBe("0.00");

    const request2 = await createSignedWebhookRequest(TEST_SECRET, {
      shop: TEST_SHOP_DOMAIN,
      topic: "draft_orders/delete",
      webhookId: webhookId2,
      payload: { id: numericId },
    });

    const url2 = new URL(request2.url);
    const response2 = await requestContext.run({ getSql: () => sql }, () =>
      action({ request: request2, params: {}, context: {} as never, url: url2, pattern: "/webhooks/draft_orders" })
    );
    expect(response2.status).toBe(200);

    const messages2 = await sql<Array<{ message: { resourceGid: string } }>>`
      SELECT message FROM pgmq.q_s6_sync 
      WHERE message->>'webhookId' = ${webhookId2}
    `;
    expect(messages2.length).toBe(1);
    const enqueuedGid2 = messages2[0].message.resourceGid;
    expect(enqueuedGid2).toBe(expectedGid);

    const result2 = await processDraftOrderWebhook(
      sql,
      TEST_SHOP_DOMAIN,
      "DRAFT_ORDERS_DELETE",
      { id: enqueuedGid2, name: "#D2", createdAt: new Date().toISOString() },
      `wh-del-proc2-${TEST_SUFFIX}`
    );
    expect(result2.success).toBe(true);
    expect(result2.action).toBe("skipped");
    expect(result2.skipReason).toContain("not found");

    const afterSecond = await getPendingExposure(sql, TEST_ACCOUNT_ID);
    expect(afterSecond).toBe("0.00");
  });
});
