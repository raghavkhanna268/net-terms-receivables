import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/pgmq-cron-job-status.sql: confirm the pgmq_purge_archives_30d
 * pg_cron job is scheduled and succeeding. Must stay read-only, print only
 * counts/enums/booleans/ids/timestamps, never print command or return_message,
 * and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/pgmq-cron-job-status.sql";
const sql = fs.readFileSync(path.join(root, rel), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const sqlOnly = code
  .split("\n")
  .filter((l) => !/^\\(set ON_ERROR_STOP 1|echo '[^']*')$/.test(l.trim()))
  .join("\n")
  .replace(/'[^']*'/g, "''");

describe("pgmq-cron-job-status.sql", () => {
  it("passes the public-logs column check", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "job_run_details_exists", kind: "boolean", via: "derived" },
      { column: "jobid", kind: "id", via: "annotation" },
      { column: "jobname", kind: "enum", via: "derived" },
      { column: "schedule", kind: "enum", via: "derived" },
      { column: "active", kind: "boolean", via: "annotation" },
      { column: "job_exists", kind: "boolean", via: "derived" },
      { column: "runid", kind: "id", via: "annotation" },
      { column: "status", kind: "enum", via: "derived" },
      { column: "start_time_utc", kind: "timestamp", via: "annotation" },
      { column: "duration_sec", kind: "count", via: "annotation" },
      { column: "succeeded_7d", kind: "count", via: "derived" },
      { column: "failed_7d", kind: "count", via: "derived" },
      { column: "other_7d", kind: "count", via: "derived" },
      { column: "total_7d", kind: "count", via: "derived" },
    ]);
  });

  it("is read-only, rolls back and never selects command or return_message", () => {
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval)\b/i,
    );
    expect(sqlOnly).not.toMatch(/\bcommand\b/i);
    expect(sqlOnly).not.toMatch(/\breturn_message\b/i);
    expect(code).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
  });

  it("is scoped only to pgmq_purge_archives_30d job", () => {
    expect(code).toContain("pgmq_purge_archives_30d");
    const jobNameMatches = code.match(/jobname\s*=\s*'pgmq_purge_archives_30d'/g);
    expect(jobNameMatches).not.toBeNull();
    expect(jobNameMatches!.length).toBeGreaterThanOrEqual(3);
  });

  it("guards cron.job_run_details with to_regclass", () => {
    expect(code).toMatch(/to_regclass\s*\(\s*'cron\.job_run_details'\s*\)/);
  });

  it("queries job definition, last run, and 7-day counts", () => {
    expect(code).toMatch(/FROM\s+cron\.job\b/i);
    expect(code).toMatch(/FROM\s+cron\.job_run_details\b/i);
    expect(code).toMatch(/INTERVAL\s+'7 days'/i);
    expect(code).toMatch(/succeeded_7d/);
    expect(code).toMatch(/failed_7d/);
    expect(code).toMatch(/total_7d/);
  });

  it("is a choice option of prod-readonly-query.yml, in alphabetical order", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- pgmq-cron-job-status$/m);
    const opts = wf
      .split(/^\s+options:\n/m)[1]
      .split("\n")
      .filter((l) => /^\s+- /.test(l))
      .map((l) => l.trim().slice(2));
    const block: string[] = [];
    for (const o of opts) {
      if (!/^[a-z0-9-]+$/.test(o)) break;
      block.push(o);
    }
    expect(block).toContain("pgmq-cron-job-status");
    expect(block).toEqual([...block].sort());
  });
});
