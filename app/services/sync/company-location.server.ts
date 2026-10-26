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
 *
 * Main contact PII:
 * - mainContactEmail, mainContactName, mainContactCustomerId stored when CUSTOMER_PII_FIELDS=1
 * - Used for B2B payment reminder emails (S18)
 * - Cleared by customers/redact when mainContactCustomerId matches
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCompanyLocation, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";
import { decideNewAccountGate, isGatingEnforced, countActiveAccounts, takeBaLimitLock } from "../gating.server";
import { getPlanByShopId } from "../plan.server";
import { planLimit } from "~/lib/entitlements";
import { safeLog, shopHash } from "~/lib/log.server";
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
  env: PiiEnv,
  contactKnown: boolean = true,
  triggeredAt: Date | null = null
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
    // T5: Set locationDeletedAt on existing COMPANY row (preserves first delete time)
    // Use COALESCE so a repeat delete keeps the original timestamp
    const deleteTime = triggeredAt ?? new Date();
    await sql`
      UPDATE "BuyerAccount"
      SET "locationDeletedAt" = COALESCE("locationDeletedAt", ${deleteTime}),
          "updatedAt" = NOW()
      WHERE "shopId" = ${shopId}
        AND "companyLocationId" = ${location.id}
        AND kind = 'COMPANY'
    `;
    await markWebhookProcessed(sql, webhookId, topic, location.id);
    return {
      success: true,
      action: "updated",
      skipReason: "Company location deleted; BuyerAccount marked with locationDeletedAt",
    };
  }

  // T5 restore semantics for webhook path: A non-DELETE webhook (CREATE/UPDATE) means
  // Shopify just told us this location exists NOW. The webhook payload is a fresh fetch,
  // so seeing the location here is equivalent to re-fetching it from Shopify. We clear
  // locationDeletedAt only if triggeredAt (X-Shopify-Triggered-At) is newer than the
  // existing delete timestamp - this prevents stale webhook payloads (delivered late or
  // reprocessed) from incorrectly restoring a location that was deleted after them.
  const paymentTerms = location.buyerExperienceConfiguration?.paymentTermsTemplate;
  const defaultTermsDays = paymentTerms?.dueInDays ?? null;

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

  // T4: Only use transaction+lock when gating is enforced. Otherwise, use main's plain upsert.
  let action: "created" | "updated" | "gated";
  let entityId: string;

  if (!isGatingEnforced()) {
    // Flag off: main's code path - plain upsert, no transaction, no lock
    // When contactKnown=false (ACCESS_DENIED fallback), preserve existing contact fields
    // T5: Clear locationDeletedAt only if triggeredAt is newer than the delete
    const restoreTime = triggeredAt ?? new Date();
    const [result] = await sql<{ id: string; upsertAction: string }[]>`
      INSERT INTO "BuyerAccount" (
        "shopId",
        kind,
        "companyId",
        "companyLocationId",
        name,
        "defaultTermsDays",
        "defaultTermsSource",
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
        "mainContactEmail" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactEmail" ELSE "BuyerAccount"."mainContactEmail" END,
        "mainContactName" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactName" ELSE "BuyerAccount"."mainContactName" END,
        "mainContactCustomerId" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactCustomerId" ELSE "BuyerAccount"."mainContactCustomerId" END,
        "locationDeletedAt" = CASE
          WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL AND ${restoreTime} > "BuyerAccount"."locationDeletedAt"
          THEN NULL
          ELSE "BuyerAccount"."locationDeletedAt"
        END,
        "updatedAt" = NOW()
      RETURNING id, (xmax = 0)::text as "upsertAction"
    `;
    action = result.upsertAction === "true" ? "created" : "updated";
    entityId = result.id;
  } else {
    // Flag on: check plan limit to decide if we need transaction
    const plan = await getPlanByShopId(sql, shopId);
    const limit = planLimit(plan, "companies");

    if (limit === -1) {
      // Unlimited plan: plain upsert without transaction (no gating needed)
      // T5: Clear locationDeletedAt only if triggeredAt is newer than the delete
      const restoreTime = triggeredAt ?? new Date();
      const [result] = await sql<{ id: string; upsertAction: string }[]>`
        INSERT INTO "BuyerAccount" (
          "shopId",
          kind,
          "companyId",
          "companyLocationId",
          name,
          "defaultTermsDays",
          "defaultTermsSource",
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
          "mainContactEmail" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactEmail" ELSE "BuyerAccount"."mainContactEmail" END,
          "mainContactName" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactName" ELSE "BuyerAccount"."mainContactName" END,
          "mainContactCustomerId" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactCustomerId" ELSE "BuyerAccount"."mainContactCustomerId" END,
          "locationDeletedAt" = CASE
            WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL AND ${restoreTime} > "BuyerAccount"."locationDeletedAt"
            THEN NULL
            ELSE "BuyerAccount"."locationDeletedAt"
          END,
          "updatedAt" = NOW()
        RETURNING id, (xmax = 0)::text as "upsertAction"
      `;
      action = result.upsertAction === "true" ? "created" : "updated";
      entityId = result.id;
    } else {
      // Limited plan: use transaction with gating decision
      // T5: Clear locationDeletedAt only if triggeredAt is newer than the delete
      const restoreTime = triggeredAt ?? new Date();
      const hash = await shopHash(shopDomain);
      const txResult = await sql.begin(async (tx) => {
        const [existingAccount] = await tx<{ id: string; gated_at: Date | null }[]>`
          SELECT id, gated_at FROM "BuyerAccount"
          WHERE "shopId" = ${shopId} AND "companyLocationId" = ${location.id}
        `;

        let shouldGate = false;
        if (!existingAccount) {
          const decision = await decideNewAccountGate(tx, shopId, limit);
          shouldGate = decision.gate;
        }

        // When contactKnown=false (ACCESS_DENIED fallback), preserve existing contact fields
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
            "mainContactEmail" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactEmail" ELSE "BuyerAccount"."mainContactEmail" END,
            "mainContactName" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactName" ELSE "BuyerAccount"."mainContactName" END,
            "mainContactCustomerId" = CASE WHEN ${contactKnown} THEN EXCLUDED."mainContactCustomerId" ELSE "BuyerAccount"."mainContactCustomerId" END,
            "locationDeletedAt" = CASE
              WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL AND ${restoreTime} > "BuyerAccount"."locationDeletedAt"
              THEN NULL
              ELSE "BuyerAccount"."locationDeletedAt"
            END,
            "updatedAt" = NOW()
          RETURNING id, (xmax = 0)::text as "upsertAction", gated_at
        `;

        let resultAction: "created" | "updated" | "gated";
        if (result.upsertAction === "true") {
          resultAction = shouldGate ? "gated" : "created";
          if (shouldGate) {
            safeLog("info", "account_gated_company", { shopHash: hash });
          }
        } else {
          resultAction = "updated";
        }

        return { action: resultAction, entityId: result.id };
      });
      action = txResult.action;
      entityId = txResult.entityId;
    }
  }

  await markWebhookProcessed(sql, webhookId, topic, location.id);

  return {
    success: true,
    action,
    entityId,
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
 * T4: When PLAN_GATING_ENFORCED is ON, new accounts that exceed the plan
 * limit are created with gated_at set. Updates to existing accounts are
 * always allowed (downgrade-safe). Gated accounts are excluded from the
 * limit count and can be reactivated on upgrade.
 *
 * Concurrency (flag on): Uses short transactions (≤25 rows) with
 * pg_advisory_xact_lock per batch to avoid starving webhooks.
 *
 * Flag off: Row-by-row without transaction (main's original behavior),
 * so one bad row doesn't roll back the chunk.
 *
 * Orphan location handling: When contactKnown is false (orphan location whose
 * parent company was in an earlier chunk), the mainContact* columns are preserved
 * rather than overwritten with NULL. This prevents losing stored contacts.
 *
 * T5 locationDeletedAt restore: When a bulk operation sees a location, it may
 * clear locationDeletedAt (restore). To prevent stale bulk snapshots from clearing
 * a recent delete, we compare snapshotAt (Shopify's bulk operation createdAt) to
 * locationDeletedAt. If snapshotAt is older than locationDeletedAt, the location
 * was deleted after the snapshot was taken, so we must NOT clear. If snapshotAt
 * is unknown (null), we conservatively do NOT clear to avoid data loss.
 *
 * @param sql - postgres.js SQL client
 * @param accounts - Array of mapped BuyerAccount data
 * @param snapshotAt - Bulk operation's createdAt from Shopify (when the snapshot was taken)
 * @returns Number of accounts upserted
 */
export async function bulkUpsertBuyerAccounts(
  sql: Sql,
  accounts: MappedBuyerAccount[],
  snapshotAt?: Date | null
): Promise<number> {
  if (accounts.length === 0) return 0;
  
  // Normalize undefined to null for SQL compatibility (postgres.js rejects undefined)
  const bulkSnapshotAt: Date | null = snapshotAt ?? null;

  // Group accounts by shopId for batch limit checking
  const accountsByShop = new Map<string, MappedBuyerAccount[]>();
  for (const a of accounts) {
    const existing = accountsByShop.get(a.shopId) ?? [];
    existing.push(a);
    accountsByShop.set(a.shopId, existing);
  }

  let totalCount = 0;

  // Flag off: row-by-row without transaction (main's behavior, errors propagate)
  // T5: Clear locationDeletedAt only when snapshotAt is newer than the delete.
  // If snapshotAt is null (unknown), do NOT clear to prevent stale payloads from restoring.
  if (!isGatingEnforced()) {
    for (const [, shopAccounts] of accountsByShop) {
      for (const a of shopAccounts) {
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
              "locationDeletedAt" = CASE
                WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz > "BuyerAccount"."locationDeletedAt"
                THEN NULL
                ELSE "BuyerAccount"."locationDeletedAt"
              END,
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
              "locationDeletedAt" = CASE
                WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz > "BuyerAccount"."locationDeletedAt"
                THEN NULL
                ELSE "BuyerAccount"."locationDeletedAt"
              END,
              "updatedAt" = NOW()
          `;
          totalCount += result.count;
        }
      }
    }
    return totalCount;
  }

  // Flag on: use small batches (≤25 rows) with short transactions per batch
  const BATCH_SIZE = 25;

  for (const [shopId, shopAccounts] of accountsByShop) {
    const plan = await getPlanByShopId(sql, shopId);
    const limit = planLimit(plan, "companies");

    // Look up domain for shopHash logging (only needed for limited plans with potential gating)
    let hash: string | null = null;
    if (limit !== -1) {
      const [shop] = await sql<{ domain: string }[]>`
        SELECT domain FROM "Shop" WHERE id = ${shopId}
      `;
      if (shop) {
        hash = await shopHash(shop.domain);
      }
    }

    // Unlimited: process row-by-row without gating (no transaction needed, errors propagate)
    // T5: Clear locationDeletedAt only when snapshotAt is newer than the delete.
    // If snapshotAt is null (unknown), do NOT clear to prevent stale payloads from restoring.
    if (limit === -1) {
      for (const a of shopAccounts) {
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
              "locationDeletedAt" = CASE
                WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz > "BuyerAccount"."locationDeletedAt"
                THEN NULL
                ELSE "BuyerAccount"."locationDeletedAt"
              END,
              "updatedAt" = NOW()
          `;
          totalCount += result.count;
        } else {
          const result = await sql`
            INSERT INTO "BuyerAccount" (
              "shopId",
              kind,
              "companyId",
              "companyLocationId",
              name,
              "defaultTermsDays",
              "defaultTermsSource",
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
              "locationDeletedAt" = CASE
                WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz IS NOT NULL
                     AND ${bulkSnapshotAt}::timestamptz > "BuyerAccount"."locationDeletedAt"
                THEN NULL
                ELSE "BuyerAccount"."locationDeletedAt"
              END,
              "updatedAt" = NOW()
          `;
          totalCount += result.count;
        }
      }
      continue;
    }

    // Limited plan: process in small batches with short transactions
    for (let i = 0; i < shopAccounts.length; i += BATCH_SIZE) {
      const batch = shopAccounts.slice(i, i + BATCH_SIZE);

      const batchCount = await sql.begin(async (tx) => {
        await takeBaLimitLock(tx, shopId);

        const currentUsage = await countActiveAccounts(tx, shopId);
        let slotsAvailable = Math.max(0, limit - currentUsage);

        const locationIds = batch.map(a => a.companyLocationId);
        const existingAccounts = await tx<{ companyLocationId: string }[]>`
          SELECT "companyLocationId" FROM "BuyerAccount"
          WHERE "shopId" = ${shopId} AND "companyLocationId" IN ${tx(locationIds)}
        `;
        const existingSet = new Set(existingAccounts.map(e => e.companyLocationId));

        let gatedCount = 0;
        let count = 0;

        for (const a of batch) {
          const isNew = !existingSet.has(a.companyLocationId);
          let shouldGate = false;

          if (isNew) {
            if (slotsAvailable === 0) {
              shouldGate = true;
              gatedCount++;
            } else {
              slotsAvailable--;
            }
          }

          // Use different UPDATE logic based on contactKnown
          // T5: Clear locationDeletedAt only when snapshotAt is newer than the delete.
          // If snapshotAt is null (unknown), do NOT clear to prevent stale payloads from restoring.
          if (a.contactKnown) {
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
                "locationDeletedAt" = CASE
                  WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL
                       AND ${bulkSnapshotAt}::timestamptz IS NOT NULL
                       AND ${bulkSnapshotAt}::timestamptz > "BuyerAccount"."locationDeletedAt"
                  THEN NULL
                  ELSE "BuyerAccount"."locationDeletedAt"
                END,
                "updatedAt" = NOW()
            `;
            count += result.count;
          } else {
            // Orphan location: preserve existing mainContact* columns
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
                "locationDeletedAt" = CASE
                  WHEN "BuyerAccount"."locationDeletedAt" IS NOT NULL
                       AND ${bulkSnapshotAt}::timestamptz IS NOT NULL
                       AND ${bulkSnapshotAt}::timestamptz > "BuyerAccount"."locationDeletedAt"
                  THEN NULL
                  ELSE "BuyerAccount"."locationDeletedAt"
                END,
                "updatedAt" = NOW()
            `;
            count += result.count;
          }
        }

        if (gatedCount > 0 && hash) {
          safeLog("info", "bulk_accounts_gated", { gatedCount, shopHash: hash });
        }

        return count;
      });

      totalCount += batchCount;
    }
  }

  return totalCount;
}
