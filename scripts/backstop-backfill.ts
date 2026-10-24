#!/usr/bin/env tsx
/**
 * Backstop Backfill Script (S13 Hotfix)
 *
 * Finds orders from held accounts that were missed by the backstop (due to Bug 2)
 * and applies fulfillment holds retroactively.
 *
 * USAGE:
 *   npx tsx scripts/backstop-backfill.ts              # Dry-run (default)
 *   npx tsx scripts/backstop-backfill.ts --apply      # Actually write holds
 *
 * HOW IT WORKS:
 * 1. Queries all open invoices for held accounts (manualHold=true OR overdue)
 * 2. For each order, checks if it has a backstop_processed_orders row with action='held'
 * 3. For orders without holds, fetches fulfillment orders from Shopify
 * 4. In dry-run: logs what would be held
 * 5. With --apply: calls fulfillmentOrderHold mutation
 *
 * SAFETY:
 * - Dry-run by default (no changes without --apply)
 * - Logs every action for audit trail
 * - Skips already-held orders (idempotent)
 * - Uses the same hold logic as the live backstop
 *
 * ENVIRONMENT:
 *   DATABASE_URL         - Postgres connection string
 *   SHOPIFY_ADMIN_TOKEN  - Admin API token (fallback to DB session)
 *
 * @see app/services/backstop.server.ts
 */

import postgres from "postgres";
import { pathToFileURL } from "node:url";

const API_VERSION = "2026-10";
const HOLD_HANDLE = "ntr-credit-hold";
const HOLD_REASON = "Backstop backfill: order from held account";

interface Invoice {
  id: string;
  orderId: string;
  shopId: string;
  shopDomain: string;
  buyerAccountId: string;
  buyerAccountName: string;
  holdState: string;
  manualHold: boolean;
  hasOverdue: boolean;
}

interface FulfillmentOrderNode {
  id: string;
  status: string;
  supportedActions: Array<{ action: string }>;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

async function graphqlRequest<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<{ success: boolean; data?: T; error?: string }> {
  const url = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      return { success: false, error: json.errors[0].message };
    }

