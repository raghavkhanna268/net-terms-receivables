/**
 * DB-backed tests for flagAccountsForRecompute IN-list query behavior.
 *
 * Tests the `IN ${sql(ids)}` query path in flagAccountsForRecompute
 * (credit-status-recompute.server.ts ~:374) to verify:
 * - Several ids are flagged and the return count matches
 * - An empty list returns 0 with no query
 * - One id is flagged correctly
 * - Non-matching ids are untouched
 *
 * Uses the shared sqlOptions (fetch_types:false) to exercise the real query behavior.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("flagAccountsForRecompute IN-list query (DB-backed)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = `flag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const TEST_SHOP_ID = `shop-flag-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-flag-${TEST_SUFFIX}.example.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`
      SELECT pgmq.archive('s6_sync', ARRAY(
        SELECT msg_id FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      ))
    `;
    await sql`
      DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
    `;

    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "flag-accounts-recompute-db.test.ts");

    await sql.end();
  });

  afterEach(async () => {
    await sql`
      SELECT pgmq.archive('s6_sync', ARRAY(
        SELECT msg_id FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      ))
    `;
    await sql`
      DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
    `;
  });

  it("several ids are flagged and the return count matches", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const accountIds = [
      `acc-multi-1-${TEST_SUFFIX}`,
      `acc-multi-2-${TEST_SUFFIX}`,
      `acc-multi-3-${TEST_SUFFIX}`,
    ];

    const result = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, accountIds);

    expect(result).toBe(3);

    const rows = await sql<{ buyerAccountId: string }[]>`
      SELECT message->>'buyerAccountId' AS "buyerAccountId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        AND read_ct = 0
    `;

    const enqueuedIds = rows.map((r) => r.buyerAccountId);
    for (const id of accountIds) {
      expect(enqueuedIds).toContain(id);
    }
  });

  it("empty list returns 0 with no query", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const [beforeCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
    `;
    const countBefore = parseInt(beforeCount.count, 10);

    const result = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, []);

    expect(result).toBe(0);

    const [afterCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
    `;
    const countAfter = parseInt(afterCount.count, 10);

    expect(countAfter).toBe(countBefore);
  });

  it("single id is flagged correctly", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const singleId = `acc-single-${TEST_SUFFIX}`;

    const result = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, [singleId]);

    expect(result).toBe(1);

    const [msg] = await sql<{ buyerAccountId: string; topic: string }[]>`
      SELECT 
        message->>'buyerAccountId' AS "buyerAccountId",
        message->>'topic' AS topic
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'buyerAccountId' = ${singleId}
        AND read_ct = 0
    `;

    expect(msg).toBeDefined();
    expect(msg.buyerAccountId).toBe(singleId);
    expect(msg.topic).toBe("CREDIT_STATUS_RECOMPUTE");
  });

  it("ids that already have unread messages are skipped (debounce)", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const existingId = `acc-existing-${TEST_SUFFIX}`;
    const newId = `acc-new-${TEST_SUFFIX}`;

    const firstResult = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, [existingId]);
    expect(firstResult).toBe(1);

    const secondResult = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, [existingId, newId]);
    expect(secondResult).toBe(1);

    const rows = await sql<{ buyerAccountId: string }[]>`
      SELECT message->>'buyerAccountId' AS "buyerAccountId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'topic' = 'CREDIT_STATUS_RECOMPUTE'
        AND message->>'buyerAccountId' IN ${sql([existingId, newId])}
        AND read_ct = 0
    `;

    expect(rows.length).toBe(2);
    const ids = rows.map((r) => r.buyerAccountId);
    expect(ids).toContain(existingId);
    expect(ids).toContain(newId);
  });

  it("null and undefined values in the list are filtered out", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const validId = `acc-valid-${TEST_SUFFIX}`;
    const accountIds: (string | null | undefined)[] = [null, validId, undefined, null];

    const result = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, accountIds);

    expect(result).toBe(1);

    const [msg] = await sql<{ buyerAccountId: string }[]>`
      SELECT message->>'buyerAccountId' AS "buyerAccountId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'buyerAccountId' = ${validId}
        AND read_ct = 0
    `;

    expect(msg).toBeDefined();
    expect(msg.buyerAccountId).toBe(validId);
  });

  it("duplicate ids in the list are deduplicated", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const duplicateId = `acc-dup-${TEST_SUFFIX}`;
    const accountIds = [duplicateId, duplicateId, duplicateId];

    const result = await flagAccountsForRecompute(sql, TEST_SHOP_DOMAIN, accountIds);

    expect(result).toBe(1);

    const rows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'buyerAccountId' = ${duplicateId}
        AND read_ct = 0
    `;

    expect(parseInt(rows[0].count, 10)).toBe(1);
  });

  it("non-INR shop returns 0 without enqueueing", async () => {
    const { flagAccountsForRecompute } = await import("../credit-status-recompute.server");

    const nonInrShopId = `shop-noninr-${TEST_SUFFIX}`;
    const nonInrShopDomain = `test-noninr-${TEST_SUFFIX}.example.com`;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${nonInrShopId}, ${nonInrShopDomain}, 'USD', NOW(), NOW())
    `;

    try {
      const result = await flagAccountsForRecompute(
        sql,
        nonInrShopDomain,
        [`acc-noninr-${TEST_SUFFIX}`]
      );

      expect(result).toBe(0);

      const [count] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${nonInrShopDomain}
      `;
      expect(parseInt(count.count, 10)).toBe(0);
    } finally {
      await sql`DELETE FROM "Shop" WHERE id = ${nonInrShopId}`;
    }
  });
});
