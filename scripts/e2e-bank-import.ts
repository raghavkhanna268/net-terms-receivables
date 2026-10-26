#!/usr/bin/env npx tsx
/**
 * E2E bank import (throwaway INR e2e store ONLY).
 *
 * Imports the fixed synthetic fixture
 *   tests/fixtures/banks/synthetic/hdfc-review-synthetic.csv
 * into Imports for the e2e store, through the app's real path:
 *   parseBankStatement (app/lib/banks) -> the Imports page's credit mapping
 *   (mapCreditsForImport) -> validateImportRequest + computeDateBounds +
 *   isCurrencyGateOpen (app/routes/app.imports.tsx) -> insertBankImportRows
 *   (app/services/bank-import.server.ts, shared with the route action) ->
 *   runMatcher (app/services/matcher.server.ts), which only creates
 *   'suggested' Match rows for Reconcile's Suggested tab.
 *
 * NEVER confirms, rejects, pushes or applies a match. It imports no confirm /
 * reject / apply / alias-learning function (enforced by
 * scripts/__tests__/e2e-bank-import-static.test.ts) and holds no Shopify
 * token. After the run it fails (and rolls back) if any Match for the import
 * is not 'suggested', any Payment is not 'unmatched', or PayerAlias / Invoice
 * outstanding / match.confirmed AuditEvent counts changed.
 *
 * GUARDS (all fail closed, exit non-zero BEFORE any write):
 * - SHOP must be set, a *.myshopify.com domain, and equal ALLOWED_DEV_STORE
 *   (both come only from the E2E_SHOP secret via scripts/ci/e2e-shop-guard.sh)
 * - The Shop row must exist and its stored currency must be exactly INR
 *   (and pass the app's isCurrencyGateOpen)
 * - Then prints reviewer_demo_invoices_present=<0-2> (read-only count of
 *   invoices named #1001 / #1002 for the shop; never names, ids or amounts)
 * - Fixture must parse as HDFC with >= 1 credit and pass validateImportRequest
 * - Apply mode refuses rows outside the app's date bounds (computeDateBounds);
 *   dry run reports app_would_reject=true and still computes counts
 * - Re-run: if a BankImport with the fixture file name already exists for the
 *   shop, prints already_imported=true and exits 0 with NO writes (re-checked
 *   under an advisory lock inside the write transaction)
 *
 * DRY RUN (default): everything runs in one transaction that is ROLLED BACK,
 * so the counts are real but nothing persists.
 *
 * OUTPUT: key=value lines only, counts / booleans / enums. Nothing derived
 * from CSV rows (narration, remitter, amount, reference, date) and no ids or
 * domains is ever printed, including in errors (error_code=<enum> only).
 * The workflow additionally pipes output through
 * scripts/ci/e2e-bank-import-filter.sh, which drops any other line.
 *
 * ROLLBACK (needs Raghav's explicit yes before running; see the header of
 * .github/workflows/e2e-bank-import.yml): delete, for the one BankImport with fileName
 * 'hdfc-review-synthetic.csv' on the e2e shop, its 'suggested' Match rows,
 * its Payment rows (rejected_matches cascade), then the BankImport row.
 *
 * ENVIRONMENT: DATABASE_URL, SHOP, ALLOWED_DEV_STORE, DRY_RUN ("true" default)
 */

import postgres from "postgres";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sqlOptions, type Sql } from "~/lib/db-light.server";
import { parseBankStatement } from "~/lib/banks/index";
import { insertBankImportRows } from "~/services/bank-import.server";
import { runMatcher, MAX_PAYMENTS_PER_REQUEST } from "~/services/matcher.server";
import { CONFIDENCE_THRESHOLD } from "~/lib/matching/score";
import { isCurrencyGateOpen } from "~/lib/currency-gate.server";
import {
  validateImportRequest,
  computeDateBounds,
  mapCreditsForImport,
} from "~/routes/app.imports";

/** Fixed fixture: never an input. */
export const FIXTURE_RELATIVE_PATH = "tests/fixtures/banks/synthetic/hdfc-review-synthetic.csv";
export const FIXTURE_FILE_NAME = "hdfc-review-synthetic.csv";

/** Same band cut-offs as Reconcile's ScoreBadge (app/routes/app.reconcile.tsx). */
export const MEDIUM_BAND_MIN = 50;

/** Advisory lock key (arbitrary constant) to serialize concurrent runs. */
const ADVISORY_LOCK_KEY = 482_017_446;

