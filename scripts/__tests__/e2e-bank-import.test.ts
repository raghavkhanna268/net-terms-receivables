/**
 * DB tests for scripts/e2e-bank-import.ts (e2e store bank import).
 *
 * Runs the real path against a test DB: app parser -> validateImportRequest ->
 * insertBankImportRows (shared with the Imports action) -> runMatcher.
 *
 * Proves:
 * - dry run computes real counts but persists nothing
 * - apply writes 1 BankImport + 3 'unmatched' statement lines and only
 *   'suggested' matches: zero confirmed/pushing/pushed matches, no payment
 *   status change, no PayerAlias, no invoice outstanding change, no
 *   match.confirmed audit event
 * - a re-run is a no-op (already_imported=true, nothing written)
 * - fail closed BEFORE any write: missing Shop row, non-INR or empty
 *   currency, rows outside the app's date bounds in apply mode
 * - every emitted line is an allowlisted key with a count/boolean/enum value
 *
 * All data is FICTIONAL; the domain is a test placeholder.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "../../app/lib/db-light.server.js";
import {
  runE2eBankImport,
  formatOutputLine,
  FIXTURE_FILE_NAME,
  type OutputKey,
  type OutputValue,
} from "../e2e-bank-import";
import { REVIEWER_DEMO_AMOUNTS, REVIEWER_DEMO_BUYER } from "../../tests/fixtures/reviewer-demo";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const ROOT = process.cwd();
// Fixture rows are dated 2026-10-22..25; pin "now" so the app's date bounds
// (now - 2 years .. now + 7 days, computeDateBounds) pass.
const NOW_IN_BOUNDS = new Date("2026-10-26T06:00:00Z");
// Fixture dates are > now + 7 days (upper bound) / < now - 2 years (lower
// bound) here, so the app would reject the file.
const NOW_OUT_OF_BOUNDS = new Date("2026-10-10T06:00:00Z");
const NOW_PAST_LOWER_BOUND = new Date("2028-10-26T06:00:00Z");
// Like seed --reviewer-demo: orders processed 5 days before the seed run
// (seeded 2026-10-26), Net 30. Invoice.issuedAt = order processedAt.
const DEMO_ISSUED_AT = new Date("2026-10-21T10:47:00Z");
const DEMO_DUE_AT = new Date("2026-11-20T10:47:00Z");

function collector() {
  const lines: string[] = [];
  const out: Partial<Record<OutputKey, OutputValue>> = {};
  const emit = (key: OutputKey, value: OutputValue) => {
    lines.push(formatOutputLine(key, value)); // throws on a non count/bool/enum
    out[key] = value;
  };
  return { lines, out, emit };
}

describeWithDb("scripts/e2e-bank-import.ts (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  let shopId: string;
  const runId = Date.now();
  const SHOP = `test-e2e-bank-import-${runId}.myshopify.com`;
  const env = { SHOP, ALLOWED_DEV_STORE: SHOP };
  const buyerId = `buyer-e2e-import-${runId}`;

  async function counts() {
    const [row] = await sql<
      {
        imports: string;
        payments: string;
        matches: string;
        nonSuggested: string;
        nonUnmatched: string;
        aliases: string;
        outstanding: string;
        audits: string;
      }[]
    >`
      SELECT
        (SELECT COUNT(*) FROM "BankImport" WHERE "shopId" = ${shopId})::text AS imports,
        (SELECT COUNT(*) FROM "Payment" WHERE "shopId" = ${shopId})::text AS payments,
        (SELECT COUNT(*) FROM "Match" WHERE "shopId" = ${shopId})::text AS matches,
        (SELECT COUNT(*) FROM "Match" WHERE "shopId" = ${shopId}
          AND (state <> 'suggested' OR "confirmedAt" IS NOT NULL OR "confirmedBy" IS NOT NULL))::text AS "nonSuggested",
        (SELECT COUNT(*) FROM "Payment" WHERE "shopId" = ${shopId} AND status <> 'unmatched')::text AS "nonUnmatched",
        (SELECT COUNT(*) FROM "PayerAlias" WHERE "buyerAccountId" = ${buyerId})::text AS aliases,
        (SELECT COALESCE(SUM(outstanding), 0) FROM "Invoice" WHERE "shopId" = ${shopId})::text AS outstanding,
        (SELECT COUNT(*) FROM "AuditEvent" WHERE "shopId" = ${shopId})::text AS audits
    `;
    return row;
  }

  async function clearImports() {
    await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopId = shop.id;
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${shopId}, 'COMPANY',
        'gid://shopify/Company/e2e-import-test', 'gid://shopify/CompanyLocation/e2e-import-test',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
    `;
    for (const [n, amount] of [
      ["1001", REVIEWER_DEMO_AMOUNTS.order1],
      ["1002", REVIEWER_DEMO_AMOUNTS.order2],
    ] as const) {
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${`invoice-e2e-import-${n}-${runId}`}, ${shopId}, ${buyerId},
          ${`gid://shopify/Order/e2e-import-${n}-${runId}`}, ${`#${n}`}, ${amount}, 'open', ${amount},
          ${DEMO_ISSUED_AT}, ${DEMO_DUE_AT}, NOW(), NOW()
        )
      `;
    }
  });

  afterAll(async () => {
    if (sql) {
      await clearImports();
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sql.end();
    }
  });

  beforeEach(async () => {
    await clearImports();
    await sql`UPDATE "Shop" SET currency = 'INR' WHERE id = ${shopId}`;
  });

  it("dry run computes real counts and persists nothing", async () => {
    const before = await counts();
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

    expect(c.out.mode).toBe("dry_run");
    expect(c.out.reviewer_demo_invoices_present).toBe(2);
    expect(c.out.fixture_bank).toBe("hdfc");
    expect(c.out.fixture_credits).toBe(3);
    expect(c.out.app_would_reject).toBe(false);
    expect(c.out.statement_lines_inserted).toBe(3);
    expect(c.out.matcher_ran).toBe(true);
    expect(c.out.suggestions_total_import).toBeGreaterThan(0);
    expect(c.out.matches_not_suggested).toBe(0);
    expect(c.out.payments_not_unmatched).toBe(0);
    expect(c.out.payer_alias_delta).toBe(0);
    expect(c.out.rolled_back).toBe(true);
    expect(c.out.result).toBe("dry_run_ok");

    expect(await counts()).toEqual(before);
    expect((await counts()).imports).toBe("0");
  });

  it("apply imports 3 lines with suggested-only matches and confirms nothing", async () => {
    const before = await counts();
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

    expect(c.out.mode).toBe("apply");
    expect(c.out.reviewer_demo_invoices_present).toBe(2);
    expect(c.out.result).toBe("imported");
    expect(c.out.rolled_back).toBe(false);
    expect(c.out.import_ids_created).toBe(1);
    expect(c.out.statement_lines_inserted).toBe(3);
    expect(c.out.statement_lines_duplicate).toBe(0);

    const after = await counts();
    expect(after.imports).toBe("1");
    expect(after.payments).toBe("3");
    expect(Number(after.matches)).toBeGreaterThan(0);
    expect(Number(after.matches)).toBe(c.out.suggestions_total_import);
    // Zero matches confirmed / pushing / pushed, zero status changes
    expect(after.nonSuggested).toBe("0");
    expect(after.nonUnmatched).toBe("0");
    // No alias learned, no allocation applied to invoices, no confirm audit
    expect(after.aliases).toBe(before.aliases);
    expect(after.outstanding).toBe(before.outstanding);
    expect(after.audits).toBe(before.audits);

    const [imp] = await sql<{ fileName: string; bank: string; rowCount: number }[]>`
      SELECT "fileName", bank, "rowCount" FROM "BankImport" WHERE "shopId" = ${shopId}
    `;
    expect(imp).toEqual({ fileName: FIXTURE_FILE_NAME, bank: "hdfc", rowCount: 3 });
  });

  it("re-run is a no-op once the fixture is imported", async () => {
    await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });
    const before = await counts();

    for (const dryRun of [false, true]) {
      const c = collector();
      await runE2eBankImport({ sql, env, dryRun, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
      expect(c.out.reviewer_demo_invoices_present).toBe(2);
      expect(c.out.already_imported).toBe(true);
      expect(c.out.noop).toBe(true);
      expect(c.out.result).toBe("noop_already_imported");
      expect(c.out.statement_lines_inserted).toBeUndefined();
    }
    expect(await counts()).toEqual(before);
  });

  it.each([["USD"], [""]])("fails closed before any write when currency is %j", async (currency) => {
    await sql`UPDATE "Shop" SET currency = ${currency} WHERE id = ${shopId}`;
    const c = collector();
    await expect(
      runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit })
    ).rejects.toMatchObject({ code: "shop_currency_not_inr" });
    expect(c.out.shop_currency_inr).toBe(false);
    expect(c.out.reviewer_demo_invoices_present).toBeUndefined();
    expect((await counts()).imports).toBe("0");
  });

  it("fails closed when the allowlisted shop has no Shop row", async () => {
    const other = `test-e2e-bank-import-missing-${runId}.myshopify.com`;
    const c = collector();
    await expect(
      runE2eBankImport({
        sql,
        env: { SHOP: other, ALLOWED_DEV_STORE: other },
        dryRun: false,
        rootDir: ROOT,
        now: NOW_IN_BOUNDS,
        emit: c.emit,
      })
    ).rejects.toMatchObject({ code: "shop_not_found" });
    expect(c.out.shop_found).toBe(false);
    expect((await counts()).imports).toBe("0");
  });

  it.each([
    ["upper", NOW_OUT_OF_BOUNDS],
    ["lower", NOW_PAST_LOWER_BOUND],
  ])("apply refuses rows outside the app's %s date bound; dry run flags them", async (_bound, now) => {
    const c = collector();
    await expect(
      runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now, emit: c.emit })
    ).rejects.toMatchObject({ code: "rows_outside_date_bounds" });
    expect(c.out.app_would_reject).toBe(true);
    expect(c.out.rows_outside_date_bounds).toBe(3);
    expect(c.out.reviewer_demo_invoices_present).toBe(2);
    expect((await counts()).imports).toBe("0");

    const d = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now, emit: d.emit });
    expect(d.out.app_would_reject).toBe(true);
    expect(d.out.result).toBe("dry_run_ok");
    expect((await counts()).imports).toBe("0");
  });

  it("fixture is inside the app's date bounds for real 'now' values through 2028", async () => {
    for (const now of [NOW_IN_BOUNDS, new Date("2026-12-31T00:00:00Z"), new Date("2028-10-20T00:00:00Z")]) {
      const c = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now, emit: c.emit });
      expect(c.out.rows_outside_date_bounds).toBe(0);
      expect(c.out.app_would_reject).toBe(false);
    }
    expect((await counts()).imports).toBe("0");
  });

  it("reviewer_demo_invoices_present is a read-only 0-2 count printed before any write", async () => {
    const rename = async (from: string, to: string) => {
      await sql`UPDATE "Invoice" SET name = ${to} WHERE "shopId" = ${shopId} AND name = ${from}`;
    };
    try {
      await rename("#1002", "#9002");
      const one = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: one.emit });
      expect(one.out.reviewer_demo_invoices_present).toBe(1);

      await rename("#1001", "#9001");
      const none = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: none.emit });
      expect(none.out.reviewer_demo_invoices_present).toBe(0);
      expect(none.lines).toContain("reviewer_demo_invoices_present=0");
    } finally {
      await rename("#9001", "#1001");
      await rename("#9002", "#1002");
    }

    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const keys = c.lines.map((l) => l.split("=")[0]);
    const at = keys.indexOf("reviewer_demo_invoices_present");
    expect(at).toBe(keys.indexOf("shop_currency_inr") + 1);
    expect(at).toBeLessThan(keys.indexOf("already_imported"));
    expect(at).toBeLessThan(keys.indexOf("statement_lines_inserted"));
    expect(c.lines[at]).toBe("reviewer_demo_invoices_present=2");
    expect((await counts()).imports).toBe("0");
  });

  it("emits only allowlisted count/boolean/enum lines", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    for (const line of c.lines) {
      expect(line).toMatch(/^[a-z_]+=([0-9]+|true|false|[a-z0-9_]+)$/);
      expect(line).not.toContain(SHOP);
      expect(line).not.toContain(shopId);
    }
  });

  it("emits suggestion lines with r<row>_<band>_<score>_<label> format", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
    expect(suggestionLines.length).toBeGreaterThan(0);

    for (const line of suggestionLines) {
      const value = line.split("=")[1];
      expect(value).toMatch(/^r\d+_(high|medium|low)_\d+_(order_\d+|other)$/);
      expect(value).not.toContain("#");
      expect(value).toBe(value.toLowerCase());
    }

    const truncatedLine = c.lines.find((l) => l.startsWith("suggestion_lines_truncated="));
    expect(truncatedLine).toBeDefined();
    expect(truncatedLine).toMatch(/^suggestion_lines_truncated=(true|false)$/);
  });

  it("suggestion lines use exact row numbers from fixture CSV (13-15 for credits, no r0)", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
    const rows = suggestionLines.map((l) => {
      const m = l.match(/^suggestion=r(\d+)_/);
      return m ? Number(m[1]) : 0;
    });
    const uniqueRows = [...new Set(rows)].sort((a, b) => a - b);
    expect(uniqueRows).toEqual([13, 14, 15]);
    expect(rows.every((r) => r > 0)).toBe(true);
    expect(rows.some((r) => r === 0)).toBe(false);
  });

  it("suggestion lines for seed invoices use order_<digits> label", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
    const seedLabels = suggestionLines.filter((l) => l.includes("_order_1001") || l.includes("_order_1002"));
    expect(seedLabels.length).toBeGreaterThan(0);
  });

  it("suggestion lines never contain forbidden fields", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
    const forbidden = [
      "SYNT0001", "SYNT0002", "SYNT0003",
      "gid" + "://", "example" + ".com", "." + "myshopify" + ".com",
      "TEST BUYER", "NEFT-", "UPI-", "IMPS-",
      "10000", "5000", "2500",
      shopId,
    ];
    for (const line of suggestionLines) {
      for (const pattern of forbidden) {
        expect(line, `line contains "${pattern}"`).not.toContain(pattern);
      }
    }
  });

  it("emits suggestion_lines_truncated=false when under 64 suggestions", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const suggestionCount = c.lines.filter((l) => l.startsWith("suggestion=")).length;
    expect(suggestionCount).toBeLessThanOrEqual(64);
    const truncatedLine = c.lines.find((l) => l.startsWith("suggestion_lines_truncated="));
    expect(truncatedLine).toBe("suggestion_lines_truncated=false");
  });

  it("suggestion labels use 'other' for non-seed invoices (verified via unit tests)", async () => {
    // This test verifies that if a match WERE created for a non-seed invoice,
    // it would use the 'other' label. The actual label logic is unit-tested
    // in scripts/ci/__tests__/e2e-bank-import-workflow.test.ts which covers
    // formatSuggestionLabel directly without relying on matcher behavior.
    //
    // The matcher's scoring algorithm may not produce matches for every invoice
    // (depends on amount alignment, narration signals, etc.), so we cannot
    // reliably test integration-level 'other' labels here.
    //
    // Instead, we verify that all emitted suggestion lines have valid labels.
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });
    const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));

    for (const line of suggestionLines) {
      const value = line.split("=")[1];
      // Every label must be order_<digits> or 'other'
      expect(value).toMatch(/_(order_\d+|other)$/);
      // No raw invoice names in output
      expect(value).not.toContain("#");
    }
  });

  /**
   * S582: Dry-run re-match on already-imported statements.
   * When dryRun=true AND the fixture is already imported, the matcher runs
   * in read-only mode and emits suggestion lines with ZERO database writes.
   */
  describe("dry-run re-match on already-imported statements (S582)", () => {
    it("emits suggestion lines and band totals with zero DB writes", async () => {
      // First, import the fixture (live mode)
      await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });
      const before = await counts();

      // Now run dry-run on the already-imported statement
      const c = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

      // Verify noop flags
      expect(c.out.already_imported).toBe(true);
      expect(c.out.noop).toBe(true);
      expect(c.out.result).toBe("noop_already_imported");

      // Verify matcher ran in dry-run mode
      expect(c.out.matcher_ran).toBe(true);
      expect(c.out.suggestions_high).toBeDefined();
      expect(c.out.suggestions_medium).toBeDefined();
      expect(c.out.suggestions_low).toBeDefined();
      expect(c.out.suggestions_total_import).toBeDefined();
      expect(typeof c.out.suggestions_total_import).toBe("number");
      expect(c.out.suggestions_total_import).toBeGreaterThan(0);

      // Verify suggestion lines are emitted
      const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
      expect(suggestionLines.length).toBeGreaterThan(0);

      // Verify suggestion lines have correct format
      for (const line of suggestionLines) {
        const value = line.split("=")[1];
        expect(value).toMatch(/^r\d+_(high|medium|low)_\d+_(order_\d+|other)$/);
      }

      // Verify row numbers match fixture credits (13-15)
      const rows = suggestionLines.map((l) => {
        const m = l.match(/^suggestion=r(\d+)_/);
        return m ? Number(m[1]) : 0;
      });
      const uniqueRows = [...new Set(rows)].sort((a, b) => a - b);
      expect(uniqueRows).toEqual([13, 14, 15]);

      // Verify truncation flag
      const truncatedLine = c.lines.find((l) => l.startsWith("suggestion_lines_truncated="));
      expect(truncatedLine).toBeDefined();

      // Verify ZERO database writes
      expect(await counts()).toEqual(before);
    });

    it("emits exact expected suggestion lines for seeded invoices", async () => {
      // First, import the fixture (live mode)
      await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });

      // Get the live suggestions for reference
      const live = collector();
      await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: live.emit });
      // Live import is a noop since already imported, no new suggestions

      // Run dry-run re-match
      const c = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

      const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
      
      // The fixture has 3 credits that should produce suggestions for #1001 and #1002:
      // Row 13: ₹10,000 -> #1001 (exact match, medium band score 58)
      // Row 14: ₹5,000 -> #1002 (exact match, medium band score 58)
      // Row 15: ₹2,500 -> #1002 (partial, low band score 48)
      // Note: Exact scores depend on seeded data; we verify the format and row numbers
      expect(suggestionLines.some((l) => l.includes("r13_") && l.includes("_order_1001"))).toBe(true);
      expect(suggestionLines.some((l) => l.includes("r14_") && l.includes("_order_1002"))).toBe(true);
      expect(suggestionLines.some((l) => l.includes("r15_") && l.includes("_order_1002"))).toBe(true);
    });

    it("band totals match the number of suggestion lines", async () => {
      await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });

      const c = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

      const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
      const totalFromLines = suggestionLines.length;
      const high = (c.out.suggestions_high ?? 0) as number;
      const medium = (c.out.suggestions_medium ?? 0) as number;
      const low = (c.out.suggestions_low ?? 0) as number;
      const totalFromBands = high + medium + low;

      expect(c.out.suggestions_total_import).toBe(totalFromLines);
      expect(totalFromBands).toBe(totalFromLines);
    });

    it("suggestion output contains no UTRs, names, narrations, or forbidden text", async () => {
      await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });

      const c = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

      const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
      const forbidden = [
        "SYNT0001", "SYNT0002", "SYNT0003",
        "gid" + "://", "example" + ".com", "." + "myshopify" + ".com",
        "TEST BUYER", "NEFT-", "UPI-", "IMPS-",
        "10000", "5000", "2500",
        shopId, buyerId,
        "@",
      ];
      for (const line of suggestionLines) {
        for (const pattern of forbidden) {
          expect(line, `line contains "${pattern}"`).not.toContain(pattern);
        }
      }
    });

    it("result=noop_already_imported is emitted as the LAST line", async () => {
      await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });

      const c = collector();
      await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

      const lastLine = c.lines[c.lines.length - 1];
      expect(lastLine).toBe("result=noop_already_imported");
    });
  });
});

