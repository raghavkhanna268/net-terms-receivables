/**
 * Shop identity labels (scripts/ci/shop-labels.ts), static side.
 *
 * shop_kind = main | e2e | other_N | unknown replaces sort-order shop
 * numbering (shop_idx). It is derived in SQL from the masked psql vars
 * :'allowed' (ALLOWED_DEV_STORE) and :'e2e' (E2E_SHOP). other_N is stable
 * within one run only; it does not identify a shop across runs.
 *
 * Pins:
 * - every labelled readonly script embeds the canonical CTE verbatim and the
 *   column guard classifies shop_kind as an enum (no domain/id output);
 * - no readonly script or the diagnostics entity counts still number shops
 *   by sort order;
 * - prod-readonly-query.yml passes E2E_SHOP as a validated, masked psql var
 *   and fails closed (exit 1) for the labelled scripts when either secret is
 *   missing/invalid or both are equal, without printing a planted domain;
 * - prod-diagnostics.yml entity counts embed the CTE and fall back to
 *   'unknown' (never fail, never print the domain) on bad secrets.
 * The DB behaviour (labels, stability, unknown) is in
 * shop-identity-labels-db.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkSql } from "../check-readonly-columns";
import {
  SHOP_LABELS_CTE,
  SHOP_LABEL_SCRIPTS,
  SHOP_KIND_RE,
  stripShopLabelsCte,
} from "../shop-labels";

const ROOT = join(__dirname, "../../..");
const READONLY_DIR = join(ROOT, "scripts/readonly");
const PLANTED_ALLOWED = "planted-labels-main-store.myshopify.com";
const PLANTED_E2E = "planted-labels-e2e-store.myshopify.com";

interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}
interface Workflow {
  on: { workflow_dispatch: { inputs: Record<string, unknown> } };
  jobs: Record<string, { steps?: Step[] }>;
}

function loadWorkflow(file: string): Workflow {
  return parseYaml(readFileSync(join(ROOT, ".github/workflows", file), "utf8")) as Workflow;
}
function findStep(wf: Workflow, name: string): Step {
  for (const job of Object.values(wf.jobs)) {
    const s = job.steps?.find((x) => x.name === name);
    if (s) return s;
  }
  throw new Error(`step not found: ${name}`);
}
function between(run: string, start: string, end: string): string {
  const a = run.indexOf(start);
  const b = run.indexOf(end, a);
  expect(a, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `missing ${end}`).toBeGreaterThan(a);
  return run.slice(a, b + end.length);
}
function bash(script: string, env: Record<string, string>) {
  const r = spawnSync("bash", ["-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  // ::add-mask:: lines are consumed by the runner (masked), not printed.
  const visible = `${r.stdout}\n${r.stderr}`
    .split("\n")
    .filter((l) => !l.startsWith("::add-mask::"))
    .join("\n");
  return { status: r.status, visible };
}
function heredocs(run: string): string[] {
  return [...run.matchAll(/<<'EOSQL'\n([\s\S]*?)\nEOSQL/g)].map((m) => m[1]);
}

describe("canonical shop_labels CTE", () => {
  it("derives labels only from the two secret vars and never selects the domain", () => {
    expect(SHOP_LABELS_CTE).toMatch(/WHEN s\.domain = :'allowed' THEN 'main'/);
    expect(SHOP_LABELS_CTE).toMatch(/WHEN s\.domain = :'e2e' THEN 'e2e'/);
    expect(SHOP_LABELS_CTE).toMatch(/THEN 'unknown'/);
    // other_N ranks by Shop.id among non-main/e2e shops (never by domain)
    expect(SHOP_LABELS_CTE).toMatch(/PARTITION BY s\.domain IN \(:'allowed', :'e2e'\)\s+ORDER BY s\.id\)/);
    expect(SHOP_LABELS_CTE).not.toMatch(/ORDER BY s\.domain/);
    const { violations, columns } = checkSql(
      "x.sql",
      `BEGIN TRANSACTION READ ONLY;\nWITH ${SHOP_LABELS_CTE}\nSELECT sl.shop_kind FROM shop_labels sl;\nROLLBACK;\n`,
    );
    expect(violations).toEqual([]);
    expect(columns).toEqual([{ column: "shop_kind", kind: "enum", via: "derived" }]);
  });

  it("SHOP_KIND_RE accepts the scheme only", () => {
    for (const ok of ["main", "e2e", "unknown", "other_1", "other_12"]) expect(ok).toMatch(SHOP_KIND_RE);
    for (const bad of ["other_0", "other_", "shop_1", "1", PLANTED_ALLOWED]) expect(bad).not.toMatch(SHOP_KIND_RE);
  });
});

describe.each(SHOP_LABEL_SCRIPTS)("scripts/readonly/%s.sql", (name) => {
  const code = readFileSync(join(READONLY_DIR, `${name}.sql`), "utf8");

  it("embeds the canonical CTE and outputs shop_kind as an enum", () => {
    expect(code).toContain(SHOP_LABELS_CTE);
    expect(code).toMatch(/shop_labels sl ON sl\.shop_id = /);
    const { violations, columns } = checkSql(`scripts/readonly/${name}.sql`, code);
    expect(violations).toEqual([]);
    const kinds = columns.filter((c) => c.column === "shop_kind");
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(k.kind).toBe("enum");
  });

  it("has no sort-order shop numbering and no other domain use", () => {
    expect(code).not.toMatch(/shop_idx/);
    expect(code).not.toMatch(/(DENSE_RANK|RANK)\s*\(\s*\)/i);
    const rest = stripShopLabelsCte(code);
    // no window numbering of shops outside the CTE (per-rule ROW_NUMBER
    // partitioned by shop is fine; it never orders shops)
    expect(rest).not.toMatch(/OVER\s*\(\s*ORDER BY[^)]*("shopId"|\bs\.id\b|domain)/i);
    // the domain is never selected: only compared in the CTE or a join
    for (const m of rest.matchAll(/\.domain\b[^\n]*/g)) {
      expect(m[0]).toMatch(/^\.domain\s*(=|AND|$)/);
    }
  });

  it("documents the scheme and that other_N is not identity across runs", () => {
    expect(code).toMatch(/shop_kind/);
    expect(code).toMatch(/across runs/i);
    const header = code.split("\n").filter((l) => l.startsWith("--")).join("\n");
    expect(header).toMatch(/\ballowed\b/);
    expect(header).toMatch(/\be2e\b/);
  });
});