/** Every key the script may print. The workflow filter uses the same list. */
export const OUTPUT_KEYS = [
  "mode",
  "shop_guard",
  "shop_found",
  "shop_currency_inr",
  "reviewer_demo_invoices_present",
  "fixture_bank",
  "fixture_rows_total",
  "fixture_rows_skipped",
  "fixture_parse_errors",
  "fixture_credits",
  "fixture_debits_ignored",
  "validation",
  "rows_outside_date_bounds",
  "app_would_reject",
  "already_imported",
  "noop",
  "unmatched_payments_before",
  "import_ids_created",
  "statement_lines_inserted",
  "statement_lines_duplicate",
  "matcher_ran",
  "matcher_payments_processed",
  "matcher_matches_created",
  "matcher_high_confidence",
  "matcher_errors",
  "matcher_has_more",
  "suggestions_high",
  "suggestions_medium",
  "suggestions_low",
  "suggestions_total_import",
  "suggested_tab_total_shop",
  "matches_not_suggested",
  "payments_not_unmatched",
  "payer_alias_delta",
  "invoice_outstanding_changed",
  "confirm_audit_events_delta",
  "rolled_back",
  "result",
  "error_code",
] as const;
export type OutputKey = (typeof OUTPUT_KEYS)[number];
export type OutputValue = number | boolean | string;

const ENUM_VALUE = /^[a-z0-9_]{1,64}$/;

/** Fail-closed error carrying only an enum code. */
export class E2eImportError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "E2eImportError";
  }
}

/** Format one output line, refusing anything that is not a count/bool/enum. */
export function formatOutputLine(key: OutputKey, value: OutputValue): string {
  if (!(OUTPUT_KEYS as readonly string[]).includes(key)) {
    throw new E2eImportError("output_key_not_allowed");
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) throw new E2eImportError("output_value_not_count");
  } else if (typeof value === "string") {
    if (!ENUM_VALUE.test(value)) throw new E2eImportError("output_value_not_enum");
  } else if (typeof value !== "boolean") {
    throw new E2eImportError("output_value_type");
  }
  return `${key}=${String(value)}`;
}

/** Map any error to an enum-only code (never a message). */
export function errorCodeOf(err: unknown): string {
  if (err instanceof E2eImportError && ENUM_VALUE.test(err.code)) return err.code;
  return "unexpected_error";
}

export function scoreBand(score: number): "high" | "medium" | "low" {
  if (score >= CONFIDENCE_THRESHOLD) return "high";
  if (score >= MEDIUM_BAND_MIN) return "medium";
  return "low";
}

/** SHOP/ALLOWED_DEV_STORE allowlist. Returns the shop domain or throws. */
export function assertE2eShop(env: Record<string, string | undefined>): string {
  const shop = (env.SHOP ?? "").trim();
  const allowed = (env.ALLOWED_DEV_STORE ?? "").trim();
  if (!shop) throw new E2eImportError("shop_missing");
  if (!allowed) throw new E2eImportError("allowed_store_missing");
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) throw new E2eImportError("shop_invalid_format");
  if (shop !== allowed) throw new E2eImportError("shop_not_allowed");
  return shop;
}

/** Parse the fixed fixture with the app parser and build the import payload. */
export async function loadFixturePayload(rootDir: string) {
  const buf = readFileSync(join(rootDir, FIXTURE_RELATIVE_PATH));
  const content = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const parsed = await parseBankStatement(content, { fileName: FIXTURE_FILE_NAME });
  // Same shape the Imports page builds from parseBankStatement before
  // mapCreditsForImport (app/routes/app.imports.tsx, ImportsPage).
  const creditTxns = parsed.transactions.filter((t) => t.direction === "CR");
  const credits = mapCreditsForImport(
    creditTxns.map((t) => ({
      date: t.date,
      amountPaise: t.amountPaise,
      direction: t.direction,
      narration: t.narration,
      refNo: t.refNo,
      balancePaise: t.balancePaise,
      rail: t.parsed.rail,
      utr: t.parsed.utr,
      payerName: t.parsed.payerName,
      dedupeKey: t.dedupeKey,
      sourceRow: t.sourceRow,
    }))
  );
  return {
    bank: parsed.detection.bank,
    totalRows: parsed.totalRows,
    skippedRows: parsed.skippedRows,
    parseErrors: parsed.errors.length,
    debits: parsed.transactions.length - creditTxns.length,
    body: { bank: parsed.detection.bank, fileName: FIXTURE_FILE_NAME, credits },
  };
}

