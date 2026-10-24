#!/usr/bin/env npx tsx
/**
 * Credit Status Metafield Backfill Script
 *
 * Finds BuyerAccounts with metafieldSyncedAt IS NULL (never had a metafield write)
 * and either reports counts (dry-run) or enqueues CREDIT_STATUS_RECOMPUTE messages.
 *
 * USAGE:
 *   npx tsx scripts/credit-status-metafield-backfill.ts
 *   npx tsx scripts/credit-status-metafield-backfill.ts --dry-run
 *   npx tsx scripts/credit-status-metafield-backfill.ts --apply
 *   npx tsx scripts/credit-status-metafield-backfill.ts --apply --shop 1
 *   npx tsx scripts/credit-status-metafield-backfill.ts --id-prefix abc123
 *   npx tsx scripts/credit-status-metafield-backfill.ts --apply --id-prefix abc123 --expect 5
 *
 * MODES:
 *   (default)   Dry-run: prints counts only per shop index, by holdState and total.
 *               No IDs, names, emails, or shop domains in output.
 *   --dry-run   Same as default. Makes no mutations.
 *   --apply     Enqueues CREDIT_STATUS_RECOMPUTE messages via pgmq.
 *               Recommended to use with --expect for safety.
 *
 * OPTIONAL FLAGS:
 *   --shop N         Scope to a specific shop by index (1-based, from dry-run output).
 *                    Only valid with --apply. When combined with --id-prefix, N must
 *                    come from a dry-run run with the same --id-prefix.
 *   --id-prefix P    Filter candidates to BuyerAccount ids starting with prefix P.
 *                    Valid in both dry-run and --apply modes.
 *   --expect N       Assert that exactly N candidates match before applying.
 *                    In dry-run mode, prints expectMatched=true/false and exits non-zero on mismatch.
 *                    In apply mode, exits non-zero BEFORE any pgmq.send if count mismatches.
 *
 * SAFETY:
 * - Dry-run is the default and makes no mutations.
 * - Dry-run runs all reads inside an explicit READ ONLY transaction.
 * - --apply enqueues messages; it never writes Shopify metafields directly.
 * - Sends CREDIT_STATUS_RECOMPUTE messages to pgmq with 'manual' source.
 * - Dedupe key: 'credit_backfill:<id>:<date>' is used by the drain to prevent duplicate processing.
 * - Exit non-zero on any enqueue failure.
 * - Once PR #145 (prod-credit-status-backfill-apply.yml) merges, it will be the only allowed
 *   CI path; until then, no CI path may run --apply.
 *
 * ENVIRONMENT:
 *   DATABASE_URL - Postgres connection string (required)
 */

import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { sqlOptions } from "~/lib/db-light.server";
import { toErrorCode } from "~/lib/log.server";
import { verifyReadOnlyTransaction } from "./ci/backfill-dry-run-preflight";

interface BackfillStats {
  shopIndex: number;
  candidateCount: number;
  byHoldState: Record<string, number>;
}

interface BackfillCandidate {
  id: string;
  shopId: string;
  shopDomain: string;
  holdState: string;
}

/** Regex for valid id-prefix: 1-64 alphanumeric, underscore, or hyphen characters */
const ID_PREFIX_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/** Regex for valid expect value: 1-6 digit non-negative integer */
const EXPECT_REGEX = /^\d{1,6}$/;

interface ParseArgsResult {
  dryRun: boolean;
  apply: boolean;
  shopFilter: number | undefined;
  idPrefix: string | undefined;
  expect: number | undefined;
  argError?: string;
}

/**
 * Parse command line arguments.
 */
