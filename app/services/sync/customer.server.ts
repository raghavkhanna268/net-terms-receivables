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
 * Tag activation design:
 * - Tag activation (tag_active) is SEPARATE from credit hold (BuyerAccount.holdState)
 * - Tag sync NEVER touches holdState - that belongs to credit logic alone
 * - When tag removed: set tag_active=false, record tag_deactivated_at
 * - When tag re-added: set tag_active=true, clear tag_deactivated_at
 *
 * Precedence rule:
 * When a customer is both a B2B company contact AND has a buyer tag,
 * the COMPANY BuyerAccount takes precedence for order mapping. The tagged
 * customer record is still tracked in s8_tagged_customers, but no duplicate
 * BuyerAccount is created if one already exists with kind=COMPANY.
 *
 * NOTE: Full precedence check (CompanyContact lookup) is deferred to S10.
 * For now, we rely on the order processor's resolveBuyerAccount function
 * to prefer COMPANY accounts when mapping orders.
 *
 * Lifecycle:
 * - Tag added: Create BuyerAccount (kind=TAGGED_CUSTOMER), set tag_active=true
 * - Tag removed: Set tag_active=false, DO NOT touch holdState
 * - Tag re-added: Set tag_active=true, DO NOT touch holdState
 */

import type { Sql } from "~/lib/db-light.server";
import type { ShopifyCustomer, SyncResult } from "./types";
import { isWebhookProcessed, markWebhookProcessed } from "./company.server";

/**
 * Process a Customer webhook event.
 *
 * CREATE/UPDATE: Check if customer has a matching tag (from AccountSource)
 *   - If tag matches: create or update TAGGED_CUSTOMER account, set tag_active=true
 *   - If tag removed: set tag_active=false (DO NOT touch holdState)
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

  const hasTag = !!matchingRule;

  // Should-fix #5: Don't store tags for customers that match no rule
  // Only upsert if this customer has ever had a matching tag or currently does
  if (hasTag) {
    await upsertTaggedCustomer(sql, shopId, customer.id, customerTags, true);
  } else {
    // Only update existing records (don't create new ones for non-matching customers)
    await updateTaggedCustomerIfExists(sql, shopId, customer.id, customerTags, false);
  }

  // TODO (S10): Full precedence check via CompanyContact lookup
  // For now, we create TAGGED_CUSTOMER accounts even if the customer is a
  // company contact. The order processor's resolveBuyerAccount prefers
  // COMPANY accounts when mapping orders, so this is safe.
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

  // Create or update TAGGED_CUSTOMER buyer account
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
 * Marks the tagged customer record as inactive and preserves BuyerAccount.
 */
async function handleCustomerDelete(
  sql: Sql,
  shopId: string,
  customerId: string,
  webhookId: string,
  topic: string
): Promise<void> {
  // Mark customer as no longer having the tag (deactivate)
  await sql`
    UPDATE s8_tagged_customers
    SET tag_active = false, tag_deactivated_at = NOW()
    WHERE shop_id = ${shopId} AND customer_id = ${customerId}
  `;

  // Don't delete BuyerAccount - may have invoices (financial history)
  // Don't touch holdState - that belongs to credit logic
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
  tagActive: boolean
): Promise<void> {
  const tagsJson = sql.json(tags);
  const deactivatedAt = tagActive ? null : new Date();
  await sql`
    INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, tag_deactivated_at)
    VALUES (${shopId}, ${customerId}, ${tagsJson}, ${tagActive}, ${deactivatedAt})
    ON CONFLICT (shop_id, customer_id)
    DO UPDATE SET
      tags = EXCLUDED.tags,
      tag_active = EXCLUDED.tag_active,
      tag_deactivated_at = CASE
        WHEN EXCLUDED.tag_active = true THEN NULL
        WHEN s8_tagged_customers.tag_active = true AND EXCLUDED.tag_active = false THEN NOW()
        ELSE s8_tagged_customers.tag_deactivated_at
      END
  `;
}

/**
 * Update tagged customer if exists (for non-matching customers).
 * Should-fix #5: Don't create records for customers with no matching tag.
 */
