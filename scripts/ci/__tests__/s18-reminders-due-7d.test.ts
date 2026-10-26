import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/s18-reminders-due-7d.sql: counts of reminders that
 * s18_enqueue_reminders() Part 3 would pick up over the next 7 shop-local days,
 * per shop_idx and recipient domain class. Must stay read-only, print only
 * counts/enums/booleans/ids (never addresses), mirror the latest enqueue
 * function's selection, and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/s18-reminders-due-7d.sql";
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

function latestEnqueueMigration(): string {
  const dir = path.join(root, "prisma/migrations");
  const hits = fs
    .readdirSync(dir)
    .filter((d) => {
      const f = path.join(dir, d, "migration.sql");
      return (
        fs.existsSync(f) &&
        /CREATE OR REPLACE FUNCTION public\.s18_enqueue_reminders\(\)/.test(
          fs.readFileSync(f, "utf8"),
        )
      );
    })
    .sort();
  return hits[hits.length - 1];
}

describe("s18-reminders-due-7d.sql", () => {
  it("passes the public-logs column check", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "shop_idx", kind: "id", via: "derived" },
      { column: "installed", kind: "boolean", via: "derived" },
      { column: "currency_class", kind: "enum", via: "derived" },
      { column: "reminders_enabled", kind: "boolean", via: "derived" },
      { column: "enabled_email_rules", kind: "count", via: "derived" },
      { column: "shop_idx", kind: "id", via: "derived" },
      { column: "recipient_class", kind: "enum", via: "derived" },
      { column: "due_7d", kind: "count", via: "derived" },
      { column: "due_today", kind: "count", via: "derived" },
      { column: "send_gates_ok_7d", kind: "count", via: "derived" },
      { column: "distinct_recipients_7d", kind: "count", via: "derived" },
      {
        column: "distinct_recipients_gates_ok_7d",
        kind: "count",
        via: "derived",
      },
    ]);
  });

  it("is read-only, rolls back and uses no psql variables", () => {
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pgmq|s18_enqueue_reminders)\b/i,
    );
    // no psql variables (:'x' / :x); the ::DATE cast is not one
    expect(code).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
  });

  it("never prints a recipient address or the allowlist", () => {
    expect(code).not.toMatch(/RESEND_TEST_RECIPIENTS/);
    // the address column only feeds the class CASE and COUNT(DISTINCT ...)
    const finalSelect = code.split(/\)\s*SELECT c\.shop_idx/)[1] ?? "";
    expect(finalSelect).not.toBe("");
    expect(finalSelect).not.toMatch(/c\.rcpt\s*(,|$)/m);
    expect(finalSelect.match(/c\.rcpt/g)).toHaveLength(2);
    expect(finalSelect).toMatch(
      /COUNT\(DISTINCT c\.rcpt\) AS distinct_recipients_7d/,
    );
  });

  it("mirrors Part 3 of the latest s18_enqueue_reminders() migration", () => {
    const latest = latestEnqueueMigration();
    expect(sql).toContain(`prisma/migrations/${latest}/migration.sql`);
    const fn = fs.readFileSync(
      path.join(root, "prisma/migrations", latest, "migration.sql"),
      "utf8",
    );
    const part3 = fn.split("PART 3")[1].split("PART 4")[0];
    for (const pred of [
      /r\.enabled = true/,
      /r\.channel = 'email'::public\."ReminderChannel"/,
      /srs\.enabled = true/,
      /s\."uninstalledAt" IS NULL/,
      /i\.status = 'open'/,
      /i\."dueAt" IS NOT NULL/,
      /ba\."shopId" = i\."shopId"/,
      /rl\."ruleId" = r\.id AND rl\."invoiceId" = i\.id/,
    ]) {
      expect(part3).toMatch(pred);
    }
    for (const pred of [
      /r\.enabled = true/,
      /r\.channel = 'email'::"ReminderChannel"/,
      /srs\.enabled = true/,
      /s\."uninstalledAt" IS NULL/,
      /i\.status = 'open'/,
      /i\."dueAt" IS NOT NULL/,
      /ba\."shopId" = i\."shopId"/,
      /rl\."ruleId" = r\.id AND rl\."invoiceId" = i\.id/,
      /BETWEEN \(NOW\(\) AT TIME ZONE public\.s18_safe_timezone\(s\.timezone\)\)::DATE\s+AND \(NOW\(\) AT TIME ZONE public\.s18_safe_timezone\(s\.timezone\)\)::DATE \+ 6/,
      /DENSE_RANK\(\) OVER \(ORDER BY s\.id\) AS shop_idx/,
    ]) {
      expect(code).toMatch(pred);
    }
  });

  it("is a choice option of prod-readonly-query.yml, in alphabetical order", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- s18-reminders-due-7d$/m);
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
    expect(block).toContain("s18-reminders-due-7d");
    expect(block).toEqual([...block].sort());
  });
});
