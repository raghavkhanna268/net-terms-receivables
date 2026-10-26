import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";
import { SHOP_LABELS_CTE, stripShopLabelsCte } from "../shop-labels";

/**
 * scripts/readonly/s18-reminder-rule-dupes.sql: counts for the duplicate
 * ReminderRule bug (same shopId, offsetDays, channel), per shop_kind identity
 * label. Must stay read-only, print only counts/enums/booleans (never raw shop
 * or rule ids, never a domain),
 * select no text columns, and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/s18-reminder-rule-dupes.sql";
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

describe("s18-reminder-rule-dupes.sql", () => {
  it("passes the public-logs column check", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "shop_kind", kind: "enum", via: "derived" },
      { column: "has_shop", kind: "boolean", via: "derived" },
      { column: "offset_days", kind: "enum", via: "derived" },
      { column: "channel", kind: "enum", via: "derived" },
      { column: "n", kind: "count", via: "derived" },
      { column: "distinct_create_minutes", kind: "count", via: "derived" },
      { column: "n_enabled", kind: "count", via: "derived" },
      { column: "rules_with_logs", kind: "count", via: "derived" },
      { column: "log_rows", kind: "count", via: "derived" },
      { column: "dup_rules_with_logs", kind: "count", via: "derived" },
      { column: "dup_log_rows", kind: "count", via: "derived" },
      { column: "shops_affected", kind: "count", via: "derived" },
      { column: "dup_groups", kind: "count", via: "derived" },
      { column: "dup_rules", kind: "count", via: "derived" },
      { column: "excess_rules", kind: "count", via: "derived" },
    ]);
  });

  it("is read-only, rolls back and uses no psql variables outside shop_labels", () => {
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pgmq)\b/i,
    );
    // no psql variables (:'x' / :x) besides the shop_labels CTE; the ::TEXT
    // cast is not one
    expect(code).toContain(SHOP_LABELS_CTE);
    expect(codeNoLabels).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
  });

  it("groups by (shopId, offsetDays, channel) with HAVING COUNT(*) > 1 and labels shops like s12-hold-coverage", () => {
    const groupBys = code.match(
      /GROUP BY r\."shopId", r\."offsetDays", r\.channel\s+HAVING COUNT\(\*\) > 1/g,
    );
    expect(groupBys).toHaveLength(2);
    expect(code).toMatch(
      /PARTITION BY r\."shopId", r\."offsetDays", r\.channel/,
    );
    expect(code).toMatch(/WHERE k\.grp_n > 1/);
    expect(code).toMatch(
      /COUNT\(DISTINCT date_trunc\('minute', r\."createdAt"\)\) AS distinct_create_minutes/,
    );
    expect(code).toMatch(
      /COUNT\(DISTINCT rl\."ruleId"\) AS dup_rules_with_logs/,
    );
    expect(code).toContain(`WITH ${SHOP_LABELS_CTE},\ngrp AS (`);
    expect(code).toMatch(/LEFT JOIN shop_labels sl ON sl\.shop_id = g\.grp_shop/);
    expect(code).not.toMatch(/shop_idx|DENSE_RANK/);
    const hold = fs.readFileSync(
      path.join(root, "scripts/readonly/s12-hold-coverage.sql"),
      "utf8",
    );
    expect(hold).toContain(SHOP_LABELS_CTE);
    expect(hold).not.toMatch(/shop_idx|DENSE_RANK/);
  });

  it("never prints raw ids or text columns", () => {
    // the exact output column list is pinned above (no id columns at all);
    // the only ::TEXT values are the guarded offset/channel passthroughs
    const { columns } = checkSql(rel, sql);
    expect(columns.filter((c) => c.kind === "id").map((c) => c.column)).toEqual(
      [],
    );
    expect(code).toMatch(
      /CASE WHEN g\.grp_offset::TEXT ~ '\^-\?\[0-9\]\{1,4\}\$' THEN g\.grp_offset::TEXT END AS offset_days/,
    );
    expect(code).toMatch(
      /CASE WHEN g\.grp_channel::TEXT IN \('native', 'email'\) THEN g\.grp_channel::TEXT END AS channel/,
    );
    expect(code.match(/::TEXT/g)).toHaveLength(4);
    for (const col of [
      "name",
      "email",
      "domain",
      "note",
      "timezone",
      "currency",
    ]) {
      expect(codeNoLabels).not.toMatch(new RegExp(`\\.${col}\\b`, "i"));
    }
  });

  it("guards channel to the ReminderChannel enum values in schema.prisma", () => {
    const schema = fs.readFileSync(
      path.join(root, "prisma/schema.prisma"),
      "utf8",
    );
    const body = schema.split(/enum ReminderChannel \{/)[1].split("}")[0];
    const values = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z_]+$/.test(l))
      .sort();
    expect(values).toEqual(["email", "native"]);
  });

  it("is a choice option of prod-readonly-query.yml, in alphabetical order", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- s18-reminder-rule-dupes$/m);
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
    expect(block).toContain("s18-reminder-rule-dupes");
    expect(block).toEqual([...block].sort());
  });
});
