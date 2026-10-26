/**
 * Shop identity labels (scripts/ci/shop-labels.ts), DB side.
 *
 * Runs the canonical shop_labels CTE (and the prod-diagnostics entity-count
 * queries that embed it) against a TEMP "Shop" table that shadows the real
 * one inside a rolled-back transaction, with planted fake domains. The psql
 * vars :'allowed' / :'e2e' are bound as $1 / $2.
 *
 * Pins: labels are main / e2e / other_N; planted domains never appear in the
 * output; other_N is stable within a run (two CTE copies in one snapshot
 * agree) and stays contiguous when a new shop whose id sorts first appears
 * (main/e2e unchanged; other_N is NOT identity across runs); empty or equal
 * secrets label every shop 'unknown'.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { sqlOptions } from "../../../app/lib/db-light.server.js";
import { SHOP_LABELS_CTE, SHOP_KIND_RE } from "../shop-labels";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const MAIN = "planted-db-main-store.myshopify.com";
const E2E = "planted-db-e2e-store.myshopify.com";
const OTHERS = ["planted-db-other-a.myshopify.com", "planted-db-other-b.myshopify.com"];
const SHOPS: [string, string][] = [
  ["shop_m", OTHERS[0]],
  ["shop_c", MAIN],
  ["shop_q", OTHERS[1]],
  ["shop_d", E2E],
];
const ALL_DOMAINS = [MAIN, E2E, ...OTHERS, "planted-db-new-first.myshopify.com"];

function bind(sql: string): string {
  return sql.replaceAll(":'allowed'", "$1::text").replaceAll(":'e2e'", "$2::text");
}
const CTE = bind(SHOP_LABELS_CTE);

type Tx = postgres.TransactionSql;
class Rollback extends Error {}

describeWithDb("shop_labels CTE (DB)", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });
  });
  afterAll(async () => {
    await sql.end();
  });

  async function withShops(rows: [string, string][], fn: (tx: Tx) => Promise<void>) {
    await sql
      .begin(async (tx) => {
        await tx.unsafe(
          `CREATE TEMP TABLE "Shop" (id text PRIMARY KEY, domain text NOT NULL UNIQUE, "uninstalledAt" timestamptz) ON COMMIT DROP`,
        );
        for (const [id, domain] of rows) {
          await tx.unsafe(`INSERT INTO pg_temp."Shop" (id, domain) VALUES ($1, $2)`, [id, domain]);
        }
        await fn(tx);
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
  }

  async function labels(tx: Tx, allowed: string, e2e: string): Promise<Record<string, string>> {
    const rows = await tx.unsafe(`WITH ${CTE} SELECT shop_id, shop_kind FROM shop_labels ORDER BY shop_id`, [allowed, e2e]);
    return Object.fromEntries(rows.map((r) => [r.shop_id as string, r.shop_kind as string]));
  }

  it("labels main / e2e / other_N and never outputs a domain", async () => {
    await withShops(SHOPS, async (tx) => {
      const rows = await tx.unsafe(`WITH ${CTE} SELECT * FROM shop_labels`, [MAIN, E2E]);
      expect(Object.keys(rows[0]).sort()).toEqual(["shop_id", "shop_kind"]);
      const out = JSON.stringify(rows);
      for (const d of ALL_DOMAINS) expect(out).not.toContain(d);
      expect(await labels(tx, MAIN, E2E)).toEqual({
        shop_c: "main",
        shop_d: "e2e",
        shop_m: "other_1",
        shop_q: "other_2",
      });
      for (const k of Object.values(await labels(tx, MAIN, E2E))) expect(k).toMatch(SHOP_KIND_RE);
    });
  });

  it("keeps other_N stable within a run when a new shop sorts first", async () => {
    // a new install whose id sorts before every existing shop
    await withShops([["shop_a", "planted-db-new-first.myshopify.com"], ...SHOPS], async (tx) => {
      const got = await labels(tx, MAIN, E2E);
      expect(got.shop_c).toBe("main");
      expect(got.shop_d).toBe("e2e");
      const others = Object.entries(got).filter(([, k]) => k.startsWith("other_"));
      expect(others.map(([, k]) => k).sort()).toEqual(["other_1", "other_2", "other_3"]);
      expect(new Set(others.map(([, k]) => k)).size).toBe(3);
      // two sections of one run (two CTE copies, one snapshot) agree
      const cte2 = CTE.replace(/^shop_labels AS \(/, "shop_labels_b AS (");
      const pairs = await tx.unsafe(
        `WITH ${CTE}, ${cte2}
         SELECT a.shop_kind AS k1, b.shop_kind AS k2
         FROM shop_labels a JOIN shop_labels_b b USING (shop_id)`,
        [MAIN, E2E],
      );
      expect(pairs).toHaveLength(5);
      for (const p of pairs) expect(p.k1).toBe(p.k2);
    });
  });

  it.each([
    ["allowed empty", "", E2E],
    ["e2e empty", MAIN, ""],
    ["both empty", "", ""],
    ["both equal", MAIN, MAIN],
  ])("labels every shop 'unknown' when %s", async (_l, allowed, e2e) => {
    await withShops(SHOPS, async (tx) => {
      expect(new Set(Object.values(await labels(tx, allowed, e2e)))).toEqual(new Set(["unknown"]));
    });
  });

  it("prod-diagnostics entity counts output labels only", async () => {
    const wf = parseYaml(
      readFileSync(join(__dirname, "../../../.github/workflows/prod-diagnostics.yml"), "utf8"),
    ) as { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> };
    const run = Object.values(wf.jobs)
      .flatMap((j) => j.steps ?? [])
      .find((s) => s.name === "Queue and webhook counts")!.run!;
    const queries = [...run.matchAll(/<<'EOSQL'\n([\s\S]*?)\nEOSQL/g)]
      .map((m) => m[1])
      .filter((q) => q.includes("shop_labels"));
    expect(queries).toHaveLength(2);
    await withShops(SHOPS, async (tx) => {
      const table = await tx.unsafe(bind(queries[0]).replace(/;\s*$/, ""), [MAIN, E2E]);
      expect(table.map((r) => r.shop_kind).sort()).toEqual(["e2e", "main", "other_1", "other_2"]);
      const json = await tx.unsafe(bind(queries[1]).replace(/;\s*$/, ""), [MAIN, E2E]);
      const out = JSON.stringify(json);
      for (const d of ALL_DOMAINS) expect(out).not.toContain(d);
      for (const id of SHOPS.map(([i]) => i)) expect(out).not.toContain(id);
      const agg = Object.values(json[0])[0] as { shop_kind: string }[];
      expect(agg.map((r) => r.shop_kind).sort()).toEqual(["e2e", "main", "other_1", "other_2"]);
    });
  });
});
