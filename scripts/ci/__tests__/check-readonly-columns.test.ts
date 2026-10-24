import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkSql,
  checkMeta,
  compareAllowlist,
  CONFIG_INT_COLUMNS,
  validateAllowlist,
  isSafeGuardRegex,
  sensitiveWord,
  type AllowlistEntry,
} from "../check-readonly-columns";

/**
 * Tests for the public-logs column guard on scripts/readonly/*.sql (#190 F5).
 */

const issues = (sql: string) =>
  checkSql("scripts/readonly/t.sql", sql).violations.map(
    (v) => `${v.column}:${v.issue}`,
  );

const ALLOWED = `
-- @col status, topic: enum
-- @col read_ct: count
-- @col "manualHold": boolean
\\set ON_ERROR_STOP 1
BEGIN TRANSACTION READ ONLY;
\\echo '== a; b'
SHOW transaction_read_only;
SELECT i.id AS invoice_id, i.status, (i.outstanding > 0) AS outstanding_gt_0,
       COUNT(*) FILTER (WHERE i.outstanding > 0) AS n, MIN(i."dueAt") AS min_due_at,
       CASE WHEN ba."holdReasonCode" ~ '^[A-Z0-9_]{1,40}$' THEN ba."holdReasonCode" ELSE '<other>' END AS hold_reason_code,
       CASE WHEN ev.actor IN ('system','webhook') THEN ev.actor ELSE '<user>' END AS actor_kind,
       ba."manualHold", m.read_ct, m.message->>'topic' AS topic,
       DENSE_RANK() OVER (ORDER BY i."shopId") AS shop_idx,
       NOW() - i."dueAt" AS past_due_by
FROM "Invoice" i GROUP BY 1;
WITH x AS (SELECT a, b FROM t)
SELECT 'q' AS what, COUNT(*) AS n FROM x
UNION ALL
SELECT 'dlq', COUNT(*) FROM s6_dead_letter;
SELECT json_build_object('buyer_account_id', ba.id, 'overdue', EXISTS (SELECT 1 FROM "Invoice")) FROM "BuyerAccount" ba;
ROLLBACK;
`;

