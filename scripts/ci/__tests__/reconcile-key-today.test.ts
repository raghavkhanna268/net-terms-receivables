import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { checkSql } from "../check-readonly-columns";

/**
 * scripts/readonly/reconcile-key-today.sql: per installed shop_idx and stage,
 * does the day's reconcile dedupe key exist in s6_processed_webhooks and
 * s6_reconcile_stage_claims? Read-only, public-logs safe, key formats match
 * the app code, runnable from prod-readonly-query.yml.
 */

const root = path.resolve(__dirname, "../../..");
const rel = "scripts/readonly/reconcile-key-today.sql";
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

describe("reconcile-key-today.sql", () => {
  it("passes the public-logs column check with only ids, counts, enums, booleans and timestamps", () => {
    const { violations, columns } = checkSql(rel, sql);
    expect(violations).toEqual([]);
    expect(columns.map((c) => [c.column, c.kind])).toEqual([
      ["shop_idx", "id"],
      ["invoices", "count"],
      ["checked_utc_date", "timestamp"],
      ["stage", "enum"],
      ["processed_key_exists", "boolean"],
      ["processed_at", "timestamp"],
      ["stage_claim_exists", "boolean"],
      ["claim_has_bulk_op", "boolean"],
      ["claimed_at", "timestamp"],
    ]);
  });

  it("has one statement in a read-only transaction that rolls back, with no writes", () => {
    expect(sqlOnly).not.toMatch(/\\/);
    expect(code).toMatch(/BEGIN TRANSACTION READ ONLY;/);
    expect(code.trimEnd()).toMatch(/ROLLBACK;$/);
    expect(sqlOnly.match(/\bWITH\b/gi)).toHaveLength(1);
    expect(sqlOnly).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|CALL|DO|SET|COMMIT|nextval|setval|pg_\w+)\b/i,
    );
  });

  it("never prints the shop domain", () => {
    const finalSelect = code.slice(code.lastIndexOf("\nSELECT "));
    const selectList = finalSelect.slice(0, finalSelect.indexOf("\nFROM "));
    expect(selectList).not.toMatch(/\bdom(ain)?\b/i);
  });

  it("builds the keys in the same format as the reconcile app code", () => {
    expect(code).toContain(
      "p.webhook_id = 'reconcile:' || sh.dom || ':' || day.d || ':' || st.stage",
    );
    expect(code).toContain("c.chain_key = sh.dom || ':' || day.d AND c.stage = st.stage");
    const recon = fs.readFileSync(
      path.join(root, "app/services/drain/reconcile.server.ts"),
      "utf8",
    );
    expect(recon).toContain("return `reconcile:${shop}:${today}:${kind}`;");
    const handlers = fs.readFileSync(
      path.join(root, "app/services/drain/reconcile-handlers.server.ts"),
      "utf8",
    );
    expect(handlers).toContain("webhookId = `reconcile:${shop}:${today}:${stage}`;");
    expect(handlers).toContain("return `${dateMatch[1]}:${dateMatch[2]}`;");
    for (const stage of ["companies", "customers", "orders"]) {
      expect(code).toContain(`'${stage}' AS stage`);
    }
  });

  it("numbers installed shops by Shop.id like offline-session-preflight.sql", () => {
    expect(code).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY s\.id\) AS shop_idx/);
    expect(code).toMatch(/s\."uninstalledAt" IS NULL/);
  });

  it("uses the UTC date of since, else today's UTC date", () => {
    expect(code).toMatch(/\(:'since'\)::timestamptz AT TIME ZONE 'UTC'/);
    expect(code).toMatch(/\(NOW\(\) AT TIME ZONE 'UTC'\)::date/);
  });

  it("is a choice option of prod-readonly-query.yml", () => {
    const wf = fs.readFileSync(
      path.join(root, ".github/workflows/prod-readonly-query.yml"),
      "utf8",
    );
    expect(wf).toMatch(/^\s+- reconcile-key-today$/m);
  });
});
