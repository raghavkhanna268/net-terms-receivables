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
 *
 * MODES:
 *   (default)   Dry-run: prints counts only per shop index, by holdState and total.
 *               No IDs, names, emails, or shop domains in output.
 *   --dry-run   Same as default. Makes no mutations.
 *   --apply     Enqueues CREDIT_STATUS_RECOMPUTE messages via pgmq.
 *
 * OPTIONAL FLAGS:
 *   --shop N    Scope to a specific shop by index (1-based, from dry-run output).
 *               Only valid with --apply.
 *
 * SAFETY:
 * - Dry-run is the default and makes no mutations.
 * - Dry-run runs all reads inside an explicit READ ONLY transaction.
 * - --apply enqueues messages; it never writes Shopify metafields directly.
 * - Sends CREDIT_STATUS_RECOMPUTE messages to pgmq with 'manual' source.
 * - Dedupe key: 'credit_backfill:<id>:<date>' is used by the drain to prevent duplicate processing.
 * - Exit non-zero on any enqueue failure.
 * - This script must never run from CI or on its own in automated pipelines.
 *
 * ENVIRONMENT:
 *   DATABASE_URL - Postgres connection string (required)
 */

import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { sqlOptions } from "~/lib/db-light.server";
import { verifyReadOnlyTransaction } from "./ci/backfill-dry-run-preflight";

interface BackfillStats {
  shopIndex: number;
  total: number;
  byHoldState: Record<string, number>;
}

interface BackfillCandidate {
  id: string;
  shopId: string;
  shopDomain: string;
  holdState: string;
}

/**
 * Parse command line arguments.
 */
function parseArgs(args: string[]): {
  dryRun: boolean;
  apply: boolean;
  shopFilter: number | undefined;
  error?: string;
} {
  const dryRunExplicit = args.includes("--dry-run");
  const applyExplicit = args.includes("--apply");

  // --dry-run and --apply are mutually exclusive
  if (dryRunExplicit && applyExplicit) {
    return {
      dryRun: true,
      apply: false,
      shopFilter: undefined,
      error: "--dry-run and --apply are mutually exclusive",
    };
  }

  // Default to dry-run
  const dryRun = !applyExplicit;
  const apply = applyExplicit;

  const shopIndex = args.indexOf("--shop");
  let shopFilter: number | undefined;
  if (shopIndex !== -1) {
    const shopValue = args[shopIndex + 1];
    if (!shopValue || shopValue.startsWith("--")) {
      return {
        dryRun,
        apply,
        shopFilter: undefined,
        error: "--shop requires a numeric value (shop index from dry-run output)",
      };
    }
    const parsed = parseInt(shopValue, 10);
    if (isNaN(parsed) || parsed < 1) {
      return {
        dryRun,
        apply,
        shopFilter: undefined,
        error: `--shop must be a positive integer, got '${shopValue}'`,
      };
    }
    if (dryRun) {
      return {
        dryRun,
        apply,
        shopFilter: undefined,
        error: "--shop filter is only valid with --apply",
      };
    }
    shopFilter = parsed;
  }

  return { dryRun, apply, shopFilter };
}

/**
 * Get counts of accounts with metafieldSyncedAt IS NULL, grouped by shop and holdState.
 * Returns stats array with shop indices (no shop domains in output).
 */
async function getBackfillStats(
  sql: ReturnType<typeof postgres>,
): Promise<BackfillStats[]> {
  const rows = await sql<{ shopId: string; holdState: string; count: string }[]>`
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
  const shopMap = new Map<string, { total: number; byHoldState: Record<string, number> }>();
  for (const row of rows) {
    const existing = shopMap.get(row.shopId) ?? { total: 0, byHoldState: {} };
    const count = parseInt(row.count, 10);
    existing.total += count;
    existing.byHoldState[row.holdState] = count;
    shopMap.set(row.shopId, existing);
  }

  // Convert to array with indices
  const stats: BackfillStats[] = [];
  let idx = 1;
  for (const [, data] of shopMap) {
    stats.push({
      shopIndex: idx++,
      total: data.total,
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
}

/**
 * Run the dry-run path: preflight check + read-only transaction for counts.
 * Exported for testing.
 *
 * @param sql - Top-level postgres connection (NOT a TransactionSql)
 * @returns Stats from the read-only query
 * @throws Error if preflight fails or transaction_read_only is not 'on'
 */
async function runDryRun(
  sql: ReturnType<typeof postgres>,
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

    return getBackfillStats(tx);
  });

  return { success: true, stats };
}

/**
 * Get all candidates for backfill, optionally filtered by shop index.
 */
async function getCandidates(
  sql: ReturnType<typeof postgres>,
  shopFilter?: number,
): Promise<BackfillCandidate[]> {
  // First get the ordered shop IDs to map index to actual ID
  const shopIds = await sql<{ shopId: string }[]>`
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

  const query = targetShopId
    ? sql<BackfillCandidate[]>`
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
      `
    : sql<BackfillCandidate[]>`
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

  return query;
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

async function main() {
  const args = process.argv.slice(2);
  const { dryRun, apply: _apply, shopFilter, error } = parseArgs(args);

  console.log("=".repeat(60));
  console.log("Credit Status Metafield Backfill Script");
  console.log("=".repeat(60));

  if (error) {
    console.error(`ERROR: ${error}`);
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? "DRY-RUN (counts only, no mutations)" : "APPLY (enqueuing messages)"}`);
  if (shopFilter !== undefined) {
    console.log(`Shop filter: index ${shopFilter}`);
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
      try {
        const result = await runDryRun(sql);
        stats = result.stats;
      } catch (err) {
        console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      if (stats.length === 0) {
        console.log("No accounts with metafieldSyncedAt IS NULL found.");
        console.log("All accounts have had their metafield synced at least once.");
        return;
      }

      console.log("Accounts with metafieldSyncedAt IS NULL:");
      console.log("-".repeat(60));
      console.log("");

      let grandTotal = 0;
      const grandByHoldState: Record<string, number> = {};

      for (const stat of stats) {
        console.log(`Shop ${stat.shopIndex}:`);
        console.log(`  Total: ${stat.total}`);
        for (const [holdState, count] of Object.entries(stat.byHoldState)) {
          console.log(`    ${holdState}: ${count}`);
          grandByHoldState[holdState] = (grandByHoldState[holdState] ?? 0) + count;
        }
        grandTotal += stat.total;
        console.log("");
      }

      console.log("=".repeat(60));
      console.log("GRAND TOTAL:");
      console.log(`  Total accounts: ${grandTotal}`);
      for (const [holdState, count] of Object.entries(grandByHoldState).sort()) {
        console.log(`    ${holdState}: ${count}`);
      }
      console.log("");
      console.log("To enqueue recompute messages, run with --apply");
      if (stats.length > 1) {
        console.log("To target a specific shop, run with --apply --shop <index>");
      }
    } else {
      // Apply mode
      console.log("Fetching candidates...");
      const candidates = await getCandidates(sql, shopFilter);

      if (candidates.length === 0) {
        console.log("No candidates found.");
        return;
      }

      console.log(`Found ${candidates.length} candidate(s) to enqueue.`);
      console.log("Enqueuing CREDIT_STATUS_RECOMPUTE messages...");
      console.log("");

      const result = await enqueueBackfill(sql, candidates);

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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

export { parseArgs, getBackfillStats, getCandidates, enqueueBackfill, runDryRun };