function parseArgs(args: string[]): ParseArgsResult {
  const dryRunExplicit = args.includes("--dry-run");
  const applyExplicit = args.includes("--apply");

  // --dry-run and --apply are mutually exclusive
  if (dryRunExplicit && applyExplicit) {
    return {
      dryRun: true,
      apply: false,
      shopFilter: undefined,
      idPrefix: undefined,
      expect: undefined,
      argError: "--dry-run and --apply are mutually exclusive",
    };
  }

  // Default to dry-run
  const dryRun = !applyExplicit;
  const apply = applyExplicit;

  let shopFilter: number | undefined;
  let idPrefix: string | undefined;
  let expect: number | undefined;

  // Parse --shop
  const shopIndex = args.indexOf("--shop");
  if (shopIndex !== -1) {
    const shopValue = args[shopIndex + 1];
    if (!shopValue || shopValue.startsWith("--")) {
      return {
        dryRun,
        apply,
        shopFilter: undefined,
        idPrefix: undefined,
        expect: undefined,
        argError: "--shop requires a numeric value (shop index from dry-run output)",
      };
    }
    const parsed = parseInt(shopValue, 10);
    if (isNaN(parsed) || parsed < 1) {
      return {
        dryRun,
        apply,
        shopFilter: undefined,
        idPrefix: undefined,
        expect: undefined,
        argError: "--shop must be a positive integer (shop index from dry-run output)",
      };
    }
    if (dryRun) {
      return {
        dryRun,
        apply,
        shopFilter: undefined,
        idPrefix: undefined,
        expect: undefined,
        argError: "--shop filter is only valid with --apply",
      };
    }
    shopFilter = parsed;
  }

  // Parse --id-prefix
  const idPrefixIndex = args.indexOf("--id-prefix");
  if (idPrefixIndex !== -1) {
    const prefixValue = args[idPrefixIndex + 1];
    if (!prefixValue || prefixValue.startsWith("--")) {
      return {
        dryRun,
        apply,
        shopFilter,
        idPrefix: undefined,
        expect: undefined,
        argError: "--id-prefix requires a value",
      };
    }
    if (!ID_PREFIX_REGEX.test(prefixValue)) {
      return {
        dryRun,
        apply,
        shopFilter,
        idPrefix: undefined,
        expect: undefined,
        argError: "--id-prefix must match pattern [A-Za-z0-9_-]{1,64}",
      };
    }
    idPrefix = prefixValue;
  }

  // Parse --expect
  const expectIndex = args.indexOf("--expect");
  if (expectIndex !== -1) {
    const expectValue = args[expectIndex + 1];
    if (!expectValue || expectValue.startsWith("--")) {
      return {
        dryRun,
        apply,
        shopFilter,
        idPrefix,
        expect: undefined,
        argError: "--expect requires a non-negative integer value",
      };
    }
    if (!EXPECT_REGEX.test(expectValue)) {
      return {
        dryRun,
        apply,
        shopFilter,
        idPrefix,
        expect: undefined,
        argError: "--expect must be a non-negative integer (0-999999)",
      };
    }
    expect = parseInt(expectValue, 10);
  }

  return { dryRun, apply, shopFilter, idPrefix, expect };
}

/**
 * Get counts of accounts with metafieldSyncedAt IS NULL, grouped by shop and holdState.
 * Returns stats array with shop indices (no shop domains in output).
 *
 * @param sql - Postgres connection
 * @param idPrefix - Optional id prefix filter (parameterized, not string-concatenated)
 */
async function getBackfillStats(
  sql: ReturnType<typeof postgres>,
  idPrefix?: string,
): Promise<BackfillStats[]> {
  const rows = idPrefix
    ? await sql<{ shopId: string; holdState: string; count: string }[]>`
        SELECT
          "shopId",
          "holdState",
          COUNT(*)::text AS count
        FROM "BuyerAccount"
        WHERE "metafieldSyncedAt" IS NULL
          AND starts_with("id", ${idPrefix})
        GROUP BY "shopId", "holdState"
        ORDER BY "shopId", "holdState"
      `
    : await sql<{ shopId: string; holdState: string; count: string }[]>`
        SELECT
          "shopId",
          "holdState",
          COUNT(*)::text AS count
        FROM "BuyerAccount"
        WHERE "metafieldSyncedAt" IS NULL
        GROUP BY "shopId", "holdState"
        ORDER BY "shopId", "holdState"
      `;

  // Group by shopId and assign indices
  const shopMap = new Map<string, { candidateCount: number; byHoldState: Record<string, number> }>();
  for (const row of rows) {
    const existing = shopMap.get(row.shopId) ?? { candidateCount: 0, byHoldState: {} };
    const count = parseInt(row.count, 10);
    existing.candidateCount += count;
    existing.byHoldState[row.holdState] = count;
    shopMap.set(row.shopId, existing);
  }

  // Convert to array with indices
  const stats: BackfillStats[] = [];
  let idx = 1;
  for (const [, data] of shopMap) {
    stats.push({
      shopIndex: idx++,
      candidateCount: data.candidateCount,
      byHoldState: data.byHoldState,
    });
  }

  return stats;
}

