import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkSql,
  compareAllowlist,
  CONFIG_INT_COLUMNS,
  isSafeGuardRegex,
  sensitiveWord,
  type AllowlistEntry,
} from "../check-readonly-columns";

/**
 * Tests for the public-logs column guard on scripts/readonly/*.sql (#190 F5).
 */

const issues = (sql: string) => checkSql("scripts/readonly/t.sql", sql).violations.map((v) => `${v.column}:${v.issue}`);

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
    expect(issues("-- @col transaction_read_only: boolean\n" + ALLOWED)).toEqual([]);
  });

  it("fails a shop domain column", () => {
    expect(issues(`SELECT s.domain FROM "Shop" s;`)).toEqual(["domain:sensitive"]);
    expect(issues(`SELECT message->>'shop' AS shop FROM pgmq.q_s6_sync;`)).toEqual(["shop:sensitive"]);
  });

  it("fails an email / name column even when annotated, and when aliased innocently", () => {
    expect(issues(`-- @col email: enum\nSELECT c.email FROM c;`)).toEqual(["email:sensitive"]);
    expect(issues(`-- @col contact: enum\nSELECT c.email AS contact FROM c;`)).toEqual(["contact:sensitive"]);
    expect(issues(`SELECT ba.name AS buyer_account_id FROM "BuyerAccount" ba;`)).toEqual(["buyer_account_id:sensitive"]);
    expect(issues(`SELECT e.data->>'customerEmail' AS who FROM "AuditEvent" e;`)).toEqual(["who:sensitive"]);
  });

  it("fails free text and raw error columns", () => {
    expect(issues(`SELECT p.narration FROM "Payment" p;`)).toEqual(["narration:sensitive"]);
    expect(issues(`SELECT d.error FROM s6_dead_letter d;`)).toEqual(["error:sensitive"]);
    expect(issues(`SELECT d.error AS err FROM s6_dead_letter d;`)).toEqual(["err:sensitive"]);
    expect(issues(`SELECT e.data FROM "AuditEvent" e;`)).toEqual(["data:sensitive"]);
    // unguarded CASE passthrough of raw text
    expect(issues(`SELECT CASE WHEN d.error IS NULL THEN 'none' ELSE d.error END AS error_code FROM d;`)).toEqual(["error_code:sensitive"]);
    // ... and an annotation cannot launder it
    expect(issues(`-- @col error_code: enum\nSELECT CASE WHEN d.error IS NULL THEN 'none' ELSE d.error END AS error_code FROM d;`)).toEqual(["error_code:sensitive"]);
    // a guard with an unbounded regex is not a guard
    expect(issues(`SELECT CASE WHEN x.r ~ '^.*$' THEN x.r END AS reason_code FROM x;`)).toEqual(["reason_code:unclassified"]);
  });

  it("fails per-shop money columns", () => {
    expect(issues(`SELECT i.outstanding FROM "Invoice" i;`)).toEqual(["outstanding:sensitive"]);
    expect(issues(`SELECT SUM(i.amount) AS total FROM "Invoice" i;`)).toEqual(["total:sensitive"]);
    expect(issues(`SELECT SUM(i.x) AS s FROM "Invoice" i;`)).toEqual(["s:unclassified"]);
    expect(issues(`SELECT ba."creditLimit" FROM "BuyerAccount" ba;`)).toEqual(["creditLimit:sensitive"]);
  });

  it("allows booleans and counts derived from sensitive columns", () => {
    expect(issues(`SELECT (ba."creditLimit" IS NOT NULL) AS has_credit_limit, COUNT(i.outstanding) AS n,
      (s.domain = m.shop) AS shop_domain_match FROM t;`)).toEqual([]);
  });

  it("fails SELECT *, unannotated passthroughs, non-select statements and stale annotations", () => {
    expect(issues(`SELECT * FROM t;`)).toEqual(["*:star"]);
    expect(issues(`SELECT t.status FROM t;`)).toEqual(["status:unclassified"]);
    expect(issues(`DELETE FROM t;`)).toEqual(["(statement):unsupported_statement"]);
    expect(issues(`-- @col gone: enum\nSELECT COUNT(*) AS n FROM t;`)).toEqual(["gone:stale_annotation"]);
    expect(issues(`-- @col status: text\nSELECT 'a' AS status;`)).toEqual(["status:bad_annotation"]);
  });

  it("config_int passes only for a listed merchant setting", () => {
    expect(CONFIG_INT_COLUMNS).toEqual(["defaultTermsDays"]);
    expect(issues(`-- @col defaultTermsDays: config_int
SELECT CASE WHEN a."defaultTermsDays" BETWEEN 0 AND 365 THEN a."defaultTermsDays" END AS "defaultTermsDays" FROM "BuyerAccount" a;`)).toEqual([]);
    expect(issues(`-- @col "defaultTermsDays": config_int\nSELECT a."defaultTermsDays" FROM "BuyerAccount" a;`)).toEqual([]);
  });

  it("config_int fails on an unlisted name or a relabelled source, and never launders money", () => {
    expect(issues(`-- @col retryDays: config_int\nSELECT a."retryDays" FROM t a;`)).toEqual(["retryDays:config_int_not_listed"]);
    expect(issues(`-- @col defaultTermsDays: config_int\nSELECT a."graceDays" AS "defaultTermsDays" FROM t a;`)).toEqual(["defaultTermsDays:config_int_not_listed"]);
    expect(issues(`-- @col defaultTermsDays: config_int\nSELECT a."creditLimit" AS "defaultTermsDays" FROM t a;`)).toEqual(["defaultTermsDays:sensitive"]);
    expect(issues(`-- @col "creditLimit": config_int\nSELECT a."creditLimit" FROM t a;`)).toEqual(["creditLimit:sensitive"]);
  });

  it("helpers", () => {
    expect(isSafeGuardRegex("^[A-Z0-9_]{1,40}$")).toBe(true);
    expect(isSafeGuardRegex("^(?:(non_retryable|permanent):)?([A-Za-z][A-Za-z0-9_]{0,63}|graphql_error:[A-Za-z0-9_,]{1,200})$")).toBe(true);
    expect(isSafeGuardRegex("^[A-Za-z ]{1,40}$")).toBe(false);
    expect(isSafeGuardRegex("^.+$")).toBe(false);
    expect(sensitiveWord("error_code")).toBeNull();
    expect(sensitiveWord("shop_idx")).toBeNull();
    expect(sensitiveWord("shopDomain")).toBe("shop");
    expect(sensitiveWord("holdNote")).toBe("note");
  });
});

