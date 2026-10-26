import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/pgmq-archive-age.sql: dry-run sizing for a 7-day pgmq archive
 * purge. Must stay read-only, print only counts/enums/booleans/dates, cover every
 * archive table the migrations create, and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/pgmq-archive-age.sql";
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

function migrationQueues(): string[] {
  const dir = path.join(root, "prisma/migrations");
  const names = new Set<string>();
  for (const d of fs.readdirSync(dir)) {
    const f = path.join(dir, d, "migration.sql");
    if (!fs.existsSync(f)) continue;
    for (const m of fs
      .readFileSync(f, "utf8")
      .matchAll(/pgmq\.create\('([a-z0-9_]+)'\)/g)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

describe("pgmq-archive-age.sql", () => {
  it("passes the public-logs column check", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "queue", kind: "enum", via: "derived" },
      { column: "queues", kind: "count", via: "derived" },
      { column: "archive_exists", kind: "boolean", via: "derived" },
      { column: "archive_table", kind: "enum", via: "derived" },
      { column: "total_rows", kind: "count", via: "derived" },
      { column: "older_than_7d", kind: "count", via: "derived" },
      {
        column: "oldest_archived_utc_date",
        kind: "timestamp",
        via: "annotation",
      },
      { column: "dlq_rows", kind: "count", via: "derived" },
    ]);
  });

  it("is read-only, rolls back and never selects message bodies", () => {
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval)\b/i,
    );
    expect(sqlOnly).not.toMatch(/\bmessage\b/i);
    // no psql variables (:'x' / :x); the ::date cast is not one
    expect(code).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
  });

  it("covers every pgmq archive table created by the migrations, with the 7-day predicate", () => {
    const queues = migrationQueues();
    expect(queues.length).toBeGreaterThan(0);
    for (const q of queues) {
      expect(code).toContain(`FROM pgmq.a_${q}`);
    }
    const sevenDay = code.match(/archived_at < NOW\(\) - INTERVAL '7 days'/g);
    expect(sevenDay).toHaveLength(queues.length);
    expect(code).toMatch(/FROM s6_dead_letter/);
  });

  it("is a choice option of prod-readonly-query.yml, in alphabetical order", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- pgmq-archive-age$/m);
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
    expect(block).toContain("pgmq-archive-age");
    expect(block).toEqual([...block].sort());
  });
});
