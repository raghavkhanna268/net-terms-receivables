/**
 * Tests that the prod-diagnostics workflow is read-only by default.
 *
 * Verifies:
 * - Only the explicit "Refresh expired token" step (id: refresh) can call refresh code
 * - All database steps use PGOPTIONS with default_transaction_read_only=on unless in write allowlist
 * - Token refresh only runs when refresh_if_expired input is true (exact if expression)
 * - Workflow triggers are exactly [workflow_dispatch]
 * - Write steps are gated on their own dedicated inputs
 *
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/159
 */

import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW_PATH = join(
  __dirname,
  "../../../.github/workflows/prod-diagnostics.yml"
);

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowInput {
  default?: unknown;
  type?: string;
  description?: string;
  required?: boolean;
}

type WorkflowTrigger =
  | { inputs?: Record<string, WorkflowInput> }
  | Record<string, unknown>
  | null;

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, WorkflowTrigger> | string | string[];
}

const WRITE_STEP_IDS = new Set(["refresh"]);

const WRITE_STEP_NAMES_TO_INPUT_GATES: Record<string, string> = {
  "Refresh expired token": "inputs.refresh_if_expired",
  "DLQ Redrive": "inputs.redrive_dlq",
  "Drain cron control": "inputs.drain_cron",
  "Reconcile probe": "inputs.invoke_reconcile",
};

const REFRESH_CODE_PATTERN =
  /refresh-offline-token|offline-token\.server|refreshOfflineToken/;

const EXPECTED_REFRESH_IF =
  "${{ inputs.refresh_if_expired && steps.session.outputs.token_expired == 'true' && steps.session.outputs.has_refresh_token == 'true' }}";

describe("prod-diagnostics workflow read-only mode", () => {
  let workflow: Workflow;
  let allSteps: WorkflowStep[];
  let refreshStep: WorkflowStep | undefined;
  let s12Step: WorkflowStep | undefined;

  beforeAll(() => {
    const workflowContent = readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(workflowContent) as Workflow;

    allSteps = [];
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        allSteps.push(step);
      }
    }

    refreshStep = allSteps.find((s) => s.id === "refresh");
    s12Step = allSteps.find((s) => s.id === "s12_validation");
  });

  describe("step lookup by id", () => {
    it("finds refresh step by id", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.name).toBe("Refresh expired token");
    });

    it("finds S12 Validation step by id", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.name).toBe("S12 Validation");
    });
  });

  describe("workflow triggers", () => {
    it("triggers are exactly [workflow_dispatch]", () => {
      expect(workflow.on).toBeDefined();

      const triggers = workflow.on;
      if (typeof triggers === "string") {
        expect(triggers).toBe("workflow_dispatch");
      } else if (Array.isArray(triggers)) {
        expect(triggers).toEqual(["workflow_dispatch"]);
      } else {
        const triggerKeys = Object.keys(triggers ?? {});
        expect(triggerKeys).toEqual(["workflow_dispatch"]);
      }
    });
  });

  describe("refresh_if_expired input", () => {
    it("defaults to false", () => {
      const triggers = workflow.on;
      expect(triggers).toBeDefined();
      expect(typeof triggers).toBe("object");
      expect(triggers).not.toBeNull();

      const workflowDispatch = (triggers as Record<string, WorkflowTrigger>)
        .workflow_dispatch;
      expect(workflowDispatch).toBeDefined();

      const inputs = (workflowDispatch as { inputs?: Record<string, WorkflowInput> })
        ?.inputs;
      expect(inputs).toBeDefined();
      expect(inputs?.refresh_if_expired).toBeDefined();
      expect(inputs?.refresh_if_expired.default).toBe(false);
    });
  });

  describe("refresh step if expression", () => {
    it("has exact expected if expression (string equality)", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.if).toBe(EXPECTED_REFRESH_IF);
    });

    it("contains no || (OR) in if expression", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.if).not.toContain("||");
    });

    it("contains no negation (!) in if expression", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.if).not.toMatch(/[^=]!/);
      expect(refreshStep?.if).not.toMatch(/^!/);
    });

    it("records refresh_token_used in summary when triggered", () => {
      expect(refreshStep).toBeDefined();
      expect(refreshStep?.run).toContain("GITHUB_STEP_SUMMARY");
      expect(refreshStep?.run).toContain("refresh_token_used=true");
    });
  });

  describe("refresh code isolation", () => {
    it("only step with id:refresh may reference refresh code", () => {
      for (const step of allSteps) {
        if (!step.run) continue;

        const matchesRefreshCode = REFRESH_CODE_PATTERN.test(step.run);
        if (matchesRefreshCode) {
          expect(step.id).toBe("refresh");
        }
      }
    });

    it("refresh step is the only step that references refresh code", () => {
      const stepsWithRefreshCode = allSteps.filter(
        (s) => s.run && REFRESH_CODE_PATTERN.test(s.run)
      );

      expect(stepsWithRefreshCode.length).toBeGreaterThan(0);
      expect(stepsWithRefreshCode.every((s) => s.id === "refresh")).toBe(true);
    });

    it("S12 Validation step does NOT reference refresh code", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toBeDefined();
      expect(REFRESH_CODE_PATTERN.test(s12Step!.run!)).toBe(false);
    });
  });

  describe("read-only PGOPTIONS enforcement", () => {
    it("every step with DATABASE_URL in env has read-only PGOPTIONS (unless in write allowlist)", () => {
      for (const step of allSteps) {
        const env = step.env ?? {};
        const hasDbUrl =
          env.DATABASE_URL !== undefined ||
          env.DATABASE_URL_MIGRATIONS !== undefined ||
          env.DATABASE_URL_SESSION !== undefined;

        if (!hasDbUrl) continue;
        if (WRITE_STEP_IDS.has(step.id ?? "")) continue;
        if (Object.keys(WRITE_STEP_NAMES_TO_INPUT_GATES).includes(step.name ?? "")) continue;

        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" has DATABASE_URL but missing PGOPTIONS`
        ).toBeDefined();
        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" PGOPTIONS is not read-only`
        ).toContain("default_transaction_read_only=on");
      }
    });

    it("every step with DATABASE_URL reference in run script has PGOPTIONS (unless in write allowlist)", () => {
      const dbUrlPattern = /\$DATABASE_URL|\${DATABASE_URL}|\$\{?DATABASE_URL_/;

      for (const step of allSteps) {
        if (!step.run) continue;
        if (!dbUrlPattern.test(step.run)) continue;
        if (WRITE_STEP_IDS.has(step.id ?? "")) continue;
        if (Object.keys(WRITE_STEP_NAMES_TO_INPUT_GATES).includes(step.name ?? "")) continue;

        const env = step.env ?? {};
        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" references DATABASE_URL in run but has no PGOPTIONS`
        ).toBeDefined();
        expect(
          env.PGOPTIONS,
          `Step "${step.name ?? step.id}" PGOPTIONS is not read-only`
        ).toContain("default_transaction_read_only=on");
      }
    });
  });

  describe("write steps are gated on dedicated inputs", () => {
    it("each write step has if expression gated on its dedicated input", () => {
      for (const [stepName, requiredInputGate] of Object.entries(
        WRITE_STEP_NAMES_TO_INPUT_GATES
      )) {
        const step = allSteps.find((s) => s.name === stepName);
        if (!step) continue;

        expect(
          step.if,
          `Write step "${stepName}" must have an if expression`
        ).toBeDefined();
        expect(
          step.if,
          `Write step "${stepName}" if expression must contain ${requiredInputGate}`
        ).toContain(requiredInputGate);
      }
    });
  });

  describe("S12 Validation step properties", () => {
    it("uses read-only PGOPTIONS", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.PGOPTIONS).toBe("-c default_transaction_read_only=on");
    });

    it("does not have DATABASE_URL_SESSION in env", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.DATABASE_URL_SESSION).toBeUndefined();
    });

    it("does not have SHOPIFY_API_KEY in env", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.SHOPIFY_API_KEY).toBeUndefined();
    });

    it("does not have SHOPIFY_API_SECRET in env", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.env?.SHOPIFY_API_SECRET).toBeUndefined();
    });

    it("checks TOKEN_EXPIRED and REFRESH_SUCCESS before proceeding", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toContain("TOKEN_EXPIRED");
      expect(s12Step?.run).toContain("REFRESH_SUCCESS");
    });

    it("skips with token_expired reason when token is expired", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toContain("skipping S12 Validation");
      expect(s12Step?.run).toContain('status: "skipped"');
      expect(s12Step?.run).toContain('reason: "token_expired"');
    });

    it("warns and records ensure_validation_skipped when ensure_validation=true but token expired", () => {
      expect(s12Step).toBeDefined();
      expect(s12Step?.run).toContain("ensure_validation=true but token is expired");
      expect(s12Step?.run).toContain("ensure_validation_skipped=true");
      expect(s12Step?.run).toContain("GITHUB_STEP_SUMMARY");
    });
  });
});


/**
 * Second-shop E2E mode (e2e_second_shop) and default-mode shop selection.
 * Static checks on the e2e_second_shop job, plus real bash slices run against
 * a fake `psql` (sequential canned responses) and a fake `curl`.
 */
const E2E_PLANTED_DOMAIN = "planted-e2e-secret-shop.myshopify.com";
const E2E_PLANTED_ALLOWED = "planted-allowed-dev-store.myshopify.com";
const E2E_PLANTED_NAME = "Planted Buyer Name Zyxw";
const E2E_PLANTED_EMAIL = "planted.buyer@example.invalid";

interface BashResult {
  stdout: string;
  stderr: string;
  status: number | null;
  githubEnv: string;
  githubOutput: string;
}

/**
 * Runs the bash between two marker comments of a step's `run:` script.
 * `psql` returns `psqlResponses` in order (one per call; "__FAIL__" exits 1).
 * Non-zero exits are allowed (fail-closed tests assert on them).
 */
