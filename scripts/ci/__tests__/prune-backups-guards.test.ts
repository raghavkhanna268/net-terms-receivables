/**
 * Guard tests for scripts/ops/prune-backups.ts with pruning enabled.
 *
 * Covers the rails for real deletion: db/ prefix only, keep-newest-7 enforced
 * in code even when age says delete, no deletion when fewer than 7 objects are
 * listed or the listing fails, fail-closed mode/listing handling, counts-only
 * output, and the db-backup.yml mode wiring (schedule deletes; manual dispatch
 * is a dry run unless dry_run=false).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  checkDeletionPlan,
  main,
  resolvePruneMode,
  selectForDeletion,
  validateListing,
  KEEP_NEWEST,
  PREFIX,
  RETENTION_DAYS,
  type S3Object,
} from "../../ops/prune-backups.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-27T00:00:00Z");

function obj(key: string, daysAgo: number, now = NOW): S3Object {
  return { Key: key, LastModified: new Date(now - daysAgo * DAY_MS).toISOString() };
}

/** n daily backups, newest 0.5 days old, then one per day older. */
function daily(n: number, now = NOW): S3Object[] {
  return Array.from({ length: n }, (_, i) => obj(`db/b${String(i).padStart(3, "0")}`, i + 0.5, now));
}

describe("resolvePruneMode", () => {
  it("unset or empty is dry_run", () => {
    expect(resolvePruneMode(undefined)).toBe("dry_run");
    expect(resolvePruneMode("")).toBe("dry_run");
  });
  it("accepts exactly dry_run and delete", () => {
    expect(resolvePruneMode("dry_run")).toBe("dry_run");
    expect(resolvePruneMode("delete")).toBe("delete");
  });
  it("rejects anything else", () => {
    for (const v of ["Delete", "DELETE", "true", "dryrun", " delete", "delete "]) {
      expect(resolvePruneMode(v)).toBeNull();
    }
  });
});

describe("validateListing", () => {
  it("accepts well-formed entries and an empty list", () => {
    expect(validateListing(daily(3))).toBe(true);
    expect(validateListing([])).toBe(true);
  });
  it("rejects non-arrays, missing keys and unparseable dates", () => {
    expect(validateListing(null)).toBe(false);
    expect(validateListing({})).toBe(false);
    expect(validateListing([{ LastModified: "2026-01-01T00:00:00Z" }])).toBe(false);
    expect(validateListing([{ Key: "", LastModified: "2026-01-01T00:00:00Z" }])).toBe(false);
    expect(validateListing([{ Key: "db/a" }])).toBe(false);
    expect(validateListing([{ Key: "db/a", LastModified: "not-a-date" }])).toBe(false);
    expect(validateListing([null])).toBe(false);
  });
});

describe("checkDeletionPlan (independent keep-newest-7 re-check)", () => {
  it("accepts the plan selectForDeletion makes", () => {
    const objects = daily(40);
    const plan = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, NOW);
    expect(plan.length).toBeGreaterThan(0);
    expect(checkDeletionPlan(objects, plan, PREFIX, RETENTION_DAYS, KEEP_NEWEST, NOW).ok).toBe(true);
  });

  it("refuses a plan that touches any of the newest 7, even when all are >30 days old", () => {
    const objects = Array.from({ length: 10 }, (_, i) => obj(`db/old${i}`, 40 + i));
    // db/old0 is the newest, and old, so age alone would delete it
    const r = checkDeletionPlan(objects, ["db/old0"], PREFIX, RETENTION_DAYS, KEEP_NEWEST, NOW);
    expect(r).toEqual({ ok: false, reason: "plan_hits_keep_newest" });
  });

  it("refuses any deletion when fewer than 7 objects are listed", () => {
    const objects = Array.from({ length: 6 }, (_, i) => obj(`db/old${i}`, 40 + i));
    const r = checkDeletionPlan(objects, ["db/old5"], PREFIX, RETENTION_DAYS, KEEP_NEWEST, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^total_below_keep_newest/);
  });

  it("refuses a plan that would leave fewer than 7", () => {
    const objects = Array.from({ length: 8 }, (_, i) => obj(`db/old${i}`, 40 + i));
    const r = checkDeletionPlan(objects, ["db/old6", "db/old7"], PREFIX, RETENTION_DAYS, KEEP_NEWEST, NOW);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/^plan_leaves_below_keep_newest/);
  });

  it("refuses keys outside the prefix, unlisted, duplicated, or not past retention", () => {
    const objects = daily(40);
    const chk = (keys: string[]) => checkDeletionPlan(objects, keys, PREFIX, RETENTION_DAYS, KEEP_NEWEST, NOW).reason;
    expect(chk(["other/b039"])).toBe("plan_prefix_violation");
    expect(chk(["db/nope"])).toBe("plan_key_not_listed");
    expect(chk(["db/b039", "db/b039"])).toBe("plan_duplicate_key");
    expect(chk(["db/b010"])).toBe("plan_not_past_retention");
  });

  it("an empty plan is always fine", () => {
    expect(checkDeletionPlan([], [], PREFIX, RETENTION_DAYS, KEEP_NEWEST, NOW).ok).toBe(true);
  });
});

