/**
 * Nightly reconcile for S10.
 *
 * Enqueues a reconcile message for each installed shop, triggering
 * the S6 bulk exports to catch any missed webhooks and fix drift.
 *
 * The heavy work happens through the bulk operation flow:
 * 1. This function enqueues RECONCILE_COMPANIES and RECONCILE_ORDERS messages
 * 2. The drain handler starts bulk operations via Admin API
 * 3. The bulk_operations/finish webhook enqueues completion messages
 * 4. The drain processes the JSONL results in chunks
 *
 * Idempotency: Uses webhookId pattern "reconcile:<shop>:<YYYY-MM-DD>:<kind>"
 * so a nightly run is idempotent per day.
 */

import type { Sql } from "~/lib/db-light.server";
import { S6_QUEUES } from "~/lib/pgmq.server";

/**
 * Reconcile message for triggering bulk exports.
 * Extends string index signature for JSON serialization compatibility.
 */
export interface ReconcileMessage {
  topic: "RECONCILE_COMPANIES" | "RECONCILE_ORDERS";
  shop: string;
  webhookId: string;
  enqueuedAt: string;
  [key: string]: string;
}

/**
 * Get today's date in YYYY-MM-DD format (UTC).
 */
function getTodayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Generate an idempotent webhookId for reconcile.
 * Format: reconcile:<shop>:<YYYY-MM-DD>:<kind>
 *
 * This ensures:
 * - Each shop gets at most one reconcile per kind per day
 * - Re-running the nightly job on the same day is idempotent
 */
function makeReconcileWebhookId(shop: string, kind: "companies" | "orders"): string {
  const today = getTodayUTC();
  return `reconcile:${shop}:${today}:${kind}`;
}

/**
 * Enqueue reconcile messages for all installed shops.
 *
 * Called by:
 * - pg_cron nightly job via /jobs/drain?reconcile=true
 * - Manual admin action
 *
 * @param sql - postgres.js SQL client
 * @returns Number of shops enqueued for reconcile
 */
export async function enqueueReconcileForAllShops(sql: Sql): Promise<number> {
  // Get all installed shops (exclude uninstalled)
  const shops = await sql<{ domain: string }[]>`
    SELECT domain FROM "Shop" WHERE "uninstalledAt" IS NULL
  `;

  if (shops.length === 0) {
    console.log("[reconcile] no installed shops, skipping");
    return 0;
  }

  const now = new Date().toISOString();
  let enqueued = 0;

  for (const shop of shops) {
    // Enqueue companies reconcile
    const companiesMsg: ReconcileMessage = {
      topic: "RECONCILE_COMPANIES",
      shop: shop.domain,
      webhookId: makeReconcileWebhookId(shop.domain, "companies"),
      enqueuedAt: now,
    };
    await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json(companiesMsg)})`;

    // Enqueue orders reconcile
    const ordersMsg: ReconcileMessage = {
      topic: "RECONCILE_ORDERS",
      shop: shop.domain,
      webhookId: makeReconcileWebhookId(shop.domain, "orders"),
      enqueuedAt: now,
    };
    await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json(ordersMsg)})`;

    enqueued += 2;
  }

  console.log(`[reconcile] enqueued ${enqueued} messages for ${shops.length} shops`);
  return enqueued;
}

/**
 * Check if a message is a reconcile message.
 */
export function isReconcileMessage(
  message: { topic: string }
): message is ReconcileMessage {
  return (
    message.topic === "RECONCILE_COMPANIES" ||
    message.topic === "RECONCILE_ORDERS"
  );
}
