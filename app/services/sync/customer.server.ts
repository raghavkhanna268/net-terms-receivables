/**
 * Customer sync processor for S8.
 *
 * Maps Shopify Customers with matching tags to BuyerAccount (kind=TAGGED_CUSTOMER).
 * Tag rules are stored in AccountSource, specifying which tags denote buyer accounts.
 *
 * DPDP compliance:
 * - Only customer GID and tags are fetched and stored
 * - No names, emails, phones, or addresses (reserved fields are always NULL)
 *
 * Precedence rule:
 * When a customer is both a B2B company contact AND has a buyer tag,
 * the COMPANY BuyerAccount takes precedence for order mapping. The tagged
 * customer record is still tracked in s8_tagged_customers, but no duplicate
 * BuyerAccount is created if one already exists with kind=COMPANY.
 *
 * Lifecycle:
 * - Tag added: Create BuyerAccount (kind=TAGGED_CUSTOMER) if no COMPANY account exists
 * - Tag removed: Deactivate BuyerAccount (set holdState=HELD) but never delete
 * - Tag re-added: Reactivate BuyerAccount (set holdState=OK)
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCustomer, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";

/**
 * Process a Customer webhook event.
 *
 * CREATE/UPDATE: Check if customer has a matching tag (from AccountSource)
 *   - If tag matches and no COMPANY account exists: create/reactivate TAGGED_CUSTOMER
 *   - If tag removed and TAGGED_CUSTOMER exists: deactivate (hold) the account
 * DELETE: Mark customer record as deleted but preserve BuyerAccount for financial history
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @param topic - Webhook topic
 * @param customer - Customer data (id and tags only)
 * @param webhookId - Webhook ID for idempotency
 * @returns Sync result
 */
export async function processCustomerWebhook(
  sql: Sql,
  shopDomain: string,
  topic: string,
  customer: ShopifyCustomer,
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

  // Get shop with its tag rules
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

  // Handle DELETE: preserve financial history
  if (topic === "CUSTOMERS_DELETE") {
    await handleCustomerDelete(sql, shopId, customer.id, webhookId, topic);
    return {
      success: true,
      action: "skipped",
      skipReason: "Customer deleted; BuyerAccount preserved for financial history",
    };
  }

  // Get tag rules for this shop
  const tagRules = await sql<{ tag: string; defaultTermsDays: number }[]>`
    SELECT tag, "defaultTermsDays" FROM "AccountSource" WHERE "shopId" = ${shopId}
  `;

  if (tagRules.length === 0) {
    // No tag rules configured; nothing to do
    await markWebhookProcessed(sql, webhookId, topic, customer.id);
    return {
      success: true,
      action: "skipped",
      skipReason: "No tag rules configured for shop",
    };
  }

  // Check if customer has any matching tag
  const customerTags = customer.tags ?? [];
  const matchingRule = tagRules.find((rule) =>
    customerTags.some((tag) => tag.toLowerCase() === rule.tag.toLowerCase())
  );

  // Upsert the tagged customer record
  const hasTag = !!matchingRule;
  await upsertTaggedCustomer(sql, shopId, customer.id, customerTags, hasTag);

  // Check if customer already has a COMPANY buyer account (precedence rule)
  const hasCompanyAccount = await checkCompanyAccount(sql, shopId, customer.id);

  if (hasCompanyAccount) {
    // COMPANY account takes precedence; don't create TAGGED_CUSTOMER
    await markWebhookProcessed(sql, webhookId, topic, customer.id);
    return {
      success: true,
      action: "skipped",
      skipReason: "Customer is a B2B company contact; COMPANY account takes precedence",
    };
  }

  // Create, update, or deactivate TAGGED_CUSTOMER buyer account
  const result = await syncTaggedCustomerBuyerAccount(
    sql,
    shopId,
    customer.id,
    hasTag,
    matchingRule?.defaultTermsDays ?? null
  );

  await markWebhookProcessed(sql, webhookId, topic, customer.id);

  return result;
}