describe("check-readonly-columns: allowlist ratchet", () => {
  const v = (column: string, issue: "sensitive" | "unclassified" = "unclassified") => ({ file: "f.sql", column, issue, detail: "" });
  const entry = (column: string, count = 1): AllowlistEntry => ({ file: "f.sql", column, issue: "unclassified", count });

  it("allowlisted violations pass", () => {
    expect(compareAllowlist([v("a")], [entry("a")])).toEqual({ newViolations: [], stale: [] });
  });
  it("a new violation not on the allowlist fails", () => {
    const r = compareAllowlist([v("a"), v("b")], [entry("a")]);
    expect(r.newViolations.map((x) => x.column)).toEqual(["b"]);
  });
  it("a second occurrence beyond the allowed count fails", () => {
    expect(compareAllowlist([v("a"), v("a")], [entry("a")]).newViolations).toHaveLength(1);
  });
  it("a stale allowlist entry fails (counts only go down)", () => {
    const r = compareAllowlist([], [entry("a")]);
    expect(r.stale).toEqual([{ entry: entry("a"), actual: 0 }]);
    expect(compareAllowlist([v("a")], [entry("a", 2)]).stale).toHaveLength(1);
  });
});

describe("check-readonly-columns: CLI", () => {
  const script = path.join(__dirname, "..", "check-readonly-columns.ts");
  const runCli = (files: Record<string, string>, allow: AllowlistEntry[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ro-cols-"));
    fs.mkdirSync(path.join(root, "scripts", "readonly"), { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, "scripts", "readonly", f), c);
    const allowPath = path.join(root, "allow.json");
    fs.writeFileSync(allowPath, JSON.stringify({ entries: allow }));
    try {
      execFileSync("npx", ["tsx", script], { env: { ...process.env, READONLY_COLUMNS_ROOT: root, READONLY_COLUMNS_ALLOWLIST: allowPath }, encoding: "utf8" });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  it("exits 0 for a clean file, 1 for a new violation, 1 for a stale entry", () => {
    expect(runCli({ "a.sql": "SELECT COUNT(*) AS n FROM t;" }, [])).toBe(0);
    expect(runCli({ "a.sql": "SELECT s.domain FROM s;" }, [])).toBe(1);
    expect(runCli({ "a.sql": "SELECT COUNT(*) AS n FROM t;" }, [{ file: "scripts/readonly/a.sql", column: "status", issue: "unclassified", count: 1 }])).toBe(1);
    expect(runCli({ "a.sql": "SELECT t.status FROM t;" }, [{ file: "scripts/readonly/a.sql", column: "status", issue: "unclassified", count: 1 }])).toBe(0);
  }, 60000);

  it("the committed scripts/readonly files pass with the committed allowlist", () => {
    const out = execFileSync("npx", ["tsx", script], { encoding: "utf8" });
    expect(out).toContain("OK");
  }, 60000);
});