describe("check-readonly-columns: classification", () => {
  it("passes a file with only id/count/enum/boolean/timestamp columns", () => {
    // transaction_read_only needs an annotation
    expect(issues(ALLOWED)).toEqual(["transaction_read_only:unclassified"]);
    expect(
      issues("-- @col transaction_read_only: boolean\n" + ALLOWED),
    ).toEqual([]);
  });

  it("fails a shop domain column", () => {
    expect(issues(`SELECT s.domain FROM "Shop" s;`)).toEqual([
      "domain:sensitive",
    ]);
    expect(
      issues(`SELECT message->>'shop' AS shop FROM pgmq.q_s6_sync;`),
    ).toEqual(["shop:sensitive"]);
  });

  it("fails an email / name column even when annotated, and when aliased innocently", () => {
    expect(issues(`-- @col email: enum\nSELECT c.email FROM c;`)).toEqual([
      "email:sensitive",
    ]);
    expect(
      issues(`-- @col contact: enum\nSELECT c.email AS contact FROM c;`),
    ).toEqual(["contact:sensitive"]);
    expect(
      issues(`SELECT ba.name AS buyer_account_id FROM "BuyerAccount" ba;`),
    ).toEqual(["buyer_account_id:sensitive"]);
    expect(
      issues(`SELECT e.data->>'customerEmail' AS who FROM "AuditEvent" e;`),
    ).toEqual(["who:sensitive"]);
  });

  it("fails free text and raw error columns", () => {
    expect(issues(`SELECT p.narration FROM "Payment" p;`)).toEqual([
      "narration:sensitive",
    ]);
    expect(issues(`SELECT d.error FROM s6_dead_letter d;`)).toEqual([
      "error:sensitive",
    ]);
    expect(issues(`SELECT d.error AS err FROM s6_dead_letter d;`)).toEqual([
      "err:sensitive",
    ]);
    expect(issues(`SELECT e.data FROM "AuditEvent" e;`)).toEqual([
      "data:sensitive",
    ]);
    // unguarded CASE passthrough of raw text
    expect(
      issues(
        `SELECT CASE WHEN d.error IS NULL THEN 'none' ELSE d.error END AS error_code FROM d;`,
      ),
    ).toEqual(["error_code:sensitive"]);
    // ... and an annotation cannot launder it
    expect(
      issues(
        `-- @col error_code: enum\nSELECT CASE WHEN d.error IS NULL THEN 'none' ELSE d.error END AS error_code FROM d;`,
      ),
    ).toEqual(["error_code:sensitive"]);
    // a guard with an unbounded regex is not a guard
    expect(
      issues(
        `SELECT CASE WHEN x.r ~ '^.*$' THEN x.r END AS reason_code FROM x;`,
      ),
    ).toEqual(["reason_code:unclassified"]);
  });

  it("fails per-shop money columns", () => {
    expect(issues(`SELECT i.outstanding FROM "Invoice" i;`)).toEqual([
      "outstanding:sensitive",
    ]);
    expect(issues(`SELECT SUM(i.amount) AS total FROM "Invoice" i;`)).toEqual([
      "total:sensitive",
    ]);
    expect(issues(`SELECT SUM(i.x) AS s FROM "Invoice" i;`)).toEqual([
      "s:unclassified",
    ]);
    expect(issues(`SELECT ba."creditLimit" FROM "BuyerAccount" ba;`)).toEqual([
      "creditLimit:sensitive",
    ]);
  });

  it("allows booleans and counts derived from sensitive columns", () => {
    expect(
      issues(`SELECT (ba."creditLimit" IS NOT NULL) AS has_credit_limit, COUNT(i.outstanding) AS n,
      (s.domain = m.shop) AS shop_domain_match FROM t;`),
    ).toEqual([]);
  });

  it("fails SELECT *, unannotated passthroughs, non-select statements and stale annotations", () => {
    expect(issues(`SELECT * FROM t;`)).toEqual(["*:star"]);
    expect(issues(`SELECT t.status FROM t;`)).toEqual(["status:unclassified"]);
    expect(issues(`DELETE FROM t;`)).toEqual([
      "(statement):unsupported_statement",
    ]);
    expect(issues(`-- @col gone: enum\nSELECT COUNT(*) AS n FROM t;`)).toEqual([
      "gone:stale_annotation",
    ]);
    expect(issues(`-- @col status: text\nSELECT 'a' AS status;`)).toEqual([
      "status:bad_annotation",
    ]);
  });

  it("config_int passes only for a listed merchant setting", () => {
    expect(CONFIG_INT_COLUMNS).toEqual(["defaultTermsDays"]);
    expect(
      issues(`-- @col defaultTermsDays: config_int
SELECT CASE WHEN a."defaultTermsDays" BETWEEN 0 AND 365 THEN a."defaultTermsDays" END AS "defaultTermsDays" FROM "BuyerAccount" a;`),
    ).toEqual([]);
    expect(
      issues(
        `-- @col "defaultTermsDays": config_int\nSELECT a."defaultTermsDays" FROM "BuyerAccount" a;`,
      ),
    ).toEqual([]);
  });

  it("config_int fails on an unlisted name or a relabelled source, and never launders money", () => {
    expect(
      issues(`-- @col retryDays: config_int\nSELECT a."retryDays" FROM t a;`),
    ).toEqual(["retryDays:config_int_not_listed"]);
    expect(
      issues(
        `-- @col defaultTermsDays: config_int\nSELECT a."graceDays" AS "defaultTermsDays" FROM t a;`,
      ),
    ).toEqual(["defaultTermsDays:config_int_not_listed"]);
    expect(
      issues(
        `-- @col defaultTermsDays: config_int\nSELECT a."creditLimit" AS "defaultTermsDays" FROM t a;`,
      ),
    ).toEqual(["defaultTermsDays:sensitive"]);
    expect(
      issues(
        `-- @col "creditLimit": config_int\nSELECT a."creditLimit" FROM t a;`,
      ),
    ).toEqual(["creditLimit:sensitive"]);
  });

  it("helpers", () => {
    expect(isSafeGuardRegex("^[A-Z0-9_]{1,40}$")).toBe(true);
    expect(
      isSafeGuardRegex(
        "^(?:(non_retryable|permanent):)?[A-Za-z][A-Za-z0-9_]{0,63}$",
      ),
    ).toBe(true);
    expect(isSafeGuardRegex("^graphql_error:[A-Za-z0-9_]{1,64}$")).toBe(true);
    expect(
      isSafeGuardRegex(
        "^(?:(non_retryable|permanent):)?([A-Za-z][A-Za-z0-9_]{0,63}|graphql_error:[A-Za-z0-9_,]{1,200})$",
      ),
    ).toBe(false);
    expect(isSafeGuardRegex("^[A-Za-z ]{1,40}$")).toBe(false);
    expect(isSafeGuardRegex("^.+$")).toBe(false);
    expect(sensitiveWord("error_code")).toBeNull();
    expect(sensitiveWord("shop_idx")).toBeNull();
    expect(sensitiveWord("shopDomain")).toBe("shop");
    expect(sensitiveWord("holdNote")).toBe("note");
  });
});

