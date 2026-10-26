import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/initial-sync-timing.sql: where Initial Sync wall time goes
 * (per-stage s6_bulk_operations timings, pgmq queue wait, s10 drain cron
 * cadence, pg_net responses). Public logs: must stay read-only, print only UTC
 * timestamps, seconds, counts, enums and booleans, never select message bodies
 * or command/return/error text, and choose the shop only via the shop_idx
 * choice input (1 | 2 | reviewer) plus the E2E_SHOP / ALLOWED_DEV_STORE
 * secrets; never a domain or GID input. reviewer fails closed unless exactly
 * one other installed shop exists.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/initial-sync-timing.sql";
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

describe("initial-sync-timing.sql", () => {
  it("passes the public-logs column check", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns).toEqual([
      { column: "selected", kind: "enum", via: "derived" },
      { column: "reviewer_candidates", kind: "count", via: "derived" },
      { column: "target_rows", kind: "count", via: "derived" },
      { column: "shop_resolved", kind: "boolean", via: "derived" },
      { column: "op_idx", kind: "id", via: "derived" },
      { column: "stage", kind: "enum", via: "derived" },
      { column: "started_utc", kind: "timestamp", via: "annotation" },
      { column: "finish_received_utc", kind: "timestamp", via: "annotation" },
      { column: "completed_utc", kind: "timestamp", via: "annotation" },
      { column: "next_stage_enqueued_utc", kind: "timestamp", via: "annotation" },
      { column: "next_started_utc", kind: "timestamp", via: "annotation" },
      { column: "start_to_finish_webhook_sec", kind: "timestamp", via: "annotation" },
      { column: "finish_webhook_to_completed_sec", kind: "timestamp", via: "annotation" },
      { column: "completed_to_next_enqueued_sec", kind: "timestamp", via: "annotation" },
      { column: "next_enqueued_to_next_start_sec", kind: "timestamp", via: "annotation" },
      { column: "op_wall_sec", kind: "timestamp", via: "annotation" },
      { column: "failure_count", kind: "count", via: "annotation" },
      { column: "closed", kind: "boolean", via: "derived" },
      { column: "sync_enqueued_utc", kind: "timestamp", via: "annotation" },
      { column: "run_started_utc", kind: "timestamp", via: "annotation" },
      { column: "last_completed_utc", kind: "timestamp", via: "annotation" },
      { column: "enqueue_to_first_start_sec", kind: "timestamp", via: "annotation" },
      { column: "enqueue_to_last_completed_sec", kind: "timestamp", via: "annotation" },
      { column: "ops", kind: "count", via: "derived" },
      { column: "ops_completed", kind: "count", via: "derived" },
      { column: "ops_with_failures", kind: "count", via: "derived" },
      { column: "queue", kind: "enum", via: "derived" },
      { column: "topic", kind: "enum", via: "derived" },
      { column: "msgs", kind: "count", via: "derived" },
      { column: "read_ct_gt1", kind: "count", via: "derived" },
      { column: "wait_p50_sec", kind: "timestamp", via: "annotation" },
      { column: "wait_p95_sec", kind: "timestamp", via: "annotation" },
      { column: "wait_max_sec", kind: "timestamp", via: "annotation" },
      { column: "queue", kind: "enum", via: "derived" },
      { column: "topic", kind: "enum", via: "derived" },
      { column: "msgs", kind: "count", via: "derived" },
      { column: "read_ct_gt1", kind: "count", via: "derived" },
      { column: "wait_p50_sec", kind: "timestamp", via: "annotation" },
      { column: "wait_p95_sec", kind: "timestamp", via: "annotation" },
      { column: "wait_max_sec", kind: "timestamp", via: "annotation" },
      { column: "runs", kind: "count", via: "derived" },
      { column: "succeeded", kind: "count", via: "derived" },
      { column: "failed", kind: "count", via: "derived" },
      { column: "other_status", kind: "count", via: "derived" },
      { column: "gaps_over_90s", kind: "count", via: "derived" },
      { column: "first_start_utc", kind: "timestamp", via: "annotation" },
      { column: "last_start_utc", kind: "timestamp", via: "annotation" },
      { column: "gap_p50_sec", kind: "timestamp", via: "annotation" },
      { column: "gap_max_sec", kind: "timestamp", via: "annotation" },
      { column: "dur_p50_ms", kind: "timestamp", via: "annotation" },
      { column: "dur_max_ms", kind: "timestamp", via: "annotation" },
      { column: "status_code", kind: "enum", via: "annotation" },
      { column: "timed_out", kind: "boolean", via: "annotation" },
      { column: "responses", kind: "count", via: "derived" },
      { column: "with_error", kind: "count", via: "derived" },
    ]);
  });

  it("is read-only and rolls back", () => {
    expect(code).toMatch(/^BEGIN TRANSACTION READ ONLY;$/m);
    expect(code.indexOf("BEGIN TRANSACTION READ ONLY;")).toBeLessThan(
      code.indexOf("SELECT"),
    );
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly).not.toMatch(/\\/);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pg_\w+)\b/i,
    );
  });

  it("never selects message bodies, command, return, content or error text", () => {
    const { columns } = checkSql(rel, sql);
    for (const c of columns) {
      expect(c.column).not.toMatch(
        /message|body|payload|content|headers|command|return|error_msg|domain|email|gid|^k$|^tp$/i,
      );
    }
    // message is read only as message->>'topic' (mapped to literal enums) and
    // message->>'shop' (join key), never whole or as any other key
    const msgRefs = code.match(/\bmessage\b[^,\s)]*/g) ?? [];
    expect(msgRefs.length).toBeGreaterThan(0);
    for (const m of msgRefs) {
      expect(["message->>'topic'", "message->>'shop'"]).toContain(m);
    }
    expect(sqlOnly).not.toMatch(/\b(return_message|command|content|headers)\b/i);
    // pg_net error text is only tested for NULL
    expect(code.match(/\berror_msg\b[^\n]*/g)).toEqual([
      "error_msg IS NOT NULL) AS with_error",
    ]);
    // raw topic only feeds the CASE that maps it to literals
    expect(code).toMatch(/ELSE 'other' END AS topic/);
  });

  it("prints no domain, GID or email patterns and never outputs the domain", () => {
    expect(code).not.toMatch(/myshopify|gid:\/\/|@[a-z0-9-]+\.|https?:\/\//i);
    // domain is only read into the internal join key k; k is never output
    for (const m of code.match(/\bdomain\b[^\n]*/g) ?? []) {
      expect(m).toMatch(/^domain( AS k$| <> :'(e2e|allowed)'$| = :'(e2e|allowed)'\)$| IN \(SELECT c\.k FROM cand c\)$)/);
    }
    expect(sqlOnly).not.toMatch(/SELECT\s+(DISTINCT\s+)?[a-z]\.k\b(?!\s+FROM (cand|target))/i);
  });

  it("uses only the shop_idx, e2e and allowed psql variables", () => {
    const vars = [...code.matchAll(/(?<![:A-Za-z0-9]):'?([a-z_0-9]+)'?/g)].map(
      (m) => m[1],
    );
    expect(new Set(vars)).toEqual(new Set(["shop_idx", "e2e", "allowed"]));
  });

  it("fails closed: every shop-scoped statement resolves exactly one shop", () => {
    const targets = code.match(/^target AS \(/gm) ?? [];
    expect(targets).toHaveLength(4);
    expect(code.match(/AND \(SELECT COUNT\(\*\) FROM cand\) = 1\)/g)).toHaveLength(4);
    expect(
      code.match(/SELECT t\.k FROM target t WHERE \(SELECT COUNT\(\*\) FROM target\) = 1/g),
    ).toHaveLength(3);
    expect(code).toMatch(/\(SELECT COUNT\(\*\) FROM target\) = 1 AS shop_resolved/);
    // reviewer excludes both secret shops and uninstalled shops
    expect(code.match(/s\."uninstalledAt" IS NULL\n\s+AND s\.domain <> :'e2e'\n\s+AND s\.domain <> :'allowed'/g)).toHaveLength(4);
  });

  it("anchors on the same initial-sync op as getInitialSyncState", () => {
    expect(
      code.match(/WHERE b\.origin = 'reconcile'\n\s+AND b\.reconcile_stage = 'companies'\n\s+AND b\.closed_at IS NULL/g),
    ).toHaveLength(3);
  });

  it("reads only columns the migrations create", () => {
    const migDir = path.join(root, "prisma/migrations");
    const mig = fs
      .readdirSync(migDir)
      .map((d) => path.join(migDir, d, "migration.sql"))
      .filter((f) => fs.existsSync(f))
      .map((f) => fs.readFileSync(f, "utf8"))
      .join("\n");
    for (const col of [
      "started_at",
      "finish_received_at",
      "completed_at",
      "next_stage_enqueued_at",
      "failure_count",
      "reconcile_stage",
      "origin",
      "closed_at",
    ]) {
      expect(code).toContain(`b.${col}`);
      expect(mig).toMatch(new RegExp(`\\b${col}\\b`));
    }
    expect(mig).toMatch(/pgmq\.create\('s6_sync'\)/);
    expect(mig).toMatch(/pgmq\.create\('s6_bulk'\)/);
    expect(mig).toMatch(/s10_drain_every_minute/);
  });
});