/**
 * Result of a dry-run operation.
 */
interface DryRunResult {
  success: true;
  stats: BackfillStats[];
  grandTotal: number;
}

/**
 * Format a dry-run error for logging (X3 fix).
 * Uses toErrorCode to avoid leaking raw error messages.
 * Exported for testing.
 */
export function formatDryRunError(err: unknown): string {
  return `ERROR: err=${toErrorCode(err)}`;
}

/**
 * Run the dry-run path: preflight check + read-only transaction for counts.
 * Exported for testing.
 *
 * @param sql - Top-level postgres connection (NOT a TransactionSql)
 * @param idPrefix - Optional id prefix filter
 * @returns Stats from the read-only query
 * @throws Error if preflight fails or transaction_read_only is not 'on'
 */
async function runDryRun(
  sql: ReturnType<typeof postgres>,
  idPrefix?: string,
): Promise<DryRunResult> {
  // Step 1: Verify READ ONLY transaction enforcement on the connection first.
  // This runs in its own transaction and verifies that writes are rejected.
  // NOTE: verifyReadOnlyTransaction requires a top-level Sql, not TransactionSql.
  const verifyResult = await verifyReadOnlyTransaction(sql);
  if (!verifyResult.ok) {
    throw new Error(`READ ONLY transaction preflight failed: ${verifyResult.error}`);
  }

  // Step 2: Dry-run: all reads inside a single explicit READ ONLY transaction.
  const stats = await sql.begin("read only", async (tx) => {
    // Assert in-place: verifyReadOnlyTransaction() opens its own transaction and
    // cannot run inside this one (TransactionSql has no begin()).
    const [setting] = await tx<{ transaction_read_only: string }[]>`
      SELECT current_setting('transaction_read_only') AS transaction_read_only
    `;
    if (setting?.transaction_read_only !== "on") {
      throw new Error("READ ONLY transaction check failed: transaction_read_only is not 'on'");
    }

    return getBackfillStats(tx, idPrefix);
  });

  const grandTotal = stats.reduce((sum, s) => sum + s.candidateCount, 0);

  return { success: true, stats, grandTotal };
}

/**
 * Get all candidates for backfill, optionally filtered by shop index and/or id prefix.
 *
 * @param sql - Postgres connection
 * @param shopFilter - Optional shop index filter (1-based)
 * @param idPrefix - Optional id prefix filter (parameterized, not string-concatenated)
 */
