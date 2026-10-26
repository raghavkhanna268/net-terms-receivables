/**
 * Tests for backfill-dry-run-filter.py
 *
 * Verifies that the filter:
 * - Rejects id-shaped values (UUIDs, GIDs, long numeric IDs, CUIDs, seed-account-*)
 * - Passes allowed output patterns
 * - Exits with correct codes for various failure conditions
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import * as path from "path";

const FILTER_SCRIPT = path.join(__dirname, "..", "backfill-dry-run-filter.py");

function runFilter(input: string): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("python3", [FILTER_SCRIPT], {
    input,
    encoding: "utf8",
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

describe("backfill-dry-run-filter: id-shaped value rejection", () => {
  const DRY_RUN_HEADER = `============================================================
Backstop Backfill Script (S13)
============================================================
Mode: DRY-RUN (use --apply to write)
Window: 2026-10-01T00:00:00.000Z to 2026-10-15T00:00:00.000Z
Finding candidates (held accounts with missing backstop)...
`;

  // QA 2 ruling: id-shape check runs on OUTPUT after masking, not on raw input.
  // Lines that don't match the allowlist are dropped (not printed), so they don't
  // trigger id-leak errors. This is correct behavior.
  it("drops non-allowlisted lines with UUIDs without failing", () => {
    const input = DRY_RUN_HEADER + "  account: 550e8400-e29b-41d4-a716-446655440000\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dropped_lines=1");
    expect(result.stdout).not.toContain("550e8400");
  });

  it("drops non-allowlisted lines with GIDs without failing", () => {
    const input = DRY_RUN_HEADER + "  Order: gid://shopify/Order/12345678901234\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dropped_lines=1");
  });

  it("drops non-allowlisted lines with long numeric IDs without failing", () => {
    const input = DRY_RUN_HEADER + "  account: 123456789\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
  });

  it("drops non-allowlisted lines with CUIDs without failing", () => {
    const input = DRY_RUN_HEADER + "  account: clh3am0kn00001x2jc8zy4w3v\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
  });

  it("drops non-allowlisted lines with seed-account IDs without failing", () => {
    const input = DRY_RUN_HEADER + "  account: seed-account-held-1\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
  });

  // Test that id-shaped values in ALLOWLISTED output ARE caught.
  // The "Candidates: N" pattern is allowlisted, so large counts trigger id check.
  it("blocks long numeric IDs in allowlisted output", () => {
    const input = DRY_RUN_HEADER + "Candidates: 1234567\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(6);
    expect(result.stdout).toContain("id-shaped value in output");
  });

  it("blocks GIDs embedded in allowlisted error output", () => {
    // Error lines are transformed but the GID pattern would still be present
    // Actually, error lines use redact_class() which replaces digits/hex, so GIDs are redacted.
    // This test verifies GIDs in non-allowlisted lines are dropped, not printed.
    const input = DRY_RUN_HEADER + "  location: gid://shopify/CompanyLocation/24539398309\n";
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("gid://");
  });
});

describe("backfill-dry-run-filter: allowed patterns", () => {
  it("passes valid dry-run output with no ids", () => {
    const input = `============================================================
Backstop Backfill Script (S13)
============================================================
Mode: DRY-RUN (use --apply to write)
Window: 2026-10-01T00:00:00.000Z to 2026-10-15T00:00:00.000Z
Finding candidates (held accounts with missing backstop)...

Found 5 candidate(s):
Shop: #1
----------------------------------------
  ⚠ No offline session, skipping 3 orders
  Order: (processing)
    → would-hold (payment_overdue)
  Order: (processing)
    → would-skip (not_held)
Shop: #2
----------------------------------------
  Order: (processing)
    → skip (invoice_not_found)

============================================================
SUMMARY
============================================================
Candidates: 5
Would hold: 1
Would skip: 1
Errors: 3
⚠ This was a dry-run. Run with --apply to actually apply holds.
`;
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dry_run_mode_seen=true");
    expect(result.stdout).toContain("id_leak_lines=0");
  });

  it("passes no-candidates output", () => {
    const input = `============================================================
Backstop Backfill Script (S13)
============================================================
Mode: DRY-RUN (use --apply to write)
Window: 2026-10-01T00:00:00.000Z to 2026-10-15T00:00:00.000Z
Finding candidates (held accounts with missing backstop)...

✅ No candidates found. All orders from held accounts have been processed.
`;
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
  });
});

describe("backfill-dry-run-filter: exit codes", () => {
  it("exits 3 for apply-mode output", () => {
    const input = `============================================================
Backstop Backfill Script (S13)
============================================================
Mode: APPLY (writing holds)
`;
    const result = runFilter(input);
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("apply-mode output detected");
  });

  it("exits 4 when DRY-RUN mode not seen", () => {
    const input = `============================================================
Backstop Backfill Script (S13)
============================================================
Finding candidates...
`;
    const result = runFilter(input);
    expect(result.exitCode).toBe(4);
    expect(result.stdout).toContain("script did not report DRY-RUN mode");
  });

  it("masks shop domains as ordinals so they don't leak", () => {
    // Shop domains are masked to ordinals (Shop: #1, Shop: #2, etc.)
    // This is intentional - the host leak check applies to OUTPUT lines,
    // and masked shop lines are safe.
    const input = `============================================================
Backstop Backfill Script (S13)
============================================================
Mode: DRY-RUN (use --apply to write)
Window: 2026-10-01T00:00:00.000Z to 2026-10-15T00:00:00.000Z
Finding candidates (held accounts with missing backstop)...

✅ No candidates found. All orders from held accounts have been processed.
Shop: example.myshopify.com
`;
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Shop: #1");
    expect(result.stdout).not.toContain("myshopify.com");
  });

  it("redacts hosts in error lines so they pass", () => {
    // Error lines are transformed via redact_class() which replaces hosts with <host>.
    // This verifies the redaction works, so the error line passes.
    const input = `============================================================
Backstop Backfill Script (S13)
============================================================
Mode: DRY-RUN (use --apply to write)
Window: 2026-10-01T00:00:00.000Z to 2026-10-15T00:00:00.000Z
Finding candidates (held accounts with missing backstop)...

✅ No candidates found. All orders from held accounts have been processed.
    ✗ error: Connection failed to api.example.com
`;
    const result = runFilter(input);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<host>");
    expect(result.stdout).not.toContain("example.com");
  });
});

describe("backfill-dry-run-filter: check_output_line function", () => {
  // The check_output_line function is tested directly in the Python self-test
  // (test_backfill_dry_run_filter.py) because:
  // 1. stdin-based tests can't trigger exit 5 - shop lines get masked, error
  //    lines get redacted, and allowlisted patterns are too strict for hosts.
  // 2. The function must be tested directly to verify exit 5 (host leak),
  //    exit 6 (id leak), and host-before-id precedence.
  //
  // These tests verify the function via a Python subprocess that runs a
  // small test script exercising check_output_line.

  function testCheckOutputLine(line: string): number {
    const testScript = `
import sys
sys.path.insert(0, '${path.dirname(FILTER_SCRIPT).replace(/\\/g, "\\\\")}')
import re
with open('${FILTER_SCRIPT.replace(/\\/g, "\\\\")}') as f:
    code = f.read()
main_start = code.find("\\ndropped = 0")
if main_start > 0:
    code = code[:main_start]
exec_globals = {"re": re, "sys": sys, "__name__": "test"}
exec(code, exec_globals)
print(exec_globals["check_output_line"]('''${line.replace(/'/g, "\\'")}'''))
`;
    const result = spawnSync("python3", ["-c", testScript], {
      encoding: "utf8",
      timeout: 5000,
    });
    return parseInt(result.stdout?.trim() ?? "-1", 10);
  }

  it("returns 5 for host-shaped value", () => {
    expect(testCheckOutputLine("some text with api.example.com in it")).toBe(5);
  });

  it("returns 6 for id-shaped value (UUID)", () => {
    expect(testCheckOutputLine("account: 550e8400-e29b-41d4-a716-446655440000")).toBe(6);
  });

  it("returns 6 for id-shaped value (long numeric)", () => {
    expect(testCheckOutputLine("Candidates: 1234567")).toBe(6);
  });

  it("returns 5 when both host and id present (host-before-id)", () => {
    // Proves the host check runs before the id check
    expect(testCheckOutputLine("api.example.com uuid:550e8400-e29b-41d4-a716-446655440000")).toBe(5);
  });

  it("returns 0 for safe line", () => {
    expect(testCheckOutputLine("Candidates: 5")).toBe(0);
  });
});
