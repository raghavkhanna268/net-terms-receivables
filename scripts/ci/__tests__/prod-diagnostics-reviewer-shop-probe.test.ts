/**
 * Tests for the read-only reviewer_shop_probe job in prod-diagnostics.yml
 * (probe_reviewer_shop=true).
 *
 * The job selects, in SQL, the single INSTALLED shop that is neither
 * ALLOWED_DEV_STORE nor E2E_SHOP, fails closed unless exactly one exists,
 * refuses a `shop` input and refresh_if_expired=true, and prints only
 * counts, enums and booleans: shop_idx=reviewer, currency=<enum>,
 * token_expired, access_scopes, scopes_count, has_read_all_orders.
 *
 * Runs the real step script end to end against a fake `psql` (backed by
 * planted Shop/Session rows it filters the way the SQL does) and a fake
 * `curl`. No prod access.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW_PATH = join(__dirname, "../../../.github/workflows/prod-diagnostics.yml");

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
  jobs: Record<string, { if?: string; steps?: WorkflowStep[] }>;
}

const ALLOWED = "planted-reviewer-allowed-store.myshopify.com";
const E2E = "planted-reviewer-e2e-store.myshopify.com";
const REVIEWER = "planted-reviewer-secret-shop.myshopify.com";
const OTHER = "planted-reviewer-other-shop.myshopify.com";
const TOKEN = "shpat_planted_reviewer_token_0123456789abcdef";
const SCOPE = "write_planted_reviewer_scope_zyxw";
const PLANTED = [ALLOWED, E2E, REVIEWER, OTHER, TOKEN, SCOPE];
const SCOPES_QUERY = '{"query":"{ currentAppInstallation { accessScopes { handle } } }"}';
const ADMIN_URL = `https://${REVIEWER}/admin/api/2026-10/graphql.json`;

/** domain | uninstalled | currency as returned by the SQL | token state | token */
type Row = [string, boolean, string, string, string];

const ALLOWED_ROW: Row = [ALLOWED, false, "INR", "false", "shpat_planted_allowed_token_aaaa"];
const E2E_ROW: Row = [E2E, false, "INR", "false", "shpat_planted_e2e_token_bbbb"];
const reviewerRow = (over: Partial<{ un: boolean; cur: string; exp: string }> = {}): Row => [
  REVIEWER,
  over.un ?? false,
  over.cur ?? "USD",
  over.exp ?? "false",
  TOKEN,
];
const BASE_ROWS: Row[] = [ALLOWED_ROW, E2E_ROW, reviewerRow()];

// Fake psql: reads the SQL from stdin and applies the same filters the real
// query names ("uninstalledAt" IS NULL, domain <> :'allowed' / :'e2e',
// shop = :'shop') to the planted rows in $FAKE_DIR/rows.
const FAKE_PSQL = [
  "#!/usr/bin/env bash",
  "declare -A V",
  "while [ $# -gt 0 ]; do",
  "  case \"$1\" in",
  "    -v) kv=\"$2\"; V[\"${kv%%=*}\"]=\"${kv#*=}\"; shift ;;",
  "  esac",
  "  shift",
  "done",
  "SQL=$(cat)",
  "printf '%s\\n---\\n' \"$SQL\" >> \"$FAKE_DIR/psql_log\"",
  "n=0; out=\"\"",
  "while IFS='|' read -r d un cur exp tok; do",
  "  [ -n \"$d\" ] || continue",
  "  if [[ \"$SQL\" == *'\"uninstalledAt\" IS NULL'* ]] && [ \"$un\" = \"true\" ]; then continue; fi",
  "  if [[ \"$SQL\" == *\"domain <> :'allowed'\"* ]] && [ \"$d\" = \"${V[allowed]:-}\" ]; then continue; fi",
  "  if [[ \"$SQL\" == *\"domain <> :'e2e'\"* ]] && [ \"$d\" = \"${V[e2e]:-}\" ]; then continue; fi",
  "  if [[ \"$SQL\" == *\"shop = :'shop'\"* ]] && [ \"$d\" != \"${V[shop]:-}\" ]; then continue; fi",
  "  n=$((n+1))",
  "  if [[ \"$SQL\" == *'SELECT \"accessToken\"'* ]]; then",
  "    [ -n \"$out\" ] || out=\"$tok\"",
  "  else",
  "    out+=\"$d|$cur|$exp\"$'\\n'",
  "  fi",
  "done < \"$FAKE_DIR/rows\"",
  "if [[ \"$SQL\" == *'COUNT(*)'* ]]; then echo \"$n\"; else printf '%s' \"$out\"; fi",
  "",
].join("\n");