async function updateTaggedCustomerIfExists(
  sql: Sql,
  shopId: string,
  customerId: string,
  tags: string[],
  tagActive: boolean
): Promise<void> {
  const tagsJson = sql.json(tags);
  await sql`
    UPDATE s8_tagged_customers
    SET 
      tags = ${tagsJson},
      tag_active = ${tagActive},
      tag_deactivated_at = CASE
        WHEN ${tagActive} = true THEN NULL
        WHEN tag_active = true AND ${tagActive} = false THEN NOW()
        ELSE tag_deactivated_at
      END
    WHERE shop_id = ${shopId} AND customer_id = ${customerId}
  `;
}

/**
 * Check if a customer is associated with a COMPANY buyer account.
 *
 * TODO (S10): Implement proper CompanyContact lookup via GraphQL or by
 * tracking customer->company relationships in the database.
 *
 * For now, this returns false. The order processor's resolveBuyerAccount
 * function will prefer COMPANY accounts when mapping orders, so creating
 * a TAGGED_CUSTOMER account for a company contact is safe - orders will
 * still be attributed to the correct COMPANY account.
 *
 * @param _sql - postgres.js SQL client (unused pending S10)
 * @param _shopId - Shop ID (unused pending S10)
 * @param _customerId - Customer GID (unused pending S10)
 * @returns false - Full implementation deferred to S10
 */
async function checkCompanyAccount(
  _sql: Sql,
  _shopId: string,
  _customerId: string
): Promise<boolean> {
  // TODO (S10): Query for COMPANY BuyerAccount linked to orders from this customer,
  // or implement CompanyContact lookup via read_companies scope.
  return false;
}

/**
 * Sync the BuyerAccount for a tagged customer.
 *
 * IMPORTANT: This function NEVER writes holdState.
 * - holdState belongs to credit logic (HELD, NEAR_LIMIT, BYPASS)
 * - Tag activation state is tracked in s8_tagged_customers.tag_active
 *
 * - hasTag=true: Create or update TAGGED_CUSTOMER account (terms only if source allows)
 * - hasTag=false: Just update tag_active flag (already done), don't touch BuyerAccount
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
    // Tag removed: we already updated tag_active in the tracking table
    // DO NOT touch BuyerAccount.holdState - that belongs to credit logic
    return {
      success: true,
      action: "skipped",
      skipReason: "Tag removed; tag_active set to false (holdState unchanged)",
    };
  }

  // Tag present: create or update account
  // Build display name from customer ID (we don't have name due to DPDP)
  const customerId_numeric = customerId.split("/").pop() ?? customerId;
  const displayName = `Customer ${customerId_numeric}`;

  // Pre-compute derived values
  const termsSource = defaultTermsDays !== null ? "tag" : null;

  // Must-fix #2: Only apply defaultTermsDays when existing source is NULL or 'tag'
  // Never overwrite 'explicit' (merchant-set) terms
  const [result] = await sql<{ id: string; isNew: string }[]>`
    INSERT INTO "BuyerAccount" (
      "shopId",
      kind,
      "customerId",
      name,
      "defaultTermsDays",
      "defaultTermsSource",
      "createdAt",
      "updatedAt"
    ) VALUES (
      ${shopId},
      'TAGGED_CUSTOMER',
      ${customerId},
      ${displayName},
      ${defaultTermsDays},
      ${termsSource},
      NOW(),
      NOW()
    )
    ON CONFLICT ("shopId", "customerId")
    DO UPDATE SET
      name = COALESCE("BuyerAccount".name, EXCLUDED.name),
      -- Only apply tag terms if source is NULL or 'tag', never override 'explicit'
      "defaultTermsDays" = CASE
        WHEN "BuyerAccount"."defaultTermsSource" = 'explicit' THEN "BuyerAccount"."defaultTermsDays"
        ELSE COALESCE(EXCLUDED."defaultTermsDays", "BuyerAccount"."defaultTermsDays")
      END,
      "defaultTermsSource" = CASE
        WHEN "BuyerAccount"."defaultTermsSource" = 'explicit' THEN 'explicit'
        ELSE COALESCE(EXCLUDED."defaultTermsSource", "BuyerAccount"."defaultTermsSource")
      END,
      -- NEVER touch holdState - that belongs to credit logic
      "updatedAt" = NOW()
    RETURNING id, (xmax = 0)::text as "isNew"
  `;

  const wasNew = result.isNew === "true";

  return {
    success: true,
    action: wasNew ? "created" : "updated",
    entityId: result.id,
  };
}

/**
 * Map a Shopify Customer to tagged customer tracking data.
 * Used by bulk processing to prepare batch inserts.
 *
 * @param shopId - Our internal shop ID
 * @param customer - Shopify Customer data (id and tags only)
 * @param tagActive - Whether the customer has a matching tag
 */