class RollbackSentinel extends Error {
  constructor() {
    super("rollback");
    this.name = "RollbackSentinel";
  }
}

export interface RunOptions {
  sql: Sql;
  env: Record<string, string | undefined>;
  dryRun: boolean;
  rootDir: string;
  /** Test hook for the date bounds; the CLI always uses the real clock. */
  now?: Date;
  emit: (key: OutputKey, value: OutputValue) => void;
}

async function countSnapshot(sql: Sql | postgres.TransactionSql, shopId: string) {
  const [row] = await sql<{ aliases: string; outstanding: string; confirms: string }[]>`
    SELECT
      (SELECT COUNT(*) FROM "PayerAlias" pa JOIN "BuyerAccount" ba ON ba.id = pa."buyerAccountId"
        WHERE ba."shopId" = ${shopId})::text AS aliases,
      (SELECT COALESCE(SUM(outstanding), 0) FROM "Invoice" WHERE "shopId" = ${shopId})::text AS outstanding,
      (SELECT COUNT(*) FROM "AuditEvent" WHERE "shopId" = ${shopId} AND type = 'match.confirmed')::text AS confirms
  `;
  return row;
}

/**
 * Run the import. Returns normally for success, dry run and the no-op;
 * throws E2eImportError (enum code) on any guard failure.
 */
