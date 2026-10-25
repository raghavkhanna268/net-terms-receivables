/**
 * Nightly reconcile for S10.
 *
 * Enqueues a reconcile message for each installed shop, triggering
 * the S6 bulk exports to catch any missed webhooks and fix drift.
 *
 * The heavy work happens through the bulk operation flow:
 * 1. This function enqueues RECONCILE_COMPANIES messages
 * 2. The drain handler starts bulk operations via Admin API
 * 3. The bulk_operations/finish webhook triggers JSONL processing
 * 4. After companies complete, RECONCILE_CUSTOMERS is enqueued (skipped if no tag rules)
 * 5. After customers complete, RECONCILE_ORDERS is enqueued
 * 6. After orders complete, RECONCILE_DRAFT_ORDERS is enqueued
 * 7. The drain processes each stage similarly
 *
 * Sequential design: companies → customers → orders → draft_orders
 * - Companies must complete before customers (B2B contacts)
 * - Customers must complete before orders (tagged customer buyer accounts)
 * - Orders must complete before draft_orders (buyer account existence)
 *
 * Idempotency: Uses webhookId pattern "reconcile:<shop>:<YYYY-MM-DD>:<kind>"
 * so a nightly run is idempotent per day.
 */

import type { Sql } from "~/lib/db-light.server";
import { S6_QUEUES } from "~/lib/pgmq.server";

/**
 * Reconcile message for triggering bulk exports.
 * Extends string index signature for JSON serialization compatibility.
 *
 * Optional manualKey: present for manual (UI-triggered) runs only.
 * When set, orders stage uses the same key base instead of the date key.
 */
export interface ReconcileMessage {
  topic: "RECONCILE_COMPANIES" | "RECONCILE_CUSTOMERS" | "RECONCILE_ORDERS" | "RECONCILE_DRAFT_ORDERS";
  shop: string;
  webhookId: string;
  enqueuedAt: string;
  /** Manual run key base (e.g. "manual:123456789") - present only for UI-triggered runs */
  manualKey?: string;
  [key: string]: string | undefined;
}

/**
 * Get today's date in YYYY-MM-DD format (UTC).
 */
function getTodayUTC(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Reconcile stage type.
 */
export type ReconcileStageKind = "companies" | "customers" | "orders" | "draft_orders";

/**
 * Generate an idempotent webhookId for reconcile.
 * Format: reconcile:<shop>:<YYYY-MM-DD>:<kind>
 *
 * This ensures:
 * - Each shop gets at most one reconcile per kind per day
 * - Re-running the nightly job on the same day is idempotent
 */
export function makeReconcileWebhookId(
  shop: string,
  kind: ReconcileStageKind
): string {
  const today = getTodayUTC();
  return `reconcile:${shop}:${today}:${kind}`;
}

/**
 * Enqueue reconcile messages for all installed shops.
 *
 * Only enqueues RECONCILE_COMPANIES - orders are enqueued after
 * companies complete to ensure BuyerAccounts exist first.
 *
 * Called by:
 * - pg_cron nightly job via /jobs/drain?reconcile=true
 * - Manual admin action
 *
 * @param sql - postgres.js SQL client
 * @returns Number of messages enqueued
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
    // Enqueue companies reconcile only
    // Orders will be enqueued after companies complete (see processor.server.ts)
    const companiesMsg: ReconcileMessage = {
      topic: "RECONCILE_COMPANIES",
      shop: shop.domain,
      webhookId: makeReconcileWebhookId(shop.domain, "companies"),
      enqueuedAt: now,
    };
    await sql`SELECT pgmq.send(${S6_QUEUES.SYNC}, ${sql.json(companiesMsg)})`;

    enqueued += 1;
  }

  console.log(
    `[reconcile] enqueued ${enqueued} RECONCILE_COMPANIES messages for ${shops.length} shops`
  );
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
    message.topic === "RECONCILE_CUSTOMERS" ||
    message.topic === "RECONCILE_ORDERS" ||
    message.topic === "RECONCILE_DRAFT_ORDERS"
  );
}
