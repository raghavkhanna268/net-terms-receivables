/**
 * CompanyLocation sync processor for S6.
 *
 * Maps Shopify CompanyLocation to BuyerAccount (kind=COMPANY).
 * Each CompanyLocation becomes one BuyerAccount, keyed by (shopId, companyLocationId).
 *
 * Idempotent: Uses upsert with ON CONFLICT to handle duplicates.
 * Webhook dedupe: Checks processed webhooks table before processing.
 *
 * S21 gating: Enforces company limit before creating new BuyerAccounts.
 * Updates to existing accounts are always allowed (downgrade-safe).
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCompanyLocation, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { checkCompanyLimit, isGatingEnforced } from "../gating.server";

/**
 * Process a CompanyLocation webhook event.
 *
 * CREATE: Creates a new BuyerAccount with kind=COMPANY
 * UPDATE: Updates the existing BuyerAccount name and payment terms
 * DELETE: Soft-deletes are not implemented; account remains for financial history
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic
 * @param location - CompanyLocation data
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result
 */
export async function processCompanyLocationWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  location: ShopifyCompanyLocation,
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

  // Get shop ID from domain
  const [shop] = await sql<{ id: string }[]>`
    SELECT id FROM "Shop" WHERE domain = ${shopDomain}
  `;

  if (!shop) {
    return {
      success: false,
      action: "skipped",
      error: `Shop not found: ${shopDomain}`,
    };
  }

  const shopId = shop.id;

  if (topic === "COMPANY_LOCATIONS_DELETE") {
    // Don't delete BuyerAccount - it may have invoices (financial history)
    // Just mark the webhook as processed
    await markWebhookProcessed(sql, webhookId, topic, location.id);
    return {
      success: true,
      action: "skipped",
      skipReason: "Company location deleted; BuyerAccount preserved for financial history",
    };
  }

  // Extract payment terms if configured
  const paymentTerms = location.buyerExperienceConfiguration?.paymentTermsTemplate;
  const defaultTermsDays = paymentTerms?.dueInDays ?? null;

  // Build display name: location name or company name from billing address
  const displayName =
    location.name ||
    location.billingAddress?.company ||
    `Location ${location.id.split("/").pop()}`;

  // S21: Check if this is a new account (for gating)
  const [existingAccount] = await sql<{ id: string; gated_at: Date | null }[]>`
    SELECT id, gated_at FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND "companyLocationId" = ${location.id}
  `;

  // Determine if we need to gate this account
  let shouldGate = false;
  if (!existingAccount && isGatingEnforced()) {
    const limitCheck = await checkCompanyLimit(sql, shopId);
    shouldGate = !limitCheck.allowed;
  }

  // Upsert BuyerAccount (gated if over limit, or preserve existing gated state)
  const [result] = await sql<{ id: string; action: string; gated_at: Date | null }[]>`
    INSERT INTO "BuyerAccount" (
      "shopId",
      kind,
      "companyId",
      "companyLocationId",
      name,
      "defaultTermsDays",
      "defaultTermsSource",
      gated_at,
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${shopId},
      'COMPANY',
      ${location.company.id},
      ${location.id},
      ${displayName},
      ${defaultTermsDays},
      ${defaultTermsDays !== null ? "explicit" : null},
      ${shouldGate ? new Date() : null},
      NOW(),
      NOW()
    )
    ON CONFLICT ("shopId", "companyLocationId")
    DO UPDATE SET
      "companyId" = EXCLUDED."companyId",
      name = EXCLUDED.name,
      "defaultTermsDays" = COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays"),
      "updatedAt" = NOW()
    RETURNING id, (xmax = 0)::text as action, gated_at
  `;

  let action: "created" | "updated" | "gated";
  if (result.action === "true") {
    action = shouldGate ? "gated" : "created";
  } else {
    action = "updated";
  }

  await markWebhookProcessed(sql, webhookId, topic, location.id);

  return {
    success: true,
    action,
    entityId: result.id,
  };
}

/**
 * Map a Shopify CompanyLocation to BuyerAccount insert data.
 * Used by bulk processing to prepare batch inserts.
 *
 * @param shopId - Our internal shop ID
 * @param location - Shopify CompanyLocation data
 * @returns Data ready for BuyerAccount upsert
 */
export function mapCompanyLocationToBuyerAccount(
  shopId: string,
  location: ShopifyCompanyLocation
): {
  shopId: string;
  kind: "COMPANY";
  companyId: string;
  companyLocationId: string;
  name: string;
  defaultTermsDays: number | null;
  defaultTermsSource: "explicit" | null;
} {
  const paymentTerms = location.buyerExperienceConfiguration?.paymentTermsTemplate;
  const defaultTermsDays = paymentTerms?.dueInDays ?? null;

  const displayName =
    location.name ||
    location.billingAddress?.company ||
    `Location ${location.id.split("/").pop()}`;

  return {
    shopId,
    kind: "COMPANY",
    companyId: location.company.id,
    companyLocationId: location.id,
    name: displayName,
    defaultTermsDays,
    defaultTermsSource: defaultTermsDays !== null ? "explicit" : null,
  };
}

/**
 * Bulk upsert BuyerAccounts from CompanyLocations.
 * Used by bulk operation processor for efficient batch inserts.
 *
 * @param sql - postgres.js SQL client
 * @param accounts - Array of mapped BuyerAccount data
 * @returns Number of accounts upserted
 */
export async function bulkUpsertBuyerAccounts(
  sql: Sql,
  accounts: ReturnType<typeof mapCompanyLocationToBuyerAccount>[]
): Promise<number> {
  if (accounts.length === 0) return 0;

  let count = 0;
  for (const a of accounts) {
    const result = await sql`
      INSERT INTO "BuyerAccount" (
        "shopId",
        kind,
        "companyId",
        "companyLocationId",
        name,
        "defaultTermsDays",
        "defaultTermsSource",
        "createdAt",
        "updatedAt"
      ) VALUES (
        ${a.shopId},
        ${a.kind},
        ${a.companyId},
        ${a.companyLocationId},
        ${a.name},
        ${a.defaultTermsDays},
        ${a.defaultTermsSource},
        NOW(),
        NOW()
      )
      ON CONFLICT ("shopId", "companyLocationId")
      DO UPDATE SET
        "companyId" = EXCLUDED."companyId",
        name = EXCLUDED.name,
        "defaultTermsDays" = COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays"),
        "updatedAt" = NOW()
    `;
    count += result.count;
  }

  return count;
}