// ─── main() end to end with a mocked aws CLI ────────────────────────────────

type Call = string[];

function mockAws(listing: { status: number; stdout: string }, deleteStatus: (key: string) => number = () => 0) {
  const calls: Call[] = [];
  spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
    calls.push(args);
    if (args.includes("list-objects-v2")) {
      return { status: listing.status, stdout: listing.stdout };
    }
    if (args.includes("delete-object")) {
      const key = args[args.indexOf("--key") + 1];
      return { status: deleteStatus(key), stdout: "" };
    }
    return { status: 1, stdout: "" };
  });
  return calls;
}

const deletes = (calls: Call[]) => calls.filter((a) => a.includes("delete-object")).map((a) => a[a.indexOf("--key") + 1]);
const listing = (objects: unknown[]) => ({ status: 0, stdout: JSON.stringify({ Contents: objects }) });

describe("main(): guards around real deletion", () => {
  let logs: string[];
  const env = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void logs.push(String(m)));
    process.env.R2_BUCKET = "ntr-db-backups";
    process.env.R2_ENDPOINT = "https://r2.invalid";
    process.env.PRUNE_MODE = "delete";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    spawnSyncMock.mockReset();
    process.env = { ...env };
  });

  it("deletes only >30d objects beyond the newest 7, and lists with the db/ prefix", async () => {
    const objects = daily(40);
    const calls = mockAws(listing(objects));
    expect(await main()).toBe(0);
    const list = calls.find((a) => a.includes("list-objects-v2"))!;
    expect(list[list.indexOf("--prefix") + 1]).toBe("db/");
    const expected = selectForDeletion(objects, RETENTION_DAYS, KEEP_NEWEST, NOW);
    expect(deletes(calls).sort()).toEqual([...expected].sort());
    expect(deletes(calls).every((k) => k.startsWith("db/"))).toBe(true);
    // b000..b029 are <=30 days old (0.5..29.5) and kept
    expect(deletes(calls).some((k) => k <= "db/b029")).toBe(false);
  });

  it("keeps the newest 7 even when every object is older than 30 days", async () => {
    const objects = Array.from({ length: 12 }, (_, i) => obj(`db/old${String(i).padStart(2, "0")}`, 31 + i));
    // newest is 31 days old -> sanity floor (newest > 48h) blocks the run entirely
    const calls = mockAws(listing(objects));
    expect(await main()).toBe(1);
    expect(deletes(calls)).toEqual([]);
    expect(logs.join("\n")).toMatch(/prune_blocked=true reason=newest_too_old/);
  });

  it("refuses to delete when fewer than 7 objects are listed (no-op, exit 0)", async () => {
    const objects = Array.from({ length: 6 }, (_, i) => obj(`db/old${i}`, 40 + i));
    const calls = mockAws(listing(objects));
    expect(await main()).toBe(0);
    expect(deletes(calls)).toEqual([]);
    expect(logs.join("\n")).toMatch(/prune_refused=true reason=total_below_keep_newest total=6 .*deleted=0/);
  });

  it("fails closed when the listing fails", async () => {
    const calls = mockAws({ status: 255, stdout: "" });
    expect(await main()).toBe(1);
    expect(deletes(calls)).toEqual([]);
    expect(logs).toContain("prune_error=true reason=list_failed");
  });

  it("fails closed on unparseable or truncated listings", async () => {
    for (const stdout of ["not json", "null", JSON.stringify({ Contents: daily(20), NextToken: "x" }), JSON.stringify({ Contents: daily(20), IsTruncated: true }), JSON.stringify({ Contents: "x" })]) {
      logs = [];
      const calls = mockAws({ status: 0, stdout });
      expect(await main()).toBe(1);
      expect(deletes(calls)).toEqual([]);
      expect(logs).toContain("prune_error=true reason=list_failed");
    }
  });

  it("fails closed when a listed entry has a bad date", async () => {
    const objects: unknown[] = [...daily(39), { Key: "db/bad", LastModified: "garbage" }];
    const calls = mockAws(listing(objects));
    expect(await main()).toBe(1);
    expect(deletes(calls)).toEqual([]);
    expect(logs).toContain("prune_error=true reason=invalid_listing");
  });

  it("fails closed when any key is outside db/", async () => {
    const calls = mockAws(listing([...daily(39), obj("other/x", 90)]));
    expect(await main()).toBe(1);
    expect(deletes(calls)).toEqual([]);
    expect(logs).toContain("prune_error=true reason=prefix_guard_failed");
  });

  it("rejects an unknown PRUNE_MODE before listing", async () => {
    process.env.PRUNE_MODE = "Delete";
    const calls = mockAws(listing(daily(40)));
    expect(await main()).toBe(1);
    expect(calls).toEqual([]);
    expect(logs).toContain("prune_error=true reason=invalid_mode");
  });

  it("dry_run deletes nothing and prints counts only", async () => {
    process.env.PRUNE_MODE = "dry_run";
    const calls = mockAws(listing(daily(40)));
    expect(await main()).toBe(0);
    expect(deletes(calls)).toEqual([]);
    expect(logs).toEqual(["prune_mode=dry_run total=40 eligible=10 kept=30 newest_age_hours=12"]);
  });

  it("stops at the first failed delete and exits non-zero", async () => {
    const calls = mockAws(listing(daily(40)), () => 1);
    expect(await main()).toBe(1);
    expect(deletes(calls)).toHaveLength(1);
    expect(logs).toContain("prune_error=true reason=partial_delete_failure");
  });

  it("output is counts/enums only (no keys)", async () => {
    mockAws(listing(daily(40)));
    expect(await main()).toBe(0);
    expect(logs).toEqual(["prune_mode=delete total=40 eligible=10 kept=30 deleted=10 newest_age_hours=12"]);
    for (const line of logs) {
      expect(line).not.toMatch(/db\//);
      expect(line).toMatch(/^[a-z_]+=[a-z_0-9]+( [a-z_]+=[a-z_0-9]+)*$/);
    }
  });
});

