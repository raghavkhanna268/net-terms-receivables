import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/s8-draft-status-case.sql: backfill sizing for s8_draft_orders.status
 * casing. Must stay read-only, print only counts and regex-guarded status enums
 * (aggregated across shops, no shop ids), and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/s8-draft-status-case.sql";
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

describe("s8-draft-status-case.sql", () => {
  it("passes the public-logs column check with derived kinds only", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "status", kind: "enum", via: "derived" },
      { column: "draft_orders", kind: "count", via: "derived" },
      { column: "status", kind: "enum", via: "derived" },
      { column: "draft_orders", kind: "count", via: "derived" },
      { column: "total_rows", kind: "count", via: "derived" },
      { column: "non_lowercase_rows", kind: "count", via: "derived" },
    ]);
    expect(sql).not.toMatch(/^-- @col/m);
  });

  it("is read-only, rolls back and never selects shop ids or other values", () => {
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval)\b/i,
    );
    expect(sqlOnly).not.toMatch(
      /\b(shop_id|draft_order_id|buyer_account_id|name|total|id)\b/i,
    );
    // no psql variables (:'x' / :x)
    expect(code).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
  });

  it("guards printed statuses with fixed-code regexes and maps the rest to OTHER", () => {
    expect(code).toContain(
      "CASE WHEN d.status ~ '^[A-Z_]{1,40}$' THEN d.status ELSE 'OTHER' END AS status",
    );
    expect(code).toContain(
      "CASE WHEN d.status ~ '^[a-z_]{1,40}$' THEN d.status ELSE 'other' END AS status",
    );
    expect(code).toMatch(/WHERE d\.status <> lower\(d\.status\)\nGROUP BY 1/);
    expect(code).toMatch(/WHERE d\.status = lower\(d\.status\)\nGROUP BY 1/);
    const froms = code.match(/FROM s8_draft_orders d\b/g);
    expect(froms).toHaveLength(3);
  });

  it("is a choice option of prod-readonly-query.yml, in alphabetical order", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- s8-draft-status-case$/m);
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
    expect(block).toContain("s8-draft-status-case");
    expect(block).toEqual([...block].sort());
  });
});