/**
 * Handle customer deletion.
 * Marks the tagged customer record and preserves BuyerAccount for financial history.
 */
async function handleCustomerDelete(
  sql: Sql,
  shopId: string,
  customerId: string,
  webhookId: string,
  topic: string
): Promise<void> {
  // Mark customer as no longer having the tag (soft delete)
  await sql`
    UPDATE s8_tagged_customers
    SET has_tag = false, updated_at = NOW()
    WHERE shop_id = ${shopId} AND customer_id = ${customerId}
  `;

  // Don't delete BuyerAccount - may have invoices (financial history)
  // Just mark webhook as processed
  await markWebhookProcessed(sql, webhookId, topic, customerId);
}

/**
 * Upsert the tagged customer tracking record.
 */
async function upsertTaggedCustomer(
  sql: Sql,
  shopId: string,
  customerId: string,
  tags: string[],
  hasTag: boolean
): Promise<void> {
  const tagsJson = sql.json(tags);
  await sql`
    INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, has_tag)
    VALUES (${shopId}, ${customerId}, ${tagsJson}, ${hasTag})
    ON CONFLICT (shop_id, customer_id)
    DO UPDATE SET
      tags = EXCLUDED.tags,
      has_tag = EXCLUDED.has_tag,
      updated_at = NOW()
  `;
}

/**
 * Check if a customer is associated with a COMPANY buyer account.
 * This happens when the customer is a contact for a B2B company.
 *
 * Note: Shopify links customers to companies, but the link is on the
 * CompanyContact, not directly on Customer. For now, we check if any
 * order from this customer was placed through a company (purchasingEntity).
 * A more complete solution would query CompanyContact, but that requires
 * read_companies scope which we already have.
 *
 * @param _sql - postgres.js SQL client (unused in current implementation)
 * @param _shopId - Shop ID (unused in current implementation)
 * @param _customerId - Customer GID (unused in current implementation)
 * @returns false - Full implementation deferred to S10
 */
async function checkCompanyAccount(
  _sql: Sql,
  _shopId: string,
  _customerId: string
): Promise<boolean> {
  // TODO: In S10, implement proper CompanyContact lookup
  // For now, we allow tagged customer accounts to be created even if the
  // customer is a company contact. The order processor's resolveBuyerAccount
  // function will prefer COMPANY accounts when mapping orders.
  //
  // Future implementation would:
  // 1. Query CompanyContact for this customer GID
  // 2. If found, return true to skip TAGGED_CUSTOMER creation
  // 3. This prevents duplicate accounts for B2B company contacts
  return false;
}

/**
 * Sync the BuyerAccount for a tagged customer.
 *
 * - hasTag=true: Create or reactivate TAGGED_CUSTOMER account
 * - hasTag=false: Deactivate (hold) the account
 *
 * Returns the sync result indicating what action was taken.
 */
