import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * prisma/migrations/20261124000000_pgmq_archive_purge only DEFINES the 30-day
 * pgmq archive purge function. It must not schedule (or enable) any pg_cron job:
 * enabling the nightly purge needs the owner's explicit OK.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "prisma/migrations/20261124000000_pgmq_archive_purge/migration.sql";
const sql = fs.readFileSync(path.join(root, rel), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("pgmq archive purge migration", () => {
  it("does not schedule, alter or run any pg_cron job", () => {
    expect(code).not.toMatch(/\bcron\s*\./i);
    expect(code).not.toMatch(/\bPERFORM\b/i);
    // Top-level statements: the function, its comment and the REVOKEs only.
    expect(code).not.toMatch(
      /^(SELECT|DELETE|CALL|ALTER|INSERT|UPDATE|GRANT)\b/im,
    );
    const doBlocks = [...code.matchAll(/^DO\s+(\$[a-z_]*\$)([\s\S]*?)\1;/gim)];
    expect(doBlocks.map((m) => m[1])).toEqual(["$revoke$"]);
    const doBody = doBlocks[0][2];
    const executes = [...doBody.matchAll(/EXECUTE\s+'([^']*)'/g)].map(
      (m) => m[1],
    );
    expect(executes).toEqual([
      "REVOKE ALL ON FUNCTION public.pgmq_purge_archives_30d(INTEGER, INTEGER) FROM anon",
      "REVOKE ALL ON FUNCTION public.pgmq_purge_archives_30d(INTEGER, INTEGER) FROM authenticated",
    ]);
    expect(doBody).not.toMatch(/\b(DELETE|GRANT|cron)\b/i);
  });

  it("hardens the function: empty search_path, schema-qualified, EXECUTE revoked", () => {
    expect(code).toMatch(/^LANGUAGE plpgsql\nSET search_path = ''\nAS \$\$$/m);
    expect(code).toContain("pg_catalog.now() - interval ''30 days''");
    expect(code).toContain("pg_catalog.format(");
    expect(code).toContain(
      "pg_catalog.to_regclass(pg_catalog.format('pgmq.%I', v_table))",
    );
    // No unqualified builtin calls.
    expect(code).not.toMatch(/(?<![.\w])(now|format|to_regclass)\s*\(/i);
    // Every table reference is pgmq-qualified.
    for (const m of code.matchAll(/\bFROM\s+([\w.%$]+)/gi)) {
      expect(m[1]).toMatch(
        /^(pgmq\.|pg_catalog\.|public\.pgmq_purge_archives_30d|PUBLIC$|anon$|authenticated$)/,
      );
    }
    expect(code).toMatch(
      /^REVOKE ALL ON FUNCTION public\.pgmq_purge_archives_30d\(INTEGER, INTEGER\) FROM PUBLIC;$/m,
    );
    expect(code).toContain("rolname = 'anon'");
    expect(code).toContain("rolname = 'authenticated'");
  });

  it("keeps the schedule SQL only as a comment", () => {
    expect(sql).toMatch(/^--\s+PERFORM cron\.schedule\($/m);
    expect(sql).toContain("'SELECT public.pgmq_purge_archives_30d()'");
  });

  it("deletes only from the two archive tables, 30-day window, bounded batches", () => {
    expect(code).toContain("ARRAY['a_s6_sync', 'a_s6_bulk']");
    expect(code).toContain("DELETE FROM pgmq.%1$I");
    expect(code).toContain(
      "archived_at < pg_catalog.now() - interval ''30 days''",
    );
    expect(code).toMatch(/ORDER BY msg_id\s+LIMIT \$1/);
    expect(code).toContain("EXIT WHEN v_batch >= v_max_batches;");
    expect(code).toMatch(/RETURNS BIGINT/);
    expect(code).not.toMatch(/\bq_s6_|s6_dead_letter|TRUNCATE|DROP\b/i);
    const deletes = code.match(/\bDELETE\b/gi) ?? [];
    expect(deletes).toHaveLength(1);
  });

  it("is documented in data-retention.md", () => {
    const doc = fs.readFileSync(
      path.join(root, "docs/security/data-retention.md"),
      "utf8",
    );
    expect(doc).toContain(
      "Processed sync-queue messages are kept for 30 days for troubleshooting and will be deleted after 30 days once the purge job is enabled.",
    );
    expect(doc).toContain("pgmq_purge_archives_30d");
  });
});
