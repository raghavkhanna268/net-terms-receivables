import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildHeldCreditStatusUpdate,
  countCurrencies,
  currencyBucket,
  formatSummary,
  ownerGidOf,
  reseedHeldFixtureCurrency,
  HELD_FIXTURE_MAX,
  type HeldFixtureDeps,
  type HeldFixtureRow,
  type OwnerMetafield,
} from "../lib/held-fixture-currency";

const LOC_A = "gid://shopify/CompanyLocation/1001";
const LOC_B = "gid://shopify/CompanyLocation/1002";
const CUST_C = "gid://shopify/Customer/2003";
const NOW = new Date("2026-10-26T05:00:00.000Z");

function status(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    currencyCode: "USD",
    hold: true,
    holdReasonCode: "MANUAL_HOLD",
    limitPaise: "5000000",
    exposurePaise: "1234500",
    updatedAt: "2026-10-20T00:00:00.000Z",
    ...over,
  };
}

function mf(value: unknown, digest = "d1"): OwnerMetafield {
  return { jsonValue: value, compareDigest: digest };
}

/** In-memory Shopify: writes mutate the store so the after-read reflects them. */
function makeDeps(
  initial: Record<string, OwnerMetafield | null>,
  rows: HeldFixtureRow[] = [
    { id: "seed-account-s-1", companyLocationId: LOC_A, customerId: null },
    { id: "seed-account-s-2", companyLocationId: LOC_B, customerId: null },
  ],
  over: Partial<HeldFixtureDeps> = {}
) {
  const store = new Map<string, OwnerMetafield | null>(Object.entries(initial));
  const writes: Array<{ ownerId: string; value: string; compareDigest: string | null }> = [];
  const lines: string[] = [];
  const deps: HeldFixtureDeps = {
    shopCurrency: "INR",
    dryRun: false,
    loadHeldFixtures: async () => rows,
    readMetafields: async (ids) => {
      const out = new Map<string, OwnerMetafield | null>();
      for (const id of ids) if (store.has(id)) out.set(id, store.get(id) ?? null);
      return out;
    },
    writeMetafield: async (ownerId, value, compareDigest) => {
      writes.push({ ownerId, value, compareDigest });
      store.set(ownerId, mf(JSON.parse(value), "d2"));
      return true;
    },
    now: () => NOW,
    log: (l) => lines.push(l),
    ...over,
  };
  return { deps, store, writes, lines };
}

describe("held-fixture-currency pure helpers", () => {
  it("ownerGidOf prefers CompanyLocation and rejects non-GID values", () => {
    expect(ownerGidOf({ id: "x", companyLocationId: LOC_A, customerId: CUST_C })).toBe(LOC_A);
    expect(ownerGidOf({ id: "x", companyLocationId: null, customerId: CUST_C })).toBe(CUST_C);
    expect(ownerGidOf({ id: "x", companyLocationId: "local-1", customerId: null })).toBeNull();
    expect(ownerGidOf({ id: "x", companyLocationId: null, customerId: null })).toBeNull();
  });

  it("currencyBucket classifies INR / USD / other / absent (string or object jsonValue)", () => {
    expect(currencyBucket(mf(status({ currencyCode: "INR" })))).toBe("INR");
    expect(currencyBucket(mf(JSON.stringify(status())))).toBe("USD");
    expect(currencyBucket(mf(status({ currencyCode: "EUR" })))).toBe("other");
    expect(currencyBucket(null)).toBe("absent");
    expect(currencyBucket(mf(null))).toBe("absent");
  });

  it("buildHeldCreditStatusUpdate changes only currencyCode, hold and updatedAt", () => {
    const before = status();
    const next = buildHeldCreditStatusUpdate(mf(before), "INR", NOW);
    expect(next).toEqual({ ...before, currencyCode: "INR", hold: true, updatedAt: NOW.toISOString() });
  });

  it("buildHeldCreditStatusUpdate also sets hold=true on a held fixture whose metafield says hold=false", () => {
    const next = buildHeldCreditStatusUpdate(mf(status({ currencyCode: "INR", hold: false })), "INR", NOW);
    expect(next?.hold).toBe(true);
    expect(next?.currencyCode).toBe("INR");
  });

  it("is idempotent: INR + hold=true needs no write", () => {
    expect(buildHeldCreditStatusUpdate(mf(status({ currencyCode: "INR" })), "INR", NOW)).toBeNull();
  });

  it("never creates a metafield and leaves unknown schema versions alone", () => {
    expect(buildHeldCreditStatusUpdate(null, "INR", NOW)).toBeNull();
    expect(buildHeldCreditStatusUpdate(mf(status({ schemaVersion: 2 })), "INR", NOW)).toBeNull();
  });

  it("countCurrencies counts buckets and hold=true", () => {
    expect(
      countCurrencies([mf(status()), mf(status({ currencyCode: "INR", hold: false })), null])
    ).toEqual({ INR: 1, USD: 1, other: 0, absent: 1, hold_true: 1 });
  });
});