export async function runE2eBankImport(opts: RunOptions): Promise<void> {
  const { sql, env, dryRun, rootDir, emit } = opts;
  const now = opts.now ?? new Date();
  emit("mode", dryRun ? "dry_run" : "apply");

  // 1. Shop allowlist (fails closed before any DB access)
  const shopDomain = assertE2eShop(env);
  emit("shop_guard", "ok");

  // 2. Shop row + INR (fails closed before any write)
  const [shop] = await sql<{ id: string; currency: string | null }[]>`
    SELECT id, currency FROM "Shop" WHERE domain = ${shopDomain}
  `;
  if (!shop) {
    emit("shop_found", false);
    throw new E2eImportError("shop_not_found");
  }
  emit("shop_found", true);
  const inr = shop.currency === "INR" && isCurrencyGateOpen(shop.currency);
  emit("shop_currency_inr", inr);
  if (!inr) throw new E2eImportError("shop_currency_not_inr");

  // 2b. Read-only: how many of the reviewer-demo invoices (#1001, #1002) exist
  // for this shop (0-2). Runs in both modes before any write. Count only: no
  // names, ids or amounts are printed.
  const [demo] = await sql<{ n: string }[]>`
    SELECT COUNT(DISTINCT name)::text AS n
    FROM "Invoice"
    WHERE "shopId" = ${shop.id} AND name IN ('#1001', '#1002')
  `;
  emit("reviewer_demo_invoices_present", Number(demo?.n ?? 0));

  // 3. Parse + validate the fixed fixture with the app's code
  const fixture = await loadFixturePayload(rootDir);
  emit("fixture_bank", fixture.bank.toLowerCase());
  emit("fixture_rows_total", fixture.totalRows);
  emit("fixture_rows_skipped", fixture.skippedRows);
  emit("fixture_parse_errors", fixture.parseErrors);
  emit("fixture_credits", fixture.body.credits.length);
  emit("fixture_debits_ignored", fixture.debits);
  if (fixture.bank !== "HDFC") throw new E2eImportError("fixture_not_hdfc");
  if (fixture.body.credits.length === 0) throw new E2eImportError("fixture_no_credits");

  const { valid, errors } = validateImportRequest(fixture.body);
  emit("validation", valid ? "ok" : "failed");
  if (!valid || errors.length > 0) throw new E2eImportError("fixture_validation_failed");

  // Same date-bounds rule as the Imports action
  const { minDateIso, maxDateIso } = computeDateBounds(now);
  const outside = valid.credits.filter(
    (c) =>
      c.date < minDateIso ||
      c.date > maxDateIso ||
      (c.valueDate !== undefined && (c.valueDate < minDateIso || c.valueDate > maxDateIso))
  ).length;
  emit("rows_outside_date_bounds", outside);
  emit("app_would_reject", outside > 0);
  if (outside > 0 && !dryRun) throw new E2eImportError("rows_outside_date_bounds");

  // 4. Re-run guard (no write)
  const [existing] = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM "BankImport"
    WHERE "shopId" = ${shop.id} AND "fileName" = ${FIXTURE_FILE_NAME}
  `;
  if (Number(existing.n) > 0) {
    emit("already_imported", true);
    emit("noop", true);
    emit("result", "noop_already_imported");
    return;
  }
  emit("already_imported", false);

  // 5. Import + matcher in ONE transaction (rolled back on dry run / any check)
  let committed = false;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
      const [again] = await tx<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM "BankImport"
        WHERE "shopId" = ${shop.id} AND "fileName" = ${FIXTURE_FILE_NAME}
      `;
      if (Number(again.n) > 0) throw new E2eImportError("already_imported_concurrently");

      const before = await countSnapshot(tx, shop.id);
      const [unmatched] = await tx<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM "Payment"
        WHERE "shopId" = ${shop.id} AND status IN ('unmatched', 'partial')
      `;
      emit("unmatched_payments_before", Number(unmatched.n));

      const imported = await insertBankImportRows(tx, {
        shopId: shop.id,
        bank: valid.bank,
        fileName: valid.fileName,
        credits: valid.credits,
        now,
      });
      emit("import_ids_created", 1);
      emit("statement_lines_inserted", imported.inserted);
      emit("statement_lines_duplicate", imported.duplicates);

      // Same trigger as the action: matcher only when something was inserted.
      // runMatcher only issues plain queries (no nested begin), so it runs on tx.
      emit("matcher_ran", imported.inserted > 0);
      if (imported.inserted > 0) {
        const m = await runMatcher(tx as unknown as Sql, shop.id, { limit: MAX_PAYMENTS_PER_REQUEST });
        emit("matcher_payments_processed", m.paymentsProcessed);
        emit("matcher_matches_created", m.matchesCreated);
        emit("matcher_high_confidence", m.highConfidenceMatches);
        emit("matcher_errors", m.errors);
        emit("matcher_has_more", m.hasMore);
      }

      const matches = await tx<{ score: number; state: string }[]>`
        SELECT m.score, m.state::text AS state
        FROM "Match" m JOIN "Payment" p ON p.id = m."paymentId"
        WHERE p."importId" = ${imported.importId} AND p."shopId" = ${shop.id}
      `;
      const bands = { high: 0, medium: 0, low: 0 };
      let notSuggested = 0;
      for (const row of matches) {
        if (row.state !== "suggested") notSuggested++;
        else bands[scoreBand(Number(row.score))]++;
      }
      emit("suggestions_high", bands.high);
      emit("suggestions_medium", bands.medium);
      emit("suggestions_low", bands.low);
      emit("suggestions_total_import", bands.high + bands.medium + bands.low);
      emit("matches_not_suggested", notSuggested);

      const [tab] = await tx<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM "Match" WHERE "shopId" = ${shop.id} AND state = 'suggested'
      `;
      emit("suggested_tab_total_shop", Number(tab.n));

      const [pay] = await tx<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM "Payment"
        WHERE "importId" = ${imported.importId} AND status <> 'unmatched'
      `;
      emit("payments_not_unmatched", Number(pay.n));

      const after = await countSnapshot(tx, shop.id);
      const aliasDelta = Number(after.aliases) - Number(before.aliases);
      const confirmDelta = Number(after.confirms) - Number(before.confirms);
      const outstandingChanged = after.outstanding !== before.outstanding;
      emit("payer_alias_delta", Math.max(aliasDelta, 0));
      emit("invoice_outstanding_changed", outstandingChanged);
      emit("confirm_audit_events_delta", Math.max(confirmDelta, 0));

      if (notSuggested > 0 || Number(pay.n) > 0 || aliasDelta !== 0 || confirmDelta !== 0 || outstandingChanged) {
        throw new E2eImportError("no_confirm_invariant_failed");
      }
      if (dryRun) throw new RollbackSentinel();
    });
    committed = true;
  } catch (err) {
    if (!(err instanceof RollbackSentinel)) {
      emit("rolled_back", true);
      throw err;
    }
  }
  emit("rolled_back", !committed);
  emit("result", committed ? "imported" : "dry_run_ok");
}

async function main(): Promise<void> {
  const print = (key: OutputKey, value: OutputValue) => console.log(formatOutputLine(key, value));
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    print("result", "error");
    print("error_code", "database_url_missing");
    process.exit(1);
  }
  const dryRun = (process.env.DRY_RUN ?? "true") !== "false";
  const sql = postgres(dbUrl, { ...sqlOptions, max: 1, onnotice: () => {} });
  try {
    await runE2eBankImport({
      sql,
      env: process.env,
      dryRun,
      rootDir: resolve(process.cwd()),
      emit: print,
    });
  } catch (err) {
    print("result", "error");
    print("error_code", errorCodeOf(err));
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
