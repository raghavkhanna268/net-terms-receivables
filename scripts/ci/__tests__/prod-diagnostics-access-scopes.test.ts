/**
 * Tests for the read-only access scopes probes in prod-diagnostics.yml:
 * "Access scopes probe" (diagnostics job, shop_idx=2),
 * "E2E access scopes probe" (e2e_second_shop job, shop_idx=1) and
 * "Reviewer shop probe" (reviewer_shop_probe job, shop_idx=reviewer; its
 * selection, refusals and currency enum are covered in
 * prod-diagnostics-reviewer-shop-probe.test.ts).
 *
 * Public-repo safe: each probe prints ONLY shop_idx, a status line,
 * scopes_count=<int> and has_read_all_orders=<bool>. Never the scope handle
 * list, a shop domain or the access token.
 *
 * Runs the real bash between marker comments against a fake `psql` and a
 * fake `curl` (no prod access).
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
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  jobs: Record<string, { steps?: WorkflowStep[] }>;
}

const PLANTED_DOMAIN = "planted-scopes-secret-shop.myshopify.com";
const PLANTED_ALLOWED = "planted-scopes-allowed-store.myshopify.com";
const PLANTED_TOKEN = "shpat_planted_scopes_token_0123456789abcdef";
const PLANTED_SCOPE = "write_planted_secret_scope_zyxw";
const SCOPES_QUERY = '{"query":"{ currentAppInstallation { accessScopes { handle } } }"}';

function scopesBody(handles: unknown[]) {
  return JSON.stringify({
    data: { currentAppInstallation: { accessScopes: handles.map((h) => ({ handle: h })) } },
  });
}

function runSnippet(
  run: string,
  startMarker: string,
  endMarker: string,
  opts: {
    env?: Record<string, string>;
    psqlResponse?: string;
    curlBody?: string;
    curlStatus?: string;
  } = {}
) {
  const start = run.indexOf(startMarker);
  const end = run.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const snippet = run.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), "diag-scopes-"));
  try {
    writeFileSync(join(dir, "psql_resp"), opts.psqlResponse ?? "");
    const fakePsql = join(dir, "psql");
    writeFileSync(
      fakePsql,
      ["#!/usr/bin/env bash", "[ -t 0 ] || cat > /dev/null", 'cat "$FAKE_DIR/psql_resp"', ""].join("\n")
    );
    chmodSync(fakePsql, 0o755);
    const fakeCurl = join(dir, "curl");
    writeFileSync(
      fakeCurl,
      [
        "#!/usr/bin/env bash",
        'out=""',
        'while [ $# -gt 0 ]; do',
        '  case "$1" in',
        '    -o) out="$2"; shift ;;',
        '    --data-binary) printf "%s" "$2" > "$FAKE_DIR/curl_data"; shift ;;',
        '    --config) cp "$2" "$FAKE_DIR/curl_config" 2>/dev/null || true; shift ;;',
        "  esac",
        "  shift",
        "done",
        'cp "$FAKE_DIR/curl_body" "$out"',
        'printf "%s" "${FAKE_CURL_STATUS:-200}"',
        "",
      ].join("\n")
    );
    chmodSync(fakeCurl, 0o755);
    writeFileSync(join(dir, "curl_body"), opts.curlBody ?? "{}");
    writeFileSync(join(dir, "curl_data"), "");
    const childEnv: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
      TMPDIR: dir,
      FAKE_CURL_STATUS: opts.curlStatus ?? "200",
      DATABASE_URL: "postgres://fake.invalid/db",
      CURL_CONFIG: "/dev/null",
      ...(opts.env ?? {}),
    };
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", snippet], {
      cwd: join(__dirname, "../../.."),
      env: childEnv as NodeJS.ProcessEnv,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      curlData: readFileSync(join(dir, "curl_data"), "utf-8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Printed output minus ::add-mask:: lines (those register the mask, they are not shown). */
function visible(stdout: string): string {
  return stdout
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");
}