describe("check-readonly-columns: allowlist ratchet", () => {
  const v = (
    column: string,
    issue: "sensitive" | "unclassified" = "unclassified",
  ) => ({ file: "f.sql", column, issue, detail: "" });
  const entry = (column: string, count = 1): AllowlistEntry => ({
    file: "f.sql",
    column,
    issue: "unclassified",
    count,
  });

  it("allowlisted violations pass", () => {
    expect(compareAllowlist([v("a")], [entry("a")])).toEqual({
      newViolations: [],
      stale: [],
    });
  });
  it("a new violation not on the allowlist fails", () => {
    const r = compareAllowlist([v("a"), v("b")], [entry("a")]);
    expect(r.newViolations.map((x) => x.column)).toEqual(["b"]);
  });
  it("a second occurrence beyond the allowed count fails", () => {
    expect(
      compareAllowlist([v("a"), v("a")], [entry("a")]).newViolations,
    ).toHaveLength(1);
  });
  it("a stale allowlist entry fails (counts only go down)", () => {
    const r = compareAllowlist([], [entry("a")]);
    expect(r.stale).toEqual([{ entry: entry("a"), actual: 0 }]);
    expect(compareAllowlist([v("a")], [entry("a", 2)]).stale).toHaveLength(1);
  });
});

