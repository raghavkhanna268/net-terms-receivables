/**
 * DB test for #239 (c): dead-letter rows written during the 48h uninstall
 * window must not survive shop/redact.
 *
 * Sequence:
 * 1. Shop A is uninstalled (uninstalledAt set, Shop row still present).
 * 2. The drain dead-letters a sync and a bulk message for A. moveToDeadLetter
 *    sanitizes them: the domain is dropped and the internal Shop id is kept at
 *    message->>'shopId'.
 * 3. shop/redact runs deleteShop(A).
 *
 * Expected: 0 rows for A anywhere (queues, archives, s6_dead_letter, Shop),
 * while shop B (installed, full DLQ row) and near-miss shop AX (uninstalled,
 * id and domain that share A's prefix) keep their rows.
 *
 * Before the fix, deleteShop only matched message->>'shop', so A's sanitized
 * rows survived until the weekly 30-day DLQ cleanup.
 *
 * Synthetic fixtures only (test-* domains).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import type { BulkMessage, SyncMessage } from "~/lib/pgmq.server";
import { assertNoQueueLeftovers } from "../../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SUFFIX = Date.now().toString(36) + "-dlq-uninst";

const A = { id: `shop-a-${SUFFIX}`, domain: `test-a-${SUFFIX}.myshopify.com` };
// Near-miss: id and domain both start with A's, so LIKE-style matching would hit it.
const AX_SUFFIX = `${SUFFIX}x`;
const AX = { id: `shop-a-${AX_SUFFIX}`, domain: `test-a-${AX_SUFFIX}.myshopify.com` };
const B = { id: `shop-b-${SUFFIX}`, domain: `test-b-${SUFFIX}.myshopify.com` };
const ALL = [A, AX, B];

function syncMsg(shop: string, tag: string): SyncMessage {
  return {
    shop,
    topic: "ORDERS_CREATE",
    webhookId: `wh-${tag}-${SUFFIX}`,
    resourceGid: `gid://shopify/Order/${tag}-${SUFFIX}`,
    enqueuedAt: new Date().toISOString(),
  };
}

function bulkMsg(shop: string, tag: string): BulkMessage {
  return {
    shop,
    topic: "BULK_OPERATIONS_FINISH",
    webhookId: `wh-${tag}-${SUFFIX}`,
    bulkOperationId: `gid://shopify/BulkOperation/${tag}-${SUFFIX}`,
    bulkType: "orders",
    enqueuedAt: new Date().toISOString(),
  };
}

describeWithDb("shop/redact purges sanitized dead-letter rows from the uninstall window (#239)", () => {
  let sql: ReturnType<typeof postgres>;

  async function cleanup(): Promise<void> {
    const domains = ALL.map((s) => s.domain);
    const ids = ALL.map((s) => s.id);
    await sql`DELETE FROM s6_dead_letter WHERE message->>'webhookId' LIKE ${`%${SUFFIX}%`}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(domains)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(domains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(domains)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(domains)}`;
    await sql`DELETE FROM webhook_receipts WHERE shop IN ${sql(domains)}`;
    await sql`DELETE FROM "Session" WHERE shop IN ${sql(domains)}`;
    await sql`DELETE FROM "Shop" WHERE id IN ${sql(ids)}`;
  }

  async function deadLetter(queue: "s6_sync" | "s6_bulk", message: SyncMessage | BulkMessage, error: string) {
    const [{ send }] = await sql<[{ send: string }]>`
      SELECT pgmq.send(${queue}, ${sql.json(message)})
    `;
    const { moveToDeadLetter } = await import("~/services/drain/processor.server");
    const ok = await moveToDeadLetter(sql, queue, send, message, error, 5);
    expect(ok, `dead-letter ${message.webhookId}`).toBe(true);
  }

  async function dlqCount(where: "shop" | "shopId", value: string): Promise<number> {
    const [row] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM s6_dead_letter
      WHERE message->>${where} = ${value}
    `;
    return parseInt(row.count, 10);
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await assertNoQueueLeftovers(sql, ALL.map((s) => s.domain), "dlq-uninstall-redact-db.test.ts");
    await sql.end();
  });

  it("leaves 0 dead-letter rows for A after redact; B and near-miss AX untouched", async () => {
    const now = new Date();
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    for (const s of [A, AX]) {
      await sql`
        INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
        VALUES (${s.id}, ${s.domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
      `;
    }
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${B.id}, ${B.domain}, 'INR', ${now}, ${now})
    `;

    // Uninstall window: A's and AX's messages are dead-lettered and sanitized.
    await deadLetter("s6_sync", syncMsg(A.domain, "a-sync"), "non_retryable:shop_not_found");
    await deadLetter("s6_bulk", bulkMsg(A.domain, "a-bulk"), "permanent:shop_not_found");
    await deadLetter("s6_sync", syncMsg(AX.domain, "ax-sync"), "non_retryable:shop_not_found");
    // Installed shop B: full (unsanitized) row.
    await deadLetter("s6_sync", syncMsg(B.domain, "b-sync"), "test_error");

    // Precondition: A's rows are sanitized (no domain, shopId present), so a
    // domain-only delete cannot find them.
    expect(await dlqCount("shop", A.domain), "A rows carry no domain").toBe(0);
    expect(await dlqCount("shopId", A.id), "A sanitized rows before redact").toBe(2);
    expect(await dlqCount("shopId", AX.id), "AX sanitized row before redact").toBe(1);
    expect(await dlqCount("shop", B.domain), "B full row before redact").toBe(1);

    const { deleteShop } = await import("~/services/compliance/compliance.server");
    const result = await deleteShop(sql, A.domain);

    expect(result.deleted).toBe(true);
    expect(result.deadLetterPurged).toBe(2);

    // A: nothing left anywhere.
    expect(await dlqCount("shopId", A.id), "A sanitized rows after redact").toBe(0);
    const [aLeft] = await sql<[{ dlq: string; shop: string; q: string; a: string }]>`
      SELECT
        (SELECT COUNT(*)::text FROM s6_dead_letter
          WHERE message->>'webhookId' IN (${`wh-a-sync-${SUFFIX}`}, ${`wh-a-bulk-${SUFFIX}`})) AS dlq,
        (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${A.id}) AS shop,
        (SELECT COUNT(*)::text FROM pgmq.q_s6_sync WHERE message->>'shop' = ${A.domain}) AS q,
        (SELECT (
          (SELECT COUNT(*) FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${A.domain}) +
          (SELECT COUNT(*) FROM pgmq.a_s6_sync WHERE message->>'shop' = ${A.domain}) +
          (SELECT COUNT(*) FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${A.domain})
        )::text) AS a
    `;
    expect(aLeft.dlq, "A dead-letter rows by webhookId").toBe("0");
    expect(aLeft.shop, "A Shop row").toBe("0");
    expect(aLeft.q, "A sync queue").toBe("0");
    expect(aLeft.a, "A bulk queue + archives").toBe("0");

    // B and near-miss AX: untouched.
    expect(await dlqCount("shopId", AX.id), "AX sanitized row after redact").toBe(1);
    expect(await dlqCount("shop", B.domain), "B full row after redact").toBe(1);
    const [others] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM "Shop" WHERE id IN (${AX.id}, ${B.id})
    `;
    expect(others.count, "AX and B Shop rows remain").toBe("2");
  });
});