describe("scripts/readonly (all)", () => {
  it("only the listed scripts label shops, and none numbers shops as shop_idx", () => {
    // initial-sync-timing (#465) uses shop_idx only as its 1 | 2 | reviewer
    // selector input, not as sort-order numbering; it is out of scope here.
    const files = readdirSync(READONLY_DIR).filter(
      (f) => f.endsWith(".sql") && f !== "initial-sync-timing.sql",
    );
    const labelled = files
      .filter((f) => readFileSync(join(READONLY_DIR, f), "utf8").includes("shop_kind"))
      .map((f) => f.replace(/\.sql$/, ""))
      .sort();
    expect(labelled).toEqual([...SHOP_LABEL_SCRIPTS].sort());
    for (const f of files) {
      expect(readFileSync(join(READONLY_DIR, f), "utf8"), f).not.toMatch(/shop_idx/);
    }
  });
});

describe("prod-readonly-query.yml", () => {
  const wf = loadWorkflow("prod-readonly-query.yml");
  const step = findStep(wf, "Run query");
  const run = step.run ?? "";

  it("adds no free-text inputs", () => {
    // shop_idx is #465's choice input (1 | 2 | reviewer) for initial-sync-timing
    expect(Object.keys(wf.on.workflow_dispatch.inputs).sort()).toEqual(
      ["location_id", "msg_ids", "query", "shop_idx", "since"],
    );
    expect((wf.on.workflow_dispatch.inputs.shop_idx as { type?: string }).type).toBe("choice");
  });

  it("validates and masks E2E_SHOP exactly once", () => {
    expect(run.match(/E2E="\$\{E2E_SHOP:-\}"/g)).toHaveLength(1);
    expect(run.match(/echo "::add-mask::\$E2E"/g)).toHaveLength(1);
  });

  it("passes both secrets as validated, masked psql vars", () => {
    expect(step.env?.E2E_SHOP).toBe("${{ secrets.E2E_SHOP }}");
    expect(step.env?.ALLOWED_DEV_STORE).toBe("${{ secrets.ALLOWED_DEV_STORE }}");
    expect(run).toContain('E2E="${E2E_SHOP:-}"');
    expect(run).toContain('[[ ! "$E2E" =~ ^[a-z0-9-]+\\.myshopify\\.com$ ]]');
    expect(run).toContain('echo "::add-mask::$E2E"');
    expect(run).toMatch(/psql .*-v "allowed=\$\{ALLOWED\}" -v "e2e=\$\{E2E\}"/);
    // never echoed outside add-mask
    for (const line of run.split("\n")) {
      if (/\becho\b/.test(line) && !line.includes("::add-mask::")) {
        expect(line).not.toMatch(/\$\{?(E2E|E2E_SHOP|ALLOWED|ALLOWED_DEV_STORE)\b/);
      }
    }
  });

  const guard = (() => {
    const pre = run.slice(run.indexOf('ALLOWED="${ALLOWED_DEV_STORE:-}"'), run.indexOf("# shop-labels-guard:start"));
    return `set -euo pipefail\n${pre}${between(run, "# shop-labels-guard:start", "# shop-labels-guard:end")}\necho GUARD_PASSED\n`;
  })();

  it("guard case list equals SHOP_LABEL_SCRIPTS", () => {
    const m = guard.match(/case "\$QUERY_NAME" in\n\s*([^)]+)\)/);
    expect(m?.[1].trim().split("|").sort()).toEqual([...SHOP_LABEL_SCRIPTS].sort());
  });

  const bad: [string, Record<string, string>][] = [
    ["E2E_SHOP missing", { ALLOWED_DEV_STORE: PLANTED_ALLOWED }],
    ["ALLOWED_DEV_STORE missing", { E2E_SHOP: PLANTED_E2E }],
    ["both missing", {}],
    ["E2E_SHOP invalid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: `${PLANTED_E2E}\nx` }],
    ["both equal", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: PLANTED_ALLOWED }],
  ];

  describe.each(SHOP_LABEL_SCRIPTS)("guard for %s", (q) => {
    it.each(bad)("fails closed when %s, printing no domain", (_l, env) => {
      const r = bash(guard, { QUERY_NAME: q, ...env });
      expect(r.status).toBe(1);
      expect(r.visible).toMatch(/::error::ALLOWED_DEV_STORE and E2E_SHOP secrets must both be set/);
      expect(r.visible).not.toContain("GUARD_PASSED");
      expect(r.visible).not.toContain("myshopify");
    });

    it("passes with both secrets valid and different", () => {
      const r = bash(guard, { QUERY_NAME: q, ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: PLANTED_E2E });
      expect(r.status).toBe(0);
      expect(r.visible).toContain("GUARD_PASSED");
      expect(r.visible).not.toContain("myshopify");
    });
  });

  it("does not block queries that do not label shops", () => {
    const r = bash(guard, { QUERY_NAME: "pgmq-archive-age" });
    expect(r.status).toBe(0);
    expect(r.visible).toContain("GUARD_PASSED");
  });
});

