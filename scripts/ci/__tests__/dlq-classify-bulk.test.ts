import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/dlq-classify-bulk.sql classifies s6_bulk DLQ msg 14 and 15
 * for prod-readonly-query.yml (public logs). It must stay read-only, take no
 * inputs, and print error codes only as literals: '<prefix>:<code>' for codes
 * listed from the app source, '<other_code>' when the mandatory-prefix pattern
 * matches an unlisted code, '<non_code>' otherwise. Never the error column.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/dlq-classify-bulk.sql";
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
const wf = fs.readFileSync(
  path.join(root, ".github/workflows/prod-readonly-query.yml"),
  "utf8",
);
const bulkSrc = fs.readFileSync(
  path.join(root, "app/services/sync/bulk-jsonl-processor.server.ts"),
  "utf8",
);

const PREFIX_RE = "'^(permanent|non_retryable):[a-z][a-z0-9_]{0,63}$'";

function bulkErrorCodes(): string[] {
  const block = bulkSrc.match(/export const BULK_ERROR_CODES = \{([\s\S]*?)\} as const;/);
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

describe("dlq-classify-bulk.sql", () => {
  it("passes the public-logs column check", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns.map((c) => `${c.column}:${c.kind}`)).toEqual([
      "original_msg_id:id",
      "error_code:enum",
      "error_len_class:enum",
      "dlq_at_ist:timestamp",
      "bulk_type:enum",
      "sanitized:boolean",
      "webhook_id_kind:enum",
      "enqueue_to_dlq:timestamp",
      "original_msg_id:id",
      "shop_row_exists:boolean",
      "op_row_exists:boolean",
      "origin:enum",
      "op_completed:boolean",
      "op_closed:boolean",
      "failure_count:count",
      "dlq_rows_same_op:count",
      "distinct_shops:count",
      "distinct_ops:count",
      "day_ist:timestamp",
      "code:enum",
      "count:count",
    ]);
  });

  it("is read-only: four SELECT statements in a read-only transaction that rolls back", () => {
    expect(sqlOnly).not.toMatch(/\\/);
    expect(code).toMatch(/^BEGIN TRANSACTION READ ONLY;$/m);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|set_config|pgmq|pg_\w+)\b/i,
    );
    expect(code).not.toMatch(/statement_timeout/);
  });

  it("only targets msg 14 and 15 as literals and takes no psql variables", () => {
    expect(code.match(/original_msg_id IN \('14','15'\)/g)).toHaveLength(3);
    expect(sqlOnly).not.toMatch(/(?<![:\w]):'?[a-z_]/i);
  });

  it("prints error codes only as listed literals, gated by the mandatory-prefix pattern", () => {
    // the pattern gates both code columns
    expect(code.split(PREFIX_RE)).toHaveLength(3);
    // the error column is never printed, only compared
    expect(code).not.toMatch(/THEN\s+(d\.)?error\b/);
    const thens = [...code.matchAll(/WHEN (?:d\.)?error = '([^']+)' THEN '([^']+)'/g)];
    expect(thens.length).toBeGreaterThan(0);
    for (const [, when, then] of thens) {
      expect(then).toBe(when);
      expect(when).toMatch(/^(permanent|non_retryable):[a-z][a-z0-9_]{0,63}$/);
    }
    const listed = new Set(thens.map(([, w]) => w));
    // every BULK_ERROR_CODES value is mapped for both prefixes
    for (const c of bulkErrorCodes()) {
      expect(listed).toContain(`permanent:${c}`);
      expect(listed).toContain(`non_retryable:${c}`);
    }
    expect(code.match(/ELSE '<other_code>' END AS (error_code|code)/g)).toHaveLength(2);
    expect(code.match(/THEN '<non_code>'/g)).toHaveLength(2);
  });

  it("buckets the error length instead of printing it", () => {
    expect(code).not.toMatch(/length\(d\.error\) AS/);
    expect(code).toMatch(/ELSE '>128' END AS error_len_class/);
  });

  it("keeps origin a closed enum", () => {
    expect(code).toContain(
      "CASE WHEN bo.origin IN ('reconcile','webhook','manual') THEN bo.origin WHEN bo.origin IS NULL THEN NULL ELSE 'other' END AS origin",
    );
  });

  it("is a choice option of prod-readonly-query.yml and adds no inputs of its own", () => {
    expect(wf).toMatch(/^\s+- dlq-classify-bulk$/m);
    const inputs = [...wf.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs).toEqual(["query", "msg_ids", "since", "location_id", "shop_idx", "closed_window_hours"]);
  });
});