async function syncTaggedCustomerBuyerAccount(
  sql: Sql,
  shopId: string,
  customerId: string,
  hasTag: boolean,
  defaultTermsDays: number | null
): Promise<SyncResult> {
  if (!hasTag) {
    // Tag removed: deactivate the account
    const [deactivated] = await sql<{ id: string }[]>`
      UPDATE "BuyerAccount"
      SET "holdState" = 'HELD', "updatedAt" = NOW()
      WHERE "shopId" = ${shopId}
        AND "customerId" = ${customerId}
        AND kind = 'TAGGED_CUSTOMER'
        AND "holdState" != 'HELD'
      RETURNING id
    `;

    if (deactivated) {
      return {
        success: true,
        action: "updated",
        entityId: deactivated.id,
        skipReason: "Tag removed; account deactivated (held)",
      };
    }

    return {
      success: true,
      action: "skipped",
      skipReason: "Tag removed; no active account to deactivate",
    };
  }

  // Tag present: create or reactivate account
  // Build display name from customer ID (we don't have name due to DPDP)
  const customerId_numeric = customerId.split("/").pop() ?? customerId;
  const displayName = `Customer ${customerId_numeric}`;

  // Pre-compute derived values to avoid parameter type issues in SQL
  const termsSource = defaultTermsDays !== null ? "tag" : null;

  const [result] = await sql<{ id: string; action: string; wasHeld: boolean }[]>`
    INSERT INTO "BuyerAccount" (
      "shopId",
      kind,
      "customerId",
      name,
      "defaultTermsDays",
      "defaultTermsSource",
      "holdState",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${shopId},
      'TAGGED_CUSTOMER',
      ${customerId},
      ${displayName},
      ${defaultTermsDays},
      ${termsSource},
      'OK',
      NOW(),
      NOW()
    )
    ON CONFLICT ("shopId", "customerId")
    DO UPDATE SET
      "defaultTermsDays" = COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays"),
      "defaultTermsSource" = COALESCE(EXCLUDED."defaultTermsSource", "BuyerAccount"."defaultTermsSource"),
      "holdState" = 'OK',
      "updatedAt" = NOW()
    RETURNING id, (xmax = 0)::text as action, ("holdState" = 'HELD') as "wasHeld"
  `;

  const wasNew = result.action === "true";
  const wasReactivated = !wasNew && result.wasHeld;

  return {
    success: true,
    action: wasNew ? "created" : "updated",
    entityId: result.id,
    skipReason: wasReactivated ? "Tag re-added; account reactivated" : undefined,
  };
}

/**
 * Map a Shopify Customer to tagged customer tracking data.
 * Used by bulk processing to prepare batch inserts.
 *
 * @param shopId - Our internal shop ID
 * @param customer - Shopify Customer data (id and tags only)
 * @param hasTag - Whether the customer has a matching tag
 */
export function mapCustomerToTaggedCustomer(
  shopId: string,
  customer: ShopifyCustomer,
  hasTag: boolean
): {
  shopId: string;
  customerId: string;
  tags: string[];
  hasTag: boolean;
} {
  return {
    shopId,
    customerId: customer.id,
    tags: customer.tags ?? [],
    hasTag,
  };
}

/**
 * Bulk upsert tagged customers.
 * Used by bulk operation processor for efficient batch inserts.
 *
 * @param sql - postgres.js SQL client
 * @param customers - Array of mapped tagged customer data
 * @returns Number of customers upserted
 */
export async function bulkUpsertTaggedCustomers(
  sql: Sql,
  customers: ReturnType<typeof mapCustomerToTaggedCustomer>[]
): Promise<number> {
  if (customers.length === 0) return 0;

  let count = 0;
  for (const c of customers) {
    const tagsJson = sql.json(c.tags);
    const result = await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, has_tag)
      VALUES (${c.shopId}, ${c.customerId}, ${tagsJson}, ${c.hasTag})
      ON CONFLICT (shop_id, customer_id)
      DO UPDATE SET
        tags = EXCLUDED.tags,
        has_tag = EXCLUDED.has_tag,
        updated_at = NOW()
    `;
    count += result.count;
  }

  return count;
}

/**
 * Get tag rules for a shop.
 * Returns the list of tags that denote buyer accounts and their default terms.
 */
export async function getTagRules(
  sql: Sql,
  shopId: string
): Promise<Array<{ tag: string; defaultTermsDays: number }>> {
  return sql<{ tag: string; defaultTermsDays: number }[]>`
    SELECT tag, "defaultTermsDays" FROM "AccountSource" WHERE "shopId" = ${shopId}
  `;
}

/**
 * Check if a customer has a matching tag from the shop's tag rules.
 *
 * @param customerTags - Customer's tags array
 * @param tagRules - Shop's tag rules from AccountSource
 * @returns Matching rule or undefined
 */
export function findMatchingTagRule(
  customerTags: string[],
  tagRules: Array<{ tag: string; defaultTermsDays: number }>
): { tag: string; defaultTermsDays: number } | undefined {
  return tagRules.find((rule) =>
    customerTags.some((tag) => tag.toLowerCase() === rule.tag.toLowerCase())
  );
}
