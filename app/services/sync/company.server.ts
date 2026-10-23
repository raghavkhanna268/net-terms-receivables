/**
 * Company sync processor for S6.
 *
 * Handles syncing Shopify Company data to our system. Note that BuyerAccount
 * is keyed by CompanyLocation, not Company, so this processor primarily ensures
 * Company metadata is available when CompanyLocations are synced.
 *
 * The actual BuyerAccount records are created/updated by the CompanyLocation
 * processor, which includes the Company reference.
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCompany, SyncResult } from "./types";

/**
 * Webhook-id based dedupe table name.
 * Stores processed webhook IDs to prevent duplicate processing.
 */
const DEDUPE_TABLE = "s6_processed_webhooks";

/**
 * Check if a webhook has already been processed (idempotency check).
 *
 * @param sql - postgres.js SQL client
 * @param webhookId - Shopify webhook ID
 * @returns true if already processed
 */
export async function isWebhookProcessed(
  sql: Sql,
  webhookId: string
): Promise<boolean> {
  const [result] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM ${sql(DEDUPE_TABLE)}
      WHERE webhook_id = ${webhookId}
    ) as exists
  `;
  return result?.exists ?? false;
}

/**
 * Mark a webhook as processed (for idempotency).
 *
 * @param sql - postgres.js SQL client
 * @param webhookId - Shopify webhook ID
 * @param topic - Webhook topic
 * @param resourceGid - Resource GID that was processed
 */
export async function markWebhookProcessed(
  sql: Sql,
  webhookId: string,
  topic: string,
  resourceGid: string
): Promise<void> {
  await sql`
    INSERT INTO ${sql(DEDUPE_TABLE)} (webhook_id, topic, resource_gid, processed_at)
    VALUES (${webhookId}, ${topic}, ${resourceGid}, NOW())
    ON CONFLICT (webhook_id) DO NOTHING
  `;
}

/**
 * Process a Company webhook event.
 *
 * For CREATE/UPDATE: We don't create BuyerAccount from Company directly.
 * BuyerAccount is created from CompanyLocation. This processor just logs
 * and marks the webhook as processed.
 *
 * For DELETE: We don't delete BuyerAccounts when Company is deleted.
 * Shopify will send separate company_locations/delete webhooks for each
 * location, which will handle BuyerAccount cleanup.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic (COMPANIES_CREATE, COMPANIES_UPDATE, COMPANIES_DELETE)
 * @param company - Company data from webhook
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result
 */
export async function processCompanyWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  company: ShopifyCompany,
  webhookId: string
): Promise<SyncResult> {
  // Idempotency check
  if (await isWebhookProcessed(sql, webhookId)) {
    return {
      success: true,
      action: "skipped",
      skipReason: "Webhook already processed (idempotent)",
    };
  }

  // Company webhooks don't directly create BuyerAccounts
  // We just mark them as processed for tracking
  await markWebhookProcessed(sql, webhookId, topic, company.id);

  return {
    success: true,
    action: "skipped",
    skipReason: `Company ${topic} processed; BuyerAccount created from CompanyLocation`,
  };
}

/**
 * Map a Shopify Company to our internal format.
 * Used by bulk processing to normalize company data.
 *
 * @param company - Raw Shopify company data
 * @returns Normalized company data
 */
export function mapCompany(company: ShopifyCompany): {
  companyId: string;
  name: string;
  externalId: string | null;
} {
  return {
    companyId: company.id,
    name: company.name,
    externalId: company.externalId ?? null,
  };
}
