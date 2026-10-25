/**
 * Tests that the prod-bulk-count workflow is read-only and counts-only.
 *
 * Verifies:
 * - Triggers are exactly [workflow_dispatch], main-only job guard
 * - The only input is a fixed choice of committed query names (no free text)
 * - No GraphQL write operation other than the committed bulkOperationRunQuery
 *   wrapper can be sent: the workflow, its jq filter and guard script contain
 *   no other write operation or write-style field name
 * - The runtime guard refuses (code=QUERY_NOT_READONLY) on any committed file
 *   that is not the fixed wrapper around a read of the expected connection
 * - No token refresh code and no write DB access
 * - The committed query is byte-identical to S8 PR-B's text (sha256 pinned)
 * - The jq reducer prints only name=<int> lines with correct counts and never
 *   leaks a planted name, amount or id from a fixture JSONL
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(__dirname, "../../..");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/prod-bulk-count.yml");
const QUERY_PATH = join(ROOT, "scripts/readonly/bulk/s8-draft-orders.graphql");
const JQ_PATH = join(ROOT, "scripts/ci/bulk-count/s8-draft-orders.jq");
const GUARD_PATH = join(ROOT, "scripts/ci/bulk-count/guard_query.py");
const FIXTURE_PATH = join(__dirname, "fixtures/bulk-count/s8-draft-orders.jsonl");

/** sha256 of S8 PR-B's /workspace/s8-bulk-draft-orders-query.graphql. */
const S8_DRAFT_ORDERS_SHA256 =
  "5d0c8432af47449714d161932d840fa3f5b3329e445bae5ae028db52b9c033e7";

/** The one write document shape allowed, whitespace-normalized. */
const FIXED_WRAPPER =
  "mutation BulkDraftOrdersExport{bulkOperationRunQuery(query:@Q@){bulkOperation{id status url}userErrors{field message}}}";

/** Lines of guard_query.py allowed to contain the word "mutation". */
const GUARD_MUTATION_LINES_ALLOWLIST = [
  '    r"\\Amutation [A-Za-z_][A-Za-z0-9_]*\\{bulkOperationRunQuery\\(query:@Q@\\)"',
  'FORBIDDEN_INNER_RE = re.compile(r"\\b(mutation|subscription|fragment)\\b", re.IGNORECASE)',
];

/** Shopify Admin write-field naming (camelCase noun + verb suffix). */
const WRITE_FIELD_RE =
  /\b[a-z][a-zA-Z0-9]*(Create|Update|Delete|Set|Cancel|Remove|Add|Enable|Disable|Activate|Deactivate|Upsert|Assign|Unassign|Send|Complete|Calculate|Duplicate|Archive|Unarchive|Publish|Unpublish|Revoke|Grant|Approve|Close|Open|Capture|Refund|Register|Reorder|Replace|Import|Run[A-Z][a-zA-Z]*)\b/g;
// totalPriceSet is a read field (MoneyBag) that only looks write-like.
const ALLOWED_WRITE_FIELDS = new Set(["bulkOperationRunQuery", "totalPriceSet"]);

const PLANTED = [
  "Zebulon",
  "Plantedname",
  "PLANTED",
  "98765.43",
  "12345.67",
  "55555.55",
  "990000000001",
  "880000000001",
  "660000000001",
  "770000000001",
  "gid://",
  "INR",
  "Net 30",
];

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  if?: string;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
}

interface WorkflowInput {
  default?: unknown;
  type?: string;
  options?: string[];
  required?: boolean;
}

interface Workflow {
  on?: Record<string, { inputs?: Record<string, WorkflowInput> } | null> | string | string[];
  jobs?: Record<string, WorkflowJob>;
}

