/**
 * Static guards for the one-off #200 seed-orphan delete (workflow + SQL).
 *
 * Verifies:
 * - workflow_dispatch only, main only, mode defaults to dry-run, apply needs confirm
 * - never uses the shopify-release environment
 * - dry-run runs with default_transaction_read_only=on
 * - the SQL allowlist is exactly the 3 approved CompanyLocation gids, everywhere
 * - the SQL only deletes from "BuyerAccount", only inside the apply branch,
 *   asserts 3 deleted rows, and commits only under `\if :is_apply`
 * - the SQL never selects the shop domain or other sensitive columns
 * - is_seed matches the two seed id formats scripts/seed.ts has written, each
 *   EXACTLY against the row's own columns (legacy seed-account-<location gid>,
 *   current seed-account-<shopId>-<location gid>); anything else is refused
 *
 * @see https://github.com/raghavkhanna268/net-terms-receivables/issues/200
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import postgres from "postgres";

const ROOT = join(__dirname, "../../..");
const WF_TEXT = readFileSync(
  join(ROOT, ".github/workflows/ops-200-delete-seed-orphans.yml"),
  "utf8",
);
const SQL = readFileSync(
  join(ROOT, "scripts/ops/200-delete-seed-orphans.sql"),
  "utf8",
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wf: any = parseYaml(WF_TEXT);

const APPROVED = [
  "gid://shopify/CompanyLocation/24539463845",
  "gid://shopify/CompanyLocation/24539529381",
  "gid://shopify/CompanyLocation/24539594917",
];

function gidsIn(text: string): string[] {
  return [
    ...new Set(text.match(/gid:\/\/shopify\/CompanyLocation\/\d+/g) ?? []),
  ].sort();
}

function sqlWithoutComments(): string {
  return SQL.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

describe("ops-200 workflow", () => {
  it("is workflow_dispatch only", () => {
    // YAML parses the `on` key as true in some parsers; accept either.
    const on = wf.on ?? wf[true as unknown as string];
    expect(Object.keys(on)).toEqual(["workflow_dispatch"]);
  });

  it("defaults mode to dry-run with only dry-run|apply", () => {
    const on = wf.on ?? wf[true as unknown as string];
    const mode = on.workflow_dispatch.inputs.mode;
    expect(mode.default).toBe("dry-run");
    expect(mode.options).toEqual(["dry-run", "apply"]);
  });

  it("runs on main only and never uses shopify-release", () => {
    const job = wf.jobs.run;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toBeUndefined();
    expect(WF_TEXT).not.toMatch(/environment:\s*shopify-release/);
  });

  it("requires the confirm phrase for apply", () => {
    expect(WF_TEXT).toContain(
      'if [ "$INPUT_CONFIRM" != "DELETE-3-SEED-ORPHANS" ]; then',
    );
  });

  it("forces a read-only session for dry-run and redacts psql stderr", () => {
    const step = wf.jobs.run.steps.find((s: { name?: string }) =>
      s.name?.startsWith("Run guarded delete"),
    );
    expect(step.run).toContain('if [ "$INPUT_MODE" = "dry-run" ]; then');
    expect(step.run).toContain(
      'export PGOPTIONS="-c default_transaction_read_only=on"',
    );
    expect(step.run).toContain("source scripts/ci/psql-redacted.sh");
  });

  it("takes the shop only from the ALLOWED_DEV_STORE secret, masked", () => {
    expect(WF_TEXT).toContain(
      "ALLOWED_DEV_STORE: ${{ secrets.ALLOWED_DEV_STORE }}",
    );
    expect(WF_TEXT).toContain('echo "::add-mask::$ALLOWED_DEV_STORE"');
    // No literal shop domain anywhere in the workflow.
    expect(WF_TEXT).not.toMatch(/[a-z0-9][a-z0-9-]*\.myshopify\.com/i);
  });

  it("only references the 3 approved gids", () => {
    expect(gidsIn(WF_TEXT)).toEqual(APPROVED);
  });
});

describe("ops-200 SQL", () => {
  it("only references the 3 approved gids", () => {
    expect(gidsIn(SQL)).toEqual(APPROVED);
  });

  it("has exactly one DELETE, from BuyerAccount, inside the apply branch, asserting 3 rows", () => {
    const body = sqlWithoutComments();
    const deletes = body.match(/\bDELETE\s+FROM\s+[^\s;]+/gi) ?? [];
    expect(deletes).toEqual(['DELETE FROM "BuyerAccount"']);
    const applyIdx = body.indexOf("IF v_apply THEN\n    DELETE");
    expect(applyIdx).toBeGreaterThan(0);
    expect(body).toContain(
      "IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_200:deleted_rows_%', v_n; END IF;",
    );
    // `FOR UPDATE` row locks are allowed; no other write statements.
    expect(body.replace(/\bFOR\s+UPDATE\b/gi, "")).not.toMatch(
      /\b(UPDATE|INSERT|TRUNCATE|DROP|ALTER)\b/i,
    );
  });

  it("checks every dependent table before writing", () => {
    for (const code of [
      "matched_rows_",
      "seed_rows_",
      "admin_nodes_not_all_null",
      "invoices_",
      "matches_",
      "rejected_matches_",
      "reminder_logs_",
      "payer_aliases_",
      "draft_orders_",
      "audit_events_",
      "queued_messages_",
      "fk_rows_",
    ]) {
      expect(SQL).toContain(`'refuse_200:${code}`);
    }
    expect(SQL).toContain("c.confrelid = '\"BuyerAccount\"'::regclass");
    expect(SQL.indexOf("refuse_200:fk_rows_")).toBeLessThan(
      SQL.indexOf("DELETE FROM"),
    );
  });

  it("commits only in apply mode, otherwise rolls back", () => {
    expect(SQL).toMatch(/\\if :is_apply\nCOMMIT;\n[^\n]*\n\\else\nROLLBACK;/);
    expect((SQL.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });

  it("never selects the shop domain or sensitive columns", () => {
    const body = sqlWithoutComments();
    expect(body).not.toMatch(/\bSELECT\s+[^;]*\bs\.domain\s+AS/i);
    expect(body).not.toMatch(
      /\b(name|email|"creditLimit"|outstanding|"holdNote"|"accessToken")\b/,
    );
    // The domain is only ever compared, never output.
    for (const m of body.matchAll(
      /current_setting\('ntr200\.shop_domain'\)/g,
    )) {
      const before = body.slice(Math.max(0, (m.index ?? 0) - 12), m.index);
      expect(before).toMatch(/=\s*$/);
    }
  });
});

// is_seed: the two exact per-row formats written by scripts/seed.ts.
//   legacy  (seed.ts #48 90f4d69 .. #163 e04a908): `seed-account-${locationId}`
//   current (scripts/seed.ts:3558 and :3664):      `seed-account-${shopId}-${locationId}`
const IS_SEED_EXPR = `(ba.id = 'seed-account-' || ba."companyLocationId" OR ba.id = 'seed-account-' || ba."shopId" || '-' || ba."companyLocationId")`;

function guardSeedWhere(): string {
  const m = SQL.match(
    /SELECT COUNT\(\*\) INTO v_n FROM "BuyerAccount" ba\n\s+WHERE ba\.id = ANY\(v_ids\)\n\s+AND ([\s\S]*?);\n\s+IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_200:seed_rows_%'/,
  );
  if (!m) throw new Error("seed_rows guard block not found");
  return m[1];
}

describe("ops-200 SQL is_seed (static)", () => {
  it("uses the exact per-row expression in both R1 and the seed_rows guard", () => {
    expect(SQL).toContain(`       ${IS_SEED_EXPR} AS is_seed,`);
    const where = guardSeedWhere();
    expect(where).toBe(
      `${IS_SEED_EXPR}\n    AND ba.id LIKE 'seed-account-%'\n    AND ba.kind = 'COMPANY'`,
    );
    // Exactly those 2 uses; the seed check is still enforced (count must be 3).
    expect(SQL.split(IS_SEED_EXPR).length - 1).toBe(2);
    expect(SQL).toContain(
      "IF v_n <> 3 THEN RAISE EXCEPTION 'refuse_200:seed_rows_%', v_n; END IF;",
    );
  });

  it("matches the formats scripts/seed.ts writes", () => {
    const seedTs = readFileSync(join(ROOT, "scripts/seed.ts"), "utf8");
    const formats = [...new Set(seedTs.match(/`seed-account-[^`]*`/g) ?? [])];
    expect(formats).toEqual(["`seed-account-${shopId}-${locationId}`"]);
  });
});

// Behavioural check: run the SQL file's own guard predicate in Postgres against
// literal rows (no tables touched, nothing written).
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("ops-200 SQL seed_rows guard predicate (Postgres)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, { max: 1 });
  });
  afterAll(async () => {
    await sql?.end();
  });

  const SHOP = "shop-dev-1";
  const OTHER_SHOP = "shop-other-2";

  async function passes(
    id: string,
    shopId: string,
    loc: string,
    kind = "COMPANY",
  ): Promise<boolean> {
    const rows = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM (VALUES ($1::text, $2::text, $3::text, $4::text))
         AS ba(id, "shopId", "companyLocationId", kind)
       WHERE ${guardSeedWhere()}`,
      [id, shopId, loc, kind],
    );
    return rows[0].n === 1;
  }

  it("passes the legacy format for each of the 3 allowlisted gids", async () => {
    for (const gid of APPROVED) {
      expect(await passes(`seed-account-${gid}`, SHOP, gid)).toBe(true);
    }
  });

  it("passes the current shop-scoped format (scripts/seed.ts:3558) for the row's own shop and gid", async () => {
    for (const gid of APPROVED) {
      expect(await passes(`seed-account-${SHOP}-${gid}`, SHOP, gid)).toBe(true);
    }
  });

  it("refuses non-seed / real-looking ids", async () => {
    const gid = APPROVED[0];
    for (const id of [
      "cm2abc123def456ghi789jkl0",
      gid,
      `account-${gid}`,
      `seed-account-`,
      `seed-account-%`,
      `SEED-ACCOUNT-${gid}`,
      `seed-account-${gid}-x`,
      ` seed-account-${gid}`,
    ]) {
      expect(await passes(id, SHOP, gid)).toBe(false);
    }
  });

  it("refuses a seed-format id for another location (wrong gid)", async () => {
    const [a, b] = APPROVED;
    expect(await passes(`seed-account-${b}`, SHOP, a)).toBe(false);
    expect(await passes(`seed-account-${SHOP}-${b}`, SHOP, a)).toBe(false);
    expect(
      await passes("seed-account-gid://shopify/CompanyLocation/1", SHOP, a),
    ).toBe(false);
  });

  it("refuses a shop-scoped seed id from another shop", async () => {
    const gid = APPROVED[0];
    expect(await passes(`seed-account-${OTHER_SHOP}-${gid}`, SHOP, gid)).toBe(
      false,
    );
    expect(await passes(`seed-account-${SHOP}-${gid}`, OTHER_SHOP, gid)).toBe(
      false,
    );
  });

  it("refuses non-COMPANY rows and rows with a null location", async () => {
    const gid = APPROVED[0];
    expect(
      await passes(`seed-account-${gid}`, SHOP, gid, "TAGGED_CUSTOMER"),
    ).toBe(false);
    const rows = await sql.unsafe(
      `SELECT COUNT(*)::int AS n FROM (VALUES ('seed-account-'::text, $1::text, NULL::text, 'COMPANY'::text))
         AS ba(id, "shopId", "companyLocationId", kind)
       WHERE ${guardSeedWhere()}`,
      [SHOP],
    );
    expect(rows[0].n).toBe(0);
  });
});
