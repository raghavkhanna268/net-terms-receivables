/**
 * Static checks for prisma/migrations/20261125000000_pgmq_archive_purge_schedule:
 * schedules public.pgmq_purge_archives_30d() daily via pg_cron, idempotently,
 * and only when pg_cron is installed.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../../..");
const MIGRATION = path.join(
  root,
  "prisma/migrations/20261125000000_pgmq_archive_purge_schedule/migration.sql",
);
const JOB = "pgmq_purge_archives_30d";

function code(sql: string): string {
  return sql
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
}

describe("pgmq archive purge schedule migration", () => {
  const raw = fs.readFileSync(MIGRATION, "utf8");
  const body = code(raw);

  it("sorts after the purge function migration", () => {
    const dirs = fs.readdirSync(path.join(root, "prisma/migrations")).sort();
    expect(
      dirs.indexOf("20261125000000_pgmq_archive_purge_schedule"),
    ).toBeGreaterThan(dirs.indexOf("20261124000000_pgmq_archive_purge"));
  });

  it("is a single DO block guarded on pg_cron", () => {
    const dos = body.match(/\bDO \$do\$/g) ?? [];
    expect(dos).toHaveLength(1);
    expect(body).toMatch(
      /IF NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_extension WHERE extname = 'pg_cron'\) THEN\s+RAISE NOTICE '[^']*';\s+RETURN;\s+END IF;/,
    );
    const guard = body.indexOf("extname = 'pg_cron'");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("cron.job"));
    expect(guard).toBeLessThan(body.indexOf("cron.schedule"));
  });

  it("unschedules an existing job by name before scheduling (idempotent)", () => {
    const check = body.indexOf(
      `IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${JOB}') THEN`,
    );
    const unsched = body.indexOf(`PERFORM cron.unschedule('${JOB}');`);
    const sched = body.indexOf("PERFORM cron.schedule(");
    expect(check).toBeGreaterThan(-1);
    expect(unsched).toBeGreaterThan(check);
    expect(sched).toBeGreaterThan(unsched);
    expect(body.match(/cron\.unschedule\(/g)).toHaveLength(1);
    expect(body.match(/cron\.schedule\(/g)).toHaveLength(1);
  });

  it("schedules the job name, schedule and command exactly", () => {
    expect(body).toMatch(
      new RegExp(
        String.raw`PERFORM cron\.schedule\(\s*'${JOB}',\s*'30 5 \* \* \*',\s*'SELECT public\.${JOB}\(\)'\s*\);`,
      ),
    );
  });

  it("does nothing else", () => {
    expect(body).not.toMatch(
      /\b(DELETE|INSERT|UPDATE|TRUNCATE|DROP|ALTER|GRANT|CREATE)\b/i,
    );
    expect(body).not.toMatch(/cron\.alter_job/);
  });

  it("is documented as scheduled daily in data-retention.md", () => {
    const doc = fs.readFileSync(
      path.join(root, "docs/security/data-retention.md"),
      "utf8",
    );
    expect(doc).toContain(
      "Processed sync-queue messages are kept for 30 days for troubleshooting, then deleted.",
    );
    expect(doc).toMatch(/Status: scheduled daily\./);
    expect(doc).not.toContain("once the purge job is enabled");
    expect(doc).not.toMatch(
      /pgmq_purge_archives_30d\(\)`[^\n]*not scheduled yet/,
    );
    expect(doc).toContain(`| \`${JOB}\` | \`30 5 * * *\` (daily 05:30 UTC) |`);
  });
});