describe("reseedHeldFixtureCurrency", () => {
  it("updates the 2 held USD fixtures in place to INR and verifies (held INR 2 / USD 0)", async () => {
    const { deps, writes, lines } = makeDeps({ [LOC_A]: mf(status()), [LOC_B]: mf(status(), "d9") });
    const res = await reseedHeldFixtureCurrency(deps);
    expect(res.ok).toBe(true);
    expect(writes.map((w) => w.ownerId).sort()).toEqual([LOC_A, LOC_B]);
    expect(writes.find((w) => w.ownerId === LOC_B)?.compareDigest).toBe("d9");
    expect(res.summary).toMatchObject({
      mode: "apply",
      target_currency: "INR",
      held_total: 2,
      owner_missing: 0,
      before: { INR: 0, USD: 2, other: 0, absent: 0, hold_true: 2 },
      would_update: 2,
      updated: 2,
      unchanged: 0,
      failed: 0,
      after: { INR: 2, USD: 0, other: 0, absent: 0, hold_true: 2 },
    });
    expect(lines).toHaveLength(1);
  });

  it("second run is a no-op (no duplicates, no writes)", async () => {
    const { deps, writes } = makeDeps({ [LOC_A]: mf(status()), [LOC_B]: mf(status()) });
    await reseedHeldFixtureCurrency(deps);
    writes.length = 0;
    const res = await reseedHeldFixtureCurrency(deps);
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(0);
    expect(res.summary).toMatchObject({ would_update: 0, updated: 0, unchanged: 2 });
  });

  it("dry run writes nothing and reports would_update", async () => {
    const { deps, writes } = makeDeps({ [LOC_A]: mf(status()), [LOC_B]: mf(status()) }, undefined, { dryRun: true });
    const res = await reseedHeldFixtureCurrency(deps);
    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(0);
    expect(res.summary).toMatchObject({ mode: "dry_run", would_update: 2, updated: 0, after: null });
  });

  it("refuses when the shop currency is not INR, before any read", async () => {
    const load = vi.fn(async () => []);
    const { deps } = makeDeps({}, undefined, { shopCurrency: "USD", loadHeldFixtures: load });
    const res = await reseedHeldFixtureCurrency(deps);
    expect(res).toMatchObject({ ok: false, reason: "shop_currency_not_target" });
    expect(load).not.toHaveBeenCalled();
  });

  it("refuses with no held fixtures and with more than the cap", async () => {
    const none = makeDeps({}, []);
    expect(await reseedHeldFixtureCurrency(none.deps)).toMatchObject({ ok: false, reason: "no_held_fixtures" });
    const many = Array.from({ length: HELD_FIXTURE_MAX + 1 }, (_, i) => ({
      id: `seed-account-s-${i}`,
      companyLocationId: `gid://shopify/CompanyLocation/${3000 + i}`,
      customerId: null,
    }));
    const lots = makeDeps({}, many);
    expect(await reseedHeldFixtureCurrency(lots.deps)).toMatchObject({ ok: false, reason: "too_many_held_fixtures" });
    expect(lots.writes).toHaveLength(0);
  });

  it("ignores non-seed rows even if the loader returns them", async () => {
    const { deps, writes } = makeDeps(
      { [LOC_A]: mf(status()), [LOC_B]: mf(status()) },
      [
        { id: "seed-account-s-1", companyLocationId: LOC_A, customerId: null },
        { id: "real-account-1", companyLocationId: LOC_B, customerId: null },
      ]
    );
    const res = await reseedHeldFixtureCurrency(deps);
    expect(res.summary?.held_total).toBe(1);
    expect(writes.map((w) => w.ownerId)).toEqual([LOC_A]);
  });

  it("counts absent metafields and missing owners without writing them", async () => {
    const { deps, writes } = makeDeps(
      { [LOC_A]: mf(status()), [CUST_C]: null },
      [
        { id: "seed-account-s-1", companyLocationId: LOC_A, customerId: null },
        { id: "seed-account-s-2", companyLocationId: null, customerId: CUST_C },
        { id: "seed-account-s-3", companyLocationId: LOC_B, customerId: null }, // not returned by Shopify
      ]
    );
    const res = await reseedHeldFixtureCurrency(deps);
    expect(writes.map((w) => w.ownerId)).toEqual([LOC_A]);
    expect(res.summary).toMatchObject({ held_total: 3, owner_missing: 1, before: { absent: 1, USD: 1 } });
  });

  it("fails (non-ok) when a write fails, without retrying", async () => {
    const write = vi.fn(async () => false);
    const { deps } = makeDeps({ [LOC_A]: mf(status()), [LOC_B]: mf(status()) }, undefined, { writeMetafield: write });
    const res = await reseedHeldFixtureCurrency(deps);
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });
    expect(write).toHaveBeenCalledTimes(2);
    expect(res.summary).toMatchObject({ updated: 0, failed: 2, after: { USD: 2 } });
  });

  it("public output: summary has counts/enums only (no GIDs, domains, money, ids)", async () => {
    const { deps, lines } = makeDeps({ [LOC_A]: mf(status()), [LOC_B]: mf(status()) });
    const res = await reseedHeldFixtureCurrency(deps);
    const out = lines.join("\n") + formatSummary(res.summary!);
    expect(out).not.toMatch(/gid:\/\//);
    expect(out).not.toMatch(/\b\d{6,}\b/);
    expect(out).not.toMatch(/myshopify\.com|[a-z0-9-]+\.[a-z]{2,}\//i);
    expect(out).not.toMatch(/seed-account-/);
    expect(out).not.toMatch(/Paise|5000000|1234500/);
  });
});

describe("seed-dev-store.yml wiring", () => {
  const wf = fs.readFileSync(path.join(__dirname, "../../.github/workflows/seed-dev-store.yml"), "utf-8");

  it("exposes reseed_held_currency as a boolean input passed via env (no inline interpolation)", () => {
    expect(wf).toMatch(/reseed_held_currency:\n\s+description:[^\n]+\n\s+type: boolean\n\s+default: false/);
    expect(wf).toContain("INPUT_RESEED_HELD_CURRENCY: ${{ inputs.reseed_held_currency }}");
    const steps = wf.slice(wf.indexOf("    steps:"));
    expect(steps).not.toContain("inputs.reseed_held_currency");
  });

  it("runs the re-seed mode and exits before any reset/seed path, and takes no shop input", () => {
    const runIdx = wf.indexOf("--reseed-held-currency");
    expect(runIdx).toBeGreaterThan(-1);
    expect(runIdx).toBeLessThan(wf.indexOf('ARGS+=("--reset")'));
    expect(wf).not.toMatch(/inputs:[\s\S]*\bshop(_domain)?:/);
  });
});