function stripShellComments(script: string): string {
  return script
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

function runGuard(content: string, expected = "draftOrders"): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "bulk-guard-"));
  try {
    const file = join(dir, "q.graphql");
    writeFileSync(file, content);
    const r = spawnSync("python3", [GUARD_PATH, file, expected], { encoding: "utf-8" });
    return { status: r.status, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runJq(input: string): { status: number | null; stdout: string } {
  const r = spawnSync("jq", ["-n", "-r", "-f", JQ_PATH], { input, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout };
}

describe("prod-bulk-count workflow", () => {
  let raw: string;
  let workflow: Workflow;
  let job: WorkflowJob;
  let steps: WorkflowStep[];
  let script: string;
  const queryText = readFileSync(QUERY_PATH, "utf-8");

  beforeAll(() => {
    raw = readFileSync(WORKFLOW_PATH, "utf-8");
    workflow = parseYaml(raw) as Workflow;
    const jobs = Object.values(workflow.jobs ?? {});
    expect(jobs).toHaveLength(1);
    job = jobs[0];
    steps = job.steps ?? [];
    script = steps.map((s) => s.run ?? "").join("\n");
  });

  describe("trigger and guards", () => {
    it("triggers are exactly [workflow_dispatch]", () => {
      expect(typeof workflow.on).toBe("object");
      expect(Object.keys(workflow.on as object)).toEqual(["workflow_dispatch"]);
    });

    it("job runs only from main", () => {
      expect(job.if).toBe("github.ref == 'refs/heads/main'");
    });

    it("has a timeout of at most 15 minutes", () => {
      expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
    });

    it("only input is a fixed choice of committed query names", () => {
      const on = workflow.on as Record<string, { inputs?: Record<string, WorkflowInput> }>;
      const inputs = on.workflow_dispatch?.inputs ?? {};
      expect(Object.keys(inputs)).toEqual(["query"]);
      expect(inputs.query.type).toBe("choice");
      expect(inputs.query.options).toEqual(["s8-draft-orders"]);
    });

    it("every choice option maps to a committed query file in the case map", () => {
      const on = workflow.on as Record<string, { inputs?: Record<string, WorkflowInput> }>;
      for (const opt of on.workflow_dispatch?.inputs?.query.options ?? []) {
        expect(script).toContain(`${opt})`);
        expect(script).toContain(`QUERY_FILE=scripts/readonly/bulk/${opt}.graphql`);
        expect(() => readFileSync(join(ROOT, `scripts/readonly/bulk/${opt}.graphql`))).not.toThrow();
      }
      expect(script).toMatch(/\*\)\s*\n\s*echo "bulk_count=refused code=UNKNOWN_QUERY"/);
    });

    it("never expands inputs.* inside run scripts", () => {
      expect(script).not.toMatch(/\$\{\{\s*inputs\./);
    });

    it("has no shop/domain input or env from inputs other than the choice", () => {
      expect(raw).not.toMatch(/inputs\.shop/);
      const inputEnv = steps.flatMap((s) => Object.values(s.env ?? {})).filter((v) => /inputs\./.test(String(v)));
      expect(inputEnv).toEqual(["${{ inputs.query }}"]);
    });
  });

  describe("read-only", () => {
    it("every step with DATABASE_URL enforces read-only PGOPTIONS", () => {
      for (const s of steps) {
        if (s.env && "DATABASE_URL" in s.env) {
          expect(s.env.PGOPTIONS).toBe("-c default_transaction_read_only=on");
          expect(s.env.DATABASE_URL).toBe("${{ secrets.DATABASE_URL_MIGRATIONS }}");
        }
      }
    });

    it("contains no token refresh code or refresh secrets", () => {
      expect(raw).not.toMatch(/refresh-offline-token|offline-token\.server|refreshOfflineToken|refresh_token|grant_type/);
      expect(raw).not.toMatch(/SHOPIFY_API_SECRET|SHOPIFY_API_KEY|DATABASE_URL_SESSION/);
    });

    it("prints skipped_token_expired and exits 0 on an expired token", () => {
      expect(script).toMatch(/echo "bulk_count=skipped_token_expired"\s*\n\s*exit 0/);
    });

    it("SQL contains no write statements", () => {
      const sql = stripShellComments(script);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT|pgmq\.(send|pop|read|delete|archive)|cron\.)\b/i);
    });

    it("uploads no artifacts", () => {
      expect(steps.some((s) => (s.uses ?? "").includes("upload-artifact"))).toBe(false);
    });
  });

  describe("no GraphQL write other than the fixed bulkOperationRunQuery wrapper", () => {
    it("workflow and jq filter never contain the word 'mutation'", () => {
      expect(raw).not.toMatch(/mutation/i);
      expect(readFileSync(JQ_PATH, "utf-8")).not.toMatch(/mutation/i);
    });

    it("guard script names 'mutation' only on the pinned wrapper/keyword lines", () => {
      const lines = readFileSync(GUARD_PATH, "utf-8")
        .split("\n")
        .filter((l) => /mutation/i.test(l));
      expect(lines).toEqual(GUARD_MUTATION_LINES_ALLOWLIST);
    });

    it("no write-style field name appears in the workflow or its scripts", () => {
      for (const p of [WORKFLOW_PATH, JQ_PATH, GUARD_PATH, QUERY_PATH]) {
        const found = (readFileSync(p, "utf-8").match(WRITE_FIELD_RE) ?? []).filter(
          (f) => !ALLOWED_WRITE_FIELDS.has(f)
        );
        expect({ file: p, found }).toEqual({ file: p, found: [] });
      }
    });

    it("the only GraphQL documents built inline are read queries", () => {
      const docs = [...script.matchAll(/jq -n [^\n]*'\{query: "([^"]*)"/g)].map((m) => m[1]);
      expect(docs.length).toBe(2);
      for (const d of docs) expect(d.startsWith("query")).toBe(true);
      expect(docs.some((d) => d.includes("currentBulkOperation(type: QUERY) { status }"))).toBe(true);
      expect(docs.some((d) => d.includes("node(id: $id) { ... on BulkOperation"))).toBe(true);
    });

    it("the submitted document is read from the committed query file only", () => {
      const submits = [...script.matchAll(/--rawfile q "([^"]+)"/g)].map((m) => m[1]);
      expect(submits).toEqual(["$QUERY_FILE"]);
    });

    it("the committed query file is exactly the fixed wrapper (one write op)", () => {
      const parts = queryText.split('"""');
      expect(parts).toHaveLength(3);
      const outer = (parts[0] + "@Q@" + parts[2])
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\s*([(){}:,])\s*/g, "$1");
      expect(outer).toBe(FIXED_WRAPPER);
      expect(queryText.match(/mutation/gi)).toHaveLength(1);
      expect(parts[1]).not.toMatch(/\b(mutation|subscription|fragment)\b/i);
    });

    it("runs the guard before any DB or network access and refuses with QUERY_NOT_READONLY", () => {
      const guardIdx = script.indexOf("scripts/ci/bulk-count/guard_query.py");
      expect(guardIdx).toBeGreaterThan(0);
      expect(guardIdx).toBeLessThan(script.indexOf("psql -X"));
      expect(guardIdx).toBeLessThan(script.indexOf("curl -sS"));
      expect(script).toMatch(/guard_query\.py "\$QUERY_FILE" "\$EXPECTED_FIELD"; then\s*\n\s*echo "bulk_count=refused code=QUERY_NOT_READONLY"\s*\n\s*exit 1/);
      expect(script).toContain("EXPECTED_FIELD=draftOrders");
    });
  });

  describe("runtime query guard (guard_query.py)", () => {
    it("accepts the committed s8-draft-orders file", () => {
      expect(runGuard(queryText).status).toBe(0);
    });

    it("rejects the committed file when a different connection is expected", () => {
      expect(runGuard(queryText, "customers").status).toBe(3);
    });

    const cases: Array<[string, string, string]> = [
      ["inner mutation keyword", queryText.replace("{\n      draftOrders", "mutation {\n      draftOrders"), "INNER_KEYWORD"],
      ["extra top-level field", queryText.replace("      draftOrders(", "      shop { id }\n      draftOrders("), "INNER_TOP_LEVEL_FIELD"],
      ["different top-level field", queryText.replace("draftOrders(query", "customers(query"), "INNER_TOP_LEVEL_FIELD"],
      ["aliased top-level field", queryText.replace("draftOrders(query", "x: draftOrders(query"), "INNER_ALIAS"],
      ["other outer write field", queryText.replace("bulkOperationRunQuery(", "bulkOperationRunMutation("), "WRAPPER_MISMATCH"],
      ["second outer operation", queryText + "\nmutation Two { bulkOperationCancel(id: \"x\") { userErrors { field } } }\n", "WRAPPER_MISMATCH"],
      ["extra outer field", queryText.replace("userErrors { field message } }", "userErrors { field message } }\n  tagsAdd(id: \"x\", tags: [\"y\"]) { node { id } }"), "WRAPPER_MISMATCH"],
      ["comment present", "# hi\n" + queryText, "COMMENT_PRESENT"],
      ["no block", "query { shop { id } }", "BLOCK_COUNT"],
    ];
    for (const [label, content, code] of cases) {
      it(`refuses: ${label}`, () => {
        expect(content).not.toBe(queryText);
        const r = runGuard(content);
        expect(r.status).toBe(3);
        expect(r.stderr.trim()).toBe(`guard_reason=${code}`);
      });
    }
  });

  describe("committed query", () => {
    it("is byte-identical to S8 PR-B's query (sha256 pinned)", () => {
      const sha = createHash("sha256").update(readFileSync(QUERY_PATH)).digest("hex");
      expect(sha).toBe(S8_DRAFT_ORDERS_SHA256);
    });
  });

  describe("jq counts reducer", () => {
    const fixture = readFileSync(FIXTURE_PATH, "utf-8");

    it("counts company, customer-only and neither cases correctly", () => {
      const r = runJq(fixture);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "draft_order_lines=6",
        "with_purchasing_company=2",
        "customer_only=2",
        "neither=2",
      ]);
    });

    it("prints only name=<int> lines and never a planted value", () => {
      const r = runJq(fixture);
      for (const line of r.stdout.trim().split("\n")) {
        expect(line).toMatch(/^(draft_order_lines|with_purchasing_company|customer_only|neither)=\d+$/);
        for (const p of PLANTED) expect(line).not.toContain(p);
      }
    });

    it("handles an empty result (no url, zero objects)", () => {
      const r = runJq("");
      expect(r.stdout.trim().split("\n")).toEqual([
        "draft_order_lines=0",
        "with_purchasing_company=0",
        "customer_only=0",
        "neither=0",
      ]);
    });

    it("fails (non-zero) on malformed JSONL so the workflow prints a fixed code", () => {
      expect(runJq('{"id":"gid://shopify/DraftOrder/1"\nnot json\n').status).not.toBe(0);
      expect(script).toContain('echo "bulk_count=failed code=JSONL_PARSE"');
    });

    it("workflow filters printed count lines to name=<int>", () => {
      expect(script).toContain(
        '[[ "$line" =~ ^(draft_order_lines|with_purchasing_company|customer_only|neither)=[0-9]+$ ]]'
      );
    });
  });

  describe("collision guards", () => {
    it("refuses inside the 02:00 UTC reconcile window", () => {
      expect(script).toMatch(/-ge 145 \] && \[ "\$NOW_HHMM" -lt 330 \]/);
      expect(script).toContain('echo "bulk_count=refused code=RECONCILE_WINDOW"');
    });

    it("refuses when reconcile is in flight in the DB", () => {
      expect(script).toContain("FROM s6_bulk_operations");
      expect(script).toContain("completed_at IS NULL");
      expect(script).toContain('echo "bulk_count=refused code=RECONCILE_IN_FLIGHT"');
    });

    it("refuses when Shopify reports an active QUERY bulk operation", () => {
      expect(script).toMatch(/CREATED\|RUNNING\|CANCELING\|UNKNOWN\)\s*\n\s*echo "bulk_count=refused code=BULK_OP_IN_PROGRESS"/);
    });

    it("guards run before the submit", () => {
      const submit = script.indexOf("--rawfile q");
      for (const marker of ["RECONCILE_WINDOW", "RECONCILE_IN_FLIGHT", "BULK_OP_IN_PROGRESS", "skipped_token_expired"]) {
        expect(script.indexOf(marker)).toBeLessThan(submit);
      }
    });
  });
});