describe("check-readonly-columns: QA review at 61c306b (fail-closed probes)", () => {
  it("1. naming convention needs a plain ref whose source name matches; alias alone fails", () => {
    expect(issues(`SELECT address1 AS addr_id FROM t;`)).toEqual([
      "addr_id:sensitive",
    ]);
    expect(issues(`SELECT city AS city_at FROM t;`)).toEqual([
      "city_at:unclassified",
    ]);
    expect(issues(`SELECT max(zip) AS last_at FROM t;`)).toEqual([
      "last_at:unclassified",
    ]);
    expect(issues(`SELECT COALESCE(address1, 'n/a') AS a_id FROM t;`)).toEqual([
      "a_id:sensitive",
    ]);
    expect(issues(`SELECT COALESCE(t.zip, 'n/a') AS a_id FROM t;`)).toEqual([
      "a_id:unclassified",
    ]);
    for (const fn of [
      "to_json",
      "string_agg",
      "array_agg",
      "concat",
      "format",
      "replace",
    ]) {
      expect(issues(`SELECT ${fn}(t.zip) AS z_id FROM t;`)).toEqual([
        "z_id:unclassified",
      ]);
    }
    // still fine: source and output both follow the convention
    expect(
      issues(
        `SELECT i.id AS invoice_id, i."createdAt" AS created_at, e.data->>'orderGid' AS order_gid, MAX(i."updatedAt") AS last_at FROM "Invoice" i;`,
      ),
    ).toEqual([]);
  });

  it("1. whole-row references always fail, even annotated", () => {
    expect(issues(`SELECT s AS shop_idx FROM "Shop" s;`)).toEqual([
      "shop_idx:whole_row",
    ]);
    expect(issues(`SELECT row_to_json(s) AS row_id FROM "Shop" s;`)).toEqual([
      "row_id:whole_row",
    ]);
    expect(
      issues(`-- @col x: enum\nSELECT to_json(t) AS x FROM tbl AS t;`),
    ).toEqual(["x:whole_row"]);
    expect(issues(`SELECT "Invoice" AS r FROM "Invoice";`)).toEqual([
      "r:whole_row",
    ]);
  });

  it("2. guard regexes: only short code-shaped classes; guarded source gets the sensitive check", () => {
    for (const re of [
      "^[a-z0-9.-]{1,100}$",
      "^[!-~]{1,200}$",
      "^[^~]{1,200}$",
      "^\\D{1,200}$",
      "^[A-Z]{1,65}$",
      "^[[:alnum:]]{1,10}$",
      "^[A-Z@]{1,10}$",
      "^[a-z/]{1,10}$",
      "^[A-Z]{1,}$",
    ]) {
      expect(isSafeGuardRegex(re), re).toBe(false);
    }
    expect(isSafeGuardRegex("^[A-Za-z0-9_:-]{1,40}$")).toBe(true);
    expect(
      issues(
        `SELECT CASE WHEN m."shopDomain" ~ '^[a-z0-9.-]{1,100}$' THEN m."shopDomain" END AS src FROM m;`,
      ),
    ).toEqual(["src:sensitive"]);
    expect(
      issues(
        `SELECT CASE WHEN m."shopDomain" ~ '^[a-z0-9_]{1,40}$' THEN m."shopDomain" END AS src FROM m;`,
      ),
    ).toEqual(["src:sensitive"]);
    expect(
      issues(
        `SELECT CASE WHEN m.kind ~ '^[a-z0-9_]{1,40}$' THEN m.kind END AS k FROM m;`,
      ),
    ).toEqual([]);
  });

  it("3. OR defeats the guard", () => {
    expect(
      issues(
        `SELECT CASE WHEN t."errorText" ~ '^A$' OR true THEN t."errorText" END AS k FROM t;`,
      ),
    ).toEqual(["k:sensitive"]);
    expect(
      issues(
        `SELECT CASE WHEN true OR t."errorText" ~ '^A$' THEN t."errorText" END AS k FROM t;`,
      ),
    ).toEqual(["k:sensitive"]);
    expect(
      issues(`SELECT CASE WHEN t.v ~ '^A$' OR true THEN t.v END AS k FROM t;`),
    ).toEqual(["k:unclassified"]);
    expect(
      issues(`SELECT CASE WHEN t.v IN ('a') OR true THEN t.v END AS k FROM t;`),
    ).toEqual(["k:unclassified"]);
    expect(
      issues(
        `SELECT CASE WHEN t.ok AND t.v ~ '^[A-Z]{1,9}$' THEN t.v ELSE '<other>' END AS k FROM t;`,
      ),
    ).toEqual([]);
  });

  it("4. NOW() - x only as the whole expression; sources always collected", () => {
    expect(
      issues(`SELECT t."errorText" || now() - t.at AS age FROM t;`),
    ).toEqual(["age:sensitive"]);
    expect(issues(`SELECT t.v || now() - t.at AS age FROM t;`)).toEqual([
      "age:unclassified",
    ]);
    expect(issues(`SELECT now() - t."errorText" AS age FROM t;`)).toEqual([
      "age:sensitive",
    ]);
    expect(
      issues(
        `SELECT NOW() - i."dueAt" AS past_due_by, i."dueAt" - NOW() AS until_due, NOW() - INTERVAL '1 day' AS cutoff FROM i;`,
      ),
    ).toEqual([]);
  });

  it("5. psql meta commands other than \\set ON_ERROR_STOP and \\echo '<literal>' fail", () => {
    expect(
      issues(
        `\\copy (SELECT email FROM "Shop") TO STDOUT\nSELECT COUNT(*) AS n FROM t;`,
      ),
    ).toEqual(["(psql):unsupported_statement"]);
    expect(issues(`SELECT s.email AS e FROM s \\gset\n\\echo :e`)).toEqual([
      "(psql):unsupported_statement",
      "(psql):unsupported_statement",
      "e:sensitive",
    ]);
    for (const m of [
      "\\o /tmp/x",
      "\\! env",
      "\\i other.sql",
      "\\qecho hi",
      "\\x",
      "\\pset format csv",
      "\\echo `env`",
      "\\echo 'a' :v",
      "\\set v 1",
    ]) {
      expect(checkMeta([m]), m).toEqual([m]);
    }
    expect(
      checkMeta([
        "\\set ON_ERROR_STOP 1",
        "\\echo '== since :since (literal)'",
        "\\echo 'a' 'b'",
      ]),
    ).toEqual([]);
  });

  it("6. a set operator must be followed by SELECT", () => {
    expect(issues(`SELECT 'a' AS kind UNION VALUES ('x');`)).toEqual([
      "(statement):unparseable",
    ]);
    expect(issues(`SELECT 'a' AS kind UNION ALL TABLE secrets;`)).toEqual([
      "(statement):unparseable",
    ]);
    expect(
      issues(`SELECT 'a' AS kind EXCEPT (SELECT t.email FROM t);`),
    ).toEqual(["(statement):unparseable"]);
    expect(issues(`WITH x AS (SELECT 1) TABLE x;`)).toEqual([
      "(statement):unparseable",
    ]);
    expect(issues(`SELECT 'a' AS kind UNION ALL SELECT 'b';`)).toEqual([]);
  });

  it("7. allowlist: never-allowlist issues and duplicates rejected", () => {
    const e = (
      issue: AllowlistEntry["issue"],
      column = "c",
      count = 1,
    ): AllowlistEntry => ({ file: "f.sql", column, issue, count });
    for (const bad of [
      "sensitive",
      "star",
      "unsupported_statement",
      "bad_annotation",
      "config_int_not_listed",
      "whole_row",
    ] as const) {
      expect(validateAllowlist([e(bad)]), bad).toHaveLength(1);
    }
    expect(validateAllowlist([e("unclassified"), e("unclassified")])).toEqual([
      "f.sql:c:unclassified: duplicate entry",
    ]);
    expect(validateAllowlist([e("unclassified", "c", 0)])).toHaveLength(1);
    expect(validateAllowlist([e("unclassified")])).toEqual([]);
  });

  it("7. shrink-only: the committed allowlist is pinned (growing it needs a visible edit here)", () => {
    const committed = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "..", "readonly-columns-allowlist.json"),
        "utf8",
      ),
    );
    expect(committed.entries).toEqual([]);
    expect(
      committed.entries.reduce(
        (n: number, x: AllowlistEntry) => n + x.count,
        0,
      ),
    ).toBe(0);
  });
});

