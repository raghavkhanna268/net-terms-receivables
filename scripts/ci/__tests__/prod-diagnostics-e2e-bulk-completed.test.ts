/**
 * prod-diagnostics: e2e_bulk_ops_completed sits next to e2e_bulk_ops_closed in
 * the E2E sync detail scalars. Counts only; the existing closed count is
 * unchanged; the key/value pass the detail summary allow-list.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW_PATH = join(__dirname, "../../../.github/workflows/prod-diagnostics.yml");

interface Step { name?: string; run?: string; env?: Record<string, string> }
interface Wf { jobs?: Record<string, { steps?: Step[] }> }

const CLOSED_LINE =
  "(10, 'e2e_bulk_ops_closed', (SELECT COUNT(*) FROM bulk WHERE closed_at IS NOT NULL)::text),";
const COMPLETED_LINE =
  "(20, 'e2e_bulk_ops_completed', (SELECT COUNT(*) FROM bulk WHERE completed_at IS NOT NULL)::text),";

describe("prod-diagnostics e2e_bulk_ops_completed", () => {
  let run = "";
  let lines: string[] = [];

  beforeAll(() => {
    const wf = parseYaml(readFileSync(WORKFLOW_PATH, "utf-8")) as Wf;
    const step = (wf.jobs?.e2e_second_shop?.steps ?? []).find((s) => s.name === "E2E DB checks");
    expect(step).toBeDefined();
    run = step?.run ?? "";
    lines = run.split("\n").map((l) => l.trim());
    expect(step?.env?.PGOPTIONS).toBe("-c default_transaction_read_only=on");
  });

  it("keeps e2e_bulk_ops_closed unchanged and adds the completed count right after it", () => {
    expect(lines.filter((l) => l === CLOSED_LINE)).toHaveLength(1);
    expect(lines.filter((l) => l === COMPLETED_LINE)).toHaveLength(1);
    const closedAt = lines.indexOf(CLOSED_LINE);
    const completedAt = lines.indexOf(COMPLETED_LINE);
    expect(completedAt).toBeGreaterThan(closedAt);
    // Only a comment may sit between them.
    for (const l of lines.slice(closedAt + 1, completedAt)) expect(l.startsWith("--")).toBe(true);
    expect((run.match(/'e2e_bulk_ops_completed'/g) ?? []).length).toBe(1);
  });

  it("uses a unique sort key within the scalars block", () => {
    const start = run.indexOf("scalars(o, k, v) AS (VALUES");
    const end = run.indexOf("bulk_rows AS (");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = run.slice(start, end);
    const keys = [...block.matchAll(/^\s*\((\d+), 'e2e_/gm)].map((m) => Number(m[1]));
    expect(keys).toContain(20);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("passes the detail summary allow-list as an integer count", () => {
    const START = "# E2E sync detail summary";
    const END = "# End E2E sync detail";
    const s = run.indexOf(START);
    const e = run.indexOf(END);
    expect(s).toBeGreaterThan(-1);
    expect(e).toBeGreaterThan(s);
    const snippet = run.slice(s, e);
    const dir = mkdtempSync(join(tmpdir(), "diag-bulk-completed-"));
    try {
      const f = join(dir, "detail");
      writeFileSync(f, ["e2e_bulk_ops_closed|2", "e2e_bulk_ops_completed|3", "e2e_bulk_ops_completed|gid://x/1"].join("\n") + "\n");
      const res = spawnSync("bash", ["-c", `set -euo pipefail\nDETAIL_OUT="$1"\n${snippet}`, "probe", f], {
        encoding: "utf-8",
      });
      expect(res.status).toBe(0);
      expect(res.stdout.trim().split("\n")).toEqual([
        "e2e_bulk_ops_closed=2",
        "e2e_bulk_ops_completed=3",
        "e2e_bulk_ops_completed=invalid",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
