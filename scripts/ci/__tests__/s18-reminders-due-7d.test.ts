import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";
import { SHOP_LABELS_CTE, stripShopLabelsCte } from "../shop-labels";

/**
 * scripts/readonly/s18-reminders-due-7d.sql: counts of reminders that
 * s18_enqueue_reminders() Part 3 would pick up over the next 7 shop-local days,
 * per shop_kind identity label and recipient domain class. Must stay read-only, print only
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
// the canonical shop_labels CTE is the only place that reads s.domain and
// :'allowed' / :'e2e' (pinned by shop-identity-labels.test.ts)
const codeNoLabels = stripShopLabelsCte(code);
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
      { column: "shop_kind", kind: "enum", via: "derived" },
      { column: "installed", kind: "boolean", via: "derived" },
      { column: "currency_class", kind: "enum", via: "derived" },
      { column: "reminders_enabled", kind: "boolean", via: "derived" },
      { column: "enabled_email_rules", kind: "count", via: "derived" },
      { column: "shop_kind", kind: "enum", via: "derived" },
      { column: "recipient_class", kind: "enum", via: "derived" },
      { column: "would_fire_7d", kind: "count", via: "derived" },
      { column: "would_fire_email_7d", kind: "count", via: "derived" },
      { column: "would_fire_email_today", kind: "count", via: "derived" },
      { column: "enqueue_gated_email_7d", kind: "count", via: "derived" },
      { column: "distinct_recipients_email_7d", kind: "count", via: "derived" },
      { column: "distinct_recipients_gated_7d", kind: "count", via: "derived" },
      { column: "local_day", kind: "enum", via: "derived" },
      { column: "would_fire_email", kind: "count", via: "derived" },
      { column: "over_daily_cap", kind: "boolean", via: "derived" },
    ]);
  });

  it("is read-only, rolls back and uses no psql variables outside shop_labels", () => {
    // one snapshot for both shop_labels copies (other_N agrees across sections)
    expect(code).toMatch(/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;$/m);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pgmq|s18_enqueue_reminders)\b/i,
    );
    // no psql variables (:'x' / :x) besides the shop_labels CTE (both
    // sections); the ::DATE cast is not one
    expect(code.split(SHOP_LABELS_CTE)).toHaveLength(3);
    expect(codeNoLabels).not.toMatch(/\.domain\b/);
    expect(codeNoLabels).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
  });

  it("never prints a recipient address or the allowlist", () => {
    expect(code).not.toMatch(/RESEND_TEST_RECIPIENTS/);
    // the address column only feeds the class CASE and COUNT(DISTINCT ...)
    const finalSelect = code.split(/\)\s*SELECT c\.shop_kind/)[1] ?? "";
    expect(finalSelect).not.toBe("");
    expect(finalSelect.match(/c\.rcpt/g)).toHaveLength(2);
    expect(finalSelect.match(/COUNT\(DISTINCT c\.rcpt\)/g)).toHaveLength(2);
    expect(code).not.toMatch(/AS rcpt\b[\s\S]*SELECT d\.rcpt\s*,?\s*FROM/);
  });

  it("implements the Team Lead would-fire definition", () => {
    // open + unpaid invoice, buyer not opted out, enabled rule offset in the
    // next 7 shop-local days, minus existing ReminderLog (rule, invoice).
    // Each section that counts would-fire carries every predicate.
    const sections = code.split(/\\echo /).slice(2);
    expect(sections).toHaveLength(2);
    for (const sec of sections) {
      for (const pred of [
        /i\.status = 'open'/,
        /i\.outstanding > 0/,
        /i\."dueAt" IS NOT NULL/,
        /ba\."reminderOptOutAt" IS NULL/,
        /ba\."shopId" = i\."shopId"/,
        /r\.enabled = true/,
        /i\."dueAt" AT TIME ZONE public\.s18_safe_timezone\(s\.timezone\)\)::DATE \+ r\."offsetDays"\s+BETWEEN \(NOW\(\) AT TIME ZONE public\.s18_safe_timezone\(s\.timezone\)\)::DATE\s+AND \(NOW\(\) AT TIME ZONE public\.s18_safe_timezone\(s\.timezone\)\)::DATE \+ 6/,
        /NOT EXISTS \(\s*SELECT 1 FROM "ReminderLog" rl\s+WHERE rl\."ruleId" = r\.id AND rl\."invoiceId" = i\.id\s*\)/,
      ]) {
        expect(sec).toMatch(pred);
      }
    }
    // the headline count is not narrowed by channel or shop settings
    const s2 = sections[0];
    expect(
      s2.split('FROM "ReminderRule" r')[1].split("classed AS")[0],
    ).not.toMatch(/WHERE[\s\S]*r\.channel/);
    expect(s2).toMatch(/COUNT\(\*\) AS would_fire_7d/);
    expect(s2).toMatch(/LEFT JOIN s18_shop_reminder_settings srs/);
    // daily cap comparison uses DAILY_SEND_CAP from reminders.server.ts
    const svc = fs.readFileSync(
      path.join(root, "app/services/reminders.server.ts"),
      "utf8",
    );
    const cap = svc.match(/export const DAILY_SEND_CAP = (\d+);/)?.[1];
    expect(cap).toBeDefined();
    expect(sections[1]).toContain(`COUNT(*) > ${cap} AS over_daily_cap`);
    expect(sections[1]).toMatch(/r\.channel = 'email'::"ReminderChannel"/);
  });

  it("gates enqueue_gated_email_7d like Part 3 of the latest s18_enqueue_reminders() migration", () => {
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
      /r\.channel = 'email'::"ReminderChannel" AS is_email/,
      /COALESCE\(srs\.enabled, false\) AND s\."uninstalledAt" IS NULL/,
      /INNER JOIN shop_labels sl ON sl\.shop_id = s\.id/,
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
