/**
 * scripts/readonly/initial-sync-timing.sql, DB side: closed-run coverage.
 *
 * Plants one shop with an open Initial Sync run, a run closed (reinstall_reset)
 * 5 hours ago and a run closed 30 hours ago, plus pgmq archive rows, inside a
 * rolled-back transaction, then runs the shop-scoped statements (shop
 * selection through 2a; 3b needs pg_cron, which CI lacks) with the psql vars
 * bound as $1..$4 (shop_idx, e2e, allowed, closed_window_hours).
 *
 * Pins: the open run is always reported; a closed run is included only when
 * its closed_at falls within the clamped window (SQL clamp 1..168 as well as
 * the workflow's); a closed run's ops stop at the next companies anchor; 1c
 * percentiles cover closed runs only; planted domains and GIDs never appear
 * in the output.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sqlOptions } from "../../../app/lib/db-light.server.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const SUFFIX = Date.now().toString(36);
const E2E = `planted-ist-closed-${SUFFIX}.myshopify.com`;
const ALLOWED = `planted-ist-allowed-${SUFFIX}.myshopify.com`;
const GID = (n: string) => `gid://shopify/BulkOperation/planted-ist-${SUFFIX}-${n}`;

const raw = readFileSync(join(__dirname, "../../readonly/initial-sync-timing.sql"), "utf8");

/** Statements between `== <from>` and `== <to>`, keyed by section label. */
function sections(from: string, to: string): Map<string, string> {
  const body = raw.slice(raw.indexOf(`\\echo '== ${from}`), raw.indexOf(`\\echo '== ${to}`));
  const out = new Map<string, string>();
  for (const chunk of body.split(/^\\echo '== /m).filter((c) => c.trim())) {
    const label = chunk.slice(0, chunk.search(/[ .]/));
    const stmt = chunk
      .slice(chunk.indexOf("\n") + 1)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n")
      .replaceAll(":'shop_idx'", "$1::text")
      .replaceAll(":'e2e'", "$2::text")
      .replaceAll(":'allowed'", "$3::text")
      .replaceAll(":'closed_window_hours'", "$4::text")
      .trim()
      .replace(/;$/, "");
    expect(stmt).not.toMatch(/(?<!:):'?[a-z_]+'?/);
    out.set(label, stmt);
  }
  return out;
}
const STMTS = sections("shop selection", "2b.");

type Tx = postgres.TransactionSql;
type Row = Record<string, unknown>;
class Rollback extends Error {}

describeWithDb("initial-sync-timing.sql closed runs (DB)", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, max: 1 });
  });
  afterAll(async () => {
    await sql.end();
  });

  async function planted(fn: (tx: Tx) => Promise<void>) {
    await sql
      .begin(async (tx) => {
        await tx.unsafe(
          `INSERT INTO "Shop" (domain, timezone, currency, plan_key, "createdAt", "updatedAt")
           VALUES ($1, 'America/New_York', 'INR', 'starter', NOW(), NOW())`,
          [E2E],
        );
        // [gid, stage, started h ago, finish_received h ago, completed h ago, closed h ago]
        const ops: [string, string, number, number | null, number | null, number | null][] = [
          // closed 30h ago (outside 24h, inside 48h)
          [GID("old-c"), "companies", 40, 39.9, 39.8, 30],
          [GID("old-u"), "customers", 39.5, 39.4, 39.3, null],
          // closed 5h ago
          [GID("new-c"), "companies", 10, 9.9, 9.8, 5],
          [GID("new-u"), "customers", 9.5, 9.4, 9.3, null],
          [GID("new-o"), "orders", 9, 8.9, 8.5, null],
          // open run
          [GID("open-c"), "companies", 1, 0.9, 0.8, null],
          [GID("open-u"), "customers", 0.5, null, null, null],
        ];
        for (const [id, stage, st, fr, co, cl] of ops) {
          await tx.unsafe(
            `INSERT INTO s6_bulk_operations
               (bulk_operation_id, shop, bulk_type, origin, reconcile_stage, started_at,
                finish_received_at, completed_at, closed_at, closed_reason, failure_count)
             VALUES ($1, $2, $3, 'reconcile', $3,
                     NOW() - make_interval(secs => $4::float8 * 3600),
                     NOW() - make_interval(secs => $5::float8 * 3600),
                     NOW() - make_interval(secs => $6::float8 * 3600),
                     NOW() - make_interval(secs => $7::float8 * 3600),
                     CASE WHEN $7::float8 IS NULL THEN NULL ELSE 'reinstall_reset' END, 0)`,
            [id, E2E, stage, st, fr, co, cl],
          );
        }
        // Start sync enqueue 60s before each companies anchor, plus a FINISH webhook
        const base = 9_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
        const arch: [string, string, number][] = [
          ["a_s6_sync", "RECONCILE_COMPANIES", 40],
          ["a_s6_sync", "RECONCILE_COMPANIES", 10],
          ["a_s6_sync", "RECONCILE_COMPANIES", 1],
          ["a_s6_bulk", "BULK_OPERATIONS_FINISH", 9.9],
        ];
        let i = 0;
        for (const [table, topic, h] of arch) {
          await tx.unsafe(
            `INSERT INTO pgmq.${table} (msg_id, read_ct, enqueued_at, archived_at, vt, message)
             VALUES ($1, 1,
                     NOW() - make_interval(secs => $2::float8 * 3600 + 60),
                     NOW() - make_interval(secs => $2::float8 * 3600 + 30),
                     NOW() - make_interval(secs => $2::float8 * 3600 + 30),
                     jsonb_build_object('topic', $3::text, 'shop', $4::text))`,
            [base + i++, h, topic, E2E],
          );
        }
        await fn(tx);
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
  }

  async function run(tx: Tx, label: string, hours: string): Promise<Row[]> {
    const stmt = STMTS.get(label)!;
    // bind only the $n a statement uses (Postgres cannot type an unused $4)
    const n = Math.max(...[...stmt.matchAll(/\$(\d)/g)].map((m) => Number(m[1])));
    const rows = await tx.unsafe(stmt, ["1", E2E, ALLOWED, hours].slice(0, n));
    const out = JSON.stringify(rows);
    expect(out).not.toContain(E2E);
    expect(out).not.toContain("planted-ist");
    expect(out).not.toContain("gid://");
    return [...rows] as Row[];
  }

  it("covers sections shop selection, 1, 1b, 1c and 2a", () => {
    expect([...STMTS.keys()]).toEqual(["shop", "1", "1b", "1c", "2a"]);
  });

  it("resolves the planted shop via shop_idx 1", async () => {
    await planted(async (tx) => {
      const [r] = await run(tx, "shop", "24");
      expect(r.shop_resolved).toBe(true);
    });
  });

  it("24h window: open run plus only the run closed 5h ago", async () => {
    await planted(async (tx) => {
      const ops = await run(tx, "1", "24");
      const by = (s: string) => ops.filter((r) => r.status === s);
      expect(by("open").map((r) => r.stage)).toEqual(["companies", "customers"]);
      expect(by("closed").map((r) => r.stage)).toEqual(["companies", "customers", "orders"]);
      expect(new Set(ops.map((r) => String(r.run_idx)))).toEqual(new Set(["1", "2"]));

      const sum = await run(tx, "1b", "24");
      expect(sum.map((r) => [r.status, String(r.run_idx), Number(r.ops)])).toEqual([
        ["open", "1", 2],
        ["closed", "2", 3],
      ]);
      const closed = sum[1];
      expect(closed.run_closed_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(sum[0].run_closed_utc).toBeNull();
      expect(Number(closed.ops_completed)).toBe(3);
      expect(closed.enqueue_to_first_start_sec).toBe(60);
      expect(closed.start_to_last_completed_sec).toBe(1.5 * 3600);

      const pct = await run(tx, "1c", "24");
      const total = pct.find((r) => r.scope === "run_total")!;
      expect(Number(total.closed_runs)).toBe(1);
      expect(total.wall_max_sec).toBe(1.5 * 3600);
      const comp = pct.find((r) => r.scope === "companies")!;
      expect(Number(comp.closed_runs)).toBe(1);
      expect(comp.wall_p50_sec).toBe(720);
      expect(pct.map((r) => r.scope).sort()).toEqual(["companies", "customers", "orders", "run_total"]);

      const q = await run(tx, "2a", "24");
      expect(new Set(q.map((r) => r.status))).toEqual(new Set(["open", "closed"]));
      const qc = q.filter((r) => r.status === "closed");
      expect(qc.map((r) => [r.queue, r.topic, Number(r.msgs)])).toEqual([
        ["s6_bulk", "BULK_OPERATIONS_FINISH", 1],
        ["s6_sync", "RECONCILE_COMPANIES", 1],
      ]);
    });
  });

  it("48h window adds the run closed 30h ago, bounded by the next anchor", async () => {
    await planted(async (tx) => {
      const sum = await run(tx, "1b", "48");
      expect(sum.map((r) => [r.status, String(r.run_idx), Number(r.ops)])).toEqual([
        ["open", "1", 2],
        ["closed", "2", 3],
        ["closed", "3", 2],
      ]);
      const pct = await run(tx, "1c", "48");
      expect(Number(pct.find((r) => r.scope === "run_total")!.closed_runs)).toBe(2);
      expect(Number(pct.find((r) => r.scope === "customers")!.ops)).toBe(2);
    });
  });

  it.each([
    ["0 (clamped up to 1h)", "0", ["open"]],
    ["6", "6", ["open", "closed"]],
    ["1000 (clamped down to 168h)", "1000", ["open", "closed", "closed"]],
  ])("clamps closed_window_hours %s in SQL as well", async (_l, hours, want) => {
    await planted(async (tx) => {
      const sum = await run(tx, "1b", hours);
      expect(sum.map((r) => r.status)).toEqual(want);
    });
  });

  it("reports no closed runs and no 1c stage rows when nothing closed in the window", async () => {
    await planted(async (tx) => {
      const pct = await run(tx, "1c", "1");
      expect(pct.map((r) => [r.scope, Number(r.closed_runs)])).toEqual([["run_total", 0]]);
    });
  });
});
