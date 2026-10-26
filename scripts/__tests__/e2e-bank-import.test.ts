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
// Fixture credits are dated 2026-11; pin "now" so the app's date bounds pass.
const NOW_IN_BOUNDS = new Date("2026-11-20T06:00:00Z");
// Fixture dates are > now + 7 days here, so the app would reject the file.
const NOW_OUT_OF_BOUNDS = new Date("2026-10-01T06:00:00Z");

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
          NOW(), NOW() + INTERVAL '30 days', NOW(), NOW()
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

  it("apply refuses rows outside the app's date bounds; dry run flags them", async () => {
    const c = collector();
    await expect(
      runE2eBankImport({ sql, env, dryRun: false, rootDir: ROOT, now: NOW_OUT_OF_BOUNDS, emit: c.emit })
    ).rejects.toMatchObject({ code: "rows_outside_date_bounds" });
    expect(c.out.app_would_reject).toBe(true);
    expect((await counts()).imports).toBe("0");

    const d = collector();
    await runE2eBankImport({ sql, env, dryRun: true, rootDir: ROOT, now: NOW_OUT_OF_BOUNDS, emit: d.emit });
    expect(d.out.app_would_reject).toBe(true);
    expect(d.out.result).toBe("dry_run_ok");
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
});
