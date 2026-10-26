import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * prisma/migrations/20261120000000_pgmq_archive_purge only DEFINES the 7-day
 * pgmq archive purge function. It must not schedule (or enable) any pg_cron job:
 * enabling the nightly purge needs the owner's explicit OK.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "prisma/migrations/20261120000000_pgmq_archive_purge/migration.sql";
const sql = fs.readFileSync(path.join(root, rel), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

describe("pgmq archive purge migration", () => {
  it("does not schedule, alter or run any pg_cron job", () => {
    expect(code).not.toMatch(/\bcron\s*\./i);
    expect(code).not.toMatch(/\bPERFORM\b/i);
    // The only top-level statements are the function and its comment.
    expect(code).not.toMatch(/^(SELECT|DO|DELETE|CALL|ALTER)\b/im);
  });

  it("keeps the schedule SQL only as a comment", () => {
    expect(sql).toMatch(/^--\s+PERFORM cron\.schedule\($/m);
    expect(sql).toContain("'SELECT public.pgmq_purge_archives_7d()'");
  });

  it("deletes only from the two archive tables, 7-day window, bounded batches", () => {
    expect(code).toContain("ARRAY['a_s6_sync', 'a_s6_bulk']");
    expect(code).toContain("DELETE FROM pgmq.%1$I");
    expect(code).toContain("archived_at < now() - interval ''7 days''");
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
      "Processed sync-queue messages are kept for 7 days for troubleshooting, then deleted.",
    );
    expect(doc).toContain("pgmq_purge_archives_7d");
  });
});