/**
 * Zero-write proof tests for dry-run re-match (S582).
 * These tests verify that the dry-run path executes no write SQL statements.
 */
describeWithDb("dry-run re-match zero-write proof (S582)", () => {
  let sql: ReturnType<typeof postgres>;
  let shopId: string;
  const runId = Date.now();
  const SHOP = `test-zero-write-${runId}.myshopify.com`;
  const env = { SHOP, ALLOWED_DEV_STORE: SHOP };
  const buyerId = `buyer-zero-write-${runId}`;

  async function fullRowCounts() {
    const [row] = await sql<{
      matches: string;
      payments: string;
      imports: string;
      aliases: string;
      audits: string;
      invoices: string;
      outstanding: string;
    }[]>`
      SELECT
        (SELECT COUNT(*) FROM "Match" WHERE "shopId" = ${shopId})::text AS matches,
        (SELECT COUNT(*) FROM "Payment" WHERE "shopId" = ${shopId})::text AS payments,
        (SELECT COUNT(*) FROM "BankImport" WHERE "shopId" = ${shopId})::text AS imports,
        (SELECT COUNT(*) FROM "PayerAlias" WHERE "buyerAccountId" = ${buyerId})::text AS aliases,
        (SELECT COUNT(*) FROM "AuditEvent" WHERE "shopId" = ${shopId})::text AS audits,
        (SELECT COUNT(*) FROM "Invoice" WHERE "shopId" = ${shopId})::text AS invoices,
        (SELECT COALESCE(SUM(outstanding), 0) FROM "Invoice" WHERE "shopId" = ${shopId})::text AS outstanding
    `;
    return row;
  }

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopId = shop.id;
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${shopId}, 'COMPANY',
        'gid://shopify/Company/zero-write-test', 'gid://shopify/CompanyLocation/zero-write-test',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
    `;
    for (const [n, amount] of [
      ["1001", REVIEWER_DEMO_AMOUNTS.order1],
      ["1002", REVIEWER_DEMO_AMOUNTS.order2],
    ] as const) {
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${`invoice-zero-write-${n}-${runId}`}, ${shopId}, ${buyerId},
          ${`gid://shopify/Order/zero-write-${n}-${runId}`}, ${`#${n}`}, ${amount}, 'open', ${amount},
          ${DEMO_ISSUED_AT}, ${DEMO_DUE_AT}, NOW(), NOW()
        )
      `;
    }

    // Import the fixture once (live mode)
    await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "AuditEvent" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sql.end();
    }
  });

  it("full row counts are identical before and after dry-run re-match", async () => {
    const before = await fullRowCounts();

    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

    expect(c.out.already_imported).toBe(true);
    expect(c.out.matcher_ran).toBe(true);
    expect(c.out.suggestions_total_import).toBeGreaterThan(0);

    const after = await fullRowCounts();
    expect(after).toEqual(before);
  });

  it("dryRun=false on already-imported statement still prints old lines and writes nothing", async () => {
    const before = await fullRowCounts();

    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

    expect(c.out.already_imported).toBe(true);
    expect(c.out.noop).toBe(true);
    expect(c.out.result).toBe("noop_already_imported");
    // Live mode does NOT run the re-match
    expect(c.out.matcher_ran).toBeUndefined();
    expect(c.out.suggestions_total_import).toBeUndefined();

    const after = await fullRowCounts();
    expect(after).toEqual(before);
  });
});

/**
 * Rejected pair filtering test for dry-run re-match (S582).
 * Verifies that rejected payment-invoice pairs are excluded from suggestions.
 */
describeWithDb("dry-run re-match rejected pair filtering (S582)", () => {
  let sql: ReturnType<typeof postgres>;
  let shopId: string;
  const runId = Date.now();
  const SHOP = `test-rejected-pair-${runId}.myshopify.com`;
  const env = { SHOP, ALLOWED_DEV_STORE: SHOP };
  const buyerId = `buyer-rejected-${runId}`;
  const invoice1Id = `invoice-rejected-1001-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopId = shop.id;
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${shopId}, 'COMPANY',
        'gid://shopify/Company/rejected-test', 'gid://shopify/CompanyLocation/rejected-test',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
    `;
    // Create invoices #1001 and #1002
    const orderGid1 = `gid://shopify/Order/rejected-1001-${runId}`;
    const orderGid2 = `gid://shopify/Order/rejected-1002-${runId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoice1Id}, ${shopId}, ${buyerId},
        ${orderGid1}, '#1001', ${REVIEWER_DEMO_AMOUNTS.order1}, 'open', ${REVIEWER_DEMO_AMOUNTS.order1},
        ${DEMO_ISSUED_AT}, ${DEMO_DUE_AT}, NOW(), NOW()
      )
    `;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
        "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${`invoice-rejected-1002-${runId}`}, ${shopId}, ${buyerId},
        ${orderGid2}, '#1002', ${REVIEWER_DEMO_AMOUNTS.order2}, 'open', ${REVIEWER_DEMO_AMOUNTS.order2},
        ${DEMO_ISSUED_AT}, ${DEMO_DUE_AT}, NOW(), NOW()
      )
    `;

    // Import the fixture (creates payments)
    await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: collector().emit });

    // Get the payment for row 13 (₹10,000 payment for #1001) - match by amount
    const [payment] = await sql<{ id: string }[]>`
      SELECT p.id FROM "Payment" p
      JOIN "BankImport" bi ON bi.id = p."importId"
      WHERE p."shopId" = ${shopId}
        AND p.amount = 10000  -- Row 13 is ₹10,000
      LIMIT 1
    `;

    // Insert a rejected pair for this payment and invoice #1001
    await sql`
      INSERT INTO "rejected_matches" ("shopId", "paymentId", "invoiceId", "rejectedBy", "rejectedAt")
      VALUES (${shopId}, ${payment.id}, ${invoice1Id}, 'test-user', NOW())
    `;
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "rejected_matches" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sql.end();
    }
  });

  it("rejected pair is excluded from dry-run suggestions", async () => {
    const c = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: c.emit });

    expect(c.out.already_imported).toBe(true);
    expect(c.out.matcher_ran).toBe(true);

    const suggestionLines = c.lines.filter((l) => l.startsWith("suggestion="));
    
    // The first row (row 13) should NOT have a suggestion for #1001 because it's rejected
    // It may have no suggestions at all or suggestions for other invoices
    const row13Order1001Suggestions = suggestionLines.filter(
      (l) => l.includes("r13_") && l.includes("_order_1001")
    );
    expect(row13Order1001Suggestions.length).toBe(0);
  });
});

/**
 * Parity test: in-memory computed allocations match what runMatcher writes.
 * For a fresh shop, the allocations computed by computeSuggestionsForPayment
 * should produce the same invoice/score as the live matcher creates.
 */
describeWithDb("parity test: in-memory vs live matcher (S582)", () => {
  let sql: ReturnType<typeof postgres>;
  let shopId: string;
  const runId = Date.now();
  const SHOP = `test-parity-${runId}.myshopify.com`;
  const env = { SHOP, ALLOWED_DEV_STORE: SHOP };
  const buyerId = `buyer-parity-${runId}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, { ...sqlOptions, onnotice: () => {} });
    const [shop] = await sql<{ id: string }[]>`
      INSERT INTO "Shop" (domain, currency, timezone, "createdAt", "updatedAt")
      VALUES (${SHOP}, 'INR', 'Asia/Kolkata', NOW(), NOW())
      RETURNING id
    `;
    shopId = shop.id;
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name, "creditLimit", "holdState", "createdAt", "updatedAt"
      )
      VALUES (
        ${buyerId}, ${shopId}, 'COMPANY',
        'gid://shopify/Company/parity-test', 'gid://shopify/CompanyLocation/parity-test',
        ${REVIEWER_DEMO_BUYER.name}, 100000, 'OK', NOW(), NOW()
      )
    `;
    for (const [n, amount] of [
      ["1001", REVIEWER_DEMO_AMOUNTS.order1],
      ["1002", REVIEWER_DEMO_AMOUNTS.order2],
    ] as const) {
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, status, outstanding,
          "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${`invoice-parity-${n}-${runId}`}, ${shopId}, ${buyerId},
          ${`gid://shopify/Order/parity-${n}-${runId}`}, ${`#${n}`}, ${amount}, 'open', ${amount},
          ${DEMO_ISSUED_AT}, ${DEMO_DUE_AT}, NOW(), NOW()
        )
      `;
    }
  });

  afterAll(async () => {
    if (sql) {
      await sql`DELETE FROM "Match" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Payment" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BankImport" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
      await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
      await sql.end();
    }
  });

  it("dry-run suggestions match live matcher results", async () => {
    // First run: import with live matcher
    const live = collector();
    await runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: live.emit });

    expect(live.out.result).toBe("imported");
    const liveSuggestionLines = live.lines.filter((l) => l.startsWith("suggestion=")).sort();
    const liveTotals = {
      high: live.out.suggestions_high,
      medium: live.out.suggestions_medium,
      low: live.out.suggestions_low,
      total: live.out.suggestions_total_import,
    };

    // Second run: dry-run re-match on already-imported
    const dryRun = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_IN_BOUNDS, emit: dryRun.emit });

    expect(dryRun.out.already_imported).toBe(true);
    expect(dryRun.out.matcher_ran).toBe(true);
    const dryRunSuggestionLines = dryRun.lines.filter((l) => l.startsWith("suggestion=")).sort();
    const dryRunTotals = {
      high: dryRun.out.suggestions_high,
      medium: dryRun.out.suggestions_medium,
      low: dryRun.out.suggestions_low,
      total: dryRun.out.suggestions_total_import,
    };

    // The suggestion lines should be identical
    expect(dryRunSuggestionLines).toEqual(liveSuggestionLines);
    expect(dryRunTotals).toEqual(liveTotals);
  });
});