function expectSafe(stdout: string) {
  const out = visible(stdout);
  for (const planted of [PLANTED_DOMAIN, PLANTED_ALLOWED, PLANTED_TOKEN, PLANTED_SCOPE]) {
    expect(out).not.toContain(planted);
  }
  // No handle list: no scope-like handles (read_*/write_*/unauthenticated_*).
  expect(out).not.toMatch(/\b(read|write|unauthenticated)_[a-z_]+\b(?!=)/);
  expect(out).not.toMatch(/myshopify\.com|shpat_|gid:\/\//);
  // Only allow-listed key=value lines (plus the section header and warnings).
  for (const line of out.trim().split("\n")) {
    if (line === "" || line === "=== Access scopes (read-only) ===" || line.startsWith("::warning::")) continue;
    expect(line).toMatch(
      /^(shop_idx=(1|2|reviewer|unknown)|currency=(INR|USD|NONE|OTHER)|token_expired=(true|false|unknown)|scopes_count=\d+|has_read_all_orders=(true|false)|access_scopes=(ok|skipped_[a-z_]+|error (http_status=\d{3}|parse_failed|error_codes=[A-Z0-9_,]+)))$/
    );
  }
}

const CASES = [
  {
    label: "diagnostics job",
    job: "diagnostics",
    stepName: "Access scopes probe",
    idx: "2",
    start: "# Access scopes query and summary (counts/booleans only)",
    end: "# End access scopes query and summary",
    env: { SHOP_DOMAIN: PLANTED_DOMAIN },
  },
  {
    label: "e2e_second_shop job",
    job: "e2e_second_shop",
    stepName: "E2E access scopes probe",
    idx: "1",
    start: "# E2E access scopes query and summary (counts/booleans only)",
    end: "# End E2E access scopes query and summary",
    env: { E2E_SHOP_DOMAIN: PLANTED_DOMAIN },
  },
  {
    label: "reviewer_shop_probe job",
    job: "reviewer_shop_probe",
    stepName: "Reviewer shop probe",
    idx: "reviewer",
    start: "# Reviewer access scopes query and summary (counts/booleans only)",
    end: "# End reviewer access scopes query and summary",
    env: { REVIEWER_SHOP_DOMAIN: PLANTED_DOMAIN },
  },
] as const;

describe("prod-diagnostics access scopes probes", () => {
  let wf: Workflow;
  const steps: Record<string, WorkflowStep> = {};

  beforeAll(() => {
    wf = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
    for (const c of CASES) {
      const s = (wf.jobs[c.job]?.steps ?? []).find((x) => x.name === c.stepName);
      expect(s, c.stepName).toBeDefined();
      steps[c.job] = s as WorkflowStep;
    }
  });

  it("adds no workflow_dispatch input", () => {
    const names = Object.keys(wf.on.workflow_dispatch.inputs);
    expect(names.filter((n) => /scope/i.test(n))).toEqual([]);
    for (const c of CASES) {
      expect(JSON.stringify(steps[c.job])).not.toMatch(/\$\{\{[^}]*inputs\./);
    }
  });

  it("e2e probe runs after E2E select shop; diagnostics probe after Active subscriptions probe", () => {
    const e2eNames = (wf.jobs.e2e_second_shop.steps ?? []).map((s) => s.name);
    expect(e2eNames.indexOf("E2E access scopes probe")).toBeGreaterThan(e2eNames.indexOf("E2E select shop"));
    expect(e2eNames.indexOf("E2E access scopes probe")).toBeGreaterThan(e2eNames.indexOf("E2E DB checks"));
    const diagNames = (wf.jobs.diagnostics.steps ?? []).map((s) => s.name);
    expect(diagNames.indexOf("Access scopes probe")).toBe(diagNames.indexOf("Active subscriptions probe") + 1);
  });

  for (const c of CASES) {
    describe(c.label, () => {
      it("is read-only: read-only PGOPTIONS, query only, no mutation or refresh", () => {
        const s = steps[c.job];
        expect(s.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
        const run = s.run ?? "";
        expect(run).toContain(SCOPES_QUERY);
        expect(run).toContain("/admin/api/2026-10/graphql.json");
        expect(run).toContain("unset ACCESS_TOKEN");
        expect(run).toContain('echo "::add-mask::$ACCESS_TOKEN"');
        expect(run).not.toMatch(/mutation/i);
        expect(run).not.toMatch(/refresh-offline-token|offline-token\.server|refreshOfflineToken|grant_type/);
        expect(run).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY)\b/);
        // Never echoes the handles, the domain or the token.
        const echoes = run.split("\n").filter((l) => /^\s*echo\b/.test(l) && !l.includes("::add-mask::"));
        for (const l of echoes) {
          expect(l).not.toMatch(/\$\{?(ACCESS_TOKEN|SHOP_DOMAIN|E2E_SHOP_DOMAIN|REVIEWER_SHOP_DOMAIN|ALLOWED_DEV_STORE|E2E_SHOP)\b/);
        }
        expect(run).not.toMatch(/join\(",\s*"\)[^\n]*handle|handle[^\n]*join\(/);
        expect(run).toContain(`echo "shop_idx=${c.idx}"`);
      });

      it("prints only status, scopes_count and has_read_all_orders; never handles, domain or token", () => {
        const r = runSnippet(steps[c.job].run ?? "", c.start, c.end, {
          env: c.env,
          curlBody: scopesBody(["read_orders", "read_all_orders", PLANTED_SCOPE, PLANTED_DOMAIN, 42, null]),
        });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        expect(r.stdout.trim().split("\n")).toEqual([
          "access_scopes=ok",
          "scopes_count=4",
          "has_read_all_orders=true",
        ]);
        expect(r.curlData).toBe(SCOPES_QUERY);
        expectSafe(r.stdout);
      });

      it("has_read_all_orders=false when the scope is absent or the list is empty", () => {
        const absent = runSnippet(steps[c.job].run ?? "", c.start, c.end, {
          env: c.env,
          curlBody: scopesBody(["read_orders", "read_all_orders_x", PLANTED_SCOPE]),
        });
        expect(absent.stdout.trim().split("\n")).toEqual([
          "access_scopes=ok",
          "scopes_count=3",
          "has_read_all_orders=false",
        ]);
        const empty = runSnippet(steps[c.job].run ?? "", c.start, c.end, {
          env: c.env,
          curlBody: JSON.stringify({ data: { currentAppInstallation: null } }),
        });
        expect(empty.stdout.trim().split("\n")).toEqual([
          "access_scopes=ok",
          "scopes_count=0",
          "has_read_all_orders=false",
        ]);
        for (const r of [absent, empty]) {
          expect(r.status).toBe(0);
          expectSafe(r.stdout);
        }
      });

      it("soft-fails with fixed error lines that never echo the response", () => {
        const http = runSnippet(steps[c.job].run ?? "", c.start, c.end, {
          env: c.env,
          curlBody: scopesBody([PLANTED_SCOPE, PLANTED_DOMAIN]),
          curlStatus: "401",
        });
        expect(http.stdout).toContain("access_scopes=error http_status=401");
        const parse = runSnippet(steps[c.job].run ?? "", c.start, c.end, {
          env: c.env,
          curlBody: `not json ${PLANTED_DOMAIN} ${PLANTED_TOKEN}`,
        });
        expect(parse.stdout).toContain("access_scopes=error parse_failed");
        const gql = runSnippet(steps[c.job].run ?? "", c.start, c.end, {
          env: c.env,
          curlBody: JSON.stringify({
            errors: [
              { message: PLANTED_DOMAIN, extensions: { code: "ACCESS_DENIED" } },
              { message: PLANTED_SCOPE, extensions: { code: PLANTED_SCOPE } },
            ],
          }),
        });
        expect(gql.stdout).toContain("access_scopes=error error_codes=ACCESS_DENIED,UNKNOWN");
        for (const r of [http, parse, gql]) {
          expect(r.status).toBe(0);
          expect(r.stdout).not.toMatch(/scopes_count=|has_read_all_orders=/);
          expectSafe(r.stdout);
        }
      });
    });
  }

  it("diagnostics probe prints shop_idx=2 only when the selected shop is the allowed dev store", () => {
    const run = steps.diagnostics.run ?? "";
    const START = "# Access scopes shop index";
    const END = "# End access scopes shop index";
    const match = runSnippet(run, START, END, {
      env: { SHOP_DOMAIN: PLANTED_ALLOWED, ALLOWED_DEV_STORE: PLANTED_ALLOWED },
    });
    expect(match.stdout.trim()).toBe("shop_idx=2");
    const other = runSnippet(run, START, END, {
      env: { SHOP_DOMAIN: PLANTED_DOMAIN, ALLOWED_DEV_STORE: PLANTED_ALLOWED },
    });
    expect(other.stdout.trim()).toBe("shop_idx=unknown");
    const unset = runSnippet(run, START, END, { env: { SHOP_DOMAIN: PLANTED_DOMAIN } });
    expect(unset.stdout.trim()).toBe("shop_idx=unknown");
    for (const r of [match, other, unset]) {
      expect(r.status).toBe(0);
      expectSafe(r.stdout);
    }
  });

  it("e2e probe gate skips with a fixed reason and never reaches the token", () => {
    const run = steps.e2e_second_shop.run ?? "";
    const cases: [Record<string, string>, string][] = [
      [{ UNINSTALLED: "true", OFFLINE_OK: "true", TOKEN_EXPIRED: "false" }, "access_scopes=skipped_shop_uninstalled"],
      [{ UNINSTALLED: "false", OFFLINE_OK: "false", TOKEN_EXPIRED: "false" }, "access_scopes=skipped_no_offline_session"],
      [{ UNINSTALLED: "false", OFFLINE_OK: "true", TOKEN_EXPIRED: "true" }, "access_scopes=skipped_token_expired"],
      [{ UNINSTALLED: "false", OFFLINE_OK: "true", TOKEN_EXPIRED: "unknown" }, "access_scopes=skipped_token_expired"],
    ];
    for (const [env, line] of cases) {
      const r = runSnippet(run, "# E2E access scopes gate", "# End E2E access scopes gate", { env });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(line);
    }
  });
});
