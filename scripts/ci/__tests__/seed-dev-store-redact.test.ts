/**
 * seed-dev-store.yml public-log redaction.
 *
 * - scripts/ci/redact-seed-output.sh masks any gid://shopify/<Type>/<id>
 *   (numeric or not), ntr-seed-* externalIds and the seed company names, which
 *   it reads from scripts/seed.ts (COMPANY_SEEDS / REVIEWER_DEMO_COMPANY_SEED).
 * - every seed.ts call in seed-dev-store.yml is piped through it under
 *   pipefail, so a failing seed.ts still fails the job.
 *
 * REDACT_SCRIPT_UNDER_TEST lets the redact tests run against another copy of
 * the script (used to show they fail on the previous version).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { COMPANY_SEEDS, REVIEWER_DEMO_COMPANY_SEED, SEED_PREFIX } from "../../seed";

const ROOT = path.resolve(__dirname, "../../..");
const REDACT =
  process.env.REDACT_SCRIPT_UNDER_TEST ?? path.join(ROOT, "scripts", "ci", "redact-seed-output.sh");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "seed-dev-store.yml");
const SEED_TS = path.join(ROOT, "scripts", "seed.ts");

function run(input: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [REDACT], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, SEED_TS, ...env } as unknown as NodeJS.ProcessEnv,
  });
}

function redact(input: string): string {
  const res = run(input);
  expect(res.status).toBe(0);
  return res.stdout;
}

const NAMES = [...COMPANY_SEEDS.map((c) => c.name), REVIEWER_DEMO_COMPANY_SEED.name];

describe("redact-seed-output.sh (seed-dev-store patterns)", () => {
  it.each([
    "gid://shopify/Customer/7012345678901",
    "gid://shopify/Company/abc-DEF_123",
    "gid://shopify/CompanyLocation/not-a-number",
    "gid://shopify/BulkOperation/0f8e2c1a-55aa-4d1b",
    "gid://shopify/Order/12?x=1",
  ])("masks GID form %#", (gid) => {
    const out = redact(`  → Created: ${gid} done\n  ids=[${gid}, "${gid}"]\n`);
    expect(out).not.toMatch(/gid:\/\/shopify/);
    const id = gid.split("/").pop()!;
    expect(out).not.toContain(id);
    expect(out).toContain("<gid>");
  });

  it("masks ntr-seed-* externalIds", () => {
    expect(SEED_PREFIX).toBe("ntr-seed-");
    const ids = [`${SEED_PREFIX}company-3`, `${SEED_PREFIX}order-company-1-net30-2`, `${SEED_PREFIX}abc_DEF.9`];
    const out = redact(ids.map((id) => `  externalId=${id} (existing)\n`).join(""));
    expect(out).not.toContain(SEED_PREFIX);
    for (const id of ids) expect(out).not.toContain(id.slice(SEED_PREFIX.length));
  });

  it("masks every seed company name taken from scripts/seed.ts", () => {
    expect(NAMES.length).toBeGreaterThan(0);
    const out = redact(
      NAMES.map((n, i) => `  [${i + 1}/6] Company: ${n} / location ${n} - Net 30\n`).join(""),
    );
    for (const n of NAMES) expect(out).not.toContain(n);
    expect(out).toContain("<company>");
    expect(out).toContain("Net 30");
  });

  it("keeps counts, enums, booleans and timestamps", () => {
    const line =
      "  company_idx=2 duplicate=false templates_found=3 status=PENDING dry_run=true at 2026-10-26T05:00:00Z\n";
    expect(redact(line)).toBe(line);
  });

  it("fails closed (no output, non-zero) when seed names cannot be read", () => {
    const res = run("Company: anything\n", { SEED_TS: path.join(ROOT, "does-not-exist.ts") });
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("seed-dev-store.yml pipes seed.ts through the redactor under pipefail", () => {
  const wf = fs.readFileSync(WORKFLOW, "utf8");
  const step = wf.split(/^ {6}- name: Run seed script\s*$/m)[1].split(/^ {6}- name:/m)[0];
  const calls = step.split("\n").filter((l) => /npx tsx scripts\/seed\.ts/.test(l));

  it("run block starts with set -euo pipefail", () => {
    expect(step).toMatch(/run: \|\s*\n\s+set -euo pipefail\n/);
  });

  it("every seed.ts call (report-duplicates, reseed-held-currency, seed) is redacted", () => {
    expect(calls.length).toBe(4);
    for (const l of calls) {
      expect(l.trimEnd()).toMatch(/ 2>&1 \| bash scripts\/ci\/redact-seed-output\.sh$/);
    }
  });

  it("no seed.ts call elsewhere in the workflow is unredacted", () => {
    const all = wf.split("\n").filter((l) => /^\s*npx tsx scripts\/seed\.ts/.test(l));
    expect(all.length).toBe(calls.length);
  });

  it("with pipefail a failing seed.ts exit code survives the pipe", () => {
    const script = `set -euo pipefail\n(echo "Company: ${NAMES[0]}"; exit 3) 2>&1 | bash "${REDACT}"\necho unreachable\n`;
    const res = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, SEED_TS } as unknown as NodeJS.ProcessEnv,
    });
    expect(res.status).toBe(3);
    expect(res.stdout).not.toContain("unreachable");
    expect(res.stdout).not.toContain(NAMES[0]);
  });
});