const FAKE_CURL = [
  "#!/usr/bin/env bash",
  "out=\"\"",
  "while [ $# -gt 0 ]; do",
  "  case \"$1\" in",
  "    -o) out=\"$2\"; shift ;;",
  "    --data-binary) printf \"%s\" \"$2\" > \"$FAKE_DIR/curl_data\"; shift ;;",
  "    --config) cp \"$2\" \"$FAKE_DIR/curl_config\" 2>/dev/null || true; shift ;;",
  "    http*) printf \"%s\" \"$1\" > \"$FAKE_DIR/curl_url\" ;;",
  "  esac",
  "  shift",
  "done",
  "cp \"$FAKE_DIR/curl_body\" \"$out\"",
  "printf \"%s\" \"${FAKE_CURL_STATUS:-200}\"",
  "",
].join("\n");

function scopesBody(handles: unknown[]) {
  return JSON.stringify({
    data: { currentAppInstallation: { accessScopes: handles.map((h) => ({ handle: h })) } },
  });
}

function runProbe(
  run: string,
  opts: {
    rows?: Row[];
    inputs?: Record<string, unknown>;
    env?: Record<string, string>;
    curlBody?: string;
    curlStatus?: string;
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "diag-reviewer-"));
  try {
    const rows = opts.rows ?? BASE_ROWS;
    writeFileSync(join(dir, "rows"), rows.map((r) => r.join("|")).join("\n") + "\n");
    writeFileSync(join(dir, "psql"), FAKE_PSQL);
    chmodSync(join(dir, "psql"), 0o755);
    writeFileSync(join(dir, "curl"), FAKE_CURL);
    chmodSync(join(dir, "curl"), 0o755);
    writeFileSync(
      join(dir, "curl_body"),
      opts.curlBody ?? scopesBody(["read_orders", "read_all_orders", SCOPE, REVIEWER])
    );
    for (const f of ["curl_data", "curl_url", "curl_config", "psql_log"]) writeFileSync(join(dir, f), "");
    writeFileSync(
      join(dir, "event.json"),
      JSON.stringify({ inputs: { probe_reviewer_shop: true, ...(opts.inputs ?? {}) } })
    );
    const env: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
      TMPDIR: dir,
      RUNNER_TEMP: dir,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      FAKE_CURL_STATUS: opts.curlStatus ?? "200",
      DATABASE_URL: "postgres://fake.invalid/db",
      ALLOWED_DEV_STORE: ALLOWED,
      E2E_SHOP: E2E,
      ...(opts.env ?? {}),
    };
    const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", run], {
      cwd: join(__dirname, "../../.."),
      env: env as NodeJS.ProcessEnv,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      status: r.status,
      psqlLog: readFileSync(join(dir, "psql_log"), "utf-8"),
      curlData: readFileSync(join(dir, "curl_data"), "utf-8"),
      curlUrl: readFileSync(join(dir, "curl_url"), "utf-8"),
      curlConfig: readFileSync(join(dir, "curl_config"), "utf-8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Printed output minus ::add-mask:: lines (those register masks, they are not shown). */
function visible(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");
}

const ALLOWED_LINE =
  /^(reviewer_candidates=\d+|reviewer_select=(ok|error code=[A-Z0-9_]+( candidates=(\d+|changed))?)|::error::reviewer shop selection failed: [A-Z0-9_]+|=== Access scopes \(read-only\) ===|shop_idx=reviewer|currency=(INR|USD|NONE|OTHER)|token_expired=(true|false|unknown)|scopes_count=\d+|has_read_all_orders=(true|false)|access_scopes=(ok|skipped_[a-z_]+|error (http_status=\d{3}|parse_failed|error_codes=[A-Z0-9_,]+)))$/;

function expectSafe(r: { stdout: string; stderr: string }) {
  const out = visible(r.stdout) + "\n" + r.stderr;
  for (const p of PLANTED) expect(out).not.toContain(p);
  expect(out).not.toMatch(/myshopify\.com|shpat_|gid:\/\//);
  expect(out).not.toMatch(/\b(read|write|unauthenticated)_[a-z_]+\b(?!=)/);
  for (const line of visible(r.stdout).trim().split("\n")) {
    if (line === "") continue;
    expect(line).toMatch(ALLOWED_LINE);
  }
  for (const l of r.stdout.split("\n").filter((x) => x.startsWith("::add-mask::"))) {
    expect([ALLOWED, E2E, REVIEWER, TOKEN]).toContain(l.slice("::add-mask::".length));
  }
}

describe("prod-diagnostics reviewer_shop_probe", () => {
  let wf: Workflow;
  let step: WorkflowStep;
  let run: string;

  beforeAll(() => {
    wf = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
    const s = (wf.jobs.reviewer_shop_probe?.steps ?? []).find((x) => x.name === "Reviewer shop probe");
    expect(s).toBeDefined();
    step = s as WorkflowStep;
    run = step.run ?? "";
  });

  describe("static safety", () => {
    it("probe_reviewer_shop is a boolean defaulting to false; no domain or GID input exists", () => {
      const inputs = wf.on.workflow_dispatch.inputs;
      expect(inputs.probe_reviewer_shop.type).toBe("boolean");
      expect(inputs.probe_reviewer_shop.default).toBe(false);
      expect(Object.keys(inputs).filter((n) => /domain|gid/i.test(n))).toEqual([]);
    });

    it("runs only on main in reviewer mode; diagnostics and e2e jobs are skipped in reviewer mode", () => {
      expect(wf.jobs.reviewer_shop_probe.if).toBe(
        "github.ref == 'refs/heads/main' && inputs.probe_reviewer_shop"
      );
      expect(wf.jobs.diagnostics.if).toContain("!inputs.probe_reviewer_shop");
      expect(wf.jobs.e2e_second_shop.if).toContain("!inputs.probe_reviewer_shop");
    });

    it("reads no input via expressions; reads only shop and refresh_if_expired from the payload, to refuse them", () => {
      expect(JSON.stringify(wf.jobs.reviewer_shop_probe.steps)).not.toMatch(/\$\{\{[^}]*inputs\./);
      expect((run.match(/\.inputs\.[a-z_]+/g) ?? []).sort()).toEqual([
        ".inputs.refresh_if_expired",
        ".inputs.shop",
      ]);
    });

    it("is read-only: read-only PGOPTIONS, SELECT only, no mutation, no refresh, no outputs", () => {
      expect(step.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
      expect(step.env?.ALLOWED_DEV_STORE).toBe("${{ secrets.ALLOWED_DEV_STORE }}");
      expect(step.env?.E2E_SHOP).toBe("${{ secrets.E2E_SHOP }}");
      expect(run).toContain(SCOPES_QUERY);
      expect(run).toContain("unset ACCESS_TOKEN");
      expect(run).not.toMatch(/mutation/i);
      expect(run).not.toMatch(/refresh-offline-token|offline-token\.server|refreshOfflineToken|grant_type|refresh_token/i);
      expect(run).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY)\b/);
      expect(run).not.toMatch(/GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY/);
    });

    it("selects installed shops only, excluding both secrets, maps currency in SQL, never uses sort order", () => {
      const filters = run.split("\n").filter((l) => l.includes("domain <> :'allowed'"));
      expect(filters.length).toBe(2);
      for (const l of filters) {
        expect(l).toMatch(/"uninstalledAt\\?" IS NULL/);
        expect(l).toContain("domain <> :'e2e'");
      }
      expect(run).toContain("CASE WHEN s.currency = 'INR' THEN 'INR'");
      expect(run).toContain("ELSE 'OTHER' END");
      expect(run).not.toMatch(/ORDER BY s\.id|ROW_NUMBER|DENSE_RANK/);
    });

    it("never echoes the domain, the token, a secret or the raw row", () => {
      const echoes = run.split("\n").filter((l) => /^\s*echo\b/.test(l) && !l.includes("::add-mask::"));
      for (const l of echoes) {
        expect(l).not.toMatch(/\$\{?(ACCESS_TOKEN|REVIEWER_SHOP_DOMAIN|ALLOWED_DEV_STORE|E2E_SHOP|ROW)\b/);
      }
    });
  });

  describe("behaviour (fake psql/curl)", () => {
    it("happy path: prints the currency enum and scopes summary; never the domain, token or scope handle", () => {
      const r = runProbe(run);
      expect(r.status).toBe(0);
      expect(visible(r.stdout).trim().split("\n")).toEqual([
        "reviewer_candidates=1",
        "reviewer_select=ok",
        "=== Access scopes (read-only) ===",
        "shop_idx=reviewer",
        "currency=USD",
        "token_expired=false",
        "access_scopes=ok",
        "scopes_count=4",
        "has_read_all_orders=true",
      ]);
      expect(r.curlData).toBe(SCOPES_QUERY);
      expect(r.curlUrl).toBe(ADMIN_URL);
      expect(r.curlConfig).toContain(TOKEN);
      expect(r.stdout).toContain(`::add-mask::${REVIEWER}`);
      expect(r.stdout).toContain(`::add-mask::${TOKEN}`);
      expectSafe(r);
    });

    it("prints INR, NONE and OTHER enums; an unexpected value from SQL prints OTHER, never raw", () => {
      for (const [cur, expected] of [
        ["INR", "INR"],
        ["NONE", "NONE"],
        ["OTHER", "OTHER"],
        ["EUR", "OTHER"],
        [SCOPE, "OTHER"],
      ] as const) {
        const r = runProbe(run, { rows: [ALLOWED_ROW, E2E_ROW, reviewerRow({ cur })] });
        expect(r.status, cur).toBe(0);
        expect(visible(r.stdout).split("\n")).toContain(`currency=${expected}`);
        expect(visible(r.stdout)).not.toContain("EUR");
        expectSafe(r);
      }
    });

    it("NOT_FOUND: fails closed when no installed non-allowed, non-e2e shop exists", () => {
      const r = runProbe(run, { rows: [ALLOWED_ROW, E2E_ROW] });
      expect(r.status).not.toBe(0);
      expect(visible(r.stdout)).toContain("reviewer_candidates=0");
      expect(visible(r.stdout)).toContain("reviewer_select=error code=REVIEWER_SHOP_NOT_FOUND");
      expect(r.stdout).not.toMatch(/shop_idx=|currency=/);
      expect(r.curlUrl).toBe("");
      expectSafe(r);
    });

    it("NOT_FOUND: an uninstalled reviewer shop is not a candidate", () => {
      const r = runProbe(run, { rows: [ALLOWED_ROW, E2E_ROW, reviewerRow({ un: true })] });
      expect(r.status).not.toBe(0);
      expect(visible(r.stdout)).toContain("reviewer_candidates=0");
      expect(visible(r.stdout)).toContain("reviewer_select=error code=REVIEWER_SHOP_NOT_FOUND");
      expect(r.curlUrl).toBe("");
      expectSafe(r);
    });

    it("NOT_UNIQUE: fails closed with two installed candidates", () => {
      const r = runProbe(run, {
        rows: [...BASE_ROWS, [OTHER, false, "INR", "false", "shpat_planted_other_cccc"]],
      });
      expect(r.status).not.toBe(0);
      expect(visible(r.stdout)).toContain("reviewer_candidates=2");
      expect(visible(r.stdout)).toContain("reviewer_select=error code=REVIEWER_SHOP_NOT_UNIQUE candidates=2");
      expect(r.stdout).not.toMatch(/shop_idx=|currency=/);
      expect(r.curlUrl).toBe("");
      expectSafe(r);
    });

    it("counts installed shops only: an extra uninstalled shop does not make it non-unique", () => {
      const r = runProbe(run, {
        rows: [...BASE_ROWS, [OTHER, true, "INR", "false", "shpat_planted_other_cccc"]],
      });
      expect(r.status).toBe(0);
      expect(visible(r.stdout)).toContain("reviewer_candidates=1");
      expect(r.curlUrl).toBe(ADMIN_URL);
      expectSafe(r);
    });

    it("refuses refresh_if_expired=true (boolean or string) before touching the DB", () => {
      for (const v of [true, "true"]) {
        const r = runProbe(run, { inputs: { refresh_if_expired: v } });
        expect(r.status).not.toBe(0);
        expect(visible(r.stdout)).toContain("reviewer_select=error code=REVIEWER_REFRESH_NOT_ALLOWED");
        expect(r.psqlLog).toBe("");
        expect(r.curlUrl).toBe("");
        expectSafe(r);
      }
      for (const v of [false, "false"]) {
        expect(runProbe(run, { inputs: { refresh_if_expired: v } }).status).toBe(0);
      }
    });

    it("refuses a shop input before touching the DB", () => {
      const r = runProbe(run, { inputs: { shop: REVIEWER } });
      expect(r.status).not.toBe(0);
      expect(visible(r.stdout)).toContain("reviewer_select=error code=REVIEWER_SHOP_INPUT_NOT_ALLOWED");
      expect(r.psqlLog).toBe("");
      expect(r.curlUrl).toBe("");
      expectSafe(r);
    });

    it("fails closed when either secret is unset, invalid or both are equal", () => {
      const cases: [Record<string, string>, string][] = [
        [{ ALLOWED_DEV_STORE: "" }, "REVIEWER_ALLOWED_DEV_STORE_UNSET"],
        [{ E2E_SHOP: "" }, "REVIEWER_E2E_SHOP_UNSET"],
        [{ ALLOWED_DEV_STORE: "not a domain" }, "REVIEWER_ALLOWED_DEV_STORE_INVALID"],
        [{ E2E_SHOP: `${E2E}\nx` }, "REVIEWER_E2E_SHOP_INVALID"],
        [{ E2E_SHOP: ALLOWED }, "REVIEWER_SECRETS_NOT_DISTINCT"],
      ];
      for (const [env, code] of cases) {
        const r = runProbe(run, { env });
        expect(r.status, code).not.toBe(0);
        expect(visible(r.stdout)).toContain(`reviewer_select=error code=${code}`);
        expect(r.psqlLog).toBe("");
        expectSafe(r);
      }
    });

    it("never refreshes: an expired or missing token skips with a fixed reason and no Admin call", () => {
      for (const [exp, line] of [
        ["true", "access_scopes=skipped_token_expired"],
        ["unknown", "access_scopes=skipped_no_offline_session"],
      ] as const) {
        const r = runProbe(run, { rows: [ALLOWED_ROW, E2E_ROW, reviewerRow({ exp })] });
        expect(r.status).toBe(0);
        const lines = visible(r.stdout).trim().split("\n");
        expect(lines).toContain(`token_expired=${exp}`);
        expect(lines).toContain("currency=USD");
        expect(lines[lines.length - 1]).toBe(line);
        expect(r.psqlLog).not.toContain('SELECT "accessToken"');
        expect(r.curlUrl).toBe("");
        expectSafe(r);
      }
    });

    it("soft-fails Admin errors with fixed lines that never echo the response", () => {
      const http = runProbe(run, { curlBody: scopesBody([SCOPE, REVIEWER]), curlStatus: "401" });
      expect(http.stdout).toContain("access_scopes=error http_status=401");
      const parse = runProbe(run, { curlBody: `not json ${REVIEWER} ${TOKEN}` });
      expect(parse.stdout).toContain("access_scopes=error parse_failed");
      const gql = runProbe(run, {
        curlBody: JSON.stringify({ errors: [{ message: REVIEWER, extensions: { code: SCOPE } }] }),
      });
      expect(gql.stdout).toContain("access_scopes=error error_codes=UNKNOWN");
      for (const r of [http, parse, gql]) {
        expect(r.status).toBe(0);
        expect(r.stdout).not.toMatch(/scopes_count=|has_read_all_orders=/);
        expectSafe(r);
      }
    });
  });
});
