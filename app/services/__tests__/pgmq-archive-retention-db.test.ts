/**
 * DB integration tests for pgmq archive retention purge (30-day cleanup).
 *
 * Tests:
 * - Migration creates exactly one cron job with the correct name and schedule
 * - Migration is idempotent (applying twice leaves exactly one job)
 * - Purge deletes only archive rows older than 30 days
 * - Live queue rows and dead-letter rows are not touched
 * - 29-day and 1-day old archive rows survive
 *
 * Uses a stand-in cron schema so the real migration can be exercised in CI.
 * Requires a running PostgreSQL instance with pgmq.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- pgmq-archive-retention-db
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import * as fs from "fs";
import * as path from "path";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATION_PATH = path.resolve(
  __dirname,
  "../../../prisma/migrations/20261126000000_pgmq_archive_purge_30d/migration.sql"
);

describeWithDb("pgmq archive retention purge 30d (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-archive-purge";
  const TEST_SHOP_31D = `test-archive-purge-31d-${TEST_SUFFIX}.example.com`;
  const TEST_SHOP_29D = `test-archive-purge-29d-${TEST_SUFFIX}.example.com`;
  const TEST_SHOP_1D = `test-archive-purge-1d-${TEST_SUFFIX}.example.com`;
  const TEST_SHOP_LIVE = `test-archive-purge-live-${TEST_SUFFIX}.example.com`;
  const TEST_SHOP_DLQ = `test-archive-purge-dlq-${TEST_SUFFIX}.example.com`;

  const ALL_TEST_SHOPS = [TEST_SHOP_31D, TEST_SHOP_29D, TEST_SHOP_1D, TEST_SHOP_LIVE, TEST_SHOP_DLQ];

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}`;
  });

  describe("migration with stand-in cron schema", () => {
    let cronSchemaSql: ReturnType<typeof postgres>;
    let cronSchemaName: string;

    beforeEach(async () => {
      cronSchemaName = `cron_test_${TEST_SUFFIX.replace(/-/g, "_")}`;
      cronSchemaSql = sql;

      await cronSchemaSql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${cronSchemaName}`);

      await cronSchemaSql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${cronSchemaName}.job (
          jobid SERIAL PRIMARY KEY,
          jobname TEXT NOT NULL,
          schedule TEXT NOT NULL,
          command TEXT NOT NULL
        )
      `);

      await cronSchemaSql.unsafe(`
        CREATE OR REPLACE FUNCTION ${cronSchemaName}.schedule(name TEXT, schedule TEXT, cmd TEXT)
        RETURNS INTEGER AS $$
        DECLARE
          new_id INTEGER;
        BEGIN
          INSERT INTO ${cronSchemaName}.job (jobname, schedule, command)
          VALUES (name, schedule, cmd)
          RETURNING jobid INTO new_id;
          RETURN new_id;
        END;
        $$ LANGUAGE plpgsql
      `);

      await cronSchemaSql.unsafe(`
        CREATE OR REPLACE FUNCTION ${cronSchemaName}.unschedule(name TEXT)
        RETURNS BOOLEAN AS $$
        BEGIN
          DELETE FROM ${cronSchemaName}.job WHERE jobname = name;
          RETURN TRUE;
        END;
        $$ LANGUAGE plpgsql
      `);
    });

    afterEach(async () => {
      await cronSchemaSql.unsafe(`DROP SCHEMA IF EXISTS ${cronSchemaName} CASCADE`);
    });

    it("creates exactly one job named pgmq_purge_archives_30d with correct schedule after applying migration twice", async () => {
      const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
      const rewritten = migrationSql.replace(/\bcron\./g, `${cronSchemaName}.`);

      await cronSchemaSql.unsafe(rewritten);
      await cronSchemaSql.unsafe(rewritten);

      const jobs = await cronSchemaSql.unsafe<{ jobname: string; schedule: string; command: string }[]>(`
        SELECT jobname, schedule, command FROM ${cronSchemaName}.job WHERE jobname = 'pgmq_purge_archives_30d'
      `);

      expect(jobs.length).toBe(1);
      expect(jobs[0].jobname).toBe("pgmq_purge_archives_30d");
      expect(jobs[0].schedule).toBe("30 5 * * *");
      expect(jobs[0].command).toContain("DELETE FROM pgmq.a_s6_sync");
      expect(jobs[0].command).toContain("DELETE FROM pgmq.a_s6_bulk");
      expect(jobs[0].command).toContain("INTERVAL '30 days'");
    });

    it("purges only 31-day old archive rows, keeps 29-day and 1-day rows, live queue, and dead-letter", async () => {
      const migrationSql = fs.readFileSync(MIGRATION_PATH, "utf8");
      const rewritten = migrationSql.replace(/\bcron\./g, `${cronSchemaName}.`);
      await cronSchemaSql.unsafe(rewritten);

      const now = new Date();
      const days31Ago = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
      const days29Ago = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
      const days1Ago = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);

      const [sync31d] = await sql<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql.json({ shop: TEST_SHOP_31D, topic: 'ORDERS_UPDATE', webhookId: 'wh-31d-sync', resourceGid: 'gid://shopify/Order/31d' })})
      `;
      await sql`SELECT pgmq.archive('s6_sync', ${sync31d.send}::bigint)`;
      await sql`UPDATE pgmq.a_s6_sync SET archived_at = ${days31Ago} WHERE msg_id = ${sync31d.send}::bigint`;

      const [bulk31d] = await sql<[{ send: string }]>`
        SELECT pgmq.send('s6_bulk', ${sql.json({ shop: TEST_SHOP_31D, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-31d-bulk', bulkOperationId: 'gid://shopify/BulkOperation/31d' })})
      `;
      await sql`SELECT pgmq.archive('s6_bulk', ${bulk31d.send}::bigint)`;
      await sql`UPDATE pgmq.a_s6_bulk SET archived_at = ${days31Ago} WHERE msg_id = ${bulk31d.send}::bigint`;

      const [sync29d] = await sql<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql.json({ shop: TEST_SHOP_29D, topic: 'ORDERS_UPDATE', webhookId: 'wh-29d-sync', resourceGid: 'gid://shopify/Order/29d' })})
      `;
      await sql`SELECT pgmq.archive('s6_sync', ${sync29d.send}::bigint)`;
      await sql`UPDATE pgmq.a_s6_sync SET archived_at = ${days29Ago} WHERE msg_id = ${sync29d.send}::bigint`;

      const [bulk29d] = await sql<[{ send: string }]>`
        SELECT pgmq.send('s6_bulk', ${sql.json({ shop: TEST_SHOP_29D, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-29d-bulk', bulkOperationId: 'gid://shopify/BulkOperation/29d' })})
      `;
      await sql`SELECT pgmq.archive('s6_bulk', ${bulk29d.send}::bigint)`;
      await sql`UPDATE pgmq.a_s6_bulk SET archived_at = ${days29Ago} WHERE msg_id = ${bulk29d.send}::bigint`;

      const [sync1d] = await sql<[{ send: string }]>`
        SELECT pgmq.send('s6_sync', ${sql.json({ shop: TEST_SHOP_1D, topic: 'ORDERS_UPDATE', webhookId: 'wh-1d-sync', resourceGid: 'gid://shopify/Order/1d' })})
      `;
      await sql`SELECT pgmq.archive('s6_sync', ${sync1d.send}::bigint)`;
      await sql`UPDATE pgmq.a_s6_sync SET archived_at = ${days1Ago} WHERE msg_id = ${sync1d.send}::bigint`;

      const [bulk1d] = await sql<[{ send: string }]>`
        SELECT pgmq.send('s6_bulk', ${sql.json({ shop: TEST_SHOP_1D, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-1d-bulk', bulkOperationId: 'gid://shopify/BulkOperation/1d' })})
      `;
      await sql`SELECT pgmq.archive('s6_bulk', ${bulk1d.send}::bigint)`;
      await sql`UPDATE pgmq.a_s6_bulk SET archived_at = ${days1Ago} WHERE msg_id = ${bulk1d.send}::bigint`;

      await sql`
        SELECT pgmq.send('s6_sync', ${sql.json({ shop: TEST_SHOP_LIVE, topic: 'ORDERS_UPDATE', webhookId: 'wh-live-sync', resourceGid: 'gid://shopify/Order/live' })})
      `;
      await sql`
        SELECT pgmq.send('s6_bulk', ${sql.json({ shop: TEST_SHOP_LIVE, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-live-bulk', bulkOperationId: 'gid://shopify/BulkOperation/live' })})
      `;

      await sql`
        INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
        VALUES ('s6_sync', 'msg-dlq-test', ${sql.json({ shop: TEST_SHOP_DLQ, topic: 'ORDERS_CREATE', webhookId: 'wh-dlq', resourceGid: 'gid://shopify/Order/dlq' })}, 'test_error', ${days31Ago})
      `;

      const beforeSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const beforeBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const beforeLiveSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const beforeLiveBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const beforeDlq = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;

      expect(parseInt(beforeSync[0].count, 10)).toBe(3);
      expect(parseInt(beforeBulk[0].count, 10)).toBe(3);
      expect(parseInt(beforeLiveSync[0].count, 10)).toBe(1);
      expect(parseInt(beforeLiveBulk[0].count, 10)).toBe(1);
      expect(parseInt(beforeDlq[0].count, 10)).toBe(1);

      const [job] = await cronSchemaSql.unsafe<{ command: string }[]>(`
        SELECT command FROM ${cronSchemaName}.job WHERE jobname = 'pgmq_purge_archives_30d'
      `);
      expect(job).toBeDefined();

      await sql.unsafe(job.command);

      const afterSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const afterBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const afterLiveSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const afterLiveBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;
      const afterDlq = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM s6_dead_letter WHERE message->>'shop' IN ${sql(ALL_TEST_SHOPS)}
      `;

      expect(parseInt(afterSync[0].count, 10)).toBe(2);
      expect(parseInt(afterBulk[0].count, 10)).toBe(2);
      expect(parseInt(afterLiveSync[0].count, 10)).toBe(1);
      expect(parseInt(afterLiveBulk[0].count, 10)).toBe(1);
      expect(parseInt(afterDlq[0].count, 10)).toBe(1);

      const remaining31dSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_31D}
      `;
      const remaining31dBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_31D}
      `;
      expect(parseInt(remaining31dSync[0].count, 10)).toBe(0);
      expect(parseInt(remaining31dBulk[0].count, 10)).toBe(0);

      const remaining29dSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_29D}
      `;
      const remaining29dBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_29D}
      `;
      expect(parseInt(remaining29dSync[0].count, 10)).toBe(1);
      expect(parseInt(remaining29dBulk[0].count, 10)).toBe(1);

      const remaining1dSync = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_1D}
      `;
      const remaining1dBulk = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${TEST_SHOP_1D}
      `;
      expect(parseInt(remaining1dSync[0].count, 10)).toBe(1);
      expect(parseInt(remaining1dBulk[0].count, 10)).toBe(1);
    });
  });
});