describe("prod-readonly-query.yml wiring for initial-sync-timing", () => {
  it("is a choice option, in alphabetical order", () => {
    expect(wf).toMatch(/^\s+- initial-sync-timing$/m);
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
    expect(block).toContain("initial-sync-timing");
    expect(block).toEqual([...block].sort());
  });

  it("adds only a shop_idx enum choice (1 | 2 | reviewer), no free-text shop input", () => {
    const inputs = [...wf.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]);
    expect(inputs).toEqual(["query", "msg_ids", "since", "location_id", "shop_idx"]);
    expect(wf).toMatch(
      /^ {6}shop_idx:\n {8}description: "[^"]*"\n {8}required: false\n {8}default: "1"\n {8}type: choice\n {8}options:\n {10}- "1"\n {10}- "2"\n {10}- reviewer\n/m,
    );
    expect(wf).not.toMatch(/^\s{6}(shop|domain|shop_domain|shop_gid|gid):/m);
    expect(wf).toContain('if [[ ! "$SHOP_IDX" =~ ^(1|2|reviewer)$ ]]; then');
  });

  it("gets :e2e from the E2E_SHOP secret, validated before masking", () => {
    expect(wf).toContain("E2E_SHOP: ${{ secrets.E2E_SHOP }}");
    const validateAt = wf.indexOf('if [[ ! "$E2E" =~ ^[a-z0-9-]+\\.myshopify\\.com$ ]]; then');
    const maskAt = wf.indexOf('echo "::add-mask::$E2E"');
    expect(validateAt).toBeGreaterThan(-1);
    expect(validateAt).toBeLessThan(maskAt);
    expect(wf).toContain('-v "e2e=${E2E}" -v "shop_idx=${SHOP_IDX}"');
  });

  it("fails closed unless both secrets are valid and different", () => {
    expect(wf).toMatch(
      /if \[ "\$QUERY_NAME" = "initial-sync-timing" \]; then\n(\s+#[^\n]*\n)*\s+if \[ -z "\$E2E" \] \|\| \[ -z "\$ALLOWED" \] \|\| \[ "\$E2E" = "\$ALLOWED" \]; then\n\s+echo "::error::[^"]*"\n\s+exit 1/,
    );
    // the check runs before psql
    expect(wf.indexOf('"$QUERY_NAME" = "initial-sync-timing"')).toBeLessThan(
      wf.indexOf("psql -X"),
    );
  });
});
