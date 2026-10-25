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
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", snippet], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        REPO_INPUT_QUERY_HAS_CREDIT_STATUS: "true",
        CURL_CONFIG: "/dev/null",
        SHOP_DOMAIN: "example.invalid",
        ...files,
      },
      encoding: "utf-8",
    });
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

  it("null is distinguished from empty string", () => {
    const nul = status(null).s;
    expect(nul).toMatchObject({ input_query_null: true, input_query_length: 0, deployed_input_query_has_credit_status: false });
    const empty = status("").s;
    expect(empty).toMatchObject({ input_query_null: false, input_query_length: 0, deployed_input_query_has_credit_status: false });
  });

  it("missing inputQuery key and missing validation node both read as null", () => {
    expect(status(undefined, false).s).toMatchObject({ input_query_null: true, input_query_length: 0 });
    const { json } = runSnippet(run, STATUS_START, CROSS_START, {
      HTTP_RESPONSE_JSON: JSON.stringify({ data: { validations: { nodes: [] } } }),
    });
    expect(json[0]).toMatchObject({ exists: false, input_query_null: true, input_query_length: 0, iq_has_metafield: false });
  });

  it("status prints only booleans and integers under a fixed key set", () => {
    const { s } = status(MULTILINE_DOLLAR_APP);
    expect(Object.keys(s).sort()).toEqual(
      [
        "blockOnFailure",
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

    it("prints count, ids and per-function booleans/ints only, never text or titles", () => {
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
            id: "01a1681b-c9af-7830-9995-f515e3eada0b",
            handle_is_credit_check_validation: true,
            input_query_null: false,
            input_query_length: [...MULTILINE_APP_PREFIX].length,
            has_credit_status: true,
          },
          { id: "fn-2", handle_is_credit_check_validation: false, input_query_null: true, input_query_length: 0, has_credit_status: false },
        ],
      });
      expect(stdout).not.toContain(SENTINEL);
      expect(stdout).not.toContain("metafield(");
    });

    it("soft-fails on HTTP error and on GraphQL errors (codes only)", () => {
      expect(cross({}, "403").json[0]).toEqual({ cross_check: "error", http_status: "403" });
      const g = cross({ errors: [{ message: `secret ${SENTINEL}`, extensions: { code: "ACCESS_DENIED" } }] });
      expect(g.json[0]).toEqual({ cross_check: "error", error_codes: ["ACCESS_DENIED"] });
      expect(g.stdout).not.toContain(SENTINEL);
    });
  });
});
