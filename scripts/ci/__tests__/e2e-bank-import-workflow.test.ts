/**
 * Static + unit tests for the e2e bank import (no DB needed).
 *
 * - .github/workflows/e2e-bank-import.yml: dispatch-only, main-only, a single
 *   boolean dry_run input defaulting to true (no shop/domain/file input),
 *   pinned actions, e2e-shop guard first, output piped through the filter
 * - scripts/e2e-bank-import.ts and app/services/bank-import.server.ts import
 *   and call NO confirm / reject / apply / alias / status-update function, and
 *   runMatcher's own path in matcher.server.ts calls none either
 * - shop guard fails closed before any DB access
 * - output formatting refuses anything that is not a count, boolean or enum,
 *   and errors map to enum codes only
 * - scripts/ci/e2e-bank-import-filter.sh drops ids, domains, amounts,
 *   narration and any non-allowlisted line
 * - the fixed fixture parses to the expected counts with the app parser
 *
 * All domains here are fake placeholders.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  assertE2eShop,
  formatOutputLine,
  errorCodeOf,
  E2eImportError,
  loadFixturePayload,
  runE2eBankImport,
  OUTPUT_KEYS,
  FIXTURE_RELATIVE_PATH,
  type OutputKey,
} from "../../e2e-bank-import";
import type { Sql } from "../../../app/lib/db-light.server";

const ROOT = path.resolve(__dirname, "../../..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "e2e-bank-import.yml");
const FILTER = path.join(ROOT, "scripts", "ci", "e2e-bank-import-filter.sh");
const SCRIPT = path.join(ROOT, "scripts", "e2e-bank-import.ts");
const SERVICE = path.join(ROOT, "app", "services", "bank-import.server.ts");
const MATCHER = path.join(ROOT, "app", "services", "matcher.server.ts");

const E2E = "fake-e2e-store-0000.myshopify.com";
const OTHER = "fake-main-dev-store-0000.myshopify.com";

/** Functions that confirm, reject, apply, push or learn from a match. */
const FORBIDDEN = [
  "confirmMatch",
  "rejectMatch",
  "updateMatchAllocation",
  "updateMatchState",
  "updatePaymentStatus",
  "upsertPayerAlias",
  "createRejectedMatch",
];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function runFilter(input: string) {
  return spawnSync("bash", [FILTER], { input, encoding: "utf8" });
}

describe("e2e-bank-import.yml", () => {
  const wf = fs.readFileSync(WORKFLOW, "utf8");

  it("is dispatch-only, main-only, with a single boolean dry_run defaulting to true", () => {
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}dry_run:\n/m);
    expect(wf).not.toMatch(/^\s+(push|pull_request|schedule|workflow_run):/m);
    expect(wf).toContain("if: github.ref == 'refs/heads/main'");
    const inputs = wf.split("inputs:")[1].split("permissions:")[0];
    expect(inputs.match(/^ {6}[a-z_]+:$/gm)).toEqual(["      dry_run:"]);
    expect(inputs).toContain("type: boolean");
    expect(inputs).toContain("default: true");
    expect(wf).not.toMatch(/inputs\.(shop|domain|file|path)/i);
  });

  it("has read-only permissions, a concurrency group and pinned actions", () => {
    expect(wf).toMatch(/permissions:\n {2}contents: read\n/);
    expect(wf).toContain("group: e2e-bank-import");
    const uses = wf.match(/uses: \S+/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
  });

  it("guards the shop first and pipes the script through the filter", () => {
    const guard = wf.indexOf("bash scripts/ci/e2e-shop-guard.sh");
    const run = wf.indexOf("npx tsx scripts/e2e-bank-import.ts");
    expect(guard).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(guard);
    expect(wf).toContain("E2E_SHOP: ${{ secrets.E2E_SHOP }}");
    expect(wf).toContain("set -euo pipefail");
    expect(wf).toContain("npx tsx scripts/e2e-bank-import.ts 2>&1 | bash scripts/ci/e2e-bank-import-filter.sh");
    // No Shopify credentials: the import never talks to Shopify
    expect(wf).not.toMatch(/SHOPIFY_(ADMIN_TOKEN|API_KEY|API_SECRET)|DATABASE_URL_SESSION/);
    expect(wf).not.toMatch(/[a-z0-9-]+\.myshopify\.com/);
  });
});

describe("no confirm/apply path (static)", () => {
  it.each([[SCRIPT], [SERVICE]])("%s imports and calls no confirm/apply function", (file) => {
    const src = stripComments(fs.readFileSync(file, "utf8"));
    for (const name of FORBIDDEN) {
      expect(src, name).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(src).not.toMatch(/services\/apply|apply\.server|@shopify\/|admin\.graphql|SHOPIFY_ADMIN_TOKEN/);
    expect(src).not.toMatch(/state\s*=\s*'(confirmed|pushing|pushed)'|status\s*=\s*'(matched|partial)'/);
  });

  it("the script imports only runMatcher/MAX_PAYMENTS_PER_REQUEST from the matcher", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const imp = src.match(/import \{([^}]*)\} from "~\/services\/matcher\.server";/);
    expect(imp).not.toBeNull();
    const names = imp![1].split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(names).toEqual(["MAX_PAYMENTS_PER_REQUEST", "runMatcher"]);
  });

  it("runMatcher's own path (runMatcher + matchSinglePayment) calls no confirm/apply function", () => {
    const src = fs.readFileSync(MATCHER, "utf8");
    const start = src.indexOf("export async function runMatcher(");
    const end = src.indexOf("export async function confirmMatch(");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = stripComments(src.slice(start, end));
    for (const name of FORBIDDEN) {
      expect(body, name).not.toMatch(new RegExp(`\\b${name}\\s*\\(`));
    }
  });
});

