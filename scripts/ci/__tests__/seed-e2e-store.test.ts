/**
 * Tests for seed-e2e-store.yml (throwaway INR e2e store seed).
 *
 * Proves the fail-closed guards refuse a mismatched shop:
 * - scripts/ci/e2e-shop-guard.sh: empty, bad format and equal-to-main-dev-store
 *   all fail without printing the value; valid-and-different passes and sets
 *   SHOP and ALLOWED_DEV_STORE to the e2e store
 * - scripts/seed.ts validateEnv: refuses (exit 1, before any network call)
 *   when SHOP != ALLOWED_DEV_STORE
 * - scripts/ci/redact-seed-output.sh: GIDs, order names, amounts, emails and
 *   domains never reach public logs
 * - the workflow itself: dispatch-only, main-only, boolean inputs only (no
 *   shop/domain input), dry_run defaults to true, pinned actions, guard first
 *
 * All domains here are fake placeholders.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const GUARD = path.join(ROOT, "scripts", "ci", "e2e-shop-guard.sh");
const REDACT = path.join(ROOT, "scripts", "ci", "redact-seed-output.sh");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "seed-e2e-store.yml");
const SEED = path.join(ROOT, "scripts", "seed.ts");

const E2E = "fake-e2e-store-0000.myshopify.com";
const MAIN = "fake-main-dev-store-0000.myshopify.com";

function runGuard(env: Record<string, string | undefined>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-guard-"));
  const ghEnv = path.join(tmp, "github_env");
  fs.writeFileSync(ghEnv, "");
  const res = spawnSync("bash", [GUARD], {
    env: { PATH: process.env.PATH, GITHUB_ENV: ghEnv, ...env } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  const written = fs.readFileSync(ghEnv, "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });
  const out = `${res.stdout}${res.stderr}`;
  // Every non-mask line must be free of either domain value.
  const unmasked = out.split("\n").filter((l) => !l.startsWith("::add-mask::")).join("\n");
  return { status: res.status, out, unmasked, written };
}

describe("e2e-shop-guard.sh", () => {
  it("fails closed when E2E_SHOP is empty", () => {
    const r = runGuard({ E2E_SHOP: "", MAIN_DEV_STORE: MAIN });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("e2e_shop_missing");
    expect(r.written).toBe("");
    expect(r.unmasked).not.toContain(MAIN);
  });

  it("fails closed when E2E_SHOP is unset", () => {
    const r = runGuard({ MAIN_DEV_STORE: MAIN });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("e2e_shop_missing");
    expect(r.written).toBe("");
  });

  it.each([
    "fake-e2e-store-0000.example.com",
    "Fake-E2E.myshopify.com",
    "https://fake-e2e-store-0000.myshopify.com",
    "fake_e2e.myshopify.com",
    "fake-e2e.myshopify.com.evil.example",
  ])("fails closed on invalid format (%s)", (bad) => {
    const r = runGuard({ E2E_SHOP: bad, MAIN_DEV_STORE: MAIN });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("e2e_shop_invalid_format");
    expect(r.written).toBe("");
    expect(r.unmasked).not.toContain(bad);
  });

  it("fails closed when E2E_SHOP equals the main dev store", () => {
    const r = runGuard({ E2E_SHOP: MAIN, MAIN_DEV_STORE: MAIN });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("e2e_shop_equals_main_dev_store");
    expect(r.written).toBe("");
    expect(r.unmasked).not.toContain(MAIN);
  });

  it("fails closed when equal after whitespace trimming", () => {
    const r = runGuard({ E2E_SHOP: ` ${MAIN}\n`, MAIN_DEV_STORE: MAIN });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("e2e_shop_equals_main_dev_store");
  });

  it("fails closed when the main dev-store secret is missing (cannot prove they differ)", () => {
    const r = runGuard({ E2E_SHOP: E2E, MAIN_DEV_STORE: "" });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("main_dev_store_missing");
    expect(r.written).toBe("");
    expect(r.unmasked).not.toContain(E2E);
  });

  it("passes for a valid domain different from the main dev store", () => {
    const r = runGuard({ E2E_SHOP: E2E, MAIN_DEV_STORE: MAIN });
    expect(r.status).toBe(0);
    expect(r.out).toContain("e2e_shop_guard=ok");
    // Both values are masked before anything else is printed.
    const lines = r.out.split("\n");
    expect(lines[0]).toBe(`::add-mask::${E2E}`);
    expect(lines[1]).toBe(`::add-mask::${MAIN}`);
    expect(r.unmasked).not.toContain(E2E);
    expect(r.unmasked).not.toContain(MAIN);
    // SHOP and seed.ts's guard env both come from E2E_SHOP, never the main store.
    expect(r.written).toBe(`SHOP=${E2E}\nALLOWED_DEV_STORE=${E2E}\n`);
  });
});

describe("seed.ts dev-store guard (validateEnv)", () => {
  const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");

  function runSeed(env: Record<string, string>) {
    return spawnSync(tsx, [SEED, "--dry-run"], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("refuses when the connected shop != ALLOWED_DEV_STORE", () => {
    const res = runSeed({ SHOP: MAIN, ALLOWED_DEV_STORE: E2E, SHOPIFY_ADMIN_TOKEN: "fake-token-not-used" });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain("Security: SHOP is not a valid dev-store domain");
    // Guard runs before any preflight / network call.
    expect(res.stdout).not.toContain("Checking store type");
  }, 60_000);

  it("refuses when ALLOWED_DEV_STORE is unset", () => {
    const res = runSeed({ SHOP: E2E, SHOPIFY_ADMIN_TOKEN: "fake-token-not-used" });
    expect(res.status).toBe(1);
    expect(`${res.stdout}${res.stderr}`).toContain("Missing ALLOWED_DEV_STORE");
    expect(res.stdout).not.toContain("Checking store type");
  }, 60_000);
});

describe("redact-seed-output.sh", () => {
  function redact(input: string): string {
    const res = spawnSync("bash", [REDACT], { input, encoding: "utf8" });
    expect(res.status).toBe(0);
    return res.stdout;
  }

  it("redacts GIDs, order names, amounts, emails, domains and long numeric ids", () => {
    const out = redact(
      [
        "    → Created customer: gid://shopify/Customer/7012345678901",
        "  ✓ [3/35] Order unchanged (#1042)",
        "  amount INR 125,000 and USD 1,234.50",
        "  contact buyer.fake@example.com",
        `  shop ${E2E}`,
        "  id 123456789012",
      ].join("\n") + "\n",
    );
    expect(out).not.toMatch(/gid:\/\/shopify/);
    expect(out).not.toContain("7012345678901");
    expect(out).not.toContain("#1042");
    expect(out).not.toContain("125,000");
    expect(out).not.toContain("1,234");
    expect(out).not.toContain("@example.com");
    expect(out).not.toContain("myshopify.com");
    expect(out).not.toContain("123456789012");
  });

  it("keeps counts, enums and booleans", () => {
    const line = "  [3/35] Net 30 Companies: 5 Currency: INR dry_run=true\n";
    expect(redact(line)).toBe(line);
  });
});

describe("seed-e2e-store.yml static checks", () => {
  const wf = fs.readFileSync(WORKFLOW, "utf8");

  it("is workflow_dispatch only", () => {
    const onBlock = wf.split(/^on:\s*$/m)[1].split(/^permissions:/m)[0];
    const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
    expect(triggers).toEqual(["workflow_dispatch"]);
  });

  it("job runs only on refs/heads/main", () => {
    expect(wf).toMatch(/^\s+if: github\.ref == 'refs\/heads\/main'$/m);
  });

  it("has only boolean inputs dry_run (default true) and reviewer_demo (default false)", () => {
    const inputsBlock = wf.split(/^ {4}inputs:\s*$/m)[1].split(/^permissions:/m)[0];
    const names = [...inputsBlock.matchAll(/^ {6}([a-z_]+):/gm)].map((m) => m[1]);
    expect(names).toEqual(["dry_run", "reviewer_demo"]);
    const types = [...inputsBlock.matchAll(/^ {8}type: (\S+)/gm)].map((m) => m[1]);
    expect(types).toEqual(["boolean", "boolean"]);
    const defaults = [...inputsBlock.matchAll(/^ {8}default: (\S+)/gm)].map((m) => m[1]);
    expect(defaults).toEqual(["true", "false"]);
    expect(names.some((n) => /shop|domain|store/i.test(n))).toBe(false);
  });

  it("never interpolates a shop/domain from inputs and reads the store only from secrets.E2E_SHOP", () => {
    expect(wf).not.toMatch(/inputs\.[a-z_]*(shop|domain|store)/i);
    expect(wf).toContain("E2E_SHOP: ${{ secrets.E2E_SHOP }}");
    expect(wf).not.toMatch(/[a-z0-9-]+\.myshopify\.com/);
  });

  it("permissions are contents: read", () => {
    expect(wf).toMatch(/^permissions:\n {2}contents: read$/m);
  });

  it("pins every action to a full commit SHA", () => {
    const uses = [...wf.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it("runs the shop guard before npm ci and checks needsReauth before the seed", () => {
    const guardIdx = wf.indexOf("bash scripts/ci/e2e-shop-guard.sh");
    expect(guardIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeLessThan(wf.indexOf("run: npm ci"));
    const reauthIdx = wf.indexOf('"needsReauth"');
    expect(reauthIdx).toBeGreaterThan(0);
    expect(reauthIdx).toBeLessThan(wf.indexOf("npx tsx scripts/seed.ts"));
  });

  it("pipes seed output through the redaction filter", () => {
    expect(wf).toContain('npx tsx scripts/seed.ts "${ARGS[@]}" 2>&1 | bash scripts/ci/redact-seed-output.sh');
  });
});