describe("prod-diagnostics.yml entity counts", () => {
  const wf = loadWorkflow("prod-diagnostics.yml");
  const step = findStep(wf, "Queue and webhook counts");
  const run = step.run ?? "";
  const cteInRun = SHOP_LABELS_CTE; // the YAML block scalar is dedented

  it("embeds the CTE in both entity-count queries, with masked vars", () => {
    expect(step.env?.ALLOWED_DEV_STORE).toBe("${{ secrets.ALLOWED_DEV_STORE }}");
    expect(step.env?.E2E_SHOP).toBe("${{ secrets.E2E_SHOP }}");
    const labelled = heredocs(run).filter((h) => h.includes("shop_labels"));
    expect(labelled).toHaveLength(2);
    for (const h of labelled) {
      expect(h).toContain(`WITH ${cteInRun}`);
      expect(stripShopLabelsCte(h)).not.toMatch(/\.domain\b|ROW_NUMBER|RANK\s*\(|shop_idx/i);
    }
    // the table query is in the column guard's dialect (the json_agg one is
    // pinned by key below)
    const { violations, columns } = checkSql("diag.sql", `BEGIN TRANSACTION READ ONLY;\n${labelled[0]}\nROLLBACK;\n`);
    expect(violations).toEqual([]);
    expect(columns.find((c) => c.column === "shop_kind")?.kind).toBe("enum");
    expect(run.match(/-v "allowed=\$\{LABEL_ALLOWED\}" -v "e2e=\$\{LABEL_E2E\}"/g)).toHaveLength(2);
    expect(run).toMatch(/'shop_kind', x\.shop_kind/);
    expect(run).not.toMatch(/shop_idx/);
  });

  const snippet = between(run, "# Entity counts shop label secrets", "# End entity counts shop label secrets");
  const probe = `set -euo pipefail\n${snippet}\necho "allowed=\${LABEL_ALLOWED:+set} e2e=\${LABEL_E2E:+set}"\n`;

  it.each([
    ["valid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: PLANTED_E2E }, "allowed=set e2e=set"],
    ["E2E_SHOP missing", { ALLOWED_DEV_STORE: PLANTED_ALLOWED }, "allowed=set e2e="],
    ["E2E_SHOP invalid", { ALLOWED_DEV_STORE: PLANTED_ALLOWED, E2E_SHOP: `${PLANTED_E2E}\nx` }, "allowed=set e2e="],
    ["both missing", {}, "allowed= e2e="],
  ] as const)("secrets %s -> vars (unknown labels, no failure, no domain)", (_l, env, want) => {
    const r = bash(probe, { ...env });
    expect(r.status).toBe(0);
    expect(r.visible.trim()).toBe(want);
    expect(r.visible).not.toContain("myshopify");
  });
});