describe("db-backup.yml prune wiring", () => {
  const wf = parse(readFileSync(join(__dirname, "../../../.github/workflows/db-backup.yml"), "utf8"));
  const input = wf.on.workflow_dispatch.inputs.dry_run;
  const step = wf.jobs.prune.steps.find((s: { name?: string }) => s.name === "Prune eligible backups");
  const expr: string = step.env.PRUNE_MODE;

  /**
   * Evaluates the PRUNE_MODE `${{ }}` expression for an event. Only the
   * operators used here are supported (==, &&, ||, parentheses, literals);
   * anything else in the expression fails the test. `inputs.dry_run` is
   * null outside workflow_dispatch, as in GitHub's inputs context.
   */
  function resolveMode(event: string, dryRun: boolean | null): string {
    const m = /^\$\{\{ (.*) \}\}$/.exec(expr);
    expect(m).not.toBeNull();
    const body = m![1];
    const allowed = body
      .replace(/github\.event_name|inputs\.dry_run|'[a-z_]+'|==|&&|\|\||\(|\)|false|true|\s+/g, "");
    expect(allowed).toBe("");
    const js = body
      .replace(/github\.event_name/g, "ctx.event")
      .replace(/inputs\.dry_run/g, "ctx.dryRun")
      .replace(/==/g, "===");
    return new Function("ctx", `return (${js});`)({ event, dryRun }) as string;
  }

  it("manual dispatch has a boolean dry_run input that defaults to true", () => {
    expect(input.type).toBe("boolean");
    expect(input.default).toBe(true);
    expect(wf.on.workflow_dispatch.inputs.prune_mode).toBeUndefined();
  });

  it("schedule -> delete (real)", () => {
    expect(resolveMode("schedule", null)).toBe("delete");
  });

  it("dispatch with the default (dry_run=true) -> dry_run", () => {
    expect(resolveMode("workflow_dispatch", input.default)).toBe("dry_run");
    expect(resolveMode("workflow_dispatch", true)).toBe("dry_run");
  });

  it("dispatch with explicit dry_run=false -> delete (real)", () => {
    expect(resolveMode("workflow_dispatch", false)).toBe("delete");
  });

  it("any other event, or a missing input, falls back to dry_run", () => {
    expect(resolveMode("push", null)).toBe("dry_run");
    expect(resolveMode("workflow_dispatch", null)).toBe("dry_run");
  });

  it("the only triggers are schedule and workflow_dispatch", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("prune runs only after a successful backup, on main", () => {
    expect(wf.jobs.prune.needs).toBe("backup");
    expect(wf.jobs.prune.if).toBe("github.ref == 'refs/heads/main'");
  });

  it("runs the guarded script, with no inline aws delete in the workflow", () => {
    expect(step.run).toContain("node --experimental-strip-types scripts/ops/prune-backups.ts");
    expect(JSON.stringify(wf.jobs.prune)).not.toMatch(/delete-object|aws s3 rm/);
  });
});