describe("assertE2eShop (fails closed)", () => {
  it.each([
    [{}, "shop_missing"],
    [{ SHOP: "", ALLOWED_DEV_STORE: E2E }, "shop_missing"],
    [{ SHOP: E2E }, "allowed_store_missing"],
    [{ SHOP: E2E, ALLOWED_DEV_STORE: "" }, "allowed_store_missing"],
    [{ SHOP: "not a domain", ALLOWED_DEV_STORE: "not a domain" }, "shop_invalid_format"],
    [{ SHOP: E2E, ALLOWED_DEV_STORE: OTHER }, "shop_not_allowed"],
  ])("%j -> %s", (env, code) => {
    expect(() => assertE2eShop(env)).toThrowError(expect.objectContaining({ code }));
  });

  it("returns the shop when it equals the allowlist", () => {
    expect(assertE2eShop({ SHOP: E2E, ALLOWED_DEV_STORE: E2E })).toBe(E2E);
  });

  it("runE2eBankImport touches no DB when the shop guard fails", async () => {
    let used = 0;
    const sql = new Proxy(() => {}, {
      apply() {
        used++;
        throw new Error("db used");
      },
      get() {
        used++;
        throw new Error("db used");
      },
    }) as unknown as Sql;
    const lines: string[] = [];
    await expect(
      runE2eBankImport({
        sql,
        env: { SHOP: E2E, ALLOWED_DEV_STORE: OTHER },
        dryRun: false,
        rootDir: ROOT,
        emit: (k, v) => lines.push(formatOutputLine(k, v)),
      })
    ).rejects.toMatchObject({ code: "shop_not_allowed" });
    expect(used).toBe(0);
    expect(lines).toEqual(["mode=apply"]);
  });
});

describe("output is counts/booleans/enums only", () => {
  it("formats allowed values", () => {
    expect(formatOutputLine("fixture_credits", 3)).toBe("fixture_credits=3");
    expect(formatOutputLine("noop", true)).toBe("noop=true");
    expect(formatOutputLine("result", "dry_run_ok")).toBe("result=dry_run_ok");
  });

  it.each([
    ["fixture_credits", -1],
    ["fixture_credits", 1.5],
    ["result", "Test Buyer Co"],
    ["result", "10000.00"],
    ["result", "2026-10-22"],
    ["reviewer_demo_invoices_present", "#1001"],
    ["reviewer_demo_invoices_present", -1],
    ["result", "0b5c3c1e-1111-4222-8333-444455556666"],
    ["result", E2E],
    ["narration", "x"],
  ])("refuses %s=%j", (key, value) => {
    expect(() => formatOutputLine(key as OutputKey, value)).toThrowError(E2eImportError);
  });

  it("errors map to enum codes only, never messages", () => {
    expect(errorCodeOf(new E2eImportError("shop_not_found"))).toBe("shop_not_found");
    expect(errorCodeOf(new Error(`duplicate key for ${E2E} TEST BUYER CO 10000.00`))).toBe("unexpected_error");
    expect(errorCodeOf(new E2eImportError("Has Spaces"))).toBe("unexpected_error");
    expect(errorCodeOf("raw string")).toBe("unexpected_error");
  });

  it("script without DATABASE_URL exits non-zero printing only result/error_code", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, SHOP: E2E, ALLOWED_DEV_STORE: E2E };
    delete env.DATABASE_URL;
    const res = spawnSync("npx", ["tsx", SCRIPT], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
    expect(res.status).toBe(1);
    expect(res.stdout.trim().split("\n")).toEqual(["result=error", "error_code=database_url_missing"]);
    expect(`${res.stdout}${res.stderr}`).not.toContain(E2E);
  }, 70_000);
});

describe("e2e-bank-import-filter.sh", () => {
  it("keeps only allowlisted key=value lines", () => {
    const res = runFilter(
      [
        "mode=dry_run",
        "fixture_credits=3",
        "app_would_reject=false",
        '{"level":"info","event":"import.start","shopId":"0b5c3c1e-1111-4222-8333-444455556666"}',
        `shop=${E2E}`,
        "narration=NEFT-SYNT0001-TEST BUYER CO",
        "result=Test Buyer Co",
        "amount=10000.00",
        "date=2026-10-22",
        "reviewer_demo_invoices_present=2",
        "reviewer_demo_invoices_present=#1001,#1002",
        "error_code=0b5c3c1e-1111-4222-8333-444455556666",
        "Error: duplicate key value violates unique constraint",
        "    at Object.<anonymous> (/x.ts:1:1)",
        "result=imported",
      ].join("\n") + "\n"
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe(
      [
        "mode=dry_run",
        "fixture_credits=3",
        "app_would_reject=false",
        "reviewer_demo_invoices_present=2",
        "result=imported",
        "filtered_lines_dropped=10",
        "",
      ].join(
        "\n"
      )
    );
  });

  it("allowlists exactly the script's OUTPUT_KEYS", () => {
    const sh = fs.readFileSync(FILTER, "utf8");
    const keys = sh.match(/^KEYS='([^']+)'$/m)![1].split("|");
    expect(keys).toEqual([...OUTPUT_KEYS]);
  });
});

describe("fixed fixture", () => {
  it("is the HDFC review CSV and parses to 3 credits with the app parser", async () => {
    expect(FIXTURE_RELATIVE_PATH).toBe("tests/fixtures/banks/synthetic/hdfc-review-synthetic.csv");
    const f = await loadFixturePayload(ROOT);
    expect(f.bank).toBe("HDFC");
    expect(f.body.credits).toHaveLength(3);
    expect(f.debits).toBe(1);
    expect(f.body.fileName).toBe("hdfc-review-synthetic.csv");
  });
});