async function getCandidates(
  sql: ReturnType<typeof postgres>,
  shopFilter?: number,
  idPrefix?: string,
): Promise<BackfillCandidate[]> {
  // First get the ordered shop IDs to map index to actual ID
  // Apply idPrefix filter here too for consistent shop index mapping
  const shopIds = idPrefix
    ? await sql<{ shopId: string }[]>`
        SELECT DISTINCT "shopId"
        FROM "BuyerAccount"
        WHERE "metafieldSyncedAt" IS NULL
          AND starts_with("id", ${idPrefix})
        ORDER BY "shopId"
      `
    : await sql<{ shopId: string }[]>`
        SELECT DISTINCT "shopId"
        FROM "BuyerAccount"
        WHERE "metafieldSyncedAt" IS NULL
        ORDER BY "shopId"
      `;

  let targetShopId: string | undefined;
  if (shopFilter !== undefined) {
    if (shopFilter < 1 || shopFilter > shopIds.length) {
      throw new Error(`Shop index ${shopFilter} is out of range (1-${shopIds.length})`);
    }
    targetShopId = shopIds[shopFilter - 1].shopId;
  }

  // Build query with optional filters (all parameterized via postgres.js tagged templates)
  if (targetShopId && idPrefix) {
    return sql<BackfillCandidate[]>`
      SELECT
        ba.id,
        ba."shopId",
        s.domain AS "shopDomain",
        ba."holdState"
      FROM "BuyerAccount" ba
      JOIN "Shop" s ON s.id = ba."shopId"
      WHERE ba."metafieldSyncedAt" IS NULL
        AND ba."shopId" = ${targetShopId}
        AND starts_with(ba."id", ${idPrefix})
      ORDER BY ba."shopId", ba.id
    `;
  } else if (targetShopId) {
    return sql<BackfillCandidate[]>`
      SELECT
        ba.id,
        ba."shopId",
        s.domain AS "shopDomain",
        ba."holdState"
      FROM "BuyerAccount" ba
      JOIN "Shop" s ON s.id = ba."shopId"
      WHERE ba."metafieldSyncedAt" IS NULL
        AND ba."shopId" = ${targetShopId}
      ORDER BY ba."shopId", ba.id
    `;
  } else if (idPrefix) {
    return sql<BackfillCandidate[]>`
      SELECT
        ba.id,
        ba."shopId",
        s.domain AS "shopDomain",
        ba."holdState"
      FROM "BuyerAccount" ba
      JOIN "Shop" s ON s.id = ba."shopId"
      WHERE ba."metafieldSyncedAt" IS NULL
        AND starts_with(ba."id", ${idPrefix})
      ORDER BY ba."shopId", ba.id
    `;
  } else {
    return sql<BackfillCandidate[]>`
      SELECT
        ba.id,
        ba."shopId",
        s.domain AS "shopDomain",
        ba."holdState"
      FROM "BuyerAccount" ba
      JOIN "Shop" s ON s.id = ba."shopId"
      WHERE ba."metafieldSyncedAt" IS NULL
      ORDER BY ba."shopId", ba.id
    `;
  }
}

/**
 * Enqueue CREDIT_STATUS_RECOMPUTE messages for candidates.
 */
async function enqueueBackfill(
  sql: ReturnType<typeof postgres>,
  candidates: BackfillCandidate[],
): Promise<{ enqueued: number; failed: number }> {
  const today = new Date().toISOString().split("T")[0];
  let enqueued = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const dedupeKey = `credit_backfill:${candidate.id}:${today}`;
    const message = {
      topic: "CREDIT_STATUS_RECOMPUTE",
      shop: candidate.shopDomain,
      buyerAccountId: candidate.id,
      source: "manual",
      webhookId: dedupeKey,
      resourceGid: candidate.id,
    };

    try {
      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;
      enqueued++;
    } catch {
      failed++;
      console.error(`Failed to enqueue: shop index (internal), account index ${enqueued + failed}`);
    }
  }

  return { enqueued, failed };
}

/**
 * Result of an apply operation.
 */
interface ApplyResult {
  success: boolean;
  candidateCount: number;
  enqueued: number;
  failed: number;
  expectMismatch?: { expected: number; actual: number };
}

/**
 * Run the apply path: fetch candidates, check --expect, enqueue messages.
 * Exported for testing.
 *
 * @param sql - Postgres connection
 * @param shopFilter - Optional shop index filter
 * @param idPrefix - Optional id prefix filter
 * @param expect - Optional expected count (exits before enqueue if mismatched)
 */
