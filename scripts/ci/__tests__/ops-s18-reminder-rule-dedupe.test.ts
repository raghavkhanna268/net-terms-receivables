/**
 * Static guards for the one-off S18 duplicate ReminderRule dedupe
 * (.github/workflows/ops-s18-reminder-rule-dedupe.yml +
 * scripts/ops/s18-reminder-rule-dedupe.sql).
 *
 * Verifies:
 * - workflow_dispatch only, main only, one boolean input dry_run (default true)
 *   and no id / GID / domain / shop inputs
 * - the shop comes only from the ALLOWED_DEV_STORE secret, validated then
 *   masked, fails closed when missing; no literal domain, GID or UUID anywhere
 * - dry run: default_transaction_read_only=on + BEGIN TRANSACTION READ ONLY,
 *   ROLLBACK; COMMIT only under `\if :is_apply`
 * - SQL guards: exactly 1 Shop row, currency 'USD', shop_idx 2, only the
 *   (-3|0|7, email) groups, newer copy by ("createdAt", id), 3 targets, 3
 *   kept, 0 ReminderLog / FK rows, deleted = 3, 0 duplicate groups after
 * - the only DELETE is FROM "ReminderRule", inside the apply-and-no-refuse
 *   branch, scoped to the shop and NOT EXISTS ReminderLog
 * - the domain is only compared, never output; only count/boolean columns
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(__dirname, "../../..");
const WF_TEXT = readFileSync(
  join(ROOT, ".github/workflows/ops-s18-reminder-rule-dedupe.yml"),
  "utf8",
);
const SQL = readFileSync(
  join(ROOT, "scripts/ops/s18-reminder-rule-dedupe.sql"),
  "utf8",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wf: any = parseYaml(WF_TEXT);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const on: any = wf.on ?? wf[true as unknown as string];

const BODY = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const GID = /gid:\/\/shopify\//i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DOMAIN = /[a-z0-9][a-z0-9-]*\.myshopify\.com/i;

function runStep(): { run: string; env: Record<string, string> } {
  return wf.jobs.run.steps.find((s: { name?: string }) =>
    s.name?.startsWith("Run guarded dedupe"),
  );
}

describe("ops-s18-reminder-rule-dedupe workflow", () => {
  it("is workflow_dispatch only", () => {
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
  });

  it("has exactly one input, dry_run, boolean, default true", () => {
    const inputs = on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(["dry_run"]);
    expect(inputs.dry_run.type).toBe("boolean");
    expect(inputs.dry_run.default).toBe(true);
  });

  it("takes no ids, GIDs, domains or shops as inputs", () => {
    const names = Object.keys(on.workflow_dispatch.inputs ?? {});
    for (const n of names) {
      expect(n).not.toMatch(/id|gid|domain|shop|store|rule|target/i);
    }
    // Nothing else in the workflow reads inputs besides dry_run.
    const refs = [...WF_TEXT.matchAll(/inputs\.([a-z_]+)/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(["dry_run"]));
  });

  it("runs on main only, serialized, and never uses shopify-release", () => {
    const job = wf.jobs.run;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBeUndefined();
    expect(wf.concurrency).toEqual({
      group: "ops-s18-reminder-rule-dedupe",
      "cancel-in-progress": false,
    });
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(WF_TEXT).not.toMatch(/environment:\s*shopify-release/);
  });

  it("takes the shop only from the ALLOWED_DEV_STORE secret: fail closed, validate, then mask", () => {
    const step = runStep();
    expect(step.env.ALLOWED_DEV_STORE).toBe("${{ secrets.ALLOWED_DEV_STORE }}");
    expect(step.env.DATABASE_URL).toBe(
      "${{ secrets.DATABASE_URL_MIGRATIONS }}",
    );
    const run = step.run;
    const empty = run.indexOf('if [ -z "${ALLOWED_DEV_STORE:-}" ]; then');
    const valid = run.indexOf(
      'if [[ ! "$ALLOWED_DEV_STORE" =~ ^[a-z0-9-]+\\.myshopify\\.com$ ]]; then',
    );
    const mask = run.indexOf('echo "::add-mask::$ALLOWED_DEV_STORE"');
    const psql = run.indexOf("psql -X");
    expect(empty).toBeGreaterThanOrEqual(0);
    expect(valid).toBeGreaterThan(empty);
    expect(mask).toBeGreaterThan(valid);
    expect(psql).toBeGreaterThan(mask);
    expect(run).toContain('if [ -z "${DATABASE_URL:-}" ]; then');
    // The secret is only passed to psql, never echoed.
    expect(run).not.toMatch(/echo [^\n]*\$\{?ALLOWED_DEV_STORE\}?(?!")/);
    expect(run).toContain('-v "shop=${ALLOWED_DEV_STORE}"');
  });

  it("forces a read-only session for dry run and redacts psql stderr", () => {
    const run = runStep().run;
    expect(run).toMatch(
      /APPLY=false\n\s*#[^\n]*\n\s*export PGOPTIONS="-c default_transaction_read_only=on"/,
    );
    expect(run).toContain(
      'if [ "$INPUT_DRY_RUN" = "false" ]; then\n  APPLY=true',
    );
    expect(run).toContain("source scripts/ci/psql-redacted.sh");
    expect(run.indexOf("source scripts/ci/psql-redacted.sh")).toBeLessThan(
      run.indexOf("psql -X"),
    );
    expect(run).toContain("-v ON_ERROR_STOP=1");
    expect(run).toContain("-f scripts/ops/s18-reminder-rule-dedupe.sql");
  });

  it("contains no literal domain, GID or UUID", () => {
    expect(WF_TEXT).not.toMatch(DOMAIN);
    expect(WF_TEXT).not.toMatch(GID);
    expect(WF_TEXT).not.toMatch(UUID);
  });
});

describe("ops-s18-reminder-rule-dedupe SQL", () => {
  it("contains no literal domain, GID or UUID", () => {
    expect(SQL).not.toMatch(DOMAIN);
    expect(SQL).not.toMatch(GID);
    expect(SQL).not.toMatch(UUID);
  });

  it("has exactly one DELETE, from ReminderRule, in the apply-and-no-refuse branch", () => {
    const deletes = BODY.match(/\bDELETE\s+FROM\s+[^\s;]+/gi) ?? [];
    expect(deletes).toEqual(['DELETE FROM "ReminderRule"']);
    expect(BODY).toContain(
      "IF v_apply AND v_refuse = '' THEN\n" +
        '    DELETE FROM "ReminderRule" r\n' +
        "    WHERE r.id = ANY(v_target_ids)\n" +
        '      AND r."shopId" = v_shop_id\n' +
        '      AND NOT EXISTS (SELECT 1 FROM "ReminderLog" rl WHERE rl."ruleId" = r.id);',
    );
    // `FOR UPDATE` row locks are allowed; no other write statements.
    expect(BODY.replace(/\bFOR\s+UPDATE\b/gi, "")).not.toMatch(
      /\b(UPDATE|INSERT|TRUNCATE|DROP|ALTER|CREATE|GRANT|COPY)\b/i,
    );
  });

  it("asserts the outcome after the DELETE, inside the same block", () => {
    const del = BODY.indexOf('DELETE FROM "ReminderRule"');
    const end = BODY.indexOf("$rrd$;");
    for (const s of [
      "IF v_deleted <> 3 THEN RAISE EXCEPTION 'refuse_rrd:deleted_rows_%', v_deleted; END IF;",
      "IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_rrd:targets_remaining_%', v_n; END IF;",
      "IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_rrd:kept_rows_after_%', v_n; END IF;",
      "IF v_n <> 0 THEN RAISE EXCEPTION 'refuse_rrd:dup_groups_after_%', v_n; END IF;",
    ]) {
      const i = BODY.indexOf(s);
      expect(i, s).toBeGreaterThan(del);
      expect(i, s).toBeLessThan(end);
    }
  });

  it("guards the shop: 1 row by domain, currency USD, shop_idx 2", () => {
    expect(BODY).toContain(
      `SELECT COUNT(*) INTO v_shop_rows FROM "Shop" s WHERE v_domain <> '' AND s.domain = v_domain;`,
    );
    expect(BODY).toContain("COALESCE(s.currency = 'USD', false)");
    expect(BODY).toContain(
      'DENSE_RANK() OVER (ORDER BY s.id) AS shop_idx FROM "Shop" s',
    );
    expect(BODY).toContain(
      "IF v_shop_rows <> 1 THEN v_refuse := 'shop_rows_' || v_shop_rows;",
    );
    expect(BODY).toContain(
      "ELSIF NOT v_currency_ok THEN v_refuse := 'currency_not_usd';",
    );
    expect(BODY).toContain(
      "ELSIF v_shop_idx IS DISTINCT FROM 2 THEN v_refuse := 'shop_idx_not_2';",
    );
  });

  it("targets only the newer copy of the 3 approved (offsetDays, channel) groups on that shop", () => {
    expect(BODY).toContain('WHERE r."shopId" = v_shop_id\n    ),');
    expect(BODY).toContain(
      "AND (k.rk_offset, k.rk_channel) IN ((-3, 'email'), (0, 'email'), (7, 'email'))",
    );
    expect(BODY).toMatch(
      /PARTITION BY r\."shopId", r\."offsetDays", r\.channel\s+ORDER BY r\."createdAt", r\.id/,
    );
    expect(BODY).toContain("FROM scoped s WHERE s.rn > 1)");
    expect(BODY).toContain("FROM scoped s WHERE s.rn = 1)");
  });

  it("refuses unless the counts match exactly, before any write", () => {
    for (const s of [
      "ELSIF v_groups_all <> 3 THEN v_refuse := 'dup_groups_on_shop_'",
      "ELSIF v_groups <> 3 THEN v_refuse := 'groups_'",
      "ELSIF COALESCE(cardinality(v_target_ids), 0) <> 3 THEN v_refuse := 'target_rows_'",
      "ELSIF COALESCE(cardinality(v_kept_ids), 0) <> 3 THEN v_refuse := 'kept_rows_'",
      "ELSIF v_log_rows <> 0 OR v_with_logs <> 0 THEN v_refuse := 'target_log_rows_'",
      "ELSIF v_fk_rows <> 0 THEN v_refuse := 'fk_rows_'",
    ]) {
      const i = BODY.indexOf(s);
      expect(i, s).toBeGreaterThan(0);
      expect(i, s).toBeLessThan(BODY.indexOf("DELETE FROM"));
    }
    expect(BODY).toContain("c.confrelid = '\"ReminderRule\"'::regclass");
    // Apply locks the shop's rules before counting.
    expect(BODY.indexOf("FOR UPDATE;")).toBeLessThan(
      BODY.indexOf("WITH ranked AS"),
    );
    // A refused guard always fails the run (after the counts are printed).
    expect(BODY).toContain(
      "IF current_setting('ntr_rrd.guard_passed') <> 'true' THEN\n    RAISE EXCEPTION 'refuse_rrd:%'",
    );
  });

  it("dry run is READ ONLY and rolls back; COMMIT only under \\if :is_apply", () => {
    expect(BODY).toMatch(
      /\\if :is_apply\nBEGIN;\n\\else\nBEGIN TRANSACTION READ ONLY;\n\\endif/,
    );
    expect(BODY).toMatch(/\\if :is_apply\nCOMMIT;\n[^\n]*\n\\else\nROLLBACK;/);
    expect((BODY.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
    expect(BODY).toContain(
      "SELECT :'apply' IN ('true', 'false') AS apply_valid",
    );
    expect(BODY).toContain("RAISE EXCEPTION 'refuse_rrd:bad_apply_var'");
  });

  it("prints the pinned count fields and never the domain or ids", () => {
    for (const col of [
      "shop_rows",
      "currency_is_usd",
      "shop_idx",
      "dup_groups_on_shop",
      "groups",
      "target_rows",
      "target_rows_with_logs",
      "target_log_rows",
      "target_fk_rows",
      "kept_rows",
      "guard_passed",
      "refuse_code",
      "deleted_rows",
      "dup_groups_on_shop_now",
      "shop_rules_now",
      "shop_rules_enabled_now",
    ]) {
      expect(BODY).toMatch(new RegExp(`\\bAS ${col}\\b`));
    }
    expect(BODY).not.toMatch(/\bSELECT\s+[^;]*\bs\.domain\s+AS/i);
    // Everything printed after the main block is exactly these columns.
    const printed = BODY.slice(BODY.indexOf("$rrd$;"));
    expect([...printed.matchAll(/\bAS (\w+)/g)].map((m) => m[1])).toEqual([
      "shop_rows",
      "currency_is_usd",
      "shop_idx",
      "dup_groups_on_shop",
      "groups",
      "target_rows",
      "target_rows_with_logs",
      "target_log_rows",
      "target_fk_rows",
      "kept_rows",
      "guard_passed",
      "refuse_code",
      "deleted_rows",
      "dup_groups_on_shop_now",
      "shop_rules_now",
      "shop_rules_enabled_now",
      "apply_mode",
    ]);
    expect(printed).not.toMatch(
      /\bSELECT\s+[^;]*\b(r\.id|s\.id|s\.domain|"shopId")\s*(,|AS|$)/im,
    );
    // The domain is only ever compared or assigned to a compared variable.
    for (const m of BODY.matchAll(
      /current_setting\('ntr_rrd\.shop_domain'\)/g,
    )) {
      const before = BODY.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
      expect(before).toMatch(/:?=\s*$/);
    }
    const rest = BODY.replace(
      /v_domain\s+text := current_setting\('ntr_rrd\.shop_domain'\);/,
      "",
    )
      .replace(/v_domain <> ''/g, "")
      .replace(/s\.domain = v_domain/g, "");
    expect(rest).not.toMatch(/\bv_domain\b/);
    expect(BODY).not.toMatch(/\bRAISE\s+(NOTICE|INFO|LOG|WARNING)\b/i);
  });
});
