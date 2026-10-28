/**
 * Edge-level DB tests for compliance webhook receipt+queue atomicity.
 *
 * Tests:
 * - Same webhook twice gives one receipt and one queue message
 * - Bad HMAC leaves zero rows
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import postgres from "postgres";
import { recordWebhookReceipt } from "~/lib/webhook-receipts.server";
import { sendSyncMessage, S6_QUEUES } from "~/lib/pgmq.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("compliance edge DB", () => {
  const testShopDomain = "test-compliance-edge.myshopify.com";
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "uninstalledAt", "createdAt", "updatedAt")
      VALUES (
        'test-compliance-edge-shop-id',
        ${testShopDomain},
        'INR',
        NULL,
        NOW(),
        NOW()
      )
      ON CONFLICT (domain) DO NOTHING
    `;
  });

  afterAll(async () => {
    if (!sql) return;

    await sql`DELETE FROM webhook_receipts WHERE shop = ${testShopDomain}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM "Shop" WHERE domain = ${testShopDomain}`;

    await assertNoQueueLeftovers(sql, [testShopDomain], "compliance-edge-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    if (!sql) return;
    await sql`DELETE FROM webhook_receipts WHERE shop = ${testShopDomain}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${testShopDomain}`;
  });

  it("same webhook twice gives one receipt and one queue message", async () => {
    const webhookId = "test-duplicate-wh-123";
    const topic = "CUSTOMERS_DATA_REQUEST";

    const firstResult = await sql.begin(async (tx) => {
      const isNew = await recordWebhookReceipt(tx, testShopDomain, webhookId, topic, null);
      if (!isNew) {
        return { enqueued: false };
      }

      const sendResult = await sendSyncMessage(tx, {
        topic,
        shop: testShopDomain,
        webhookId,
        resourceGid: `compliance:${topic}`,
        enqueuedAt: new Date().toISOString(),
        requestId: "req-123",
        customerId: "456",
      });

      return { enqueued: true, msgId: sendResult.msgId };
    });

    expect(firstResult.enqueued).toBe(true);

    const secondResult = await sql.begin(async (tx) => {
      const isNew = await recordWebhookReceipt(tx, testShopDomain, webhookId, topic, null);
      if (!isNew) {
        return { enqueued: false };
      }

      const sendResult = await sendSyncMessage(tx, {
        topic,
        shop: testShopDomain,
        webhookId,
        resourceGid: `compliance:${topic}`,
        enqueuedAt: new Date().toISOString(),
        requestId: "req-123",
        customerId: "456",
      });

      return { enqueued: true, msgId: sendResult.msgId };
    });

    expect(secondResult.enqueued).toBe(false);

    const [receiptCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM webhook_receipts 
      WHERE shop = ${testShopDomain} AND webhook_id = ${webhookId}
    `;
    expect(parseInt(receiptCount.count, 10)).toBe(1);

    const [queueCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync 
      WHERE message->>'shop' = ${testShopDomain}
        AND message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(queueCount.count, 10)).toBe(1);
  });

  it("bad HMAC leaves zero rows (simulated by rolling back transaction)", async () => {
    const webhookId = "test-bad-hmac-wh-456";
    const topic = "CUSTOMERS_REDACT";

    try {
      await sql.begin(async (tx) => {
        await recordWebhookReceipt(tx, testShopDomain, webhookId, topic, null);

        await sendSyncMessage(tx, {
          topic,
          shop: testShopDomain,
          webhookId,
          resourceGid: `compliance:${topic}`,
          enqueuedAt: new Date().toISOString(),
          customerId: "789",
        });

        throw new Error("Simulated HMAC failure - rollback");
      });
    } catch (e) {
      expect((e as Error).message).toContain("Simulated HMAC failure");
    }

    const [receiptCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM webhook_receipts 
      WHERE shop = ${testShopDomain} AND webhook_id = ${webhookId}
    `;
    expect(parseInt(receiptCount.count, 10)).toBe(0);

    const [queueCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync 
      WHERE message->>'shop' = ${testShopDomain}
        AND message->>'webhookId' = ${webhookId}
    `;
    expect(parseInt(queueCount.count, 10)).toBe(0);
  });

  it("enqueue failure rolls back receipt (atomic transaction)", async () => {
    const webhookId = "test-enqueue-fail-wh-789";
    const topic = "SHOP_REDACT";

    try {
      await sql.begin(async (tx) => {
        await recordWebhookReceipt(tx, testShopDomain, webhookId, topic, null);

        throw new Error("Simulated enqueue failure");
      });
    } catch (e) {
      expect((e as Error).message).toContain("Simulated enqueue failure");
    }

    const [receiptCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM webhook_receipts 
      WHERE shop = ${testShopDomain} AND webhook_id = ${webhookId}
    `;
    expect(parseInt(receiptCount.count, 10)).toBe(0);
  });
});
