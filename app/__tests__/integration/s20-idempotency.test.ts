import { describe, it, expect, beforeEach, afterEach } from "vitest";
import postgres from "postgres";

/**
 * S20 Idempotency Integration Tests
 *
 * Real database tests for:
 * 1. Edge-level replay dedupe (webhook_receipts table)
 * 2. Drain-level replay dedupe (s6_processed_webhooks table)
 * 3. Receipt+enqueue atomicity (transaction rollback)
 *
 * These replace the placebo tests in s20-hardening.test.ts with actual DB operations.
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

    // Verify record exists
    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });

  it("recordWebhookReceipt returns false for duplicate webhook (Shopify retry)", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-edge-2-${Date.now()}`;

    // First call - should succeed
    const first = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(first).toBe(true);

    // Second call (Shopify retry) - should detect duplicate
    const second = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(second).toBe(false);

    // Should still only be one record
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

    // Create multiple receipts
    await recordWebhookReceipt(sql, TEST_SHOP, `test-edge-4a-${Date.now()}`, "ORDERS_CREATE");
    await recordWebhookReceipt(sql, TEST_SHOP, `test-edge-4b-${Date.now()}`, "ORDERS_PAID");
    await recordWebhookReceipt(sql, TEST_SHOP, `test-edge-4c-${Date.now()}`, "COMPANIES_CREATE");

    // Verify 3 records
    const before = await sql`SELECT COUNT(*) as count FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    expect(Number(before[0].count)).toBe(3);

    // Delete all
    const deleted = await deleteWebhookReceiptsForShop(sql, TEST_SHOP);
    expect(deleted).toBe(3);

    // Verify none remain
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

    // Initially not processed
    const before = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(before).toBe(false);

    // Mark as processed
    await markWebhookProcessed(sql, webhookId, "ORDERS_CREATE", "gid://shopify/Order/123", TEST_SHOP);

    // Now should be processed
    const after = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(after).toBe(true);
  });

  it("markWebhookProcessed is idempotent (ON CONFLICT DO NOTHING)", async () => {
    const { markWebhookProcessed } = await import("~/services/sync/company.server");

    const webhookId = `test-drain-3-${Date.now()}`;

    // First call
    await markWebhookProcessed(sql, webhookId, "ORDERS_CREATE", "gid://shopify/Order/123", TEST_SHOP);

    // Second call - should not throw
    await markWebhookProcessed(sql, webhookId, "ORDERS_CREATE", "gid://shopify/Order/123", TEST_SHOP);

    // Should still only be one record
    const rows = await sql`
      SELECT webhook_id FROM s6_processed_webhooks WHERE webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });
});

describeWithDb("S20 Idempotency: Receipt+enqueue atomicity (transaction rollback)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SHOP = "s20-atomic-test.myshopify.com";

  beforeEach(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
  });

  afterEach(async () => {
    await sql`DELETE FROM webhook_receipts WHERE shop = ${TEST_SHOP}`;
    await sql.end();
  });

  it("successful enqueue commits receipt", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-1-${Date.now()}`;

    // Simulate successful edge processing: receipt + enqueue in one transaction
    await sql.begin(async (tx) => {
      const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
      expect(isNew).toBe(true);

      // Simulate successful enqueue (in real code this would be pgmq.send)
      await tx`SELECT 1`;
    });

    // Receipt should be committed
    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
  });

  it("failed enqueue rolls back receipt (no orphan receipts)", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-2-${Date.now()}`;

    // Simulate failed edge processing: receipt succeeds but enqueue fails
    try {
      await sql.begin(async (tx) => {
        const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
        expect(isNew).toBe(true);

        // Simulate failed enqueue - this throws and rolls back the transaction
        throw new Error("Simulated enqueue failure");
      });
    } catch (err) {
      // Expected - transaction rolled back
      expect((err as Error).message).toBe("Simulated enqueue failure");
    }

    // Receipt should NOT exist (rolled back)
    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(0);
  });

  it("Shopify retry succeeds after rollback", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-3-${Date.now()}`;

    // First attempt - fails and rolls back
    try {
      await sql.begin(async (tx) => {
        await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
        throw new Error("Simulated enqueue failure");
      });
    } catch {
      // Expected
    }

    // Verify receipt was rolled back
    const afterFail = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(afterFail.length).toBe(0);

    // Shopify retry - same webhookId, should succeed because receipt was rolled back
    await sql.begin(async (tx) => {
      const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
      expect(isNew).toBe(true); // Should be "new" because rollback cleared the receipt

      // Simulate successful enqueue
      await tx`SELECT 1`;
    });

    // Now receipt should exist
    const afterRetry = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(afterRetry.length).toBe(1);
  });

  it("concurrent duplicate webhooks deduplicate correctly", async () => {
    const { recordWebhookReceipt } = await import("~/lib/webhook-receipts.server");

    const webhookId = `test-atomic-4-${Date.now()}`;
    const results: boolean[] = [];

    // Simulate two concurrent webhook deliveries
    // In real scenario, Shopify might retry before we respond
    await Promise.all([
      sql.begin(async (tx) => {
        const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
        results.push(isNew);
        // Small delay to allow for concurrent execution
        await new Promise((r) => setTimeout(r, 50));
      }),
      sql.begin(async (tx) => {
        // Small delay before second attempt
        await new Promise((r) => setTimeout(r, 10));
        const isNew = await recordWebhookReceipt(tx, TEST_SHOP, webhookId, "ORDERS_CREATE");
        results.push(isNew);
      }),
    ]);

    // Exactly one should be true (the winner)
    const successes = results.filter((r) => r === true);
    expect(successes.length).toBe(1);

    // Should be exactly one record
    const rows = await sql`
      SELECT webhook_id FROM webhook_receipts WHERE shop = ${TEST_SHOP} AND webhook_id = ${webhookId}
    `;
    expect(rows.length).toBe(1);
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

    // Record at edge (webhook_receipts)
    await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");

    // Drain should NOT see it as processed yet
    const beforeDrain = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(beforeDrain).toBe(false);

    // Mark processed at drain (s6_processed_webhooks)
    await markWebhookProcessed(
      sql,
      webhookId,
      "ORDERS_CREATE",
      "gid://shopify/Order/123",
      TEST_SHOP
    );

    // Now drain sees it as processed
    const afterDrain = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(afterDrain).toBe(true);

    // Verify records in both tables
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

    // First delivery - accepted at edge
    const first = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(first).toBe(true);

    // Shopify retry - blocked at edge (no duplicate enqueue)
    const retry = await recordWebhookReceipt(sql, TEST_SHOP, webhookId, "ORDERS_CREATE");
    expect(retry).toBe(false);
  });

  it("replay at drain blocks duplicate processing (pgmq duplicate)", async () => {
    const { isWebhookProcessed, markWebhookProcessed } = await import(
      "~/services/sync/company.server"
    );

    const webhookId = `test-twolevel-3-${Date.now()}`;

    // First processing in drain
    const firstCheck = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(firstCheck).toBe(false);

    await markWebhookProcessed(
      sql,
      webhookId,
      "ORDERS_CREATE",
      "gid://shopify/Order/123",
      TEST_SHOP
    );

    // Second processing (e.g., pgmq at-least-once delivery)
    const secondCheck = await isWebhookProcessed(sql, webhookId, TEST_SHOP);
    expect(secondCheck).toBe(true); // Skipped - already processed
  });
});