    return { success: true, data: json.data };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const FULFILLMENT_ORDERS_QUERY = `
  query FulfillmentOrdersForOrder($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 20) {
        edges {
          node {
            id
            status
            supportedActions {
              action
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_ORDER_HOLD_MUTATION = `
  mutation FulfillmentOrderHold($id: ID!, $reason: FulfillmentHoldReason!, $reasonNotes: String, $handle: String) {
    fulfillmentOrderHold(
      id: $id,
      fulfillmentHold: {
        reason: $reason,
        reasonNotes: $reasonNotes,
        handle: $handle
      }
    ) {
      fulfillmentOrder {
        id
        status
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

async function getAccessToken(
  sql: ReturnType<typeof postgres>,
  shopDomain: string
): Promise<string | null> {
  // First check for env var
  const envToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (envToken) {
    return envToken;
  }

  // Fall back to DB session
  const [session] = await sql<{ accessToken: string }[]>`
    SELECT "accessToken" FROM "Session"
    WHERE shop = ${shopDomain}
    ORDER BY id DESC LIMIT 1
  `;

  return session?.accessToken ?? null;
}

async function findMissedOrders(sql: ReturnType<typeof postgres>): Promise<Invoice[]> {
  const rows = await sql<Invoice[]>`
    WITH overdue_accounts AS (
      SELECT DISTINCT "buyerAccountId"
      FROM "Invoice"
      WHERE status = 'open'
        AND outstanding > 0
        AND "dueAt" IS NOT NULL
        AND "dueAt" < NOW() - INTERVAL '1 day'
    ),
    held_accounts AS (
      SELECT id, name, "holdState", "manualHold", "shopId"
      FROM "BuyerAccount"
      WHERE "manualHold" = true
         OR id IN (SELECT "buyerAccountId" FROM overdue_accounts)
    )
    SELECT
      i.id,
      i."orderId" AS "orderId",
      i."shopId" AS "shopId",
      s.domain AS "shopDomain",
      ba.id AS "buyerAccountId",
      ba.name AS "buyerAccountName",
      ba."holdState" AS "holdState",
      ba."manualHold" AS "manualHold",
      EXISTS (SELECT 1 FROM overdue_accounts oa WHERE oa."buyerAccountId" = ba.id) AS "hasOverdue"
    FROM "Invoice" i
    JOIN held_accounts ba ON ba.id = i."buyerAccountId"
    JOIN "Shop" s ON s.id = i."shopId"
    LEFT JOIN backstop_processed_orders bpo ON bpo.shop_id = i."shopId" AND bpo.order_gid = i."orderId"
    WHERE i.status = 'open'
      AND i.outstanding > 0
      AND i."orderId" IS NOT NULL
      AND (bpo.action IS NULL OR bpo.action = 'pending')
    ORDER BY s.domain, ba.name, i."orderId"
  `;

  return rows;
}

async function applyHoldsForOrder(
  sql: ReturnType<typeof postgres>,
  invoice: Invoice,
  accessToken: string,
  dryRun: boolean
): Promise<{ held: number; skipped: number; errors: string[] }> {
  const result = { held: 0, skipped: 0, errors: [] as string[] };

  // Query fulfillment orders
  const foResult = await graphqlRequest<{
    order: {
      fulfillmentOrders: {
        edges: Array<{ node: FulfillmentOrderNode }>;
      };
    };
  }>(invoice.shopDomain, accessToken, FULFILLMENT_ORDERS_QUERY, {
    orderId: invoice.orderId,
  });

  if (!foResult.success || !foResult.data?.order) {
    result.errors.push(`Failed to fetch FOs: ${foResult.error ?? "Order not found"}`);
    return result;
  }

  const fulfillmentOrders = foResult.data.order.fulfillmentOrders.edges.map((e) => e.node);

  for (const fo of fulfillmentOrders) {
    // Skip if not holdable (no HOLD action or already held)
    if (fo.status === "ON_HOLD" || fo.status === "CLOSED") {
      result.skipped++;
      continue;
    }

    const canHold = fo.supportedActions.some((a) => a.action === "HOLD");
    if (!canHold) {
      result.skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`    [DRY-RUN] Would hold FO ${fo.id} (status: ${fo.status})`);
      result.held++;
      continue;
    }

    // Apply hold
    const holdResult = await graphqlRequest<{
      fulfillmentOrderHold: {
        fulfillmentOrder: { id: string; status: string } | null;
        userErrors: Array<{ field: string[]; message: string }>;
      };
    }>(invoice.shopDomain, accessToken, FULFILLMENT_ORDER_HOLD_MUTATION, {
      id: fo.id,
      reason: "OTHER",
      reasonNotes: HOLD_REASON,
      handle: HOLD_HANDLE,
    });

    if (!holdResult.success) {
      result.errors.push(`Failed to hold FO ${fo.id}: ${holdResult.error}`);
      continue;
    }

    const userErrors = holdResult.data?.fulfillmentOrderHold.userErrors ?? [];
    if (userErrors.length > 0) {
      result.errors.push(`Hold userError for FO ${fo.id}: ${userErrors[0].message}`);
      continue;
    }

    console.log(`    ✓ Held FO ${fo.id}`);
    result.held++;
  }

  // If we applied holds, record in backstop_processed_orders
  if (result.held > 0 && !dryRun) {
    await sql`
      INSERT INTO backstop_processed_orders (shop_id, order_gid, action, reason, processed_at)
      VALUES (${invoice.shopId}, ${invoice.orderId}, 'held', ${HOLD_REASON}, NOW())
      ON CONFLICT (shop_id, order_gid) DO UPDATE SET
        action = 'held',
        reason = ${HOLD_REASON},
        processed_at = NOW()
    `;
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--apply");

  console.log("=".repeat(60));
  console.log("Backstop Backfill Script (S13 Hotfix)");
  console.log("=".repeat(60));
  console.log(`Mode: ${dryRun ? "DRY-RUN (use --apply to write holds)" : "APPLY (writing holds)"}`);
  console.log("");

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log("Finding orders from held accounts missing backstop holds...\n");
    const missedOrders = await findMissedOrders(sql);

    if (missedOrders.length === 0) {
      console.log("✅ No missed orders found. All orders from held accounts have been processed.\n");
      return;
    }

    console.log(`Found ${missedOrders.length} orders to process:\n`);

    // Group by shop for access token efficiency
    const byShop = new Map<string, Invoice[]>();
    for (const inv of missedOrders) {
      const existing = byShop.get(inv.shopDomain) ?? [];
      existing.push(inv);
      byShop.set(inv.shopDomain, existing);
    }

    let totalHeld = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const [shopDomain, invoices] of byShop) {
      console.log(`\nShop: ${shopDomain}`);
      console.log("-".repeat(40));

      const accessToken = await getAccessToken(sql, shopDomain);
      if (!accessToken) {
        console.log(`  ⚠ No access token found, skipping ${invoices.length} orders`);
        totalErrors += invoices.length;
        continue;
      }

      for (const inv of invoices) {
        const holdReason = inv.manualHold ? "Manual hold" : "Payment overdue";
        console.log(`  Order: ${inv.orderId}`);
        console.log(`    Account: ${inv.buyerAccountName} (${holdReason})`);

        const result = await applyHoldsForOrder(sql, inv, accessToken, dryRun);
        totalHeld += result.held;
        totalSkipped += result.skipped;

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            console.log(`    ❌ ${err}`);
          }
          totalErrors += result.errors.length;
        }

        if (result.held === 0 && result.errors.length === 0) {
          console.log(`    (no holdable FOs)`);
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`Total orders checked: ${missedOrders.length}`);
    console.log(`Fulfillment orders ${dryRun ? "to hold" : "held"}: ${totalHeld}`);
    console.log(`Fulfillment orders skipped: ${totalSkipped}`);
    console.log(`Errors: ${totalErrors}`);

    if (dryRun && totalHeld > 0) {
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

export { findMissedOrders, applyHoldsForOrder };
