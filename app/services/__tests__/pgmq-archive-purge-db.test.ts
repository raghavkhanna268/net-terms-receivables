/**
 * DB integration tests for public.pgmq_purge_archives_7d()
 * (prisma/migrations/20261120000000_pgmq_archive_purge).
 *
 * Every case runs inside a transaction that is rolled back, so no rows outside
 * the test are removed for good.
 *
 * Requires a running PostgreSQL instance with pgmq and the migrations applied.
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- pgmq-archive-purge-db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

class Rollback extends Error {}

describeWithDb("pgmq archive 7-day purge (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const BASE = 9_000_000_000_000 + Math.floor(Math.random() * 1_000_000) * 1000;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function inRollback(
    fn: (tx: postgres.TransactionSql) => Promise<void>,
  ) {
    await expect(
      sql.begin(async (tx) => {
        await fn(tx);
        throw new Rollback();
      }),
    ).rejects.toBeInstanceOf(Rollback);
  }

  async function seed(
    tx: postgres.TransactionSql,
    table: "a_s6_sync" | "a_s6_bulk",
    ids: number[],
    ageDays: number,
  ) {
    for (const id of ids) {
      await tx.unsafe(
        `INSERT INTO pgmq.${table} (msg_id, read_ct, enqueued_at, archived_at, vt, message)
         VALUES ($1, 1, now() - make_interval(days => $2), now() - make_interval(days => $2),
                 now() - make_interval(days => $2), '{"topic":"TEST"}'::jsonb)`,
        [id, ageDays],
      );
    }
  }

  async function present(
    tx: postgres.TransactionSql,
    table: "a_s6_sync" | "a_s6_bulk",
    ids: number[],
  ): Promise<number[]> {
    const rows = await tx.unsafe(
      `SELECT msg_id::text AS id FROM pgmq.${table} WHERE msg_id = ANY($1::bigint[]) ORDER BY msg_id`,
      [ids],
    );
    return rows.map((r) => Number(r.id));
  }

  it("is defined and not scheduled", async () => {
    const [fn] = await sql`
      SELECT to_regprocedure('public.pgmq_purge_archives_7d(integer, integer)') IS NOT NULL AS ok`;
    expect(fn.ok).toBe(true);
    const [cron] = await sql`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS has_cron`;
    if (cron.has_cron) {
      const jobs = await sql`
        SELECT 1 FROM cron.job WHERE command ILIKE '%pgmq_purge_archives_7d%'`;
      expect(jobs).toHaveLength(0);
    }
  });

  it("archive tables have an archived_at index for the purge predicate", async () => {
    const rows = await sql`
      SELECT tablename FROM pg_indexes
      WHERE schemaname = 'pgmq' AND tablename IN ('a_s6_sync', 'a_s6_bulk')
        AND indexdef ILIKE '%(archived_at)%'`;
    expect(new Set(rows.map((r) => r.tablename))).toEqual(
      new Set(["a_s6_sync", "a_s6_bulk"]),
    );
  });

  it("deletes only rows archived more than 7 days ago, in both archive tables", async () => {
    const oldSync = [BASE + 1, BASE + 2];
    const youngSync = [BASE + 3];
    const oldBulk = [BASE + 11];
    const youngBulk = [BASE + 12];
    await inRollback(async (tx) => {
      await seed(tx, "a_s6_sync", oldSync, 8);
      await seed(tx, "a_s6_sync", youngSync, 6);
      await seed(tx, "a_s6_bulk", oldBulk, 30);
      await seed(tx, "a_s6_bulk", youngBulk, 1);

      const [r] = await tx`SELECT public.pgmq_purge_archives_7d()::text AS n`;
      expect(Number(r.n)).toBeGreaterThanOrEqual(3);

      expect(
        await present(tx, "a_s6_sync", [...oldSync, ...youngSync]),
      ).toEqual(youngSync);
      expect(
        await present(tx, "a_s6_bulk", [...oldBulk, ...youngBulk]),
      ).toEqual(youngBulk);
    });
  });

  it("is bounded by batch size x max batches per table and returns the deleted count", async () => {
    const old = [BASE + 21, BASE + 22, BASE + 23, BASE + 24, BASE + 25];
    await inRollback(async (tx) => {
      // Clear any pre-existing old rows inside this rolled-back transaction so
      // the bound can be asserted exactly.
      await tx`SELECT public.pgmq_purge_archives_7d(50000, 1000)`;
      await seed(tx, "a_s6_sync", old, 10);

      const [r1] =
        await tx`SELECT public.pgmq_purge_archives_7d(2, 1)::text AS n`;
      expect(Number(r1.n)).toBe(2);
      expect(await present(tx, "a_s6_sync", old)).toHaveLength(3);

      const [r2] =
        await tx`SELECT public.pgmq_purge_archives_7d(2, 10)::text AS n`;
      expect(Number(r2.n)).toBe(3);
      expect(await present(tx, "a_s6_sync", old)).toEqual([]);

      const [r3] = await tx`SELECT public.pgmq_purge_archives_7d()::text AS n`;
      expect(Number(r3.n)).toBe(0);
    });
  });
});