describe("check-readonly-columns: CLI", () => {
  const script = path.join(__dirname, "..", "check-readonly-columns.ts");
  const runCli = (files: Record<string, string>, allow: AllowlistEntry[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ro-cols-"));
    fs.mkdirSync(path.join(root, "scripts", "readonly"), { recursive: true });
    for (const [f, c] of Object.entries(files))
      fs.writeFileSync(path.join(root, "scripts", "readonly", f), c);
    const allowPath = path.join(root, "allow.json");
    fs.writeFileSync(allowPath, JSON.stringify({ entries: allow }));
    try {
      execFileSync("npx", ["tsx", script], {
        env: {
          ...process.env,
          READONLY_COLUMNS_ROOT: root,
          READONLY_COLUMNS_ALLOWLIST: allowPath,
        },
        encoding: "utf8",
      });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it("exits 1 for an allowlisted sensitive column", () => {
    expect(
      runCli({ "a.sql": "SELECT s.domain FROM s;" }, [
        {
          file: "scripts/readonly/a.sql",
          column: "domain",
          issue: "sensitive",
          count: 1,
        },
      ]),
    ).toBe(1);
  }, 60000);

  it("exits 0 for a clean file, 1 for a new violation, 1 for a stale entry", () => {
    expect(runCli({ "a.sql": "SELECT COUNT(*) AS n FROM t;" }, [])).toBe(0);
    expect(runCli({ "a.sql": "SELECT s.domain FROM s;" }, [])).toBe(1);
    expect(
      runCli({ "a.sql": "SELECT COUNT(*) AS n FROM t;" }, [
        {
          file: "scripts/readonly/a.sql",
          column: "status",
          issue: "unclassified",
          count: 1,
        },
      ]),
    ).toBe(1);
    expect(
      runCli({ "a.sql": "SELECT t.status FROM t;" }, [
        {
          file: "scripts/readonly/a.sql",
          column: "status",
          issue: "unclassified",
          count: 1,
        },
      ]),
    ).toBe(0);
  }, 60000);

  it("the committed scripts/readonly files pass with the committed allowlist", () => {
    const out = execFileSync("npx", ["tsx", script], { encoding: "utf8" });
    expect(out).toContain("OK");
  }, 60000);
});