export function mapCustomerToTaggedCustomer(
  shopId: string,
  customer: ShopifyCustomer,
  tagActive: boolean
): {
  shopId: string;
  customerId: string;
  tags: string[];
  tagActive: boolean;
} {
  return {
    shopId,
    customerId: customer.id,
    tags: customer.tags ?? [],
    tagActive,
  };
}

/**
 * Bulk upsert tagged customers.
 * Used by bulk operation processor for efficient batch inserts.
 *
 * Should-fix #5: Only call this for customers that match a tag rule.
 *
 * @param sql - postgres.js SQL client
 * @param customers - Array of mapped tagged customer data (only matching customers)
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
    const deactivatedAt = c.tagActive ? null : new Date();
    const result = await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, tag_deactivated_at)
      VALUES (${c.shopId}, ${c.customerId}, ${tagsJson}, ${c.tagActive}, ${deactivatedAt})
      ON CONFLICT (shop_id, customer_id)
      DO UPDATE SET
        tags = EXCLUDED.tags,
        tag_active = EXCLUDED.tag_active,
        tag_deactivated_at = CASE
          WHEN EXCLUDED.tag_active = true THEN NULL
          WHEN s8_tagged_customers.tag_active = true AND EXCLUDED.tag_active = false THEN NOW()
          ELSE s8_tagged_customers.tag_deactivated_at
        END
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

/**
 * Delete all S8 data for a specific customer (customers/redact).
 * Called by the compliance webhook handler.
 *
 * Deletes from both:
 * - s8_tagged_customers: Customer tag tracking
 * - s8_draft_orders: Draft orders linked to this customer's buyer account
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param customerId - Customer GID to redact
 * @returns Object with counts of deleted rows from each table
 */
export async function redactCustomerData(
  sql: Sql,
  shopId: string,
  customerId: string
): Promise<{ taggedCustomers: number; draftOrders: number }> {
  // Delete tagged customer record
  const taggedResult = await sql`
    DELETE FROM s8_tagged_customers
    WHERE shop_id = ${shopId} AND customer_id = ${customerId}
  `;

  // Delete draft orders linked to this customer's buyer account
  // First find the buyer account for this customer, then delete its draft orders
  const draftResult = await sql`
    DELETE FROM s8_draft_orders
    WHERE shop_id = ${shopId}
      AND buyer_account_id IN (
        SELECT id FROM "BuyerAccount"
        WHERE "shopId" = ${shopId} AND "customerId" = ${customerId}
      )
  `;

  return {
    taggedCustomers: taggedResult.count,
    draftOrders: draftResult.count,
  };
}

/**
 * Delete all S8 data for a shop (shop/redact).
 * Called by the compliance webhook handler.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID to purge
 * @returns Object with counts of deleted rows
 */
export async function redactShopData(
  sql: Sql,
  shopId: string
): Promise<{ taggedCustomers: number; draftOrders: number }> {
  const taggedResult = await sql`
    DELETE FROM s8_tagged_customers WHERE shop_id = ${shopId}
  `;
  const draftResult = await sql`
    DELETE FROM s8_draft_orders WHERE shop_id = ${shopId}
  `;
  return {
    taggedCustomers: taggedResult.count,
    draftOrders: draftResult.count,
  };
}
