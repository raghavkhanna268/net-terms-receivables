/**
 * Guards scripts/readonly/*.sql against referencing columns that do not exist on
 * webhook_receipts (prod schema: prisma/migrations/20261025010000_s20_webhook_receipts).
 *
 * Regression: s12-hold-coverage.sql and hold-audit-s12.sql selected wr.resource_gid,
 * which webhook_receipts never had, so prod-readonly-query failed with
 * `column wr.resource_gid does not exist`.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../..");
const MIGRATION = join(
  ROOT,
  "prisma/migrations/20261025010000_s20_webhook_receipts/migration.sql",
);
const READONLY_DIR = join(ROOT, "scripts/readonly");

function webhookReceiptColumns(): Set<string> {
  const sql = readFileSync(MIGRATION, "utf8");
  const m = sql.match(
    /CREATE TABLE IF NOT EXISTS webhook_receipts \(([\s\S]*?)\n\);/,
  );
  if (!m) throw new Error("webhook_receipts CREATE TABLE not found");
  const cols = new Set<string>();
  for (const line of m[1].split("\n")) {
    const c = line.trim().match(/^([a-z_]+)\s+[A-Z]/);
    if (c && c[1] !== "PRIMARY") cols.add(c[1]);
  }
  return cols;
}

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

/** Column refs of the form <alias>.<col> for every alias bound to webhook_receipts. */
function receiptRefs(sql: string): string[] {
  const body = stripComments(sql);
  const aliases = new Set<string>();
  const aliasRe = /\bwebhook_receipts\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/gi;
  const reserved = new Set([
    "where",
    "join",
    "left",
    "on",
    "group",
    "order",
    "union",
    "limit",
    "inner",
    "cross",
  ]);
  for (const m of body.matchAll(aliasRe)) {
    if (!reserved.has(m[1].toLowerCase())) aliases.add(m[1]);
  }
  const refs: string[] = [];
  for (const a of aliases) {
    const refRe = new RegExp(`\\b${a}\\.([a-z_][a-z0-9_]*)`, "g");
    for (const r of body.matchAll(refRe)) refs.push(r[1]);
  }
  return refs;
}

describe("readonly scripts: webhook_receipts column references", () => {
  const cols = webhookReceiptColumns();

  it("parses the real webhook_receipts columns from the migration", () => {
    expect([...cols].sort()).toEqual([
      "received_at",
      "shop",
      "topic",
      "triggered_at",
      "webhook_id",
    ]);
    expect(cols.has("resource_gid")).toBe(false);
  });

  const files = readdirSync(READONLY_DIR).filter((f) => f.endsWith(".sql"));
  for (const f of files) {
    it(`${f} only references existing webhook_receipts columns`, () => {
      const refs = receiptRefs(readFileSync(join(READONLY_DIR, f), "utf8"));
      const bad = refs.filter((c) => !cols.has(c));
      expect(bad).toEqual([]);
    });
  }

  it("detects the original wr.resource_gid regression", () => {
    const sql =
      "SELECT wr.resource_gid FROM webhook_receipts wr WHERE wr.topic = 'X'";
    expect(receiptRefs(sql).filter((c) => !cols.has(c))).toEqual([
      "resource_gid",
    ]);
  });
});