function runE2eSnippet(
  run: string,
  startMarker: string,
  endMarker: string,
  opts: {
    env?: Record<string, string>;
    psqlResponses?: string[];
    curlBody?: string;
    curlStatus?: string;
    eventPayload?: unknown;
    suffix?: string;
  } = {}
): BashResult {
  const start = run.indexOf(startMarker);
  const end = run.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const snippet = run.slice(start, end) + (opts.suffix ?? "");

  const dir = mkdtempSync(join(tmpdir(), "diag-e2e-"));
  try {
    (opts.psqlResponses ?? []).forEach((r, i) =>
      writeFileSync(join(dir, `psql_resp_${i}`), r)
    );
    const fakePsql = join(dir, "psql");
    writeFileSync(
      fakePsql,
      [
        "#!/usr/bin/env bash",
        '[ -t 0 ] || cat > /dev/null',
        'n=$(cat "$FAKE_DIR/psql_count" 2>/dev/null || echo 0)',
        'echo $((n + 1)) > "$FAKE_DIR/psql_count"',
        'f="$FAKE_DIR/psql_resp_$n"',
        '[ -f "$f" ] || { echo "fake psql: no response $n" >&2; exit 2; }',
        'if [ "$(cat "$f")" = "__FAIL__" ]; then exit 1; fi',
        'cat "$f"',
        "",
      ].join("\n")
    );
    chmodSync(fakePsql, 0o755);
    const fakeCurl = join(dir, "curl");
    writeFileSync(
      fakeCurl,
      [
        "#!/usr/bin/env bash",
        'out=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
        'cp "$FAKE_DIR/curl_body" "$out"',
        'printf "%s" "${FAKE_CURL_STATUS:-200}"',
        "",
      ].join("\n")
    );
    chmodSync(fakeCurl, 0o755);
    writeFileSync(join(dir, "curl_body"), opts.curlBody ?? "{}");
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(opts.eventPayload ?? { inputs: {} }));
    const githubEnv = join(dir, "github_env");
    const githubOutput = join(dir, "github_output");
    writeFileSync(githubEnv, "");
    writeFileSync(githubOutput, "");
    const childEnv: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
      TMPDIR: dir,
      FAKE_CURL_STATUS: opts.curlStatus ?? "200",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_ENV: githubEnv,
      GITHUB_OUTPUT: githubOutput,
      DATABASE_URL: "postgres://fake.invalid/db",
      CURL_CONFIG: "/dev/null",
      ...(opts.env ?? {}),
    };
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-euo", "pipefail", "-c", snippet],
      {
        cwd: join(__dirname, "../../.."),
        env: childEnv as NodeJS.ProcessEnv,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      githubEnv: readFileSync(githubEnv, "utf-8"),
      githubOutput: readFileSync(githubOutput, "utf-8"),
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

function expectNoPlanted(text: string) {
  for (const planted of [
    E2E_PLANTED_DOMAIN,
    E2E_PLANTED_ALLOWED,
    E2E_PLANTED_NAME,
    E2E_PLANTED_EMAIL,
  ]) {
    expect(text).not.toContain(planted);
  }
}

describe("prod-diagnostics second-shop E2E mode", () => {
  let wf: Workflow & {
    on: { workflow_dispatch: { inputs: Record<string, WorkflowInput> } };
    jobs: Record<string, WorkflowJob & { if?: string }>;
  };
  let e2eSteps: WorkflowStep[];
  let selectStep: WorkflowStep;
  let dbStep: WorkflowStep;
  let adminStep: WorkflowStep;
  let maskStep: WorkflowStep;
  let allowedStep: WorkflowStep;

  beforeAll(() => {
    wf = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as typeof wf;
    e2eSteps = wf.jobs.e2e_second_shop?.steps ?? [];
    const byName = (steps: WorkflowStep[], name: string) => {
      const s = steps.find((x) => x.name === name);
      expect(s, name).toBeDefined();
      return s as WorkflowStep;
    };
    selectStep = byName(e2eSteps, "E2E select shop");
    dbStep = byName(e2eSteps, "E2E DB checks");
    adminStep = byName(e2eSteps, "E2E Admin checks");
    const diagSteps = wf.jobs.diagnostics?.steps ?? [];
    maskStep = byName(diagSteps, "Mask shop input");
    allowedStep = byName(diagSteps, "Installed shop vs allowed dev store");
  });

  describe("static safety", () => {
    it("e2e_second_shop is a boolean input defaulting to false", () => {
      const input = wf.on.workflow_dispatch.inputs.e2e_second_shop;
      expect(input).toBeDefined();
      expect(input.type).toBe("boolean");
      expect(input.default).toBe(false);
    });

    it("adds no shop input: the only shop-like input is the pre-existing `shop`", () => {
      const names = Object.keys(wf.on.workflow_dispatch.inputs);
      expect(names.filter((n) => /shop|domain|store/i.test(n)).sort()).toEqual(
        ["e2e_second_shop", "shop"].sort()
      );
      // The e2e job never reads any input inside its steps; it rejects a
      // `shop` input from the event payload instead.
      expect(JSON.stringify(e2eSteps)).not.toMatch(/\$\{\{[^}]*inputs\./);
      const payloadReads = (selectStep.run ?? "").match(/\.inputs\.[a-z_]+/g) ?? [];
      expect(payloadReads).toEqual([".inputs.shop"]);
      expect(selectStep.run).toContain("E2E_SHOP_INPUT_NOT_ALLOWED");
    });

    it("runs only in e2e mode, and the default diagnostics job is skipped in e2e mode", () => {
      expect(wf.jobs.e2e_second_shop.if).toBe(
        "github.ref == 'refs/heads/main' && inputs.e2e_second_shop"
      );
      expect(wf.jobs.diagnostics.if).toBe(
        "github.ref == 'refs/heads/main' && !inputs.e2e_second_shop"
      );
    });

    it("is read-only: read-only PGOPTIONS, no SQL writes, no mutations, no refresh", () => {
      const runs = e2eSteps.map((s) => s.run ?? "").join("\n");
      for (const step of e2eSteps) {
        if (step.env?.DATABASE_URL) {
          expect(step.env.PGOPTIONS, step.name).toContain(
            "default_transaction_read_only=on"
          );
        }
      }
      expect(runs).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|TRUNCATE|ALTER|DROP|CREATE|GRANT|REVOKE|COPY|VACUUM)\b/
      );
      expect(runs).not.toMatch(/mutation/i);
      expect(runs).not.toMatch(REFRESH_CODE_PATTERN);
      expect(runs).not.toMatch(/grant_type|["']refresh_token|\/oauth\/access_token/);
      expect(runs).not.toMatch(/pgmq\.(send|delete|archive|pop|read)\b|cron\.|set_config|nextval/);
      expect(runs).not.toMatch(/npm |npx |node /);
      // Only the read-only DB URL and the two shop secrets.
      const secrets = new Set<string>();
      for (const step of e2eSteps) {
        for (const v of Object.values(step.env ?? {})) {
          for (const m of String(v).matchAll(/secrets\.([A-Z0-9_]+)/g)) secrets.add(m[1]);
        }
      }
      expect([...secrets].sort()).toEqual(
        ["ALLOWED_DEV_STORE", "DATABASE_URL_MIGRATIONS", "E2E_SHOP"].sort()
      );
    });

    it("E2E_SHOP comes from a secret and is masked before anything is exported", () => {
      const run = selectStep.run ?? "";
      expect(selectStep.env?.E2E_SHOP).toBe("${{ secrets.E2E_SHOP }}");
      const mask = run.indexOf('echo "::add-mask::$E2E_SHOP"');
      expect(mask).toBeGreaterThan(-1);
      expect(mask).toBeLessThan(run.indexOf("GITHUB_ENV"));
      expect(run.indexOf('echo "::add-mask::$SELECTED"')).toBeLessThan(run.indexOf("GITHUB_ENV"));
      // Step names never carry a domain or expression.
      for (const s of e2eSteps) expect(s.name ?? "").not.toMatch(/\$\{\{|myshopify/);
    });

    it("Admin query is a read-only query against 2026-10", () => {
      const run = adminStep.run ?? "";
      expect(run).toContain("/admin/api/2026-10/graphql.json");
      expect(run).toContain("webhookSubscriptions(first: 100)");
      expect(run).toContain("credit-check-validation");
      expect(run).toContain("hide-terms-payment");
      expect(run).toContain("unset ACCESS_TOKEN");
    });
  });

  describe("E2E shop selection (fail closed)", () => {
    const START = "# E2E shop selection (domain never printed)";
    const END = "# End E2E shop selection";

    it("fails closed with E2E_SHOP_NOT_UNIQUE and only the candidate count", () => {
      const r = runE2eSnippet(selectStep.run ?? "", START, END, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: "" },
        psqlResponses: ["2"],
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("e2e_shop_select=error code=E2E_SHOP_NOT_UNIQUE candidates=2");
      expect(r.githubEnv).toBe("");
      expectNoPlanted(visible(r.stdout));
    });

    it("fails closed with E2E_SHOP_NOT_FOUND (fallback and secret)", () => {
      const a = runE2eSnippet(selectStep.run ?? "", START, END, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: "" },
        psqlResponses: ["0"],
      });
      expect(a.status).toBe(1);
      expect(a.stdout).toContain("e2e_shop_select=error code=E2E_SHOP_NOT_FOUND");
      const b = runE2eSnippet(selectStep.run ?? "", START, END, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: E2E_PLANTED_DOMAIN },
        psqlResponses: ["0"],
      });
      expect(b.status).toBe(1);
      expect(b.stdout).toContain("e2e_shop_select=error code=E2E_SHOP_NOT_FOUND");
      expectNoPlanted(visible(a.stdout + b.stdout));
    });

    it("refuses the allowed dev store, a shop input, and bad/unset secrets", () => {
      const cases: [Record<string, string>, unknown, string][] = [
        [{ ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: E2E_PLANTED_ALLOWED }, undefined, "E2E_SHOP_IS_ALLOWED_DEV_STORE"],
        [{ ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: "" }, { inputs: { shop: E2E_PLANTED_DOMAIN } }, "E2E_SHOP_INPUT_NOT_ALLOWED"],
        [{ ALLOWED_DEV_STORE: "", E2E_SHOP: "" }, undefined, "E2E_ALLOWED_DEV_STORE_UNSET"],
        [{ ALLOWED_DEV_STORE: E2E_PLANTED_NAME, E2E_SHOP: "" }, undefined, "E2E_ALLOWED_DEV_STORE_INVALID"],
        [{ ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: `${E2E_PLANTED_DOMAIN}\nx` }, undefined, "E2E_SHOP_INVALID"],
      ];
      for (const [env, eventPayload, code] of cases) {
        const r = runE2eSnippet(selectStep.run ?? "", START, END, { env, eventPayload });
        expect(r.status, code).toBe(1);
        expect(r.stdout).toContain(`e2e_shop_select=error code=${code}`);
        expect(r.githubEnv).toBe("");
        expectNoPlanted(visible(r.stdout));
      }
    });

    it("selects the single non-allowed shop, masks it, and never prints it", () => {
      const r = runE2eSnippet(selectStep.run ?? "", START, END, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: "" },
        psqlResponses: ["1", E2E_PLANTED_DOMAIN],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`::add-mask::${E2E_PLANTED_DOMAIN}`);
      expect(r.stdout).toContain("e2e_shop_source=fallback_non_allowed");
      expect(r.stdout).toContain("e2e_shop_select=ok");
      expect(r.githubEnv).toBe(`E2E_SHOP_DOMAIN=${E2E_PLANTED_DOMAIN}\n`);
      expectNoPlanted(visible(r.stdout));
    });

    it("uses the E2E_SHOP secret when set", () => {
      const r = runE2eSnippet(selectStep.run ?? "", START, END, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, E2E_SHOP: E2E_PLANTED_DOMAIN },
        psqlResponses: ["1"],
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("e2e_shop_source=secret");
      expect(r.githubEnv).toBe(`E2E_SHOP_DOMAIN=${E2E_PLANTED_DOMAIN}\n`);
      expectNoPlanted(visible(r.stdout));
    });
  });

  describe("E2E DB summary", () => {
    const START = "# E2E DB summary (allow-listed shapes only)";
    const END = "# End E2E DB summary";
    const rows = [
      "e2e_installed_shop_count|2",
      "e2e_shop_rows_for_selected|1",
      "e2e_uninstalled_at_set|false",
      "e2e_uninstalled_at|null",
      "e2e_db_currency_is_inr|true",
      "e2e_onboarding_complete|unknown",
      "e2e_offline_session_with_token|true",
      "e2e_offline_session_expires_at|2026-10-25T10:00:00Z",
      "e2e_offline_session_expired|false",
      "e2e_initial_sync_status|in_progress",
      "e2e_open_bulk_ops|1",
      "e2e_dlq_rows|0",
      `e2e_planted_value|${E2E_PLANTED_DOMAIN}`,
      `e2e_planted_name|${E2E_PLANTED_NAME}`,
      `${E2E_PLANTED_EMAIL}|1`,
      "allowed_shop_buyer_accounts|3",
      "allowed_shop_invoices|4",
    ].join("\n");

    it("prints allow-listed key=value lines and redacts anything else", () => {
      const dir = mkdtempSync(join(tmpdir(), "diag-e2e-db-"));
      try {
        const f = join(dir, "db_out");
        writeFileSync(f, rows + "\n");
        const r = runE2eSnippet(dbStep.run ?? "", START, END, { env: { DB_OUT: f } });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        for (const line of [
          "e2e_installed_shop_count=2",
          "e2e_initial_sync_status=in_progress",
          "e2e_offline_session_expires_at=2026-10-25T10:00:00Z",
          "e2e_open_bulk_ops=1",
          "e2e_dlq_rows=0",
          "e2e_onboarding_complete=unknown",
          "allowed_shop_buyer_accounts=3",
          "allowed_shop_invoices=4",
          "e2e_planted_value=invalid",
          "e2e_planted_name=invalid",
        ]) {
          expect(r.stdout.split("\n")).toContain(line);
        }
        for (const line of r.stdout.trim().split("\n")) {
          expect(line).toMatch(/^[a-z0-9_]+=[A-Za-z0-9_:-]+$/);
        }
        expectNoPlanted(r.stdout + r.githubOutput);
        expect(r.githubOutput).toBe(
          "offline_session_with_token=true\ntoken_expired=false\nuninstalled=false\n"
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("SQL emits every required key, filtered by the selected shop", () => {
      const run = dbStep.run ?? "";
      for (const key of [
        "e2e_shop_rows_for_selected",
        "e2e_uninstalled_at_set",
        "e2e_uninstalled_at",
        "e2e_session_rows",
        "e2e_offline_session_with_token",
        "e2e_offline_session_expires_at",
        "e2e_onboarding_complete",
        "e2e_initial_sync_status",
        "e2e_open_bulk_ops",
        "e2e_dlq_rows",
        "e2e_webhook_receipts_app_uninstalled",
        "allowed_shop_buyer_accounts",
        "allowed_shop_invoices",
      ]) {
        expect(run).toContain(`'${key}'`);
      }
      expect(run).toContain("FROM bulk WHERE completed_at IS NULL");
      expect(run).toContain("FROM s6_dead_letter WHERE message->>'shop' = :'shop'");
      expect(run).toContain('-v shop="$E2E_SHOP_DOMAIN"');
    });
  });

  describe("E2E Admin checks", () => {
    const GATE_START = "# E2E Admin gate";
    const GATE_END = "# End E2E Admin gate";
    const START = "# E2E Admin query and summary (counts/booleans only)";
    const END = "# End E2E Admin query and summary";
    const adminEnv = { E2E_SHOP_DOMAIN: E2E_PLANTED_DOMAIN };

    it("skips with a fixed reason instead of refreshing or using a missing token", () => {
      const cases: [Record<string, string>, string][] = [
        [{ UNINSTALLED: "true", OFFLINE_OK: "true", TOKEN_EXPIRED: "false" }, "e2e_admin=skipped_shop_uninstalled"],
        [{ UNINSTALLED: "false", OFFLINE_OK: "false", TOKEN_EXPIRED: "false" }, "e2e_admin=skipped_no_offline_session"],
        [{ UNINSTALLED: "false", OFFLINE_OK: "true", TOKEN_EXPIRED: "true" }, "e2e_admin=skipped_token_expired"],
        [{ UNINSTALLED: "false", OFFLINE_OK: "true", TOKEN_EXPIRED: "unknown" }, "e2e_admin=skipped_token_expired"],
      ];
      for (const [env, line] of cases) {
        const r = runE2eSnippet(adminStep.run ?? "", GATE_START, GATE_END, {
          env,
          suffix: "\necho REACHED_ADMIN\n",
        });
        expect(r.status).toBe(0);
        expect(r.stdout.trim()).toBe(line);
      }
      const ok = runE2eSnippet(adminStep.run ?? "", GATE_START, GATE_END, {
        env: { UNINSTALLED: "false", OFFLINE_OK: "true", TOKEN_EXPIRED: "false" },
        suffix: "\necho REACHED_ADMIN\n",
      });
      expect(ok.stdout.trim()).toBe("REACHED_ADMIN");
    });

    it("prints webhook/validation/payment counts and currency; never names, domains or ids", () => {
      const body = {
        data: {
          shop: { currencyCode: "INR", name: E2E_PLANTED_NAME, myshopifyDomain: E2E_PLANTED_DOMAIN },
          webhookSubscriptions: {
            nodes: [
              { topic: "ORDERS_CREATE", id: "gid://shopify/WebhookSubscription/111", endpoint: E2E_PLANTED_DOMAIN },
              { topic: "PRODUCTS_UPDATE" },
              { topic: E2E_PLANTED_NAME },
            ],
          },
          validations: {
            nodes: [
              { enabled: true, title: E2E_PLANTED_NAME, shopifyFunction: { handle: "credit-check-validation" } },
              { enabled: false, shopifyFunction: { handle: "credit-check-validation" } },
              { enabled: true, shopifyFunction: { handle: "other" } },
            ],
          },
          paymentCustomizations: {
            nodes: [{ enabled: true, title: E2E_PLANTED_EMAIL, shopifyFunction: { handle: "hide-terms-payment" } }],
          },
        },
      };
      const r = runE2eSnippet(adminStep.run ?? "", START, END, {
        env: adminEnv,
        curlBody: JSON.stringify(body),
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines).toEqual([
        "e2e_admin=ok",
        "e2e_currency_is_inr=true",
        "e2e_webhooks_expected=21",
        "e2e_webhooks_shop_specific_rows=3",
        "e2e_webhooks_present=1",
        "e2e_webhooks_missing=20",
        "e2e_webhooks_extra=2",
        "e2e_webhooks_match=false",
        "e2e_validation_count=2",
        "e2e_validation_enabled_count=1",
        "e2e_payment_customization_count=1",
        "e2e_payment_customization_enabled_count=1",
      ]);
      expectNoPlanted(r.stdout);
      expect(r.stdout).not.toMatch(/gid:\/\//);
    });

    it("webhooks_match is unknown when only app-specific (TOML) subscriptions exist; currency mismatch is false", () => {
      const r = runE2eSnippet(adminStep.run ?? "", START, END, {
        env: adminEnv,
        curlBody: JSON.stringify({
          data: {
            shop: { currencyCode: "USD" },
            webhookSubscriptions: { nodes: [] },
            validations: { nodes: [] },
            paymentCustomizations: { nodes: [] },
          },
        }),
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("e2e_webhooks_match=unknown");
      expect(r.stdout).toContain("e2e_webhooks_extra=0");
      expect(r.stdout).toContain("e2e_currency_is_inr=false");
      expect(r.stdout).toContain("e2e_validation_count=0");
    });

    it("soft-fails with fixed error lines", () => {
      const http = runE2eSnippet(adminStep.run ?? "", START, END, {
        env: adminEnv,
        curlBody: E2E_PLANTED_DOMAIN,
        curlStatus: "401",
      });
      expect(http.stdout).toContain("e2e_admin=error http_status=401");
      const parse = runE2eSnippet(adminStep.run ?? "", START, END, {
        env: adminEnv,
        curlBody: `not json ${E2E_PLANTED_NAME}`,
      });
      expect(parse.stdout).toContain("e2e_admin=error parse_failed");
      const gql = runE2eSnippet(adminStep.run ?? "", START, END, {
        env: adminEnv,
        curlBody: JSON.stringify({
          errors: [
            { message: E2E_PLANTED_NAME, extensions: { code: "ACCESS_DENIED" } },
            { message: "x", extensions: { code: E2E_PLANTED_DOMAIN } },
          ],
        }),
      });
      expect(gql.stdout).toContain("e2e_admin=error error_codes=ACCESS_DENIED,UNKNOWN");
      for (const r of [http, parse, gql]) {
        expect(r.status).toBe(0);
        expectNoPlanted(r.stdout);
      }
    });
  });

  describe("default mode: shop selection with more than one installed shop", () => {
    const START = "# Default shop selection (domain never printed)";
    const END = "# End default shop selection";
    const SUFFIX =
      '\nif [ "$SHOP" = "${ALLOWED_DEV_STORE:-}" ]; then echo SELECTED_ALLOWED; elif [ -n "$SHOP" ]; then echo SELECTED_OTHER; fi\n';

    it("selects ALLOWED_DEV_STORE when more than one shop is installed", () => {
      const r = runE2eSnippet(maskStep.run ?? "", START, END, {
        env: { SHOP: "", ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED },
        psqlResponses: ["2", "1"],
        suffix: SUFFIX,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("installed_shop_count=2");
      expect(r.stdout).toContain("shop_source=db_allowed_dev_store");
      expect(r.stdout).toContain("SELECTED_ALLOWED");
      expectNoPlanted(visible(r.stdout));
    });

    it("keeps the single-installed-shop behaviour", () => {
      const r = runE2eSnippet(maskStep.run ?? "", START, END, {
        env: { SHOP: "", ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED },
        psqlResponses: ["1", E2E_PLANTED_DOMAIN],
        suffix: SUFFIX,
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("shop_source=db_single_installed");
      expect(r.stdout).toContain("SELECTED_OTHER");
      expectNoPlanted(visible(r.stdout));
    });

    it("fails closed with fixed codes", () => {
      const cases: [Record<string, string>, string[], string][] = [
        [{ SHOP: "", ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED }, ["2", "0"], "ALLOWED_DEV_STORE_NOT_INSTALLED"],
        [{ SHOP: "", ALLOWED_DEV_STORE: "" }, ["2"], "ALLOWED_DEV_STORE_UNSET"],
        [{ SHOP: "", ALLOWED_DEV_STORE: E2E_PLANTED_NAME }, ["2"], "ALLOWED_DEV_STORE_INVALID"],
        [{ SHOP: "", ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED }, ["0"], "NO_INSTALLED_SHOP"],
        [{ SHOP: "", ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED }, [E2E_PLANTED_DOMAIN], "SHOP_COUNT_INVALID"],
      ];
      for (const [env, psqlResponses, code] of cases) {
        const r = runE2eSnippet(maskStep.run ?? "", START, END, { env, psqlResponses, suffix: SUFFIX });
        expect(r.status, code).toBe(1);
        expect(r.stdout).toContain(`shop_select=error code=${code}`);
        expect(r.stdout).not.toContain("SELECTED_");
        expectNoPlanted(visible(r.stdout));
      }
    });

    it("prints installed_shop_count, selected-shop boolean and guard counts", () => {
      const START2 = "# Allowed dev store summary (counts/booleans only)";
      const END2 = "# End allowed dev store summary";
      const r = runE2eSnippet(allowedStep.run ?? "", START2, END2, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, SHOP_DOMAIN: E2E_PLANTED_ALLOWED },
        psqlResponses: ["2", "true", "5|7"],
      });
      expect(r.status).toBe(0);
      expect(visible(r.stdout).trim().split("\n")).toEqual([
        "installed_shop_count=2",
        "installed_shop_is_allowed_dev_store=true",
        "allowed_shop_buyer_accounts=5",
        "allowed_shop_invoices=7",
      ]);
      const bad = runE2eSnippet(allowedStep.run ?? "", START2, END2, {
        env: { ALLOWED_DEV_STORE: E2E_PLANTED_ALLOWED, SHOP_DOMAIN: E2E_PLANTED_DOMAIN },
        psqlResponses: ["2", "false", `${E2E_PLANTED_NAME}|x`],
      });
      expect(visible(bad.stdout)).toContain("installed_shop_is_allowed_dev_store=false");
      expect(visible(bad.stdout)).toContain("allowed_shop_buyer_accounts=unknown");
      expect(visible(bad.stdout)).toContain("allowed_shop_invoices=unknown");
      expectNoPlanted(visible(r.stdout + bad.stdout));
      expect(allowedStep.run).toContain(":'shop' = :'allowed'");
    });
  });
});

/**
 * Runs a real slice of the "S12 Validation" step script (between two marker
 * comments) with bash, against fixture files. A fake `curl` on PATH serves
 * FAKE_CURL_BODY for the shopifyFunctions cross-check. Returns stdout and the
 * printed JSON objects.
 */
function runSnippet(
  run: string,
  startMarker: string,
  endMarker: string,
  env: Record<string, string>
): { stdout: string; json: Record<string, unknown>[] } {
  const start = run.indexOf(startMarker);
  const end = run.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const snippet = run.slice(start, end);

  const dir = mkdtempSync(join(tmpdir(), "diag-iq-"));
  try {
    const fakeCurl = join(dir, "curl");
    writeFileSync(
      fakeCurl,
      [
        "#!/usr/bin/env bash",
        'out=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
        'cp "$FAKE_CURL_BODY" "$out"',
        'printf "%s" "${FAKE_CURL_STATUS:-200}"',
        "",
      ].join("\n")
    );
    chmodSync(fakeCurl, 0o755);
    const files: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (k.endsWith("_JSON")) {
        const f = join(dir, `${k}.json`);
        writeFileSync(f, v);
        files[k.replace(/_JSON$/, "")] = f;
      } else {
        files[k] = v;
      }
    }
    // Minimal child env on purpose (no app secrets/config). Cast because the
    // generated worker types make some ProcessEnv keys required.
    const childEnv: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      REPO_INPUT_QUERY_HAS_CREDIT_STATUS: "true",
      CURL_CONFIG: "/dev/null",
      SHOP_DOMAIN: "example.invalid",
      ...files,
    };
    // Same flags GitHub Actions uses for `run:` (plus -u). --norc stops bash
    // sourcing /etc/bash.bashrc when it thinks stdin is a remote shell socket.
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-euo", "pipefail", "-c", snippet],
      {
        env: childEnv as NodeJS.ProcessEnv,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const stdout = result.stdout;
    // jq pretty-prints each object starting with "{" at column 0 and ending with "}".
    const json = (stdout.match(/^\{[\s\S]*?^\}$/gm) ?? []).map(
      (b) => JSON.parse(b) as Record<string, unknown>
    );
    return { stdout, json };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STATUS_START = "# Find credit-check-validation node";
const CROSS_START = "# Cross-check via shopifyFunctions";
const FIXTURES_START = "# S12 checkout fixtures (read-only)";

// Sentinel text that must never appear in any step output.
const SENTINEL = "SENTINEL_QUERY_TEXT_zq9x";

// Mirrors extensions/credit-check-validation/src/cart_validations_generate_run.graphql
// (multiline, metafield on customer and CompanyLocation).
// Built with join() rather than a `const X = \`query ...\`` literal so
// scripts/validate-graphql-schema.ts doesn't validate it as an Admin API document
// (it is a Function input query, not Admin).
const MULTILINE_DOLLAR_APP = [
  "query Input {",
  `  # ${SENTINEL}`,
  "  cart {",
  "    buyerIdentity {",
  "      customer {",
  "        metafield(",
  '          namespace: "$app"',
  '          key: "credit_status"',
  "        ) { jsonValue }",
  "      }",
  '      purchasingCompany { location { metafield(namespace: "$app", key: "credit_status") { jsonValue } } }',
  "    }",
  "  }",
  "}",
].join("\n");
const MULTILINE_APP_PREFIX = MULTILINE_DOLLAR_APP.replaceAll('"$app"', '"app--123456"');

describe("S12 Validation deployed inputQuery metrics (no text)", () => {
  let run: string;

  beforeAll(() => {
    const workflow = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
    const steps = Object.values(workflow.jobs ?? {}).flatMap((j) => j.steps ?? []);
    run = steps.find((s) => s.id === "s12_validation")?.run ?? "";
    expect(run).not.toBe("");
  });

  function validationsResponse(inputQuery: unknown, includeKey = true): string {
    const shopifyFunction: Record<string, unknown> = { handle: "credit-check-validation" };
    if (includeKey) shopifyFunction.inputQuery = inputQuery;
    return JSON.stringify({
      data: {
        validations: {
          nodes: [
            { id: "gid://shopify/Validation/1", title: "x", enabled: true, blockOnFailure: true, shopifyFunction },
          ],
        },
      },
    });
  }

  function status(inputQuery: unknown, includeKey = true) {
    const { stdout, json } = runSnippet(run, STATUS_START, CROSS_START, {
      HTTP_RESPONSE_JSON: validationsResponse(inputQuery, includeKey),
    });
    expect(json).toHaveLength(1);
    return { stdout, s: json[0] };
  }

  it("multiline query with $app: flags true, length = character count, text never printed", () => {
    const { stdout, s } = status(MULTILINE_DOLLAR_APP);
    expect(s).toMatchObject({
      deployed_input_query_has_credit_status: true,
      input_query_null: false,
      input_query_length: [...MULTILINE_DOLLAR_APP].length,
      iq_has_credit_status: true,
      iq_has_dollar_app: true,
      iq_has_app_prefix: false,
      iq_has_metafield: true,
    });
    expect(stdout).not.toContain(SENTINEL);
    expect(stdout).not.toContain("buyerIdentity");
    expect(stdout).not.toContain("metafield(");
    expect(stdout).not.toContain("jsonValue");
  });

  it("app--<digits> expanded namespace counts as credit_status", () => {
    const { stdout, s } = status(MULTILINE_APP_PREFIX);
    expect(s).toMatchObject({
      deployed_input_query_has_credit_status: true,
      input_query_null: false,
      iq_has_dollar_app: false,
      iq_has_app_prefix: true,
      iq_has_metafield: true,
      iq_has_credit_status: true,
    });
    expect(stdout).not.toContain(SENTINEL);
    expect(stdout).not.toContain("app--123456");
  });

  it("key before namespace also matches", () => {
    const { s } = status('query { cart { buyerIdentity { customer { metafield(key: "credit_status", namespace: "$app") { jsonValue } } } } }');
    expect(s.deployed_input_query_has_credit_status).toBe(true);
  });

  it("other namespace or other key does not count as credit_status", () => {
    expect(status('query { a { metafield(namespace: "custom", key: "credit_status") { jsonValue } } }').s.deployed_input_query_has_credit_status).toBe(false);
    const other = status('query { a { metafield(namespace: "$app", key: "other") { jsonValue } } }').s;
    expect(other.deployed_input_query_has_credit_status).toBe(false);
    expect(other.iq_has_dollar_app).toBe(true);
    expect(other.iq_has_metafield).toBe(true);
    expect(other.iq_has_credit_status).toBe(false);
  });

  it("null inputQuery reports credit_status as \"unknown\" and check as unavailable_api_null (not a failure)", () => {
    const { stdout, s: nul } = status(null);
    expect(nul).toMatchObject({
      input_query_null: true,
      input_query_length: 0,
      deployed_input_query_has_credit_status: "unknown",
      deployed_input_query_check: "unavailable_api_null",
    });
    expect(stdout).toContain("deployed_input_query_check=unavailable_api_null");
    expect(stdout).not.toContain("::error::");
    expect(stdout).not.toContain("::warning::");
  });

  it("empty-string inputQuery is non-null (length 0) and reports a definite false", () => {
    const empty = status("").s;
    expect(empty).toMatchObject({ input_query_null: false, input_query_length: 0, deployed_input_query_has_credit_status: false });
  });

  it("non-null inputQuery with credit_status reports has_credit_status check", () => {
    const { stdout, s } = status(MULTILINE_DOLLAR_APP);
    expect(s.deployed_input_query_has_credit_status).toBe(true);
    expect(s.deployed_input_query_check).toBe("has_credit_status");
    expect(stdout).toContain("deployed_input_query_check=has_credit_status");
  });

  it("non-null inputQuery without credit_status reports missing_credit_status check", () => {
    const { stdout, s } = status("query { cart { lines { id } } }");
    expect(s.deployed_input_query_has_credit_status).toBe(false);
    expect(s.deployed_input_query_check).toBe("missing_credit_status");
    expect(stdout).toContain("deployed_input_query_check=missing_credit_status");
  });

  it("missing inputQuery key and missing validation node both read as null => unavailable_api_null", () => {
    expect(status(undefined, false).s).toMatchObject({
      input_query_null: true,
      input_query_length: 0,
      deployed_input_query_has_credit_status: "unknown",
      deployed_input_query_check: "unavailable_api_null",
    });
    const { json } = runSnippet(run, STATUS_START, CROSS_START, {
      HTTP_RESPONSE_JSON: JSON.stringify({ data: { validations: { nodes: [] } } }),
    });
    expect(json[0]).toMatchObject({
      exists: false,
      input_query_null: true,
      input_query_length: 0,
      iq_has_metafield: false,
      deployed_input_query_has_credit_status: "unknown",
      deployed_input_query_check: "unavailable_api_null",
    });
  });

  it("status prints only booleans, integers and fixed enums under a fixed key set", () => {
    const { s } = status(MULTILINE_DOLLAR_APP);
    expect(Object.keys(s).sort()).toEqual(
      [
        "blockOnFailure",
        "deployed_input_query_check",
        "deployed_input_query_has_credit_status",
        "enabled",
        "exists",
        "input_query_length",
        "input_query_null",
        "iq_has_app_prefix",
        "iq_has_credit_status",
        "iq_has_dollar_app",
        "iq_has_metafield",
        "repo_input_query_has_credit_status",
      ].sort()
    );
    for (const [k, v] of Object.entries(s)) {
      if (k === "input_query_length") expect(Number.isInteger(v)).toBe(true);
      else if (k === "deployed_input_query_check") expect(v).toBe("has_credit_status");
      else expect(typeof v).toBe("boolean");
    }
    // Null case: the only non-booleans allowed are the fixed enums.
    const nul = status(null).s;
    for (const [k, v] of Object.entries(nul)) {
      if (k === "input_query_length") expect(v).toBe(0);
      else if (k === "deployed_input_query_has_credit_status") expect(v).toBe("unknown");
      else if (k === "deployed_input_query_check") expect(v).toBe("unavailable_api_null");
      else expect(typeof v).toBe("boolean");
    }
  });

  describe("shopifyFunctions cross-check", () => {
    function cross(body: unknown, httpStatus = "200") {
      return runSnippet(run, CROSS_START, FIXTURES_START, {
        FAKE_CURL_BODY_JSON: JSON.stringify(body),
        FAKE_CURL_STATUS: httpStatus,
      });
    }

    it("prints count, ordinal indices and per-function booleans/ints only, never GIDs, text or titles", () => {
      const { stdout, json } = cross({
        data: {
          shopifyFunctions: {
            nodes: [
              { id: "01a1681b-c9af-7830-9995-f515e3eada0b", handle: "credit-check-validation", title: `T ${SENTINEL}`, inputQuery: MULTILINE_APP_PREFIX },
              { id: "fn-2", handle: "other", inputQuery: null },
            ],
          },
        },
      });
      expect(json).toHaveLength(1);
      expect(json[0]).toEqual({
        cross_check: "ok",
        function_count: 2,
        functions: [
          {
            function_idx: 1,
            handle_is_credit_check_validation: true,
            input_query_null: false,
            input_query_length: [...MULTILINE_APP_PREFIX].length,
            has_credit_status: true,
            input_query_check: "has_credit_status",
          },
          { function_idx: 2, handle_is_credit_check_validation: false, input_query_null: true, input_query_length: 0, has_credit_status: "unknown", input_query_check: "unavailable_api_null" },
        ],
      });
      expect(stdout).not.toContain(SENTINEL);
      expect(stdout).not.toContain("metafield(");
      expect(stdout).not.toContain("01a1681b-c9af-7830-9995-f515e3eada0b");
      expect(stdout).not.toContain("fn-2");
    });

    it("per-function has_credit_status and input_query_check: null => unavailable_api_null, empty/non-matching => missing_credit_status", () => {
      const { stdout, json } = cross({
        data: {
          shopifyFunctions: {
            nodes: [
              { id: "fn-null", handle: "credit-check-validation", inputQuery: null },
              { id: "fn-missing", handle: "other" },
              { id: "fn-empty", handle: "other", inputQuery: "" },
              { id: "fn-nomatch", handle: "other", inputQuery: `query { cart { lines { id } } } # ${SENTINEL}` },
              { id: "fn-match", handle: "other", inputQuery: MULTILINE_DOLLAR_APP },
            ],
          },
        },
      });
      const fns = (json[0] as { functions: Array<Record<string, unknown>> }).functions;
      expect(fns.map((f) => [f.function_idx, f.input_query_null, f.has_credit_status, f.input_query_check])).toEqual([
        [1, true, "unknown", "unavailable_api_null"],
        [2, true, "unknown", "unavailable_api_null"],
        [3, false, false, "missing_credit_status"],
        [4, false, false, "missing_credit_status"],
        [5, false, true, "has_credit_status"],
      ]);
      expect(stdout).not.toContain(SENTINEL);
      expect(stdout).not.toContain("buyerIdentity");
      expect(stdout).not.toContain("lines {");
      expect(stdout).not.toContain("fn-null");
      expect(stdout).not.toContain("fn-match");
    });

    it("soft-fails on HTTP error and on GraphQL errors (codes only)", () => {
      expect(cross({}, "403").json[0]).toEqual({ cross_check: "error", http_status: "403" });
      const g = cross({ errors: [{ message: `secret ${SENTINEL}`, extensions: { code: "ACCESS_DENIED" } }] });
      expect(g.json[0]).toEqual({ cross_check: "error", error_codes: ["ACCESS_DENIED"] });
      expect(g.stdout).not.toContain(SENTINEL);
    });
  });
});

describe("Active subscriptions probe (counts/booleans only)", () => {
  let step: WorkflowStep | undefined;
  let run: string;
  const START = "# Active subscriptions query and summary";
  const END = "# End active subscriptions";

  beforeAll(() => {
    const workflow = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
    const steps = Object.values(workflow.jobs ?? {}).flatMap((j) => j.steps ?? []);
    step = steps.find((s) => s.id === "active_subscriptions");
    run = step?.run ?? "";
    expect(run).not.toBe("");
  });

  function probe(body: unknown, httpStatus = "200") {
    return runSnippet(run, START, END, {
      FAKE_CURL_BODY_JSON: typeof body === "string" ? body : JSON.stringify(body),
      FAKE_CURL_STATUS: httpStatus,
    }).stdout;
  }

  it("is read-only, never refreshes, and skips with skipped_token_expired", () => {
    expect(step?.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
    expect(step?.if).toBeUndefined();
    expect(run).not.toMatch(REFRESH_CODE_PATTERN);
    expect(run).not.toMatch(/mutation/);
    expect(run).toContain('[ "$TOKEN_EXPIRED" = "true" ] && [ "$REFRESH_SUCCESS" != "true" ]');
    expect(run).toContain("active_subscriptions=skipped_token_expired");
  });

  it("prints only the count and the has-name boolean, never names or statuses", () => {
    const out = probe({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { name: `Plan ${SENTINEL}`, status: "ACTIVE" },
            { name: "", status: "PENDING" },
          ],
        },
      },
    });
    expect(out).toBe("active_subscriptions_count=2\nany_subscription_has_plan_name=true\n");
    expect(out).not.toContain(SENTINEL);
    expect(out).not.toContain("ACTIVE");
    expect(out).not.toContain("PENDING");
  });

  it("empty/null names and no subscriptions report false", () => {
    expect(probe({ data: { currentAppInstallation: { activeSubscriptions: [] } } })).toBe(
      "active_subscriptions_count=0\nany_subscription_has_plan_name=false\n"
    );
    expect(
      probe({ data: { currentAppInstallation: { activeSubscriptions: [{ name: "", status: "ACTIVE" }, { name: null }] } } })
    ).toBe("active_subscriptions_count=2\nany_subscription_has_plan_name=false\n");
  });

  it("soft-fails on HTTP, GraphQL and parse errors (codes only)", () => {
    expect(probe({}, "403")).toContain("active_subscriptions=error http_status=403");
    const g = probe({ errors: [{ message: `secret ${SENTINEL}`, extensions: { code: "ACCESS_DENIED" } }] });
    expect(g).toContain("active_subscriptions=error error_codes=ACCESS_DENIED");
    expect(g).not.toContain(SENTINEL);
    expect(probe("not json")).toContain("active_subscriptions=error parse_failed");
  });
});

describe("Allowed dev store Admin checks", () => {
  let step: WorkflowStep | undefined;
  let run: string;
  let workflowText: string;

  beforeAll(() => {
    workflowText = readFileSync(WORKFLOW_PATH, "utf-8");
    const workflow = parseYaml(workflowText) as Workflow;
    const steps = Object.values(workflow.jobs ?? {}).flatMap((j) => j.steps ?? []);
    step = steps.find((s) => s.id === "allowed_admin");
    run = step?.run ?? "";
    expect(run).not.toBe("");
  });

  it("uses secrets.ALLOWED_DEV_STORE, never vars.ALLOWED_DEV_STORE (public log leak)", () => {
    expect(workflowText).not.toContain("vars.ALLOWED_DEV_STORE");
    expect(step?.env?.ALLOWED_DEV_STORE).toBe("${{ secrets.ALLOWED_DEV_STORE }}");
  });

  it("validates domain format and masks immediately", () => {
    expect(run).toContain("myshopify.com");
    expect(run).toContain("::add-mask::$ALLOWED_DEV_STORE");
    expect(run).toContain("invalid_domain_format");
  });

  it("compares shop via shell string compare using SHOP_DOMAIN from GITHUB_ENV (already masked)", () => {
    expect(run).toContain("shop_matches_allowed=");
    expect(run).toContain("SHOP_MATCHES");
    expect(run).toContain("SHOP_DOMAIN");
    expect(run).toContain("ALLOWED_DEV_STORE");
    expect(run).toContain('[ "${SHOP_DOMAIN:-}" = "$ALLOWED_DEV_STORE" ]');
    expect(step?.env?.SHOP_DOMAIN).toBeUndefined();
    expect(run).not.toContain("steps.shop");
    expect(run).not.toMatch(/echo.*\$SHOP_DOMAIN/);
  });

  it("skips with skipped_shop_mismatch when shop doesn't match allowed dev store", () => {
    expect(run).toContain("allowed_admin=skipped_shop_mismatch");
    expect(run).toContain('if [ "$SHOP_MATCHES" != "true" ]');
  });

  it("skips with skipped_token_expired when token expired and refresh didn't succeed", () => {
    expect(run).toContain("allowed_admin=skipped_token_expired");
    expect(run).toContain("TOKEN_EXPIRED");
    expect(run).toContain("REFRESH_SUCCESS");
    expect(step?.env?.TOKEN_EXPIRED).toBe("${{ steps.session.outputs.token_expired }}");
    expect(step?.env?.REFRESH_SUCCESS).toBe("${{ steps.refresh.outputs.refresh_success }}");
  });

  it("is read-only and skips gracefully on missing config", () => {
    expect(step?.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
    expect(run).toContain("allowed_admin=skipped_no_allowed_dev_store");
    expect(run).toContain("allowed_admin=skipped_no_offline_session");
    expect(run).toContain("allowed_admin=skipped_no_db");
  });

  it("queries paymentCustomizations and webhookSubscriptions", () => {
    expect(run).toContain("paymentCustomizations(first: 50)");
    expect(run).toContain("webhookSubscriptions(first: 100)");
  });

  it("outputs hide-terms-payment as booleans only", () => {
    expect(run).toContain("hide_terms_payment_present=");
    expect(run).toContain("hide_terms_payment_enabled=");
    expect(run).toContain('select(.shopifyFunction.handle == "hide-terms-payment")');
  });

  it("outputs webhook diff as counts and topic enums only, never URLs", () => {
    expect(run).toContain("webhook_expected_count=");
    expect(run).toContain("webhook_present_count=");
    expect(run).toContain("webhook_missing_count=");
    expect(run).toContain("webhook_extra_count=");
    expect(run).toContain("webhook_missing_topics=");
    expect(run).toContain("webhook_extra_topics=");
    expect(run).not.toContain(".endpoint");
    expect(run).not.toContain(".callbackUrl");
  });

  it("uses psql -X to ignore .psqlrc", () => {
    expect(run).toMatch(/psql\s+-X/);
  });
});

describe("Cron sweep diagnostics", () => {
  let step: WorkflowStep | undefined;
  let run: string;

  beforeAll(() => {
    const workflow = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
    const steps = Object.values(workflow.jobs ?? {}).flatMap((j) => j.steps ?? []);
    step = steps.find((s) => s.id === "cron_sweep");
    run = step?.run ?? "";
    expect(run).not.toBe("");
  });

  it("is read-only", () => {
    expect(step?.env?.PGOPTIONS).toContain("default_transaction_read_only=on");
  });

  it("looks up credit_status_daily_sweep by jobname, not id", () => {
    expect(run).toContain("credit_status_daily_sweep");
    expect(run).toContain("j.jobname = 'credit_status_daily_sweep'");
    expect(run).not.toMatch(/jobid\s*=\s*\d+/);
  });

  it("outputs cron job last run as timestamp, status enum and duration", () => {
    expect(run).toContain("start_time AT TIME ZONE 'UTC'");
    expect(run).toContain("jrd.status");
    expect(run).toContain("duration_sec");
    expect(run).toContain("start_time_utc");
  });

  it("outputs sweep effect counts (syncPending, holds applied/released)", () => {
    expect(run).toContain("sync_pending_current");
    expect(run).toContain("holds_applied_since_sweep");
    expect(run).toContain("holds_released_since_sweep");
    expect(run).toContain("credit_status.hold_applied");
    expect(run).toContain("credit_status.hold_released");
  });

  it("skips gracefully when cron schema or job_run_details is missing", () => {
    expect(run).toContain("cron_sweep=skipped_no_cron_schema");
    expect(run).toContain("cron_sweep=skipped_no_job_run_details");
    expect(run).toContain("cron_sweep=skipped_no_db");
  });

  it("never prints shop domains, buyer ids, or free text", () => {
    expect(run).not.toContain(".domain");
    expect(run).not.toContain("buyerAccountId");
    expect(run).not.toContain(".command");
    expect(run).not.toContain("return_message");
  });

  it("uses psql -X to ignore .psqlrc", () => {
    expect(run).toMatch(/psql\s+-X/);
  });
});

/**
 * Second-shop sync failure detail: which getInitialSyncState() condition
 * fired, per s6_bulk_operations row and per DLQ row (index + enums/counts),
 * and the Shopify-side status of each bulk op (enums only).
 */
describe("prod-diagnostics second-shop sync failure detail", () => {
  const PLANTED_GID = "gid://shopify/BulkOperation/987654321";
  const PLANTED_CUSTOMER_GID = "gid://shopify/Customer/555";
  let dbStep: WorkflowStep;
  let adminStep: WorkflowStep;

  beforeAll(() => {
    const wf = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Workflow;
    const steps = wf.jobs?.e2e_second_shop?.steps ?? [];
    dbStep = steps.find((s) => s.name === "E2E DB checks") as WorkflowStep;
    adminStep = steps.find((s) => s.name === "E2E Admin checks") as WorkflowStep;
    expect(dbStep).toBeDefined();
    expect(adminStep).toBeDefined();
  });

  function withFile<T>(content: string, fn: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "diag-e2e-detail-"));
    try {
      const f = join(dir, "f");
      writeFileSync(f, content);
      return fn(f);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  describe("DB sync detail", () => {
    const START = "# E2E sync detail summary";
    const END = "# End E2E sync detail";

    it("SQL mirrors getInitialSyncState() incl. closed_at IS NULL, and is filtered by the selected shop", () => {
      const run = dbStep.run ?? "";
      // Status mirror and detail block both ignore reinstall_reset rows.
      expect((run.match(/AND closed_at IS NULL/g) ?? []).length).toBe(4);
      expect(run).toContain("WHERE completed_at IS NULL AND closed_at IS NULL");
      expect(run).toContain("live AS (SELECT * FROM bulk WHERE closed_at IS NULL AND origin = 'reconcile')");
      expect(run).toContain("FROM s6_bulk_operations b WHERE b.shop = :'shop'");
      expect(run).toContain("WHERE r.shop = :'shop' AND r.topic = 'BULK_OPERATIONS_FINISH'");
      for (const key of [
        "e2e_sync_failure_reason",
        "e2e_sync_failed_companies_failure_count",
        "e2e_sync_failed_customers_failure_count",
        "e2e_sync_failed_orders_failure_count",
        "e2e_sync_linked_dlq_rows",
        "e2e_bulk_finish_receipts",
        "e2e_bulk_ops_closed",
        "e2e_bulk_ops_open_unclosed",
        "e2e_sync_reinstall_reset_ops",
        "e2e_sync_shop_age_min",
        "e2e_sync_shop_created_after_first_bulk_op",
        "e2e_sync_app_uninstalled_receipts",
        "e2e_sync_reinstall_evidence",
      ]) {
        expect(run).toContain(`'${key}'`);
      }
      for (const k of ["type", "origin", "stage", "open", "closed_reason", "failure_count", "age_min", "finish_receipt", "finish_msg", "closed_at"]) {
        expect(run).toContain(`'${k}'`);
      }
      for (const k of ["queue", "topic", "error_disposition", "error_code", "attempt_count", "age_min", "bulk_op", "error_class", "error_len"]) {
        expect(run).toContain(`'${k}'`);
      }
      // bulk_type x failure_count x lifecycle groups, counts only.
      expect(run).toContain("'e2e_bulk_grp_' || gt || '_fc' || gf || '_' || gs");
      for (const k of ["closed", "completed", "open"]) {
        expect(run).toContain(`'${k}'`);
      }
      // Never selects the error text, the GID or payload columns into the output.
      expect(run).not.toMatch(/'e2e_[a-z0-9_]*'\s*,\s*(d\.)?error\b/);
      expect(run).not.toMatch(/\(\d+,\s*'[a-z_0-9]+',\s*[a-z]?\.?(bulk_operation_id|error|message)\b[^>]/);
      expect(run).toContain("E2E_SYNC_DETAIL_QUERY_FAILED");
    });

    it("prints allow-listed lines and redacts GIDs, domains, names and free text", () => {
      const rows = [
        "e2e_sync_mirror_ignores_closed|true",
        "e2e_sync_failed_companies_failure_count|false",
        "e2e_sync_linked_dlq_rows|2",
        "e2e_sync_failure_reason|dlq_reconcile_orders",
        "e2e_bulk_op_1_type|companies",
        "e2e_bulk_op_1_open|true",
        "e2e_bulk_op_1_age_min|143",
        "e2e_bulk_op_1_finish_msg|none",
        "e2e_dlq_row_1_topic|RECONCILE_ORDERS",
        "e2e_dlq_row_1_error_code|graphql_error:THROTTLED",
        "e2e_dlq_row_1_attempt_count|unknown",
        "e2e_dlq_row_1_error_class|free_text",
        "e2e_dlq_row_1_error_len|212",
        "e2e_bulk_grp_orders_fc5_open|1",
        "e2e_bulk_op_1_closed_at|2026-10-26T01:02:03Z",
        "e2e_bulk_op_2_closed_at|2026-10-26 01:02:03+00",
        "e2e_sync_reinstall_evidence|true",
        `e2e_dlq_row_2_error_code|${E2E_PLANTED_DOMAIN}`,
        `e2e_dlq_row_2_topic|${E2E_PLANTED_NAME}`,
        `e2e_bulk_op_2_type|${PLANTED_GID}`,
        `e2e_dlq_row_2_queue|${E2E_PLANTED_EMAIL}`,
        `${E2E_PLANTED_DOMAIN}|1`,
        `not_an_e2e_key|1`,
      ].join("\n");
      withFile(rows + "\n", (f) => {
        const r = runE2eSnippet(dbStep.run ?? "", START, END, { env: { DETAIL_OUT: f } });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        const lines = r.stdout.trim().split("\n");
        expect(lines).toEqual([
          "e2e_sync_mirror_ignores_closed=true",
          "e2e_sync_failed_companies_failure_count=false",
          "e2e_sync_linked_dlq_rows=2",
          "e2e_sync_failure_reason=dlq_reconcile_orders",
          "e2e_bulk_op_1_type=companies",
          "e2e_bulk_op_1_open=true",
          "e2e_bulk_op_1_age_min=143",
          "e2e_bulk_op_1_finish_msg=none",
          "e2e_dlq_row_1_topic=RECONCILE_ORDERS",
          "e2e_dlq_row_1_error_code=graphql_error:THROTTLED",
          "e2e_dlq_row_1_attempt_count=unknown",
          "e2e_dlq_row_1_error_class=free_text",
          "e2e_dlq_row_1_error_len=212",
          "e2e_bulk_grp_orders_fc5_open=1",
          "e2e_bulk_op_1_closed_at=2026-10-26T01:02:03Z",
          "e2e_bulk_op_2_closed_at=invalid",
          "e2e_sync_reinstall_evidence=true",
          "e2e_dlq_row_2_error_code=invalid",
          "e2e_dlq_row_2_topic=invalid",
          "e2e_bulk_op_2_type=invalid",
          "e2e_dlq_row_2_queue=invalid",
        ]);
        expectNoPlanted(r.stdout);
        expect(r.stdout).not.toMatch(/gid:\/\//);
      });
    });

    it("rejects bare numeric ids, digit runs inside codes and money-like values", () => {
      const rows = [
        // (a) 13-digit value -> invalid; 12 digits is the cap.
        "e2e_bulk_op_1_type|7654321098765",
        "e2e_bulk_op_1_age_min|999999999999",
        // (b) ids riding inside a code or enum.
        "e2e_dlq_row_1_error_code|graphql_error:7654321098",
        "e2e_dlq_row_2_error_code|graphql_error:THROTTLED,7654321098",
        "e2e_dlq_row_3_error_code|graphql_error:A7654321098",
        "e2e_dlq_row_4_error_code|shop_7654321098",
        "e2e_dlq_row_5_topic|ORDER_7654321098765",
        "e2e_dlq_row_6_error_code|graphql_error:throttled",
        // (c) decimals / money-like.
        "e2e_bulk_op_1_age_min|12.50",
        "e2e_bulk_op_2_failure_count|1250.00",
        "e2e_bulk_op_3_failure_count|-5",
        "e2e_bulk_op_4_failure_count|1e9",
        "e2e_bulk_op_5_failure_count|5000,00",
        // Legit shapes keep validating.
        "e2e_dlq_row_7_queue|s6_bulk",
        "e2e_dlq_row_7_error_code|graphql_error:MAX_COST_EXCEEDED,THROTTLED",
        "e2e_bulk_op_6_age_min|0",
        "e2e_bulk_op_6_closed_at|2026-10-26T01:02:03Z",
        "e2e_bulk_grp_orders_fc5_closed|3",
      ].join("\n");
      withFile(rows + "\n", (f) => {
        const r = runE2eSnippet(dbStep.run ?? "", START, END, { env: { DETAIL_OUT: f } });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
        expect(r.stdout.trim().split("\n")).toEqual([
          "e2e_bulk_op_1_type=invalid",
          "e2e_bulk_op_1_age_min=999999999999",
          "e2e_dlq_row_1_error_code=invalid",
          "e2e_dlq_row_2_error_code=invalid",
          "e2e_dlq_row_3_error_code=invalid",
          "e2e_dlq_row_4_error_code=invalid",
          "e2e_dlq_row_5_topic=invalid",
          "e2e_dlq_row_6_error_code=invalid",
          "e2e_bulk_op_1_age_min=invalid",
          "e2e_bulk_op_2_failure_count=invalid",
          "e2e_bulk_op_3_failure_count=invalid",
          "e2e_bulk_op_4_failure_count=invalid",
          "e2e_bulk_op_5_failure_count=invalid",
          "e2e_dlq_row_7_queue=s6_bulk",
          "e2e_dlq_row_7_error_code=graphql_error:MAX_COST_EXCEEDED,THROTTLED",
          "e2e_bulk_op_6_age_min=0",
          "e2e_bulk_op_6_closed_at=2026-10-26T01:02:03Z",
          "e2e_bulk_grp_orders_fc5_closed=3",
        ]);
        expect(r.stdout).not.toContain("7654321098");
        expect(r.stdout).not.toMatch(/[0-9]\.[0-9]/);
      });
    });

    describe("SQL shape: no printed value selects an id, *_id or amount column", () => {
      const FORBIDDEN_COL = /^(?:[a-z_][a-z0-9_]*\.)?(?:"?id"?|[a-z0-9_]*_id|[a-z0-9_]*amount[a-z0-9_]*)$/i;
      const COMPARISON_AFTER = /^\s*(?:IN\b|NOT\s+IN\b|=|<>|!=|<|>|IS\b|LIKE\b|~)/i;
      const COMPARISON_BEFORE = /(?:\bIN|=|<>|!=|<|>|\bIS|\bLIKE|~)\s*$/i;

      /** Text between a `(` at `open` and its matching `)`. */
      function balanced(s: string, open: number): string {
        let depth = 0;
        for (let i = open; i < s.length; i++) {
          if (s[i] === "(") depth++;
          else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
        }
        throw new Error("unbalanced SQL");
      }

      /** Every `(o, 'key', <expr>)` tuple in the printed VALUES lists. */
      function valueTuples(sql: string): Array<{ key: string; expr: string }> {
        const out: Array<{ key: string; expr: string }> = [];
        const re = /\((\d+),\s*'([a-z0-9_]+)',\s*/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(sql)) !== null) {
          const body = balanced(sql, m.index);
          out.push({ key: m[2], expr: body.slice(body.indexOf(m[2]) + m[2].length + 2).trim() });
        }
        return out;
      }

      /**
       * Column references an expression can emit as a value: a forbidden column is
       * fine only as an operand of a comparison/membership test (boolean result) or
       * inside an aggregate like count(id). Subquery WHERE clauses are predicates.
       */
      function emittedForbidden(expr: string): string[] {
        let e = expr.replace(/'(?:[^']|'')*'/g, "''");
        // Aggregates collapse to a number.
        e = e.replace(/\b(count|sum|min|max|avg)\s*\([^()]*\)/gi, "0");
        // Drop WHERE/ORDER BY/GROUP BY clauses inside subqueries (predicates, not values).
        e = e.replace(/\b(WHERE|ORDER\s+BY|GROUP\s+BY)\b[^()]*(?:\([^()]*\)[^()]*)*/gi, " ");
        const hits: string[] = [];
        const ref = /(?:[a-z_][a-z0-9_]*\.)?"?[a-z_][a-z0-9_]*"?/gi;
        let m: RegExpExecArray | null;
        while ((m = ref.exec(e)) !== null) {
          const tok = m[0];
          if (!FORBIDDEN_COL.test(tok)) continue;
          if (/\(\s*$/.test(e.slice(0, m.index)) && /^\s*\(/.test(e.slice(m.index + tok.length))) continue;
          const before = e.slice(0, m.index);
          const after = e.slice(m.index + tok.length);
          if (COMPARISON_AFTER.test(after) || COMPARISON_BEFORE.test(before)) continue;
          // `x IN (SELECT id FROM ...)`: the subquery list feeds a membership test.
          if (/\bIN\s*\(\s*SELECT\s+(?:DISTINCT\s+)?$/i.test(before)) continue;
          // FROM/JOIN table names and aliases are not values.
          if (/\b(FROM|JOIN|AS)\s+$/i.test(before)) continue;
          hits.push(tok);
        }
        return hits;
      }

      function detailSql(): string {
        const run = dbStep.run ?? "";
        const start = run.indexOf("# E2E sync detail (allow-listed shapes only)");
        const end = run.indexOf("# E2E sync detail summary");
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        const block = run.slice(start, end);
        const sql = block.slice(block.indexOf("<<'EOSQL'") + 9, block.lastIndexOf("EOSQL"));
        expect(sql).toContain("SELECT k, v FROM (");
        return sql;
      }

      it("the checker flags planted id/amount selects and allows counts and comparisons", () => {
        expect(emittedForbidden("b.bulk_operation_id")).toEqual(["b.bulk_operation_id"]);
        expect(emittedForbidden("d.id::text")).toEqual(["d.id"]);
        expect(emittedForbidden("COALESCE(i.order_id, 'null')")).toEqual(["i.order_id"]);
        expect(emittedForbidden("(SELECT amount_paise FROM t LIMIT 1)::text")).toEqual(["amount_paise"]);
        expect(emittedForbidden("(SELECT b.id::text FROM bulk b WHERE b.n = 1)")).toEqual(["b.id"]);
        expect(emittedForbidden("(SELECT COUNT(id) FROM t)::text")).toEqual([]);
        expect(emittedForbidden("(b.bulk_operation_id IN (SELECT bulk_operation_id FROM ids))::text")).toEqual([]);
        expect(emittedForbidden("(d.id IN (SELECT id FROM linked))::text")).toEqual([]);
        expect(emittedForbidden(
          "COALESCE((SELECT b.n::text FROM bulk b WHERE b.bulk_operation_id = d.message->>'bulkOperationId'), 'none')",
        )).toEqual([]);
      });

      it("detail SQL: every printed value is free of id/*_id/amount columns", () => {
        const sql = detailSql();
        const tuples = valueTuples(sql);
        // scalars + bulk_rows + dlq_rows.
        expect(tuples.length).toBeGreaterThanOrEqual(19 + 13 + 11);
        const offenders = tuples
          .map((t) => ({ key: t.key, hits: emittedForbidden(t.expr) }))
          .filter((t) => t.hits.length > 0);
        expect(offenders).toEqual([]);
        // Group rows print COUNT(*) only; the final select prints k, v only.
        expect(sql).toContain("COUNT(*)::text AS v");
        expect(sql).toMatch(/SELECT k, v FROM \(\s*SELECT 1 AS g, 0 AS n, o, k, v FROM scalars/);
        expect(sql).not.toMatch(/\bamount\b/i);
      });

      it("bulk op ids query feeds only the request body file, never stdout", () => {
        const run = adminStep.run ?? "";
        expect(run).toContain('"$DATABASE_URL" > "$BULK_IDS_FILE" <<\'EOSQL\'');
        expect(run).not.toMatch(/(cat|echo|printf)[^\n]*\$BULK_IDS_FILE/);
        expect(run).not.toMatch(/(cat|echo|printf)[^\n]*\$BULK_QUERY_FILE/);
        // Printed per-row values are enums/counts/booleans keyed by row index.
        expect(run).not.toMatch(/e2e_bulk_op_\\\(\$ns\[\$i\]\)_[a-z_]*=\\\(\$op\.id/);
      });
    });
  });

  describe("Admin bulk op status", () => {
    const START = "# E2E bulk op status (enums only)";
    const END = "# End E2E bulk op status";

    function runAdmin(ids: string, curlBody: unknown, curlStatus = "200") {
      const dir = mkdtempSync(join(tmpdir(), "diag-e2e-bulk-"));
      try {
        const idsFile = join(dir, "ids");
        writeFileSync(idsFile, ids);
        const queryFile = join(dir, "query");
        writeFileSync(queryFile, "");
        const ordersQueryFile = join(dir, "orders-query");
        writeFileSync(ordersQueryFile, "");
        const resp = join(dir, "resp");
        writeFileSync(resp, "");
        const r = runE2eSnippet(adminStep.run ?? "", START, END, {
          env: {
            E2E_SHOP_DOMAIN: E2E_PLANTED_DOMAIN,
            BULK_IDS_FILE: idsFile,
            BULK_QUERY_FILE: queryFile,
            ORDERS_QUERY_FILE: ordersQueryFile,
            HTTP_RESPONSE: resp,
          },
          curlBody: typeof curlBody === "string" ? curlBody : JSON.stringify(curlBody),
          curlStatus,
        });
        return { ...r, query: readFileSync(queryFile, "utf-8"), ordersQuery: readFileSync(ordersQueryFile, "utf-8") };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("is a read-only nodes(ids:) query; ids go only in the request body file", () => {
      const run = adminStep.run ?? "";
      expect(run).toContain(
        "nodes(ids: $ids) { ... on BulkOperation { status errorCode type objectCount url partialDataUrl } }",
      );
      expect(run).toContain("ordersCount(limit: null) { count precision }");
      expect(run).toContain('--data-binary "@$BULK_QUERY_FILE"');
      expect(run).toContain("ORDER BY started_at, bulk_operation_id");
    });

    it("prints row index + status/errorCode/type enums; never the GID", () => {
      const ids = [
        "gid://shopify/BulkOperation/1",
        PLANTED_CUSTOMER_GID,
        "gid://shopify/BulkOperation/3",
        "gid://shopify/BulkOperation/4",
      ].join("\n") + "\n";
      const r = runAdmin(ids, {
        data: {
          nodes: [
            {
              status: "COMPLETED",
              errorCode: null,
              type: "QUERY",
              objectCount: "0",
              url: null,
              partialDataUrl: null,
              id: PLANTED_GID,
            },
            { status: "RUNNING", errorCode: null, type: "QUERY", objectCount: "12", url: `https://${E2E_PLANTED_DOMAIN}/x` },
            null,
          ],
        },
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "e2e_bulk_shopify_rows=4",
        "e2e_bulk_shopify_invalid_ids=1",
        "e2e_bulk_shopify=ok",
        "e2e_bulk_op_2_shopify_status=invalid_id",
        "e2e_bulk_op_1_shopify_status=COMPLETED",
        "e2e_bulk_op_1_shopify_error_code=null",
        "e2e_bulk_op_1_shopify_type=QUERY",
        "e2e_bulk_op_1_shopify_object_count=0",
        "e2e_bulk_op_1_shopify_url_present=false",
        "e2e_bulk_op_1_shopify_partial_url_present=false",
        "e2e_bulk_op_3_shopify_status=RUNNING",
        "e2e_bulk_op_3_shopify_error_code=null",
        "e2e_bulk_op_3_shopify_type=QUERY",
        "e2e_bulk_op_3_shopify_object_count=12",
        "e2e_bulk_op_3_shopify_url_present=true",
        "e2e_bulk_op_3_shopify_partial_url_present=false",
        "e2e_bulk_op_4_shopify_status=not_found",
        "e2e_bulk_shopify_running=1",
        "e2e_bulk_shopify_created=0",
        // The fake curl returns the same body for the ordersCount call.
        "e2e_shopify_orders=ok",
        "e2e_shopify_orders_count=unknown",
        "e2e_shopify_orders_count_precision=unknown",
        "e2e_shopify_orders_any=unknown",
      ]);
      // Invalid ids are never sent; valid ones only in the body file.
      const q = JSON.parse(r.query);
      expect(q.variables.ids).toEqual([
        "gid://shopify/BulkOperation/1",
        "gid://shopify/BulkOperation/3",
        "gid://shopify/BulkOperation/4",
      ]);
      expect(r.stdout).not.toMatch(/gid:\/\//);
      expectNoPlanted(r.stdout);
    });

    it("maps non-enum values to INVALID and soft-fails with fixed lines", () => {
      const ok = runAdmin("gid://shopify/BulkOperation/1\n", {
        data: { nodes: [{ status: E2E_PLANTED_NAME, errorCode: E2E_PLANTED_DOMAIN, type: "QUERY" }] },
      });
      expect(ok.stdout).toContain("e2e_bulk_op_1_shopify_status=INVALID");
      expect(ok.stdout).toContain("e2e_bulk_op_1_shopify_error_code=INVALID");
      const http = runAdmin("gid://shopify/BulkOperation/1\n", E2E_PLANTED_DOMAIN, "401");
      expect(http.stdout).toContain("e2e_bulk_shopify=error http_status=401");
      const parse = runAdmin("gid://shopify/BulkOperation/1\n", `not json ${E2E_PLANTED_NAME}`);
      expect(parse.stdout).toContain("e2e_bulk_shopify=error parse_failed");
      const gql = runAdmin("gid://shopify/BulkOperation/1\n", {
        errors: [{ message: E2E_PLANTED_NAME, extensions: { code: "THROTTLED" } }],
      });
      expect(gql.stdout).toContain("e2e_bulk_shopify=error error_codes=THROTTLED");
      const none = runAdmin("", {});
      expect(none.stdout).toContain("e2e_bulk_shopify=skipped_no_ids");
      for (const r of [ok, http, parse, gql, none]) {
        expect(r.status).toBe(0);
        expectNoPlanted(r.stdout);
        expect(r.stdout).not.toMatch(/gid:\/\//);
      }
      expect(http.stdout).toContain("e2e_shopify_orders=error http_status=401");
      expect(parse.stdout).toContain("e2e_shopify_orders=error parse_failed");
      expect(gql.stdout).toContain("e2e_shopify_orders=error error_codes=THROTTLED");
    });

    it("prints the store's order count and an any-orders boolean, nothing else", () => {
      const zero = runAdmin("", { data: { ordersCount: { count: 0, precision: "EXACT" } } });
      expect(zero.stdout.trim().split("\n")).toEqual([
        "e2e_bulk_shopify_rows=0",
        "e2e_bulk_shopify_invalid_ids=0",
        "e2e_bulk_shopify=skipped_no_ids",
        "e2e_shopify_orders=ok",
        "e2e_shopify_orders_count=0",
        "e2e_shopify_orders_count_precision=EXACT",
        "e2e_shopify_orders_any=false",
      ]);
      const some = runAdmin("", { data: { ordersCount: { count: 3, precision: E2E_PLANTED_NAME } } });
      expect(some.stdout).toContain("e2e_shopify_orders_count=3");
      expect(some.stdout).toContain("e2e_shopify_orders_count_precision=unknown");
      expect(some.stdout).toContain("e2e_shopify_orders_any=true");
      expect(JSON.parse(some.ordersQuery).query).toBe("query E2eOrdersCount { ordersCount(limit: null) { count precision } }");
      for (const r of [zero, some]) {
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
        expectNoPlanted(r.stdout);
      }
    });
  });
});
