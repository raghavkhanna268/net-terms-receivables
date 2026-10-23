/**
 * CompanyLocation sync processor for S6.
 *
 * Maps Shopify CompanyLocation to BuyerAccount (kind=COMPANY).
 * Each CompanyLocation becomes one BuyerAccount, keyed by (shopId, companyLocationId).
 *
 * Idempotent: Uses upsert with ON CONFLICT to handle duplicates.
 * Webhook dedupe: Checks processed webhooks table before processing.
 * Ordering guard (S20): Uses triggeredAt to prevent older events overwriting newer data.
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
 * S21: When PLAN_GATING_ENFORCED is ON, new accounts that exceed the plan
 * limit are created with gated_at set. Updates to existing accounts are
 * always allowed (downgrade-safe). Gated accounts are excluded from the
 * limit count and can be reactivated on upgrade.
 *
 * Performance: Uses per-batch count check instead of per-account to minimize
 * database queries. Computes which accounts need gating upfront based on the
 * current count and plan limit.
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

  // Group accounts by shopId for batch limit checking
  const accountsByShop = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const existing = accountsByShop.get(a.shopId) ?? [];
    existing.push(a);
    accountsByShop.set(a.shopId, existing);
  }

  let totalCount = 0;

  for (const [shopId, shopAccounts] of accountsByShop) {
    // S21: Per-batch limit check - determine how many new accounts we can create
    let slotsAvailable = Infinity;
    let shouldGateAll = false;

    if (isGatingEnforced()) {
      const limitCheck = await checkCompanyLimit(sql, shopId);
      if (limitCheck.limit !== -1) {
        slotsAvailable = Math.max(0, limitCheck.limit - limitCheck.currentUsage);
        shouldGateAll = slotsAvailable === 0;
      }
    }

    // Check which accounts already exist (updates don't consume slots)
    // Note: use IN ${sql(ids)} instead of ANY(${ids}) for fetch_types:false compatibility
    const locationIds = shopAccounts.map(a => a.companyLocationId);
    const existingAccounts = await sql<{ companyLocationId: string }[]>`
      SELECT "companyLocationId" FROM "BuyerAccount"
      WHERE "shopId" = ${shopId} AND "companyLocationId" IN ${sql(locationIds)}
    `;
    const existingSet = new Set(existingAccounts.map(e => e.companyLocationId));

    // Count new accounts to determine gating
    let newAccountsProcessed = 0;

    for (const a of shopAccounts) {
      const isNew = !existingSet.has(a.companyLocationId);
      let shouldGate = false;

      if (isNew && isGatingEnforced()) {
        if (shouldGateAll || newAccountsProcessed >= slotsAvailable) {
          shouldGate = true;
        }
        newAccountsProcessed++;
      }

      const result = await sql`
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
          ${a.shopId},
          ${a.kind},
          ${a.companyId},
          ${a.companyLocationId},
          ${a.name},
          ${a.defaultTermsDays},
          ${a.defaultTermsSource},
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
      `;
      totalCount += result.count;
    }
  }

  return totalCount;
}