async function runApply(
  sql: ReturnType<typeof postgres>,
  shopFilter?: number,
  idPrefix?: string,
  expect?: number,
): Promise<ApplyResult> {
  const candidates = await getCandidates(sql, shopFilter, idPrefix);

  // Check --expect BEFORE any pgmq.send
  if (expect !== undefined && candidates.length !== expect) {
    return {
      success: false,
      candidateCount: candidates.length,
      enqueued: 0,
      failed: 0,
      expectMismatch: { expected: expect, actual: candidates.length },
    };
  }

  if (candidates.length === 0) {
    return {
      success: true,
      candidateCount: 0,
      enqueued: 0,
      failed: 0,
    };
  }

  const result = await enqueueBackfill(sql, candidates);

  return {
    success: result.failed === 0,
    candidateCount: candidates.length,
    enqueued: result.enqueued,
    failed: result.failed,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const { dryRun, apply: _apply, shopFilter, idPrefix, expect, argError: parseMsg } = parseArgs(args);

  console.log("=".repeat(60));
  console.log("Credit Status Metafield Backfill Script");
  console.log("=".repeat(60));

  if (parseMsg) {
    console.error(`ERROR: ${parseMsg}`);
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? "DRY-RUN (counts only, no mutations)" : "APPLY (enqueuing messages)"}`);
  if (shopFilter !== undefined) {
    console.log(`Shop filter: index ${shopFilter}`);
  }
  console.log(`idPrefixApplied: ${idPrefix !== undefined}`);
  if (expect !== undefined) {
    console.log(`expectCount: ${expect}`);
  }
  console.log("");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, sqlOptions);

  try {
    if (dryRun) {
      // Use the exported runDryRun function for testability
      let stats: BackfillStats[];
      let grandTotal: number;
      try {
        const result = await runDryRun(sql, idPrefix);
        stats = result.stats;
        grandTotal = result.grandTotal;
      } catch (err) {
        console.error(formatDryRunError(err));
        process.exit(1);
      }

      if (stats.length === 0) {
        console.log("No accounts with metafieldSyncedAt IS NULL found.");
        console.log("All accounts have had their metafield synced at least once.");
        if (expect !== undefined) {
          const matched = expect === 0;
          console.log(`expectMatched: ${matched}`);
          if (!matched) {
            console.error(`ERROR: expect mismatch: expected=${expect} actual=0`);
            process.exit(1);
          }
        }
        return;
      }

      console.log("Accounts with metafieldSyncedAt IS NULL:");
      console.log("-".repeat(60));
      console.log("");

      const grandByHoldState: Record<string, number> = {};

      for (const stat of stats) {
        console.log(`Shop ${stat.shopIndex}:`);
        console.log(`  Candidates: ${stat.candidateCount}`);
        for (const [holdState, count] of Object.entries(stat.byHoldState)) {
          console.log(`    ${holdState}: ${count}`);
          grandByHoldState[holdState] = (grandByHoldState[holdState] ?? 0) + count;
        }
        console.log("");
      }

      console.log("=".repeat(60));
      console.log("GRAND TOTAL:");
      console.log(`  Total accounts: ${grandTotal}`);
      for (const [holdState, count] of Object.entries(grandByHoldState).sort()) {
        console.log(`    ${holdState}: ${count}`);
      }

      // Handle --expect in dry-run mode
      if (expect !== undefined) {
        const matched = grandTotal === expect;
        console.log(`expectMatched: ${matched}`);
        if (!matched) {
          console.error(`ERROR: expect mismatch: expected=${expect} actual=${grandTotal}`);
          process.exit(1);
        }
      }

      console.log("");
      console.log("To enqueue recompute messages, run with --apply");
      if (stats.length > 1) {
        console.log("To target a specific shop, run with --apply --shop <index>");
      }
    } else {
      // Apply mode - use runApply for testability
      console.log("Fetching candidates...");
      const result = await runApply(sql, shopFilter, idPrefix, expect);

      // Check for expect mismatch (no pgmq.send was called)
      if (result.expectMismatch) {
        console.error(`ERROR: expect mismatch: expected=${result.expectMismatch.expected} actual=${result.expectMismatch.actual}`);
        process.exit(1);
      }

      if (result.candidateCount === 0) {
        console.log("No candidates found.");
        return;
      }

      console.log(`Found ${result.candidateCount} candidate(s) to enqueue.`);
      console.log("Enqueuing CREDIT_STATUS_RECOMPUTE messages...");
      console.log("");

      console.log("=".repeat(60));
      console.log("SUMMARY");
      console.log("=".repeat(60));
      console.log(`Enqueued: ${result.enqueued}`);
      console.log(`Failed: ${result.failed}`);

      if (result.failed > 0) {
        console.error("\nERROR: Some enqueues failed. Exiting with error.");
        process.exit(1);
      }

      console.log("\nMessages enqueued successfully.");
      console.log("The drain will process them and sync metafields via recomputeCreditStatus.");
    }
  } finally {
    await sql.end();
  }
}

/**
 * Format a fatal error for logging without exposing message/stack.
 * Only returns the error type (constructor name or typeof).
 */
export function formatFatal(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n❌ Fatal error: [${formatFatal(err)}]`);
    process.exit(1);
  });
}

export { parseArgs, getBackfillStats, getCandidates, enqueueBackfill, runDryRun, runApply };
