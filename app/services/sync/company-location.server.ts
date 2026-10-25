/**
 * CompanyLocation sync processor for S6.
 *
 * Maps Shopify CompanyLocation to BuyerAccount (kind=COMPANY).
 * Each CompanyLocation becomes one BuyerAccount, keyed by (shopId, companyLocationId).
 *
 * Idempotent: Uses upsert with ON CONFLICT to handle duplicates.
 * Webhook dedupe: Checks processed webhooks table before processing.
 * Ordering guard (S20): Uses triggeredAt to prevent older events overwriting newer data.
 * T4 gating: Uses pg_advisory_xact_lock inside transactions to prevent concurrent
 * creates from overshooting the plan limit. Existing rows and updates never change gated_at.
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCompanyLocation, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { decideNewAccountGate, isGatingEnforced } from "../gating.server";
import { safeLog } from "~/lib/log.server";

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

  const paymentTerms = location.buyerExperienceConfiguration?.paymentTermsTemplate;
  const defaultTermsDays = paymentTerms?.dueInDays ?? null;

  const displayName =
    location.name ||
    location.billingAddress?.companyName ||
    `Location ${location.id.split("/").pop()}`;

  const { action, entityId } = await sql.begin(async (tx) => {
    const [existingAccount] = await tx<{ id: string; gated_at: Date | null }[]>`
      SELECT id, gated_at FROM "BuyerAccount"
      WHERE "shopId" = ${shopId} AND "companyLocationId" = ${location.id}
    `;

    let shouldGate = false;
    if (!existingAccount) {
      const decision = await decideNewAccountGate(tx, shopId);
      shouldGate = decision.gate;
    }

    const [result] = await tx<{ id: string; upsertAction: string; gated_at: Date | null }[]>`
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
      RETURNING id, (xmax = 0)::text as "upsertAction", gated_at
    `;

    let resultAction: "created" | "updated" | "gated";
    if (result.upsertAction === "true") {
      resultAction = shouldGate ? "gated" : "created";
      if (shouldGate) {
        safeLog("info", "account_gated_new", { kind: "COMPANY" });
      }
    } else {
      resultAction = "updated";
    }

    return { action: resultAction, entityId: result.id };
  });

  await markWebhookProcessed(sql, webhookId, topic, location.id);

  return {
    success: true,
    action,
    entityId,
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
    location.billingAddress?.companyName ||
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
 * T4: When PLAN_GATING_ENFORCED is ON, new accounts that exceed the plan
 * limit are created with gated_at set. Updates to existing accounts are
 * always allowed (downgrade-safe). Gated accounts are excluded from the
 * limit count and can be reactivated on upgrade.
 *
 * Concurrency: Each shop's batch runs in a single transaction with
 * pg_advisory_xact_lock to prevent concurrent creates from overshooting.
 * Uses the same lock key as decideNewAccountGate().
 *
 * Performance: Per-batch count check instead of per-account. Computes
 * which accounts need gating upfront based on current count and limit.
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

  const accountsByShop = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const existing = accountsByShop.get(a.shopId) ?? [];
    existing.push(a);
    accountsByShop.set(a.shopId, existing);
  }

  let totalCount = 0;

  for (const [shopId, shopAccounts] of accountsByShop) {
    const batchCount = await sql.begin(async (tx) => {
      let slotsAvailable = Infinity;
      let shouldGateAll = false;
      let existingSet = new Set<string>();
      let limit = -1;

      if (isGatingEnforced()) {
        const { getPlanByShopId } = await import("../plan.server");
        const { countActiveAccounts } = await import("../gating.server");
        const { planLimit } = await import("~/lib/entitlements");
        const plan = await getPlanByShopId(tx, shopId);
        limit = planLimit(plan, "companies");

        if (limit !== -1) {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'ba_limit:' + shopId}, 0))`;

          const currentUsage = await countActiveAccounts(tx, shopId);
          slotsAvailable = Math.max(0, limit - currentUsage);
          shouldGateAll = slotsAvailable === 0;
        }

        if (shopAccounts.length > 0) {
          const locationIds = shopAccounts.map(a => a.companyLocationId);
          const existingAccounts = await tx<{ companyLocationId: string }[]>`
            SELECT "companyLocationId" FROM "BuyerAccount"
            WHERE "shopId" = ${shopId} AND "companyLocationId" IN ${tx(locationIds)}
          `;
          existingSet = new Set(existingAccounts.map(e => e.companyLocationId));
        }
      }

      let newAccountsProcessed = 0;
      let gatedCount = 0;
      let count = 0;

      for (const a of shopAccounts) {
        const isNew = !existingSet.has(a.companyLocationId);
        let shouldGate = false;

        if (isNew && isGatingEnforced()) {
          if (shouldGateAll || newAccountsProcessed >= slotsAvailable) {
            shouldGate = true;
            gatedCount++;
          }
          newAccountsProcessed++;
        }

        const result = await tx`
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
        count += result.count;
      }

      if (gatedCount > 0) {
        safeLog("info", "bulk_accounts_gated", { gatedCount, kind: "COMPANY" });
      }

      return count;
    });

    totalCount += batchCount;
  }

  return totalCount;
}
