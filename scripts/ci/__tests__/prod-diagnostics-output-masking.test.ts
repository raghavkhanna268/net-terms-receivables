/**
 * Output masking tests for prod-diagnostics workflow.
 *
 * Validates that workflow output formatting never leaks:
 * - Shopify GIDs (gid://shopify/...)
 * - Bare numeric Shopify IDs (10+ digit integers)
 * - Domains (*.myshopify.com or hostname-like tokens)
 * - Money amounts (patterns like $1,234.56 or 12345 paise/cents)
 *
 * This is a fail-closed check: any match fails the test.
 * Runs against fixture data without prod access.
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

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

const ALLOWLISTED_HOSTNAMES = new Set([
  "localhost",
  "example.invalid",
  "fake.invalid",
  "github.com",
  "cursor.com",
]);

const SENSITIVE_PATTERNS = {
  shopify_gid: /gid:\/\/shopify\/[A-Za-z]+\/\d+/g,
  bare_numeric_id: /(?<![a-zA-Z0-9_.-])\d{10,}(?![a-zA-Z0-9_.-])/g,
  myshopify_domain: /[a-z0-9-]+\.myshopify\.com/gi,
  hostname_like: /(?<![a-zA-Z0-9_/.-])(?!(?:true|false|null|unknown|error|ok|skipped)\b)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|io|net|org|dev|co|app)(?![a-zA-Z0-9_.-])/gi,
  money_pattern: /\$\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:paise|cents|Paise|Cents)/g,
};

interface OutputViolation {
  pattern: string;
  match: string;
  line: string;
}

function checkOutputForViolations(output: string): OutputViolation[] {
  const violations: OutputViolation[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    if (line.startsWith("::add-mask::")) continue;
    if (line.trim() === "") continue;

    for (const [patternName, regex] of Object.entries(SENSITIVE_PATTERNS)) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(line)) !== null) {
        const matchedValue = match[0];
        if (patternName === "hostname_like" && ALLOWLISTED_HOSTNAMES.has(matchedValue.toLowerCase())) {
          continue;
        }
        if (patternName === "bare_numeric_id") {
          const context = line.slice(Math.max(0, match.index - 20), match.index + matchedValue.length + 20);
          if (/timestamp|epoch|expires|age_sec|queue_length|total_ever|count/i.test(context)) {
            continue;
          }
        }
        violations.push({
          pattern: patternName,
          match: matchedValue,
          line: line.trim().slice(0, 150),
        });
      }
    }
  }

  return violations;
}

interface BashResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runSnippet(
  snippet: string,
  opts: {
    env?: Record<string, string>;
    curlBody?: string;
    curlStatus?: string;
    psqlResponses?: string[];
  } = {}
): BashResult {
  const dir = mkdtempSync(join(tmpdir(), "diag-mask-"));
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

    const childEnv: Record<string, string> = {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_DIR: dir,
      TMPDIR: dir,
      FAKE_CURL_STATUS: opts.curlStatus ?? "200",
      CURL_CONFIG: "/dev/null",
      SHOP_DOMAIN: "example.invalid",
      DATABASE_URL: "postgres://fake.invalid/db",
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
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("prod-diagnostics output masking", () => {
  let workflow: Workflow;
  let allSteps: WorkflowStep[];
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

    s12Step = allSteps.find((s) => s.id === "s12_validation");
  });

  describe("checkout_fixtures active_validation output", () => {
    const PLANTED_VALIDATION_GID = "gid://shopify/Validation/123456789012";
    const PLANTED_FUNCTION_GID = "gid://shopify/ShopifyFunction/987654321098";
    const PLANTED_APP_GID = "gid://shopify/App/111222333444";
    const PLANTED_DOMAIN = "planted-secret-shop.myshopify.com";

    it("active_validation output contains only booleans, no GIDs", () => {
      const run = s12Step?.run ?? "";
      const START = "# Public-output safe: print only exists/enabled/blockOnFailure";
      const END = 'echo "app_version:';

      const start = run.indexOf(START);
      const end = run.indexOf(END);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const snippet = `
        HTTP_RESPONSE=$(mktemp)
        cat > "$HTTP_RESPONSE" << 'EOJSON'
{"data":{"validations":{"nodes":[{"id":"${PLANTED_VALIDATION_GID}","title":"Test","enabled":true,"blockOnFailure":false,"shopifyFunction":{"id":"${PLANTED_FUNCTION_GID}","handle":"credit-check-validation","apiType":"cart_checkout_validation","apiVersion":"2026-10","app":{"id":"${PLANTED_APP_GID}","handle":"my-app"}}}]}}}
EOJSON
        ${run.slice(start, end)}
        rm -f "$HTTP_RESPONSE"
      `;

      const result = runSnippet(snippet);
      expect(result.status).toBe(0);

      const violations = checkOutputForViolations(result.stdout);
      if (violations.length > 0) {
        const report = violations
          .map((v) => `  ${v.pattern}: "${v.match}" in line: ${v.line}`)
          .join("\n");
        expect.fail(`Found ${violations.length} sensitive output(s):\n${report}`);
      }

      expect(result.stdout).not.toContain(PLANTED_VALIDATION_GID);
      expect(result.stdout).not.toContain(PLANTED_FUNCTION_GID);
      expect(result.stdout).not.toContain(PLANTED_APP_GID);
      expect(result.stdout).not.toContain(PLANTED_DOMAIN);
      expect(result.stdout).toContain("exists");
      expect(result.stdout).toContain("enabled");
      expect(result.stdout).toContain("blockOnFailure");
      expect(result.stdout).toContain("function_handle_match");
    });
  });

  describe("checkout_fixtures fixtures output", () => {
    const PLANTED_COMPANY_LOCATION_GID = "gid://shopify/CompanyLocation/123456789012";
    const PLANTED_CUSTOMER_GID = "gid://shopify/Customer/987654321098";
    const PLANTED_BUYER_ACCOUNT_ID = "seed-account-abc123xyz";

    it("fixtures output uses ordinal indices instead of buyer_account_id, no GIDs", () => {
      const run = s12Step?.run ?? "";
      const START = "# Public-output safe: print only ordinal index, enums, booleans.";
      const END = "fixtures_summary:";

      const start = run.indexOf(START);
      const end = run.indexOf(END);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const FIXTURES = JSON.stringify({
        buyer_account_id: PLANTED_BUYER_ACCOUNT_ID,
        kind: "COMPANY_LOCATION",
        company_location_id: PLANTED_COMPANY_LOCATION_GID,
        customer_id: null,
        hold_state: "HELD",
        manual_hold: false,
        bypass: false,
        manual_hold_reason_code: "OVERDUE",
        overdue: true,
      });

      const MF_MAP = JSON.stringify({
        [PLANTED_COMPANY_LOCATION_GID]: {
          schemaVersion: 1,
          hold: true,
          currencyCode: "INR",
          holdReasonCode: "OVERDUE",
          has_limit: true,
          over_limit: false,
          updatedAt: "2026-10-25T12:00:00Z",
        },
      });

      const snippet = `
        FIXTURES='${FIXTURES}'
        MF_MAP='${MF_MAP}'
        ${run.slice(start, end).replace('printf \'%s\\n\' "$FIXTURES"', 'echo "$FIXTURES"')}
      `;

      const result = runSnippet(snippet);

      const violations = checkOutputForViolations(result.stdout);
      if (violations.length > 0) {
        const report = violations
          .map((v) => `  ${v.pattern}: "${v.match}" in line: ${v.line}`)
          .join("\n");
        expect.fail(`Found ${violations.length} sensitive output(s):\n${report}`);
      }

      expect(result.stdout).not.toContain(PLANTED_COMPANY_LOCATION_GID);
      expect(result.stdout).not.toContain(PLANTED_CUSTOMER_GID);
      expect(result.stdout).not.toContain(PLANTED_BUYER_ACCOUNT_ID);
      expect(result.stdout).toContain("fixture_idx");
      expect(result.stdout).not.toContain("buyer_account_id");
    });
  });

  describe("shopifyFunctions cross-check output", () => {
    const PLANTED_FUNCTION_GID_1 = "gid://shopify/ShopifyFunction/111222333444";
    const PLANTED_FUNCTION_GID_2 = "gid://shopify/ShopifyFunction/555666777888";
    const PLANTED_TITLE = "Secret Function Title";

    it("shopifyFunctions output uses ordinal indices instead of function IDs", () => {
      const run = s12Step?.run ?? "";
      const START = "# Cross-check via shopifyFunctions";
      const END = "# S12 checkout fixtures (read-only)";

      const start = run.indexOf(START);
      const end = run.indexOf(END);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);

      const curlBody = JSON.stringify({
        data: {
          shopifyFunctions: {
            nodes: [
              {
                id: PLANTED_FUNCTION_GID_1,
                handle: "credit-check-validation",
                title: PLANTED_TITLE,
                inputQuery: 'query { cart { buyerIdentity { customer { metafield(namespace: "$app", key: "credit_status") { jsonValue } } } } }',
              },
              {
                id: PLANTED_FUNCTION_GID_2,
                handle: "other-function",
                inputQuery: null,
              },
            ],
          },
        },
      });

      const snippet = run.slice(start, end);
      const result = runSnippet(snippet, { curlBody });

      expect(result.status).toBe(0);

      const violations = checkOutputForViolations(result.stdout);
      if (violations.length > 0) {
        const report = violations
          .map((v) => `  ${v.pattern}: "${v.match}" in line: ${v.line}`)
          .join("\n");
        expect.fail(`Found ${violations.length} sensitive output(s):\n${report}`);
      }

      expect(result.stdout).not.toContain(PLANTED_FUNCTION_GID_1);
      expect(result.stdout).not.toContain(PLANTED_FUNCTION_GID_2);
      expect(result.stdout).not.toContain(PLANTED_TITLE);
      expect(result.stdout).toContain("function_idx");
      expect(result.stdout).not.toMatch(/"id":/);
    });
  });

  describe("generic GID guard", () => {
    it("static check: workflow should not have jq output patterns that include raw .id fields", () => {
      const workflowContent = readFileSync(WORKFLOW_PATH, "utf-8");
      const lines = workflowContent.split("\n");
      const violations: { line: number; content: string }[] = [];

      const JQ_ID_OUTPUT_PATTERNS = [
        /jq[^|]*\|\s*\{[^}]*\bid:\s*\.id/i,
        /jq[^|]*\|\s*\{[^}]*validation_id:\s*\.id/i,
        /jq[^|]*\|\s*\{[^}]*function_id:\s*\.id/i,
        /jq[^|]*\|\s*\{[^}]*app_id:\s*\.id/i,
      ];

      const SAFE_LINE_PATTERNS = [
        /^\s*#/,
        /^\s*--/,
        /MF_MAP/,
        /\.id\s*!=\s*null/,
        /select\([^)]*\.id/,
        /\.id\s*\)/,
        /\{key:\s*\.id/,
      ];

      lines.forEach((line, idx) => {
        if (SAFE_LINE_PATTERNS.some((p) => p.test(line))) return;

        for (const pattern of JQ_ID_OUTPUT_PATTERNS) {
          if (pattern.test(line)) {
            violations.push({
              line: idx + 1,
              content: line.trim().slice(0, 100),
            });
            break;
          }
        }
      });

      if (violations.length > 0) {
        const report = violations
          .map((v) => `  Line ${v.line}: ${v.content}`)
          .join("\n");
        expect.fail(
          `Found ${violations.length} potential GID output pattern(s):\n${report}\n\n` +
            "Use ordinal indices (fixture_idx, function_idx) instead of .id fields."
        );
      }
    });
  });
});
