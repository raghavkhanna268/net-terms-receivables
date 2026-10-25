/**
 * Static guards for the one-off #200 seed-orphan delete (workflow + SQL).
 *
 * Verifies:
 * - workflow_dispatch only, main only, mode defaults to dry-run, apply needs confirm
 * - never uses the shopify-release environment
 * - dry-run runs with default_transaction_read_only=on
 * - the SQL allowlist is exactly the 3 approved CompanyLocation gids, everywhere
 * - the SQL only deletes from "BuyerAccount", only inside the apply branch,
 *   asserts 3 deleted rows, and commits only under `\if :is_apply`
 * - the SQL never selects the shop domain or other sensitive columns
 *
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/200
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(__dirname, "../../..");
const WF_TEXT = readFileSync(
  join(ROOT, ".github/workflows/ops-200-delete-seed-orphans.yml"),
  "utf8",
);
const SQL = readFileSync(
  join(ROOT, "scripts/ops/200-delete-seed-orphans.sql"),
  "utf8",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wf: any = parseYaml(WF_TEXT);

const APPROVED = [
  "gid://shopify/CompanyLocation/24539463845",
  "gid://shopify/CompanyLocation/24539529381",
  "gid://shopify/CompanyLocation/24539594917",
];

function gidsIn(text: string): string[] {
  return [
    ...new Set(text.match(/gid:\/\/shopify\/CompanyLocation\/\d+/g) ?? []),
  ].sort();
}

function sqlWithoutComments(): string {
  return SQL.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

describe("ops-200 workflow", () => {
  it("is workflow_dispatch only", () => {
    // YAML parses the `on` key as true in some parsers; accept either.
    const on = wf.on ?? wf[true as unknown as string];
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
  });

  it("defaults mode to dry-run with only dry-run|apply", () => {
    const on = wf.on ?? wf[true as unknown as string];
    const mode = on.workflow_dispatch.inputs.mode;
    expect(mode.default).toBe("dry-run");
    expect(mode.options).toEqual(["dry-run", "apply"]);
  });

  it("runs on main only and never uses shopify-release", () => {
    const job = wf.jobs.run;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBeUndefined();
    expect(WF_TEXT).not.toMatch(/environment:\s*shopify-release/);
  });

  it("requires the confirm phrase for apply", () => {
    expect(WF_TEXT).toContain(
      'if [ "$INPUT_CONFIRM" != "DELETE-3-SEED-ORPHANS" ]; then',
    );
  });

  it("forces a read-only session for dry-run and redacts psql stderr", () => {
    const step = wf.jobs.run.steps.find((s: { name?: string }) =>
      s.name?.startsWith("Run guarded delete"),
    );
    expect(step.run).toContain('if [ "$INPUT_MODE" = "dry-run" ]; then');
    expect(step.run).toContain(
      'export PGOPTIONS="-c default_transaction_read_only=on"',
    );
    expect(step.run).toContain("source scripts/ci/psql-redacted.sh");
  });

  it("takes the shop only from the ALLOWED_DEV_STORE secret, masked", () => {
    expect(WF_TEXT).toContain(
      "ALLOWED_DEV_STORE: ${{ secrets.ALLOWED_DEV_STORE }}",
    );
    expect(WF_TEXT).toContain('echo "::add-mask::$ALLOWED_DEV_STORE"');
    // No literal shop domain anywhere in the workflow.
    expect(WF_TEXT).not.toMatch(/[a-z0-9][a-z0-9-]*\.myshopify\.com/i);
  });

  it("only references the 3 approved gids", () => {
    expect(gidsIn(WF_TEXT)).toEqual(APPROVED);
  });
});

describe("ops-200 SQL", () => {
  it("only references the 3 approved gids", () => {
    expect(gidsIn(SQL)).toEqual(APPROVED);
  });

  it("has exactly one DELETE, from BuyerAccount, inside the apply branch, asserting 3 rows", () => {
    const body = sqlWithoutComments();
    const deletes = body.match(/\bDELETE\s+FROM\s+[^\s;]+/gi) ?? [];
    expect(deletes).toEqual(['DELETE FROM "BuyerAccount"']);
    const applyIdx = body.indexOf("IF v_apply THEN\n    DELETE");
    expect(applyIdx).toBeGreaterThan(0);
    expect(body).toContain(
      "IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_200:deleted_rows_%', v_n; END IF;",
    );
    // `FOR UPDATE` row locks are allowed; no other write statements.
    expect(body.replace(/\bFOR\s+UPDATE\b/gi, "")).not.toMatch(
      /\b(UPDATE|INSERT|TRUNCATE|DROP|ALTER)\b/i,
    );
  });

  it("checks every dependent table before writing", () => {
    for (const code of [
      "matched_rows_",
      "seed_rows_",
      "admin_nodes_not_all_null",
      "invoices_",
      "matches_",
      "rejected_matches_",
      "reminder_logs_",
      "payer_aliases_",
      "draft_orders_",
      "audit_events_",
      "queued_messages_",
      "fk_rows_",
    ]) {
      expect(SQL).toContain(`'refuse_200:${code}`);
    }
    expect(SQL).toContain("c.confrelid = '\"BuyerAccount\"'::regclass");
    expect(SQL.indexOf("refuse_200:fk_rows_")).toBeLessThan(
      SQL.indexOf("DELETE FROM"),
    );
  });

  it("commits only in apply mode, otherwise rolls back", () => {
    expect(SQL).toMatch(/\\if :is_apply\nCOMMIT;\n[^\n]*\n\\else\nROLLBACK;/);
    expect((SQL.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  it("never selects the shop domain or sensitive columns", () => {
    const body = sqlWithoutComments();
    expect(body).not.toMatch(/\bSELECT\s+[^;]*\bs\.domain\s+AS/i);
    expect(body).not.toMatch(
      /\b(name|email|"creditLimit"|outstanding|"holdNote"|"accessToken")\b/,
    );
    // The domain is only ever compared, never output.
    for (const m of body.matchAll(
      /current_setting\('ntr200\.shop_domain'\)/g,
    )) {
      const before = body.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
      expect(before).toMatch(/=\s*$/);
    }
  });
});
