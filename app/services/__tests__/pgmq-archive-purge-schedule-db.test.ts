/**
 * DB integration tests for prisma/migrations/20261125000000_pgmq_archive_purge_schedule.
 *
 * The migration's DO block is re-run inside transactions that are rolled back.
 * - Without pg_cron (CI): it must be a no-op, safe to run twice.
 * - With pg_cron: exactly one 'pgmq_purge_archives_30d' job with the expected
 *   schedule and command, even after running twice. Skipped when pg_cron is absent.
 *
 * Run with: TEST_DATABASE_URL=postgresql://... npm test -- pgmq-archive-purge-schedule-db
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const JOB = "pgmq_purge_archives_30d";
const MIGRATION_SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    "../../../prisma/migrations/20261125000000_pgmq_archive_purge_schedule/migration.sql",
  ),
  "utf8",
);

class Rollback extends Error {}

describeWithDb("pgmq archive purge schedule (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  let hasCron = false;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    const [row] = await sql`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS has_cron`;
    hasCron = row.has_cron;
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

  it("the scheduled function exists", async () => {
    const [fn] = await sql`
      SELECT to_regprocedure('public.pgmq_purge_archives_30d(integer, integer)') IS NOT NULL AS ok`;
    expect(fn.ok).toBe(true);
  });

  it("is a no-op without pg_cron and safe to run twice", async (ctx) => {
    if (hasCron) ctx.skip();
    await inRollback(async (tx) => {
      await tx.unsafe(MIGRATION_SQL);
      await tx.unsafe(MIGRATION_SQL);
      const [r] = await tx`
        SELECT to_regclass('cron.job') IS NULL AS no_cron_schema`;
      expect(r.no_cron_schema).toBe(true);
    });
  });

  it("schedules exactly one job, idempotently, with pg_cron", async (ctx) => {
    if (!hasCron) ctx.skip();
    await inRollback(async (tx) => {
      await tx.unsafe(MIGRATION_SQL);
      await tx.unsafe(MIGRATION_SQL);
      const jobs = await tx`
        SELECT schedule, command FROM cron.job WHERE jobname = ${JOB}`;
      expect(jobs).toHaveLength(1);
      expect(jobs[0].schedule).toBe("30 5 * * *");
      expect(jobs[0].command).toBe("SELECT public.pgmq_purge_archives_30d()");
    });
  });
});
