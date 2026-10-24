#!/usr/bin/env npx tsx
/**
 * Backstop Backfill Script (S13)
 *
 * Finds orders from held accounts that were missed by the backstop and applies
 * fulfillment holds retroactively using the real applyBackstop service.
 *
 * USAGE:
 *   npx tsx scripts/backstop-backfill.ts              # Dry-run (default)
 *   npx tsx scripts/backstop-backfill.ts --apply      # Actually write holds
 *   npx tsx scripts/backstop-backfill.ts --shop example.myshopify.com  # Scope to shop
 *
 * HOW IT WORKS:
 * 1. Queries all open invoices for held accounts (manualHold=true OR overdue)
 * 2. For each candidate, calls resolveInvoiceForOrder to verify invoice exists
 * 3. For each candidate (dry-run: logs only, --apply: calls applyBackstop)
 * 4. applyBackstop handles all hold rules: isBuyerHeldBeforeOrder, bypass,
 *    holdState/grace, claims, tags, and AuditEvent
 *
 * SAFETY:
 * - Dry-run by default (no changes without --apply)
 * - Uses per-shop OFFLINE session token (isOnline=false)
 * - Never overwrites pending claims (handled by applyBackstop)
 * - Output contains GIDs and counts only, no PII, no hardcoded domains
 *
 * ENVIRONMENT:
 *   DATABASE_URL - Postgres connection string (required)
 *
 * @see app/services/backstop.server.ts
 */

import postgres from "postgres";
import { pathToFileURL } from "node:url";

interface BackfillCandidate {
  invoiceId: string;
  orderId: string;
  shopId: string;
  shopDomain: string;
  buyerAccountId: string;
}

interface BackfillResult {
  candidates: number;
  applied: number;
  skipped: number;
  errors: number;
}

/**
 * Get offline session access token for a shop.
 * Returns null if no offline session exists.
 */
async function getOfflineAccessToken(
  sql: ReturnType<typeof postgres>,
  shopDomain: string
): Promise<string | null> {
  const [session] = await sql<{ accessToken: string }[]>`
    SELECT "accessToken"
    FROM "Session"
    WHERE shop = ${shopDomain}
      AND "isOnline" = false
      AND "accessToken" IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `;
  return session?.accessToken ?? null;
}

/**
 * Find orders from held accounts missing backstop holds.
 *
 * Held = manualHold=true OR has overdue invoices (dueAt < NOW() - 1 day)
 * Missing = no backstop_processed_orders row OR action='pending'
 */
async function findCandidates(
  sql: ReturnType<typeof postgres>,
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
      AND (bpo.action IS NULL OR bpo.action = 'pending')
      ${shopCondition}
    ORDER BY s.domain, i."orderId"
  `;

  return rows;
}

/**
 * Process candidates in dry-run or apply mode.
 */
async function processBackfill(
  sql: ReturnType<typeof postgres>,
  candidates: BackfillCandidate[],
  dryRun: boolean
): Promise<BackfillResult> {
  const result: BackfillResult = {
    candidates: candidates.length,
    applied: 0,
    skipped: 0,
    errors: 0,
  };

  if (candidates.length === 0) {
    return result;
  }

  // Import backstop service
  const { resolveInvoiceForOrder, applyBackstop, RetryableBackstopError } =
    await import("~/services/backstop.server");

  // Group by shop for token efficiency
  const byShop = new Map<string, BackfillCandidate[]>();
  for (const candidate of candidates) {
    const existing = byShop.get(candidate.shopDomain) ?? [];
    existing.push(candidate);
    byShop.set(candidate.shopDomain, existing);
  }

  for (const [shopDomain, shopCandidates] of byShop) {
    console.log(`\nShop: ${shopDomain}`);
    console.log("-".repeat(40));

    // Get offline access token for this shop
    const accessToken = await getOfflineAccessToken(sql, shopDomain);
    if (!accessToken) {
      console.log(`  ⚠ No offline session, skipping ${shopCandidates.length} orders`);
      result.errors += shopCandidates.length;
      continue;
    }

    // Set up shopify client context for this shop
    // The shopifyGraphQLRequest function used by applyBackstop
    // will use the session from the database
    for (const candidate of shopCandidates) {
      console.log(`  Order: ${candidate.orderId}`);

      // Verify invoice still exists
      const invoiceInfo = await resolveInvoiceForOrder(
        sql,
        shopDomain,
        candidate.orderId
      );

      if (!invoiceInfo) {
        console.log(`    → Invoice not found, skipping`);
        result.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`    → [DRY-RUN] Would apply backstop`);
        result.applied++;
        continue;
      }

      // Apply backstop (handles all rules, claims, tags, audit)
      try {
        const backstopResult = await applyBackstop(sql, {
          shopDomain,
          shopId: invoiceInfo.shopId,
          orderGid: candidate.orderId,
          buyerAccountId: invoiceInfo.buyerAccountId,
          invoiceId: invoiceInfo.invoiceId,
        });

        if (backstopResult.applied) {
          console.log(
            `    ✓ Applied: ${backstopResult.fulfillmentOrdersHeld} FOs held`
          );
          result.applied++;
        } else {
          console.log(`    → Skipped: ${backstopResult.skipReason}`);
          result.skipped++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const isRetryable = e instanceof RetryableBackstopError;
        console.log(`    ✗ Error (${isRetryable ? "retryable" : "fatal"}): ${msg}`);
        result.errors++;
      }
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply");
  const shopIndex = args.indexOf("--shop");
  const shopFilter = shopIndex !== -1 ? args[shopIndex + 1] : undefined;

  console.log("=".repeat(60));
  console.log("Backstop Backfill Script (S13)");
  console.log("=".repeat(60));
  console.log(`Mode: ${dryRun ? "DRY-RUN (use --apply to write)" : "APPLY (writing holds)"}`);
  if (shopFilter) {
    console.log(`Shop filter: ${shopFilter}`);
  }
  console.log("");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log("Finding candidates (held accounts with missing backstop)...\n");
    const candidates = await findCandidates(sql, shopFilter);

    if (candidates.length === 0) {
      console.log("✅ No candidates found. All orders from held accounts have been processed.\n");
      return;
    }

    console.log(`Found ${candidates.length} candidate(s):`);

    const result = await processBackfill(sql, candidates, dryRun);

    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`Candidates: ${result.candidates}`);
    console.log(`${dryRun ? "Would apply" : "Applied"}: ${result.applied}`);
    console.log(`Skipped: ${result.skipped}`);
    console.log(`Errors: ${result.errors}`);

    if (dryRun && result.applied > 0) {
      console.log("\n⚠ This was a dry-run. Run with --apply to actually apply holds.");
    }
  } finally {
    await sql.end();
  }
}

// Run if executed directly
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

export { findCandidates, getOfflineAccessToken, processBackfill };
