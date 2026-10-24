#!/usr/bin/env npx tsx
/**
 * Backstop Backfill Script (S13)
 *
 * Finds orders from held accounts that were missed by the backstop and applies
 * fulfillment holds retroactively using the real applyBackstop service.
 *
 * USAGE:
 *   npx tsx scripts/backstop-backfill.ts --since 2026-10-01 --until 2026-10-15
 *   npx tsx scripts/backstop-backfill.ts --since 2026-10-01 --until 2026-10-15 --apply
 *   npx tsx scripts/backstop-backfill.ts --since 2026-10-01 --until 2026-10-15 --shop example.myshopify.com
 *
 * REQUIRED FLAGS:
 *   --since  ISO timestamp - only orders with issuedAt on or after this time
 *   --until  ISO timestamp - only orders with issuedAt before this time
 *
 * NOTE: issuedAt is the order date (order.processedAt ?? order.createdAt),
 *       not the DB row creation time. See order.server.ts:259.
 *
 * OPTIONAL FLAGS:
 *   --apply  Actually write holds (default: dry-run)
 *   --shop   Scope to a specific shop domain
 *
 * HOW IT WORKS:
 * 1. Queries all open invoices for held accounts (manualHold=true, overdue, or holdState=HELD)
 *    within the --since/--until window
 * 2. For each candidate, calls evaluateBackstop (read-only) to determine action
 * 3. Dry-run: prints would-hold, would-skip (with reason), or error per order
 * 4. --apply: calls applyBackstop which handles all rules, claims, tags, AuditEvent
 *
 * SAFETY:
 * - Dry-run by default (no changes without --apply)
 * - Dry-run runs all reads inside an explicit READ ONLY transaction (protects against
 *   pooler stripping default_transaction_read_only startup param)
 * - Uses per-shop OFFLINE session from database
 * - Never overwrites pending claims (handled by applyBackstop)
 * - Output contains GIDs and shop IDs only, no PII, no domains in output
 *
 * ENVIRONMENT:
 *   DATABASE_URL - Postgres connection string (required)
 *   SHOPIFY_API_KEY - Shopify app API key (required for --apply)
 *   SHOPIFY_API_SECRET - Shopify app API secret (required for --apply)
 *
 * @see app/services/backstop.server.ts
 */

import postgres from "postgres";
import { pathToFileURL } from "node:url";
import { requestContext } from "~/lib/request-context.server";
import { sqlOptions } from "~/lib/db-light.server";
import { toErrorCode } from "~/lib/log.server";

/**
 * Asserts that the current transaction is read-only.
 * Throws with a descriptive message if not.
 * Used by dry-run mode to enforce read-only safety.
 */
export async function assertReadOnlyTransaction(
  tx: ReturnType<typeof postgres>
): Promise<void> {
  const [setting] = await tx<{ transaction_read_only: string }[]>`
    SELECT current_setting('transaction_read_only') AS transaction_read_only
  `;
  if (setting?.transaction_read_only !== "on") {
    throw new Error(
      "Dry-run safety check failed: transaction_read_only is not 'on'. " +
        "Database reads must run inside a READ ONLY transaction."
    );
  }
}

interface BackfillCandidate {
  invoiceId: string;
  orderId: string;
  shopId: string;
  shopDomain: string;
  buyerAccountId: string;
}

interface BackfillResult {
  candidates: number;
  wouldHold: number;
  wouldSkip: number;
  applied: number;
  skipped: number;
  errors: number;
}

/**
 * Check if a valid (non-expired) offline session exists for a shop.
 * Returns true if a non-expired offline session exists, false otherwise.
 */
