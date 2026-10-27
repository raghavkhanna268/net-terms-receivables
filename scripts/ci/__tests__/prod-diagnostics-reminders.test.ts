/**
 * prod-diagnostics.yml reminders option (read-only), static side.
 *
 * Pins:
 * - reminders is a boolean input defaulting to false and is the only gate of
 *   its step; no new input carries a shop, id or window;
 * - the step is read-only (PGOPTIONS + BEGIN TRANSACTION ... READ ONLY ...
 *   ROLLBACK in every heredoc) and gets the shop label vars only from the
 *   masked ALLOWED_DEV_STORE / E2E_SHOP secrets (invalid/unset -> "" ->
 *   unknown, and the e2e timezone section returns e2e_shop_rows = 0);
 * - every shop section embeds the canonical shop_labels CTE; outside it the
 *   domain is never compared or selected; the e2e shop is picked only by
 *   shop_kind = 'e2e' (no input, no id, no GID);
 * - due-today uses the same day math as the latest s18_enqueue_reminders()
 *   Part 3 (dueAt in shop tz + offsetDays = today in shop tz);
 * - section 2 groups by offset_class (before_due/on_due/after_due); the raw
 *   offset is printed only for main/e2e rows and is NULL for other_N/unknown;
 * - pg_cron jobs are picked by the jobnames the migrations schedule, and
 *   cron.job.command / return_message are never read;
 * - every output column is a count, enum, boolean or (cron) timestamp in the
 *   readonly column guard's dialect (no ids, GIDs, money, emails or free text);
 * - the 7 day / 24 hour windows are hard-coded;
 * - section 6 (main dev store offline Session health) picks the shop only by
 *   shop_kind = 'main', joins Session like offline-session-preflight.sql, and
 *   prints booleans only: Session credential / expiry columns appear only
 *   inside derived booleans (guard rule 4b), never as values or times.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkSql, CONFIG_INT_COLUMNS, SESSION_CREDENTIAL_COLUMNS } from "../check-readonly-columns";
import { SHOP_LABELS_CTE, stripShopLabelsCte } from "../shop-labels";

const ROOT = join(__dirname, "../../..");
const STEP_NAME = "Reminders counts (read-only)";
const PLANTED_ALLOWED = "planted-rem-main-store.myshopify.com";
const PLANTED_E2E = "planted-rem-e2e-store.myshopify.com";

interface Step {
  name?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown; description?: string }> } };
  jobs: Record<string, { steps?: Step[] }>;
}

const wfText = readFileSync(join(ROOT, ".github/workflows/prod-diagnostics.yml"), "utf8");
const wf = parseYaml(wfText) as Workflow;
const inputs = wf.on.workflow_dispatch.inputs;
const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
const step = steps.find((s) => s.name === STEP_NAME);
const run = step?.run ?? "";
const heredocs = [...run.matchAll(/<<'EOSQL'\n([\s\S]*?)\n\s*EOSQL/g)].map((m) => m[1]);
const mainSql = heredocs[0] ?? "";
const probeSql = heredocs[1] ?? "";
const cronSql = heredocs[2] ?? "";

function between(text: string, start: string, end: string): string {
  const a = text.indexOf(start);
  const b = text.indexOf(end, a);
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing ${end}`).toBeGreaterThan(a);
  return text.slice(a, b + end.length);
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

function latestEnqueueMigration(): string {
  const dir = join(ROOT, "prisma/migrations");
  const hits = readdirSync(dir)
    .filter((d) => {
      const f = join(dir, d, "migration.sql");
      return existsSync(f) && /CREATE OR REPLACE FUNCTION public\.s18_enqueue_reminders\(\)/.test(readFileSync(f, "utf8"));
    })
    .sort();
  return readFileSync(join(dir, hits[hits.length - 1], "migration.sql"), "utf8");
}

const norm = (s: string) => s.replace(/public\./g, "").replace(/\s+/g, " ").trim();

describe("prod-diagnostics reminders option", () => {
  it("is a boolean input defaulting to false, described as read-only", () => {
    expect(inputs.reminders).toBeDefined();
    expect(inputs.reminders.type).toBe("boolean");
    expect(inputs.reminders.default).toBe(false);
    expect(String(inputs.reminders.description)).toMatch(/^Read-only:/);
  });

  it("gates exactly one step, in the default diagnostics job", () => {
    expect(step).toBeDefined();
    expect(step?.if).toBe("${{ inputs.reminders }}");
    expect(wfText.match(/inputs\.reminders\b/g)).toHaveLength(1);
    expect(wf.jobs.diagnostics.steps?.some((s) => s.name === STEP_NAME)).toBe(true);
  });

  it("reads no workflow input (no shop, id or window input)", () => {
    expect(JSON.stringify(step?.env ?? {})).not.toMatch(/inputs\./);
    expect(run).not.toMatch(/inputs\.|SHOP_DOMAIN|GITHUB_EVENT_PATH/);
  });

  it("is read-only and takes the label vars only from secrets", () => {
    expect(step?.env).toEqual({
      DATABASE_URL: "${{ secrets.DATABASE_URL_MIGRATIONS }}",
      ALLOWED_DEV_STORE: "${{ secrets.ALLOWED_DEV_STORE }}",
      E2E_SHOP: "${{ secrets.E2E_SHOP }}",
      PGOPTIONS: "-c default_transaction_read_only=on",
    });
    expect(heredocs).toHaveLength(3);
    expect(mainSql.trimStart().startsWith("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;")).toBe(true);
    expect(mainSql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(probeSql.trim()).toBe("SELECT to_regclass('cron.job_run_details') IS NOT NULL;");
    expect(stripComments(cronSql).trimStart().startsWith("BEGIN TRANSACTION READ ONLY;")).toBe(true);
    expect(cronSql.trimEnd().endsWith("ROLLBACK;")).toBe(true);
    expect(run.match(/^\s*psql /gm)).toHaveLength(2);
    expect(run).toMatch(/psql -X -q -v ON_ERROR_STOP=1 -v "allowed=\$\{LABEL_ALLOWED\}" -v "e2e=\$\{LABEL_E2E\}" "\$DATABASE_URL" <<'EOSQL'/);
    // only the main heredoc gets the label vars
    expect(run.match(/-v "allowed=/g)).toHaveLength(1);
    for (const line of run.split("\n")) {
      if (/\becho\b/.test(line) && !line.includes("::add-mask::")) {
        expect(line).not.toMatch(/\$\{?(LABEL_ALLOWED|LABEL_E2E|ALLOWED_DEV_STORE|E2E_SHOP)\b/);
      }
    }
    for (const sql of [mainSql, cronSql]) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|COPY|CALL)\b/i);
      expect(sql).not.toMatch(/\b(pgmq\.|cron\.(schedule|unschedule|alter_job)|s18_enqueue_reminders\s*\(|net\.http)/i);
      expect(sql).not.toMatch(/\bCOMMIT\b/i);
    }
  });

  it("embeds the canonical shop_labels CTE in every shop section and never touches the domain outside it", () => {
    const sections = mainSql.split(/^\\echo .*$/m).slice(1);
    expect(sections).toHaveLength(5);
    for (const s of sections) expect(s).toContain(`WITH ${SHOP_LABELS_CTE}`);
    const rest = stripShopLabelsCte(mainSql);
    expect(rest).not.toMatch(/ROW_NUMBER|RANK\s*\(|shop_idx/i);
    // the one allowed domain use outside the CTE: section 6's Session join
    // (compared, never selected), as in offline-session-preflight.sql
    const SESSION_JOIN = `ON se.shop = s.domain AND se."isOnline" = false`;
    expect(rest.split(SESSION_JOIN)).toHaveLength(2);
    expect(rest.slice(rest.indexOf("\\echo '== 6.")).includes(SESSION_JOIN)).toBe(true);
    expect(rest.replace(SESSION_JOIN, "")).not.toMatch(/\.domain\b|\.shop\b|:'allowed'|:'e2e'|:allowed|:e2e/);
    expect(cronSql).not.toMatch(/"Shop"|\.domain\b|:'?allowed|:'?e2e/);
  });

  it("selects the e2e shop only by shop_kind = 'e2e' (no input, id or GID)", () => {
    const tz = mainSql.slice(mainSql.indexOf("\\echo '== 5."));
    expect(tz).toMatch(/WHERE sl\.shop_kind = 'e2e';/);
    expect(stripShopLabelsCte(tz)).not.toMatch(/s\.id\s*=|gid:\/\/|shopify\.com|:'[a-z_]+'/i);
    expect(tz).toMatch(/COUNT\(\*\) AS e2e_shop_rows/);
  });

  it("uses the enqueue function's due-today day math in each shop's timezone", () => {
    const mig = norm(latestEnqueueMigration());
    const dayMath =
      `(i."dueAt" AT TIME ZONE s18_safe_timezone(s.timezone))::DATE + r."offsetDays" = (NOW() AT TIME ZONE s18_safe_timezone(s.timezone))::DATE`;
    expect(mig).toContain(dayMath);
    const due = norm(between(mainSql, "due AS (", "\nSELECT d.shop_kind"));
    expect(due).toContain(dayMath);
    expect(due).toContain(`AND i.status = 'open' AND i."dueAt" IS NOT NULL`);
    expect(due).toContain(`WHERE r.enabled = true`);
    expect(due).toContain(`EXTRACT(HOUR FROM (NOW() AT TIME ZONE s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18`);
    expect(mig).toContain(`EXTRACT(HOUR FROM (NOW() AT TIME ZONE s18_safe_timezone(s.timezone))) BETWEEN 9 AND 18`);
    // enqueue_eligible_* keep the remaining Part 3 gates
    expect(mainSql).toMatch(/d\.settings_on AND d\.shop_installed\s+AND d\.rule_channel = 'email'::"ReminderChannel"\s+AND NOT d\.logged\)/);
  });

  it("picks pg_cron jobs by the scheduled jobnames and never reads command or return text", () => {
    const names = ["s18_enqueue_reminders_hourly", "s10_drain_every_minute"];
    const migs = [
      "prisma/migrations/20261030000000_s18_payment_reminders/migration.sql",
      "prisma/migrations/20261024010000_s10_drain_cron/migration.sql",
    ].map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
    for (const n of names) {
      expect(migs).toMatch(new RegExp(`cron\\.schedule\\(\\s*'${n}'`));
      expect(cronSql).toContain(`'${n}'`);
    }
    expect(cronSql.replace(/^\s*\\echo .*$/gm, "")).not.toMatch(/\bcommand\b|return_message|\bdatabase\b|\busername\b|\bnodename\b/i);
    expect(cronSql).toContain("AND d.start_time > NOW() - INTERVAL '24 hours'");
    expect(run).toContain('echo "cron_reminders=skipped_no_job_run_details"');
  });

  it("section 6 reports main dev store offline Session health as booleans only", () => {
    const s6 = mainSql.slice(mainSql.indexOf("\\echo '== 6."));
    expect(s6).toContain(`WITH ${SHOP_LABELS_CTE}`);
    expect(s6).toMatch(/WHERE sl\.shop_kind = 'main';/);
    const body = stripShopLabelsCte(s6);
    expect(body).not.toMatch(/s\.id\s*=|se\.id\s*=|gid:\/\/|shopify\.com|:'[a-z_]+'/i);
    // columns exist in the real schema (prisma/schema.prisma model Session)
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const model = between(schema, "model Session {", "\n}");
    for (const c of ["shop", "isOnline", "needsReauth", "refreshToken", "refreshTokenExpires"]) {
      expect(model).toMatch(new RegExp(`^\\s+${c}\\s`, "m"));
    }
    // TIMESTAMP(3) holding UTC wall clock -> compare against NOW() AT TIME ZONE 'UTC'
    expect(body).toContain(`se."refreshTokenExpires" > (NOW() AT TIME ZONE 'UTC')`);
    // never reads the access token, its expiry or the OAuth state
    expect(body).not.toMatch(/"accessToken"|se\.expires\b|"expires"|se\.state\b|"state"/);
    // every output column of section 6 is a derived boolean
    const res = checkSql("prod-diagnostics/reminders-s6.sql", `BEGIN TRANSACTION READ ONLY;\n${s6}`);
    expect(res.violations).toEqual([]);
    expect(res.columns.every((c) => c.kind === "boolean" && c.via === "derived")).toBe(true);
    expect(res.columns.map((c) => c.column)).toEqual([
      "main_shop_row_present",
      "session_row_present",
      "needs_reauth",
      "refresh_token_present",
      "refresh_expires_in_future",
    ]);
    // a credential column is only ever read inside those booleans
    for (const c of SESSION_CREDENTIAL_COLUMNS) {
      for (const m of body.matchAll(new RegExp(`se\\."${c}"`, "g"))) {
        const line = body.slice(body.lastIndexOf("\n", m.index) + 1, body.indexOf("\n", m.index));
        expect(line).toMatch(/^\s*COALESCE\(bool_(and|or)\(.*\), false\) AS [a-z_]+,?$/);
      }
    }
  });

  it("section 2 groups by offset class; other_N / unknown rows never carry a raw offset", () => {
    const sec = mainSql.slice(mainSql.indexOf("\\echo '== 2."), mainSql.indexOf("\\echo '== 3."));
    const n = norm(sec);
    // class enum from the raw value, computed in the CTE
    expect(n).toContain(
      `CASE WHEN r."offsetDays" < 0 THEN 'before_due' WHEN r."offsetDays" = 0 THEN 'on_due' WHEN r."offsetDays" > 0 THEN 'after_due' END AS offset_class`,
    );
    // raw offset only behind the main/e2e gate, NULL (no ELSE) for everyone else
    const gated =
      `CASE WHEN d.shop_kind IN ('main', 'e2e') THEN CASE WHEN d.rule_offset::TEXT ~ '^-?[0-9]{1,4}$' THEN d.rule_offset::TEXT END END AS offset_days`;
    expect(n).toContain(gated);
    expect(n.split(gated).length).toBe(2);
    // no other read of the raw offset in the outer select, and no ELSE branch on it
    const outer = n.slice(n.indexOf("SELECT d.shop_kind"));
    expect(outer.replace(gated, "").match(/rule_offset|offsetDays/g)).toBeNull();
    expect(outer).not.toMatch(/\bELSE\b/);
    expect(n.match(/rule_offset/g)?.length).toBe(1 + 2); // CTE alias + gated CASE (cond, result)
    // grouping uses the output columns (class + gated offset), never the raw value
    expect(n).toMatch(/GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4;/);
    expect(n).not.toMatch(/GROUP BY[^;]*rule_offset/);
    // raw offsets are not a listed config_int
    expect(CONFIG_INT_COLUMNS).toEqual(["defaultTermsDays"]);
    expect(CONFIG_INT_COLUMNS).not.toContain("offset_days");
    expect(CONFIG_INT_COLUMNS).not.toContain("offsetDays");
  });

  it("uses hard-coded windows", () => {
    expect(mainSql).toContain(`COALESCE(rl."sentAt", rl."firstCappedAt") > NOW() - INTERVAL '7 days'`);
    expect(mainSql + cronSql).not.toMatch(/:'?since'?|:'?hours'?|:'?days'?|:'?window'?/);
  });

  it("prints counts, enums, booleans and cron timestamps only (readonly column guard)", () => {
    const main = checkSql("prod-diagnostics/reminders.sql", mainSql);
    expect(main.violations).toEqual([]);
    expect(main.columns.map((c) => `${c.column}:${c.kind}`)).toEqual([
      "shop_kind:enum",
      "installed:boolean",
      "reminders_enabled:boolean",
      "settings_row:boolean",
      "shops:count",
      "shop_kind:enum",
      "offset_class:enum",
      "offset_days:enum",
      "channel:enum",
      "due_today:count",
      "due_today_unpaid:count",
      "due_today_already_logged:count",
      "enqueue_eligible_today:count",
      "enqueue_eligible_now:count",
      "shop_kind:enum",
      "log_status:enum",
      "logs_7d:count",
      "logs_undated:count",
      "logs_all_time:count",
      "e2e_shop_rows:count",
      "e2e_timezone:enum",
      "e2e_effective_tz_ist:boolean",
      "e2e_in_send_window_now:boolean",
      "e2e_installed:boolean",
      "e2e_currency_inr:boolean",
      "e2e_seed_id_prefix:boolean",
      "main_shop_row_present:boolean",
      "session_row_present:boolean",
      "needs_reauth:boolean",
      "refresh_token_present:boolean",
      "refresh_expires_in_future:boolean",
    ]);
    const cron = checkSql("prod-diagnostics/reminders-cron.sql", cronSql);
    expect(cron.violations).toEqual([]);
    expect(cron.columns.map((c) => `${c.column}:${c.kind}`)).toEqual([
      "cron_job:enum",
      "active:boolean",
      "runs_24h:count",
      "succeeded_24h:count",
      "failed_24h:count",
      "other_status_24h:count",
      "last_start_utc:timestamp",
      "last_success_utc:timestamp",
    ]);
    // the only annotation is for the two cron timestamps
    expect([...(mainSql + cronSql).matchAll(/-- @col ([^\n]*)/g)].map((m) => m[1])).toEqual([
      "last_start_utc, last_success_utc: timestamp",
    ]);
  });

  const snippet = between(run, "# Split shop label secrets", "# End split shop label secrets");
  const probe = `set -euo pipefail\n${snippet}\necho "allowed=\${LABEL_ALLOWED:+set} e2e=\${LABEL_E2E:+set}"\n`;

  it.each([
    ["valid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: PLANTED_E2E }, "allowed=set e2e=set"],
    ["E2E_SHOP missing", { ALLOWED_DEV_STORE: PLANTED_ALLOWED }, "allowed=set e2e="],
    ["E2E_SHOP invalid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: `${PLANTED_E2E}/admin` }, "allowed=set e2e="],
    ["both missing", {}, "allowed= e2e="],
  ] as const)("label secrets %s -> vars (unknown labels, no failure, no domain)", (_l, env, want) => {
    const r = spawnSync("bash", ["-c", probe], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
    const visible = `${r.stdout}\n${r.stderr}`
      .split("\n")
      .filter((l) => !l.startsWith("::add-mask::"))
      .join("\n");
    expect(r.status).toBe(0);
    expect(visible.trim()).toBe(want);
    expect(visible).not.toContain("myshopify");
  });
});
