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
 *
 * Main contact PII:
 * - mainContactEmail, mainContactName, mainContactCustomerId stored when CUSTOMER_PII_FIELDS=1
 * - Used for B2B payment reminder emails (S18)
 * - Cleared by customers/redact when mainContactCustomerId matches
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCompanyLocation, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { checkCompanyLimit, isGatingEnforced } from "../gating.server";
import { shouldIncludePiiFields, type PiiEnv } from "./customer-fields.server";

/**
 * Process a CompanyLocation webhook event.
 *
 * CREATE: Creates a new BuyerAccount with kind=COMPANY
 * UPDATE: Updates the existing BuyerAccount name and payment terms
 * DELETE: Soft-deletes are not implemented; account remains for financial history
 *
 * Main contact PII handling:
 * - When CUSTOMER_PII_FIELDS=1: stores mainContactEmail, mainContactName, mainContactCustomerId
 * - When flag is off: all three fields are set to null
 * - On contact removal: all three fields are nulled
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic
 * @param location - CompanyLocation data
 * @param webhookId - Webhook ID for idempotency
 * @param env - Environment for PII flag check
 * @returns Sync result
 */
export async function processCompanyLocationWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  location: ShopifyCompanyLocation,
  webhookId: string,
  env: PiiEnv
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
      error: "shop_not_found",
      errorCode: "shop_not_found",
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
  // Note: CompanyAddress.company was renamed to companyName in 2026-10
  const displayName =
    location.name ||
    location.billingAddress?.companyName ||
    `Location ${location.id.split("/").pop()}`;

  // Extract main contact PII (only when CUSTOMER_PII_FIELDS=1)
  // mainContact is on Company, not Location (B2B recipient is the company's main contact)
  // If flag is off or mainContact is null/missing, all fields are null
  const piiEnabled = shouldIncludePiiFields(env);
  const mainContact = location.company.mainContact?.customer;
  const mainContactEmail = piiEnabled && mainContact ? (mainContact.email ?? null) : null;
  const mainContactDisplayName = piiEnabled && mainContact ? (mainContact.displayName ?? null) : null;
  const mainContactCustomerId = piiEnabled && mainContact ? (mainContact.id ?? null) : null;

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
      "mainContactEmail",
      "mainContactName",
      "mainContactCustomerId",
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
      ${mainContactEmail},
      ${mainContactDisplayName},
      ${mainContactCustomerId},
      NOW(),
      NOW()
    )
    ON CONFLICT ("shopId", "companyLocationId")
    DO UPDATE SET
      "companyId" = EXCLUDED."companyId",
      name = EXCLUDED.name,
      "defaultTermsDays" = COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays"),
      "mainContactEmail" = EXCLUDED."mainContactEmail",
      "mainContactName" = EXCLUDED."mainContactName",
      "mainContactCustomerId" = EXCLUDED."mainContactCustomerId",
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
 * Return type for mapCompanyLocationToBuyerAccount.
 * Includes contactKnown flag to distinguish orphans from real contact removals.
 */
export interface MappedBuyerAccount {
  shopId: string;
  kind: "COMPANY";
  companyId: string;
  companyLocationId: string;
  name: string;
  defaultTermsDays: number | null;
  defaultTermsSource: "explicit" | null;
  mainContactEmail: string | null;
  mainContactName: string | null;
  mainContactCustomerId: string | null;
  /**
   * Whether the mainContact was fetched (company was in this batch).
   * - true: mainContact was fetched, values should be written (even if null = contact removed)
   * - false: mainContact was not fetched (orphan location), preserve existing values
   */
  contactKnown: boolean;
}

/**
 * Map a Shopify CompanyLocation to BuyerAccount insert data.
 * Used by bulk processing to prepare batch inserts.
 *
 * @param shopId - Our internal shop ID
 * @param location - Shopify CompanyLocation data
 * @param env - Environment for PII flag check (required, no default)
 * @param contactKnown - Whether the mainContact was fetched (false for orphan locations)
 * @returns Data ready for BuyerAccount upsert with contactKnown flag
 */