async function hasOfflineSession(
  sql: ReturnType<typeof postgres>,
  shopDomain: string
): Promise<boolean> {
  const [session] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM "Session"
      WHERE shop = ${shopDomain}
        AND "isOnline" = false
        AND "accessToken" IS NOT NULL
        AND (expires IS NULL OR expires > (NOW() AT TIME ZONE 'UTC'))
    ) AS exists
  `;
  return session?.exists ?? false;
}

/**
 * Find orders from held accounts missing backstop holds.
 *
 * Held = manualHold=true OR overdue invoices OR holdState='HELD'
 * Missing = no backstop_processed_orders row OR action='pending'
 *
 * Only includes orders within the --since/--until window.
 * Uses issuedAt (order date) not createdAt (DB row creation).
 * Per order.server.ts:259, issuedAt = order.processedAt ?? order.createdAt
 */
async function findCandidates(
  sql: ReturnType<typeof postgres>,
  since: Date,
  until: Date,
  shopFilter?: string
): Promise<BackfillCandidate[]> {
  const shopCondition = shopFilter
    ? sql`AND s.domain = ${shopFilter}`
    : sql``;

  const rows = await sql<BackfillCandidate[]>`
    WITH overdue_accounts AS (
      SELECT DISTINCT "buyerAccountId"
      FROM "Invoice"
      WHERE status = 'open'
        AND outstanding > 0
        AND "dueAt" IS NOT NULL
        AND "dueAt" < NOW() - INTERVAL '1 day'
    ),
    held_accounts AS (
      SELECT id, "shopId"
      FROM "BuyerAccount"
      WHERE "manualHold" = true
         OR "holdState" = 'HELD'
         OR id IN (SELECT "buyerAccountId" FROM overdue_accounts)
    )
    SELECT
      i.id AS "invoiceId",
      i."orderId" AS "orderId",
      i."shopId" AS "shopId",
      s.domain AS "shopDomain",
      ba.id AS "buyerAccountId"
    FROM "Invoice" i
    JOIN held_accounts ba ON ba.id = i."buyerAccountId"
    JOIN "Shop" s ON s.id = i."shopId"
    LEFT JOIN backstop_processed_orders bpo
      ON bpo.shop_id = i."shopId" AND bpo.order_gid = i."orderId"
    WHERE i.status = 'open'
      AND i.outstanding > 0
      AND i."orderId" IS NOT NULL
      AND i."issuedAt" >= ${since}
      AND i."issuedAt" < ${until}
      AND (bpo.action IS NULL OR bpo.action = 'pending')
      ${shopCondition}
    ORDER BY i."shopId", i."orderId"
  `;

  return rows;
}

/**
 * Process candidates in dry-run or apply mode.
 * Must be called inside requestContext.run() for --apply mode.
 */
async function processBackfill(
  sql: ReturnType<typeof postgres>,
  candidates: BackfillCandidate[],
  dryRun: boolean
): Promise<BackfillResult> {
  const result: BackfillResult = {
    candidates: candidates.length,
    wouldHold: 0,
    wouldSkip: 0,
    applied: 0,
    skipped: 0,
    errors: 0,
  };

  if (candidates.length === 0) {
    return result;
  }

  const {
    resolveInvoiceForOrder,
    evaluateBackstop,
    applyBackstop,
    RetryableBackstopError,
  } = await import("~/services/backstop.server");

  const byShop = new Map<string, BackfillCandidate[]>();
  for (const candidate of candidates) {
    const existing = byShop.get(candidate.shopId) ?? [];
    existing.push(candidate);
    byShop.set(candidate.shopId, existing);
  }

  for (const [shopId, shopCandidates] of byShop) {
    const shopDomain = shopCandidates[0].shopDomain;
    console.log(`\nShop: ${shopId}`);
    console.log("-".repeat(40));

    const hasSession = await hasOfflineSession(sql, shopDomain);
    if (!hasSession) {
      console.log(`  ⚠ No offline session, skipping ${shopCandidates.length} orders`);
      result.errors += shopCandidates.length;
      continue;
    }

    for (const candidate of shopCandidates) {
      console.log(`  Order: ${candidate.orderId} account: ${candidate.buyerAccountId}`);

      const invoiceInfo = await resolveInvoiceForOrder(
        sql,
        shopDomain,
        candidate.orderId
      );

      if (!invoiceInfo) {
        console.log(`    → skip (invoice_not_found)`);
        if (dryRun) {
          result.wouldSkip++;
        } else {
          result.skipped++;
        }
        continue;
      }

      const evalInput = {
        shopDomain,
        shopId: invoiceInfo.shopId,
        orderGid: candidate.orderId,
        buyerAccountId: invoiceInfo.buyerAccountId,
        invoiceId: invoiceInfo.invoiceId,
      };

      if (dryRun) {
        try {
          const evalResult = await evaluateBackstop(sql, evalInput);
          if (evalResult.wouldApply) {
            console.log(`    → would-hold (${evalResult.reasonCode})`);
            result.wouldHold++;
          } else {
            console.log(`    → would-skip (${evalResult.reasonCode})`);
            result.wouldSkip++;
          }
        } catch (e) {
          console.log(`    ✗ error: err=${toErrorCode(e)}`);
          result.errors++;
        }
        continue;
      }

      try {
        const backstopResult = await applyBackstop(sql, evalInput);

        if (backstopResult.applied) {
          console.log(
            `    ✓ held: ${backstopResult.fulfillmentOrdersHeld} FOs`
          );
          result.applied++;
        } else {
          console.log(`    → skip (${backstopResult.skipReason})`);
          result.skipped++;
        }
      } catch (e) {
        const isRetryable = e instanceof RetryableBackstopError;
        console.log(`    ✗ error (${isRetryable ? "retryable" : "fatal"}): err=${toErrorCode(e)}`);
        result.errors++;
      }
    }
  }

  return result;
}

function parseArgs(args: string[]): {
  dryRun: boolean;
  since: Date | null;
  until: Date | null;
  shopFilter: string | undefined;
  error?: string;
} {
  const dryRun = !args.includes("--apply");
  
  const sinceIndex = args.indexOf("--since");
  const sinceStr = sinceIndex !== -1 ? args[sinceIndex + 1] : undefined;
  if (sinceStr?.startsWith("--")) {
    return { dryRun, since: null, until: null, shopFilter: undefined, error: `--since requires a value, got flag '${sinceStr}'` };
  }
  const since = sinceStr ? new Date(sinceStr) : null;
  
  const untilIndex = args.indexOf("--until");
  const untilStr = untilIndex !== -1 ? args[untilIndex + 1] : undefined;
  if (untilStr?.startsWith("--")) {
    return { dryRun, since: null, until: null, shopFilter: undefined, error: `--until requires a value, got flag '${untilStr}'` };
  }
  const until = untilStr ? new Date(untilStr) : null;
  
  const shopIndex = args.indexOf("--shop");
  const shopFilter = shopIndex !== -1 ? args[shopIndex + 1] : undefined;
  if (shopFilter?.startsWith("--")) {
    return { dryRun, since: null, until: null, shopFilter: undefined, error: `--shop requires a value, got flag '${shopFilter}'` };
  }

  return { dryRun, since, until, shopFilter };
}

async function main() {
  const args = process.argv.slice(2);
  const { dryRun, since, until, shopFilter, error } = parseArgs(args);

  console.log("=".repeat(60));
  console.log("Backstop Backfill Script (S13)");
  console.log("=".repeat(60));

  if (error) {
    console.error(`ERROR: ${error}`);
    process.exit(1);
  }
  if (!since || isNaN(since.getTime())) {
    console.error("ERROR: --since is required (ISO timestamp, e.g. 2026-10-01)");
    process.exit(1);
  }
  if (!until || isNaN(until.getTime())) {
    console.error("ERROR: --until is required (ISO timestamp, e.g. 2026-10-15)");
    process.exit(1);
  }
  if (since >= until) {
    console.error("ERROR: --since must be before --until");
    process.exit(1);
  }

  console.log(`Mode: ${dryRun ? "DRY-RUN (use --apply to write)" : "APPLY (writing holds)"}`);
  console.log(`Window: ${since.toISOString()} to ${until.toISOString()}`);
  if (shopFilter) {
    console.log(`Shop filter: (provided)`);
  }
  console.log("");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  if (!dryRun) {
    if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
      console.error("ERROR: SHOPIFY_API_KEY and SHOPIFY_API_SECRET are required for --apply mode");
      process.exit(1);
    }
  }

  const sql = postgres(databaseUrl, sqlOptions);

  try {
    if (dryRun) {
      // Dry-run: all reads inside a single explicit READ ONLY transaction.
      // This protects against transaction-mode poolers (Supavisor) that strip
      // the default_transaction_read_only startup parameter.
      const result = await sql.begin("read only", async (tx) => {
        await assertReadOnlyTransaction(tx);

        console.log("Finding candidates (held accounts with missing backstop)...\n");
        const candidates = await findCandidates(tx, since, until, shopFilter);

        if (candidates.length === 0) {
          console.log("✅ No candidates found. All orders from held accounts have been processed.\n");
          return null;
        }

        console.log(`Found ${candidates.length} candidate(s):`);

        return await requestContext.run({ getSql: () => tx }, async () => {
          return processBackfill(tx, candidates, true);
        });
      });

      if (result) {
        console.log("\n" + "=".repeat(60));
        console.log("SUMMARY");
        console.log("=".repeat(60));
        console.log(`Candidates: ${result.candidates}`);
        console.log(`Would hold: ${result.wouldHold}`);
        console.log(`Would skip: ${result.wouldSkip}`);
        console.log(`Errors: ${result.errors}`);

        if (result.wouldHold > 0) {
          console.log("\n⚠ This was a dry-run. Run with --apply to actually apply holds.");
        }
      }
    } else {
      // Apply mode: normal transaction behavior (reads and writes allowed)
      console.log("Finding candidates (held accounts with missing backstop)...\n");
      const candidates = await findCandidates(sql, since, until, shopFilter);

      if (candidates.length === 0) {
        console.log("✅ No candidates found. All orders from held accounts have been processed.\n");
        return;
      }

      console.log(`Found ${candidates.length} candidate(s):`);

      const result = await requestContext.run({ getSql: () => sql }, async () => {
        return processBackfill(sql, candidates, false);
      });

      console.log("\n" + "=".repeat(60));
      console.log("SUMMARY");
      console.log("=".repeat(60));
      console.log(`Candidates: ${result.candidates}`);
      console.log(`Applied: ${result.applied}`);
      console.log(`Skipped: ${result.skipped}`);
      console.log(`Errors: ${result.errors}`);
    }
  } finally {
    await sql.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`\n❌ Fatal error: [${formatFatal(err)}]`);
    process.exit(1);
  });
}

/**
 * Format a fatal error for logging without exposing message/stack.
 * Only returns the error type (constructor name or typeof).
 */
export function formatFatal(err: unknown): string {
  return err instanceof Error ? err.constructor.name : typeof err;
}

export { findCandidates, hasOfflineSession, processBackfill, parseArgs };
