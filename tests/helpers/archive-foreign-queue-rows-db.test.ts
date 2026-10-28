/**
 * DB-backed tests for archiveForeignQueueRows helper.
 *
 * Tests:
 * 1. Archives a foreign row and keeps an own row (real pgmq, synthetic test-* shops)
 * 2. Throws on a non-test DB URL (TEST_DATABASE_URL not set)
 * 3. Throws on an empty list
 *
 * Each test must fail on revert, with no conditional asserts and no sleeps.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { archiveForeignQueueRows } from "./archive-foreign-queue-rows";
import { assertNoQueueLeftovers } from "./queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const TEST_SUFFIX = Date.now().toString(36) + "-archivehelper";

describeWithDb("archiveForeignQueueRows helper", () => {
  let sql: ReturnType<typeof postgres>;
  const OWN_SHOP = `test-own-${TEST_SUFFIX}.myshopify.com`;
  const FOREIGN_SHOP = `test-foreign-${TEST_SUFFIX}.myshopify.com`;
  const FOREIGN_SHOP_2 = `test-foreign2-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    const allDomains = [OWN_SHOP, FOREIGN_SHOP, FOREIGN_SHOP_2];
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;

    await assertNoQueueLeftovers(sql, allDomains, "archive-foreign-queue-rows-db.test.ts");

    await sql.end();
  });

  afterEach(async () => {
    const allDomains = [OWN_SHOP, FOREIGN_SHOP, FOREIGN_SHOP_2];
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
  });

  describe("sync queue", () => {
    it("archives foreign rows and keeps own rows", async () => {
      const ownMsg = {
        shop: OWN_SHOP,
        topic: "ORDERS_CREATE",
        webhookId: `wh-own-sync-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/own-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };
      const foreignMsg = {
        shop: FOREIGN_SHOP,
        topic: "ORDERS_CREATE",
        webhookId: `wh-foreign-sync-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/foreign-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(ownMsg)})`;
      await sql`SELECT pgmq.send('s6_sync', ${sql.json(foreignMsg)})`;

      const [beforeOwn] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${OWN_SHOP}
      `;
      const [beforeForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      expect(parseInt(beforeOwn.count, 10)).toBe(1);
      expect(parseInt(beforeForeign.count, 10)).toBe(1);

      const result = await archiveForeignQueueRows(sql, [OWN_SHOP]);

      expect(result.archivedSync).toBeGreaterThanOrEqual(1);

      const [afterOwn] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${OWN_SHOP}
      `;
      const [afterForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      expect(parseInt(afterOwn.count, 10)).toBe(1);
      expect(parseInt(afterForeign.count, 10)).toBe(0);

      const [archivedForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      expect(parseInt(archivedForeign.count, 10)).toBe(1);
    });
  });

  describe("bulk queue", () => {
    it("archives foreign rows and keeps own rows", async () => {
      const ownMsg = {
        shop: OWN_SHOP,
        topic: "BULK_OPERATIONS_FINISH",
        bulkOperationId: `gid://shopify/BulkOperation/own-bulk-${TEST_SUFFIX}`,
        bulkType: "orders",
        enqueuedAt: new Date().toISOString(),
      };
      const foreignMsg = {
        shop: FOREIGN_SHOP,
        topic: "BULK_OPERATIONS_FINISH",
        bulkOperationId: `gid://shopify/BulkOperation/foreign-bulk-${TEST_SUFFIX}`,
        bulkType: "orders",
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_bulk', ${sql.json(ownMsg)})`;
      await sql`SELECT pgmq.send('s6_bulk', ${sql.json(foreignMsg)})`;

      const [beforeOwn] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${OWN_SHOP}
      `;
      const [beforeForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      expect(parseInt(beforeOwn.count, 10)).toBe(1);
      expect(parseInt(beforeForeign.count, 10)).toBe(1);

      const result = await archiveForeignQueueRows(sql, [OWN_SHOP]);

      expect(result.archivedBulk).toBeGreaterThanOrEqual(1);

      const [afterOwn] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${OWN_SHOP}
      `;
      const [afterForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      expect(parseInt(afterOwn.count, 10)).toBe(1);
      expect(parseInt(afterForeign.count, 10)).toBe(0);

      const [archivedForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      expect(parseInt(archivedForeign.count, 10)).toBe(1);
    });
  });

  describe("multiple own shops", () => {
    it("keeps all own shop rows and archives only foreign rows", async () => {
      const ownMsg1 = {
        shop: OWN_SHOP,
        topic: "ORDERS_CREATE",
        webhookId: `wh-own1-multi-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/own1-multi-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };
      const ownMsg2 = {
        shop: FOREIGN_SHOP,
        topic: "ORDERS_CREATE",
        webhookId: `wh-own2-multi-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/own2-multi-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };
      const foreignMsg = {
        shop: FOREIGN_SHOP_2,
        topic: "ORDERS_CREATE",
        webhookId: `wh-foreign-multi-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/foreign-multi-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(ownMsg1)})`;
      await sql`SELECT pgmq.send('s6_sync', ${sql.json(ownMsg2)})`;
      await sql`SELECT pgmq.send('s6_sync', ${sql.json(foreignMsg)})`;

      await archiveForeignQueueRows(sql, [OWN_SHOP, FOREIGN_SHOP]);

      const [afterOwn1] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${OWN_SHOP}
      `;
      const [afterOwn2] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${FOREIGN_SHOP}
      `;
      const [afterForeign] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${FOREIGN_SHOP_2}
      `;

      expect(parseInt(afterOwn1.count, 10)).toBe(1);
      expect(parseInt(afterOwn2.count, 10)).toBe(1);
      expect(parseInt(afterForeign.count, 10)).toBe(0);
    });
  });

  describe("null shop handling", () => {
    it("archives rows with NULL shop key", async () => {
      const ownMsg = {
        shop: OWN_SHOP,
        topic: "ORDERS_CREATE",
        webhookId: `wh-own-null-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/own-null-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };
      const nullShopMsg = {
        topic: "ORDERS_CREATE",
        webhookId: `wh-null-shop-${TEST_SUFFIX}`,
        resourceGid: `gid://shopify/Order/null-${TEST_SUFFIX}`,
        enqueuedAt: new Date().toISOString(),
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(ownMsg)})`;
      await sql`SELECT pgmq.send('s6_sync', ${sql.json(nullShopMsg)})`;

      await archiveForeignQueueRows(sql, [OWN_SHOP]);

      const [afterOwn] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${OWN_SHOP}
      `;
      const [afterNull] = await sql<[{ count: string }]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${'wh-null-shop-' + TEST_SUFFIX}
      `;

      expect(parseInt(afterOwn.count, 10)).toBe(1);
      expect(parseInt(afterNull.count, 10)).toBe(0);
    });
  });

  describe("error handling", () => {
    it("throws on empty own-list", async () => {
      await expect(archiveForeignQueueRows(sql, [])).rejects.toThrow(
        "archiveForeignQueueRows: ownShopDomains must not be empty"
      );
    });

    it("throws when TEST_DATABASE_URL is not set", async () => {
      const originalEnv = process.env.TEST_DATABASE_URL;
      delete process.env.TEST_DATABASE_URL;

      try {
        await expect(archiveForeignQueueRows(sql, [OWN_SHOP])).rejects.toThrow(
          "archiveForeignQueueRows: TEST_DATABASE_URL is not set"
        );
      } finally {
        process.env.TEST_DATABASE_URL = originalEnv;
      }
    });
  });
});
