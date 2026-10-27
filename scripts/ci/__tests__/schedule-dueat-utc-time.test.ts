import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";
import { SHOP_LABELS_CTE, SHOP_LABEL_SCRIPTS, stripShopLabelsCte } from "../shop-labels";

/**
 * scripts/readonly/schedule-dueat-utc-time.sql: counts of schedule-sourced
 * Invoice rows (dueSource = 'schedule', dueBasis IS NULL) by the UTC
 * time-of-day of dueAt, split by shop_kind and seed_class (stored customer
 * tag 'ntr-seed' / 'ntr-seed-*' via BuyerAccount.customerId ->
 * s8_tagged_customers.tags). Must stay read-only, print only counts, enums
 * and time-of-day strings, and be runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/schedule-dueat-utc-time.sql";
const sql = fs.readFileSync(path.join(root, rel), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const codeNoLabels = stripShopLabelsCte(code);
const sqlOnly = code
  .split("\n")
  .filter((l) => !/^\\(set ON_ERROR_STOP 1|echo '[^']*')$/.test(l.trim()))
  .join("\n")
  .replace(/'[^']*'/g, "''");

describe("schedule-dueat-utc-time.sql", () => {
  it("passes the public-logs column check with counts, enums and utc_time only", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "shop_kind", kind: "enum", via: "derived" },
      { column: "seed_class", kind: "enum", via: "derived" },
      { column: "utc_time", kind: "timestamp", via: "annotation" },
      { column: "n", kind: "count", via: "derived" },
      { column: "shop_kind", kind: "enum", via: "derived" },
      { column: "seed_class", kind: "enum", via: "derived" },
      { column: "schedule_rows", kind: "count", via: "derived" },
      { column: "midnight_utc_rows", kind: "count", via: "derived" },
      { column: "null_due_rows", kind: "count", via: "derived" },
      { column: "schedule_rows", kind: "count", via: "derived" },
      { column: "midnight_utc_rows", kind: "count", via: "derived" },
      { column: "null_due_rows", kind: "count", via: "derived" },
    ]);
  });

  it("is read-only, rolls back and uses no psql variables outside shop_labels", () => {
    expect(code).toMatch(/^BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;$/m);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pgmq)\b/i,
    );
    expect(code.split(SHOP_LABELS_CTE)).toHaveLength(3);
    expect(codeNoLabels).not.toMatch(/\.domain\b/);
    // string literals not preceded by ':' (e.g. 'HH24:MI:SS.MS') are blanked
    // first, so a psql :'var' outside shop_labels is still caught
    const noLits = codeNoLabels.replace(/(?<!:)'[^']*'/g, "''");
    expect(noLits).not.toMatch(/(?<!:):(?!:)['"]?[a-z_]+/i);
    expect(SHOP_LABEL_SCRIPTS).toContain("schedule-dueat-utc-time");
  });

  it("selects schedule rows with no dueBasis and formats dueAt as UTC time-of-day", () => {
    const filter = /WHERE i\."dueSource" = 'schedule' AND i\."dueBasis" IS NULL/g;
    expect(code.match(filter)).toHaveLength(3);
    expect(code).toContain(`to_char(i."dueAt" AT TIME ZONE 'UTC', 'HH24:MI:SS.MS') AS utc_time`);
    expect(
      code.match(/to_char\(i\."dueAt" AT TIME ZONE 'UTC', 'HH24:MI:SS\.MS'\) = '00:00:00\.000'/g),
    ).toHaveLength(2);
  });

  it("classifies seed rows only from the stored customer tags (scripts/seed.ts markers)", () => {
    const seed = fs.readFileSync(path.join(root, "scripts/seed.ts"), "utf8");
    expect(seed).toMatch(/export const SEED_TAG = "ntr-seed";/);
    expect(seed).toMatch(/export const SEED_PREFIX = "ntr-seed-";/);
    const join =
      /LEFT JOIN s8_tagged_customers tc ON tc\.shop_id = ba\."shopId" AND tc\.customer_id = ba\."customerId"/g;
    expect(code.match(join)).toHaveLength(2);
    expect(code.match(/WHERE t\.tag = 'ntr-seed' OR t\.tag LIKE 'ntr-seed-%'/g)).toHaveLength(2);
    expect(code.match(/WHEN tc\.customer_id IS NULL THEN 'unknown'/g)).toHaveLength(2);
    // tags only feed the CASE; they are never selected
    expect(code).not.toMatch(/SELECT[^;]*\btc\.tags\b\s*(,|AS|\n\s*FROM)/);
  });

  it("is a choice option of prod-readonly-query.yml, in alphabetical order, behind the shop-labels guard", () => {
    const wf = fs.readFileSync(path.join(root, ".github/workflows/prod-readonly-query.yml"), "utf8");
    expect(wf).toMatch(/^\s+- schedule-dueat-utc-time$/m);
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
    expect(block).toContain("schedule-dueat-utc-time");
    expect(block).toEqual([...block].sort());
  });
});