export function mapCompanyLocationToBuyerAccount(
  shopId: string,
  location: ShopifyCompanyLocation,
  env: PiiEnv,
  contactKnown: boolean = true
): MappedBuyerAccount {
  const paymentTerms = location.buyerExperienceConfiguration?.paymentTermsTemplate;
  const defaultTermsDays = paymentTerms?.dueInDays ?? null;

  const displayName =
    location.name ||
    location.billingAddress?.companyName ||
    `Location ${location.id.split("/").pop()}`;

  // Extract main contact PII (only when CUSTOMER_PII_FIELDS=1)
  // mainContact is on Company, not Location (B2B recipient is the company's main contact)
  const piiEnabled = shouldIncludePiiFields(env);
  const mainContact = location.company.mainContact?.customer;
  const mainContactEmail = piiEnabled && mainContact ? (mainContact.email ?? null) : null;
  const mainContactDisplayName = piiEnabled && mainContact ? (mainContact.displayName ?? null) : null;
  const mainContactCustomerId = piiEnabled && mainContact ? (mainContact.id ?? null) : null;

  return {
    shopId,
    kind: "COMPANY",
    companyId: location.company.id,
    companyLocationId: location.id,
    name: displayName,
    defaultTermsDays,
    defaultTermsSource: defaultTermsDays !== null ? "explicit" : null,
    mainContactEmail,
    mainContactName: mainContactDisplayName,
    mainContactCustomerId,
    contactKnown,
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
 * Orphan location handling: When contactKnown is false (orphan location whose
 * parent company was in an earlier chunk), the mainContact* columns are preserved
 * rather than overwritten with NULL. This prevents losing stored contacts.
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
  accounts: MappedBuyerAccount[]
): Promise<number> {
  if (accounts.length === 0) return 0;

  // Group accounts by shopId for batch limit checking
  const accountsByShop = new Map<string, MappedBuyerAccount[]>();
  for (const a of accounts) {
    const existing = accountsByShop.get(a.shopId) ?? [];
    existing.push(a);
    accountsByShop.set(a.shopId, existing);
  }

  let totalCount = 0;

  for (const [shopId, shopAccounts] of accountsByShop) {
    // S21: Per-batch limit check - only when gating is enforced
    // When gating is OFF, we skip all gating-related queries for performance
    let slotsAvailable = Infinity;
    let shouldGateAll = false;
    let existingSet = new Set<string>();

    if (isGatingEnforced()) {
      const limitCheck = await checkCompanyLimit(sql, shopId);
      if (limitCheck.limit !== -1) {
        slotsAvailable = Math.max(0, limitCheck.limit - limitCheck.currentUsage);
        shouldGateAll = slotsAvailable === 0;
      }

      // Check which accounts already exist (updates don't consume slots)
      // Only needed when gating is ON to distinguish new accounts from updates
      // Note: use IN ${sql(ids)} instead of ANY(${ids}) for fetch_types:false compatibility
      if (shopAccounts.length > 0) {
        const locationIds = shopAccounts.map(a => a.companyLocationId);
        const existingAccounts = await sql<{ companyLocationId: string }[]>`
          SELECT "companyLocationId" FROM "BuyerAccount"
          WHERE "shopId" = ${shopId} AND "companyLocationId" IN ${sql(locationIds)}
        `;
        existingSet = new Set(existingAccounts.map(e => e.companyLocationId));
      }
    }

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

      // Use different UPDATE logic based on contactKnown:
      // - contactKnown=true: write mainContact* values (even if null = contact removed)
      // - contactKnown=false: preserve existing mainContact* values (orphan location)
      if (a.contactKnown) {
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
            "mainContactEmail",
            "mainContactName",
            "mainContactCustomerId",
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
            ${a.mainContactEmail},
            ${a.mainContactName},
            ${a.mainContactCustomerId},
            NOW(),
            NOW()
          )
          ON CONFLICT ("shopId", "companyLocationId")
          DO UPDATE SET
            "companyId" = EXCLUDED."companyId",
            name = EXCLUDED.name,
            "defaultTermsDays" = COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays"),
            "mainContactEmail" = EXCLUDED."mainContactEmail",
            "mainContactName" = EXCLUDED."mainContactName",
            "mainContactCustomerId" = EXCLUDED."mainContactCustomerId",
            "updatedAt" = NOW()
        `;
        totalCount += result.count;
      } else {
        // Orphan location: preserve existing mainContact* columns
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
            "mainContactEmail",
            "mainContactName",
            "mainContactCustomerId",
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
            ${a.mainContactEmail},
            ${a.mainContactName},
            ${a.mainContactCustomerId},
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
  }

  return totalCount;
}
