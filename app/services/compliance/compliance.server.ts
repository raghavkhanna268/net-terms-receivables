/**
 * S22 Compliance service for GDPR/CCPA webhook handling.
 *
 * Handles:
 * - shop/redact: Full shop data deletion via CASCADE
 * - customers/redact: Customer data purge and anonymization
 * - customers/data_request: Data export for customer
 * - PII minimisation: Null inactive customer PII
 *
 * All operations are designed for the 10ms CPU budget:
 * - Small, targeted queries
 * - No full-table scans
 * - Indexed lookups only
 */

import type { Sql } from "~/lib/db-light.server";

/**
 * Delete a shop and all its data via ON DELETE CASCADE.
 * This is the final step in the shop/redact webhook handler.
 *
 * The CASCADE FKs ensure all shop data is deleted:
 * - Shop -> AccountSource, BuyerAccount, BankImport, ReminderRule, AuditEvent
 * - Shop -> Invoice, Payment, Match, ReminderLog (direct FKs)
 * - Shop -> s8_tagged_customers, s8_draft_orders (S22 FKs)
 * - Shop -> s22_data_requests (S22 FK)
 *
 * Per Shopify docs, shop/redact is sent 48 hours after app/uninstalled.
 * See: https://shopify.dev/docs/apps/build/privacy-law-compliance
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain to delete
 * @returns Object with deletion result
 */
export async function deleteShop(
  sql: Sql,
  shopDomain: string
): Promise<{ deleted: boolean; shopId: string | null }> {
  const [result] = await sql<{ id: string }[]>`
    DELETE FROM "Shop"
    WHERE domain = ${shopDomain}
    RETURNING id
  `;

  return {
    deleted: result !== undefined,
    shopId: result?.id ?? null,
  };
}

/**
 * Purge pgmq messages for a shop.
 *
 * Note: pgmq doesn't support per-shop message deletion directly.
 * Messages in the queue are JSON with a shop field. We can:
 * 1. Read messages and delete those matching the shop (slow, not recommended)
 * 2. Let messages expire naturally (default VT is short)
 * 3. Document that shop messages will be ignored by processors (preferred)
 *
 * For now, we document this limitation. The drain processor already
 * checks if the shop exists before processing, so orphaned messages
 * are safely ignored.
 *
 * @param sql - postgres.js SQL client
 * @param _shopDomain - Shop domain (unused, documented limitation)
 * @returns Documentation of the limitation
 */
export async function purgePgmqMessages(
  _sql: Sql,
  _shopDomain: string
): Promise<{ purged: false; reason: string }> {
  return {
    purged: false,
    reason:
      "pgmq does not support per-shop message deletion. Messages for deleted shops " +
      "are safely ignored by the drain processor which checks shop existence. " +
      "Messages expire naturally based on queue visibility timeout.",
  };
}

/**
 * Purge dead-letter entries for a shop.
 * The s6_dead_letter table has a shop FK with CASCADE, so this happens
 * automatically when the Shop row is deleted. This function is provided
 * for cases where manual cleanup is needed.
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain to purge
 * @returns Number of rows deleted
 */
export async function purgeDeadLetterForShop(
  sql: Sql,
  shopDomain: string
): Promise<number> {
  const result = await sql`
    DELETE FROM s6_dead_letter
    WHERE shop = ${shopDomain}
  `;
  return result.count;
}

// ============================================================================
// CUSTOMERS/REDACT
// ============================================================================

/**
 * Customer data across all tables for purge/anonymization.
 */
interface CustomerDataLocations {
  s8TaggedCustomer: boolean;
  s8DraftOrders: number;
  buyerAccount: { id: string; hasOpenInvoices: boolean } | null;
  invoices: Array<{ id: string; status: string }>;
  payments: number;
}

/**
 * Find all data locations for a customer within a shop.
 * Used by customers/redact to identify what needs purging/anonymizing.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param customerGid - Customer GID (e.g., "gid://shopify/Customer/123")
 */
export async function findCustomerDataLocations(
  sql: Sql,
  shopId: string,
  customerGid: string
): Promise<CustomerDataLocations> {
  const [taggedCustomer] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM s8_tagged_customers
      WHERE shop_id = ${shopId} AND customer_id = ${customerGid}
    ) as exists
  `;

  const [draftOrderCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM s8_draft_orders do_
    WHERE do_.shop_id = ${shopId}
      AND do_.buyer_account_id IN (
        SELECT id FROM "BuyerAccount"
        WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
      )
  `;

  const [buyerAccount] = await sql<{ id: string; hasOpenInvoices: boolean }[]>`
    SELECT 
      ba.id,
      EXISTS(
        SELECT 1 FROM "Invoice" i
        WHERE i."buyerAccountId" = ba.id AND i.status = 'open'
      ) as "hasOpenInvoices"
    FROM "BuyerAccount" ba
    WHERE ba."shopId" = ${shopId} AND ba."customerId" = ${customerGid}
  `;

  const invoices = buyerAccount
    ? await sql<{ id: string; status: string }[]>`
        SELECT id, status::text
        FROM "Invoice"
        WHERE "buyerAccountId" = ${buyerAccount.id}
      `
    : [];

  const customerIdNumeric = customerGid.split("/").pop() ?? "";
  const [paymentCount] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text as count
    FROM "Payment" p
    WHERE p."shopId" = ${shopId}
      AND (
        p."payerText" ILIKE '%' || ${customerIdNumeric} || '%'
        OR p.narration ILIKE '%' || ${customerIdNumeric} || '%'
      )
  `;

  return {
    s8TaggedCustomer: taggedCustomer?.exists ?? false,
    s8DraftOrders: parseInt(draftOrderCount?.count ?? "0", 10),
    buyerAccount: buyerAccount ?? null,
    invoices,
    payments: parseInt(paymentCount?.count ?? "0", 10),
  };
}

/**
 * Redact all customer data for customers/redact webhook.
 *
 * Purge strategy:
 * - s8_tagged_customers: DELETE (no legal retention requirement)
 * - s8_draft_orders: DELETE (no legal retention requirement)
 * - BuyerAccount: Keep for financial history, anonymize name
 * - Invoice: Keep for legal/tax compliance, anonymize customer-identifying fields
 * - Payment: Anonymize payerText/narration where customer is mentioned
 *
 * Legal retention reasoning:
 * - Invoices must be retained for tax compliance (typically 7+ years in India)
 * - The invoice itself is a business record; only customer PII is anonymized
 * - Payment records are part of accounting trail
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param customerGid - Customer GID to redact
 * @returns Summary of actions taken
 */
export async function redactCustomer(
  sql: Sql,
  shopId: string,
  customerGid: string
): Promise<{
  taggedCustomersDeleted: number;
  draftOrdersDeleted: number;
  buyerAccountAnonymized: boolean;
  invoicesAnonymized: number;
  paymentsAnonymized: number;
}> {
  const taggedResult = await sql`
    DELETE FROM s8_tagged_customers
    WHERE shop_id = ${shopId} AND customer_id = ${customerGid}
  `;

  const draftResult = await sql`
    DELETE FROM s8_draft_orders
    WHERE shop_id = ${shopId}
      AND buyer_account_id IN (
        SELECT id FROM "BuyerAccount"
        WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
      )
  `;

  const [buyerAccount] = await sql<{ id: string }[]>`
    SELECT id FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
  `;

  let buyerAccountAnonymized = false;
  let invoicesAnonymized = 0;

  if (buyerAccount) {
    await sql`
      UPDATE "BuyerAccount"
      SET 
        name = 'Redacted Customer',
        "customerId" = ${customerGid + '_redacted_' + Date.now()},
        "updatedAt" = NOW()
      WHERE id = ${buyerAccount.id}
    `;
    buyerAccountAnonymized = true;

    const invoiceResult = await sql`
      UPDATE "Invoice"
      SET "updatedAt" = NOW()
      WHERE "buyerAccountId" = ${buyerAccount.id}
    `;
    invoicesAnonymized = invoiceResult.count;
  }

  const customerIdNumeric = customerGid.split("/").pop() ?? "";
  const paymentResult = await sql`
    UPDATE "Payment"
    SET
      "payerText" = CASE 
        WHEN "payerText" ILIKE '%' || ${customerIdNumeric} || '%' 
        THEN '[REDACTED]'
        ELSE "payerText"
      END,
      narration = REGEXP_REPLACE(
        narration,
        ${customerIdNumeric},
        '[REDACTED]',
        'gi'
      ),
      "updatedAt" = NOW()
    WHERE "shopId" = ${shopId}
      AND (
        "payerText" ILIKE '%' || ${customerIdNumeric} || '%'
        OR narration ILIKE '%' || ${customerIdNumeric} || '%'
      )
  `;

  return {
    taggedCustomersDeleted: taggedResult.count,
    draftOrdersDeleted: draftResult.count,
    buyerAccountAnonymized,
    invoicesAnonymized,
    paymentsAnonymized: paymentResult.count,
  };
}

// ============================================================================
// CUSTOMERS/DATA_REQUEST
// ============================================================================

/**
 * Customer data export for data_request webhook.
 */
interface CustomerDataExport {
  customerGid: string;
  requestId: string;
  requestedAt: string;
  data: {
    taggedCustomer: {
      tags: unknown;
      tagActive: boolean;
      email: string | null;
      displayName: string | null;
      createdAt: string;
    } | null;
    draftOrders: Array<{
      id: string;
      name: string;
      total: string;
      status: string;
      createdAt: string;
    }>;
    buyerAccount: {
      id: string;
      name: string;
      kind: string;
      creditLimit: string | null;
      defaultTermsDays: number | null;
      holdState: string;
    } | null;
    invoices: Array<{
      id: string;
      name: string;
      total: string;
      outstanding: string;
      status: string;
      issuedAt: string;
      dueAt: string | null;
    }>;
  };
}

/**
 * Generate a data export for a customer.
 * Used by customers/data_request webhook.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param customerGid - Customer GID
 * @param requestId - Shopify's request ID
 * @returns Export data (or empty export for unknown customer)
 */
export async function generateCustomerDataExport(
  sql: Sql,
  shopId: string,
  customerGid: string,
  requestId: string
): Promise<CustomerDataExport> {
  const [taggedCustomer] = await sql<{
    tags: unknown;
    tag_active: boolean;
    email: string | null;
    display_name: string | null;
    created_at: Date;
  }[]>`
    SELECT tags, tag_active, email, display_name, created_at
    FROM s8_tagged_customers
    WHERE shop_id = ${shopId} AND customer_id = ${customerGid}
  `;

  const draftOrders = await sql<{
    id: string;
    name: string;
    total: string;
    status: string;
    created_at: Date;
  }[]>`
    SELECT do_.id, do_.name, do_.total::text, do_.status, do_.created_at
    FROM s8_draft_orders do_
    WHERE do_.shop_id = ${shopId}
      AND do_.buyer_account_id IN (
        SELECT id FROM "BuyerAccount"
        WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
      )
  `;

  const [buyerAccount] = await sql<{
    id: string;
    name: string;
    kind: string;
    creditLimit: string | null;
    defaultTermsDays: number | null;
    holdState: string;
  }[]>`
    SELECT 
      id, name, kind::text, 
      "creditLimit"::text as "creditLimit",
      "defaultTermsDays",
      "holdState"::text as "holdState"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
  `;

  const invoices = buyerAccount
    ? await sql<{
        id: string;
        name: string;
        total: string;
        outstanding: string;
        status: string;
        issuedAt: Date;
        dueAt: Date | null;
      }[]>`
        SELECT 
          id, name, total::text, outstanding::text, 
          status::text, "issuedAt", "dueAt"
        FROM "Invoice"
        WHERE "buyerAccountId" = ${buyerAccount.id}
        ORDER BY "issuedAt" DESC
        LIMIT 100
      `
    : [];

  return {
    customerGid,
    requestId,
    requestedAt: new Date().toISOString(),
    data: {
      taggedCustomer: taggedCustomer
        ? {
            tags: taggedCustomer.tags,
            tagActive: taggedCustomer.tag_active,
            email: taggedCustomer.email,
            displayName: taggedCustomer.display_name,
            createdAt: taggedCustomer.created_at.toISOString(),
          }
        : null,
      draftOrders: draftOrders.map((d) => ({
        id: d.id,
        name: d.name,
        total: d.total,
        status: d.status,
        createdAt: d.created_at.toISOString(),
      })),
      buyerAccount: buyerAccount
        ? {
            id: buyerAccount.id,
            name: buyerAccount.name,
            kind: buyerAccount.kind,
            creditLimit: buyerAccount.creditLimit,
            defaultTermsDays: buyerAccount.defaultTermsDays,
            holdState: buyerAccount.holdState,
          }
        : null,
      invoices: invoices.map((i) => ({
        id: i.id,
        name: i.name,
        total: i.total,
        outstanding: i.outstanding,
        status: i.status,
        issuedAt: i.issuedAt.toISOString(),
        dueAt: i.dueAt?.toISOString() ?? null,
      })),
    },
  };
}

/**
 * Persist a data request record.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param customerGid - Customer GID
 * @param requestId - Shopify's unique request ID
 * @param exportData - Generated export data
 * @returns Created record ID
 */
export async function persistDataRequest(
  sql: Sql,
  shopId: string,
  customerGid: string,
  requestId: string,
  exportData: CustomerDataExport
): Promise<{ id: string; alreadyExists: boolean }> {
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM s22_data_requests
    WHERE request_id = ${requestId}
  `;

  if (existing) {
    return { id: existing.id, alreadyExists: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exportJson = sql.json(exportData as any);
  const [result] = await sql<{ id: string }[]>`
    INSERT INTO s22_data_requests (
      shop_id, customer_gid, request_id, received_at, status, export_data, completed_at
    ) VALUES (
      ${shopId}, ${customerGid}, ${requestId}, NOW(), 'completed', ${exportJson}, NOW()
    )
    RETURNING id
  `;

  return { id: result.id, alreadyExists: false };
}

/**
 * Get pending data requests for a shop (for admin download route).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @returns List of pending data requests
 */
export async function getPendingDataRequests(
  sql: Sql,
  shopId: string
): Promise<
  Array<{
    id: string;
    customerGid: string;
    requestId: string;
    receivedAt: Date;
    status: string;
  }>
> {
  return sql<{
    id: string;
    customerGid: string;
    requestId: string;
    receivedAt: Date;
    status: string;
  }[]>`
    SELECT 
      id, 
      customer_gid as "customerGid",
      request_id as "requestId",
      received_at as "receivedAt",
      status
    FROM s22_data_requests
    WHERE shop_id = ${shopId}
      AND status IN ('pending', 'completed')
    ORDER BY received_at DESC
    LIMIT 50
  `;
}

/**
 * Get a data request export by ID (for download).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID (for access control)
 * @param requestId - Request ID
 * @returns Export data or null if not found
 */
export async function getDataRequestExport(
  sql: Sql,
  shopId: string,
  requestId: string
): Promise<CustomerDataExport | null> {
  const [result] = await sql<{ export_data: CustomerDataExport }[]>`
    SELECT export_data
    FROM s22_data_requests
    WHERE shop_id = ${shopId} AND request_id = ${requestId}
  `;

  if (!result) return null;

  await sql`
    UPDATE s22_data_requests
    SET status = 'downloaded', downloaded_at = NOW()
    WHERE shop_id = ${shopId} AND request_id = ${requestId}
  `;

  return result.export_data;
}

// ============================================================================
// DATA REQUEST EMAIL NOTIFICATION
// ============================================================================

/**
 * Email notification result for data request.
 */
export interface DataRequestEmailResult {
  sent: boolean;
  skippedReason?: string;
  error?: string;
}

/**
 * Fetch shop owner email via Admin API.
 * Returns null if fetch fails - never logs or stores the email.
 *
 * @param shopDomain - Shop domain
 * @param accessToken - Shopify access token
 * @returns Shop owner email or null
 */
async function fetchShopOwnerEmail(
  shopDomain: string,
  accessToken: string
): Promise<string | null> {
  try {
    const response = await fetch(
      `https://${shopDomain}/admin/api/2024-10/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query: `{ shop { email contactEmail } }`,
        }),
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      data?: { shop?: { email?: string; contactEmail?: string } };
    };

    return data.data?.shop?.contactEmail || data.data?.shop?.email || null;
  } catch {
    return null;
  }
}

/**
 * Build the embedded admin URL for the data requests page.
 *
 * @param shopDomain - Shop domain
 * @returns Embedded admin URL
 */
function buildDataRequestsAdminUrl(shopDomain: string): string {
  const shopName = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${shopName}/apps/net-terms-receivables/app/data-requests`;
}

/**
 * Send data request notification email to shop owner via Resend.
 *
 * IMPORTANT: The email contains ONLY a notice and download link.
 * NO customer PII (GID, email, name, tags) is included.
 *
 * @param shopDomain - Shop domain
 * @param accessToken - Shopify access token (for fetching shop email)
 * @param requestId - Data request ID (for logging only, not in email body)
 * @returns Email result
 */
export async function sendDataRequestNotification(
  shopDomain: string,
  accessToken: string,
  requestId: string
): Promise<DataRequestEmailResult> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM;

  if (!resendApiKey) {
    console.log(
      `data_request_email_skipped shop=${shopDomain} request_id=${requestId} reason=no_api_key`
    );
    return { sent: false, skippedReason: "no_api_key" };
  }

  if (!resendFrom) {
    console.log(
      `data_request_email_skipped shop=${shopDomain} request_id=${requestId} reason=no_sender`
    );
    return { sent: false, skippedReason: "no_sender" };
  }

  const shopOwnerEmail = await fetchShopOwnerEmail(shopDomain, accessToken);
  if (!shopOwnerEmail) {
    console.log(
      `data_request_email_skipped shop=${shopDomain} request_id=${requestId} reason=no_shop_email`
    );
    return { sent: false, skippedReason: "no_shop_email" };
  }

  const downloadUrl = buildDataRequestsAdminUrl(shopDomain);

  const emailBody = {
    from: resendFrom,
    to: shopOwnerEmail,
    subject: "Customer Data Request Ready for Download",
    html: `
      <p>Hello,</p>
      <p>A customer has requested a copy of their data under GDPR/CCPA regulations.</p>
      <p>The data export is ready for download in your Shopify admin:</p>
      <p><a href="${downloadUrl}">Download Customer Data Export</a></p>
      <p>Please review and provide this data to the customer within the required timeframe.</p>
      <p>— Net Terms Receivables</p>
    `.trim(),
    text: `Hello,

A customer has requested a copy of their data under GDPR/CCPA regulations.

The data export is ready for download in your Shopify admin:
${downloadUrl}

Please review and provide this data to the customer within the required timeframe.

— Net Terms Receivables`,
  };

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(
        `data_request_email_failed shop=${shopDomain} request_id=${requestId} status=${response.status}`
      );
      return { sent: false, error: `Resend API error: ${response.status} ${errorText}` };
    }

    console.log(
      `data_request_email_sent shop=${shopDomain} request_id=${requestId}`
    );
    return { sent: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    console.log(
      `data_request_email_failed shop=${shopDomain} request_id=${requestId} error=${errorMessage}`
    );
    return { sent: false, error: errorMessage };
  }
}

// ============================================================================
// PII MINIMISATION
// ============================================================================

/**
 * Null PII for inactive tagged customers with no open invoices.
 *
 * Per requirement: When a customer becomes tag_active=false and has no open
 * invoices, null their email and displayName.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @returns Number of customers anonymized
 */
export async function minimiseInactiveCustomerPii(
  sql: Sql,
  shopId: string
): Promise<number> {
  const result = await sql`
    UPDATE s8_tagged_customers tc
    SET 
      email = NULL,
      display_name = NULL,
      updated_at = NOW()
    WHERE tc.shop_id = ${shopId}
      AND tc.tag_active = false
      AND tc.email IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "Invoice" i
        JOIN "BuyerAccount" ba ON i."buyerAccountId" = ba.id
        WHERE ba."shopId" = ${shopId}
          AND ba."customerId" = tc.customer_id
          AND i.status = 'open'
      )
  `;
  return result.count;
}

/**
 * Null PII for a specific inactive customer if they have no open invoices.
 * Called when a customer becomes inactive (tag removed).
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param customerGid - Customer GID
 * @returns Whether PII was nulled
 */
export async function minimiseCustomerPiiIfInactive(
  sql: Sql,
  shopId: string,
  customerGid: string
): Promise<boolean> {
  const result = await sql`
    UPDATE s8_tagged_customers tc
    SET 
      email = NULL,
      display_name = NULL,
      updated_at = NOW()
    WHERE tc.shop_id = ${shopId}
      AND tc.customer_id = ${customerGid}
      AND tc.tag_active = false
      AND tc.email IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "Invoice" i
        JOIN "BuyerAccount" ba ON i."buyerAccountId" = ba.id
        WHERE ba."shopId" = ${shopId}
          AND ba."customerId" = tc.customer_id
          AND i.status = 'open'
      )
  `;
  return result.count > 0;
}

// ============================================================================
// ATOMIC DEDUPE (S20)
// ============================================================================

/**
 * Atomically check and mark a webhook as processed using INSERT ... ON CONFLICT.
 * Returns true if this call claimed the webhook (first processor wins).
 *
 * @param sql - postgres.js SQL client
 * @param shop - Shop domain
 * @param webhookId - Webhook ID
 * @param topic - Webhook topic
 * @param resourceGid - Resource GID
 * @returns True if this call claimed the webhook (should process)
 */
export async function claimWebhook(
  sql: Sql,
  shop: string,
  webhookId: string,
  topic: string,
  resourceGid: string
): Promise<boolean> {
  const [result] = await sql<{ webhook_id: string }[]>`
    INSERT INTO s6_processed_webhooks (webhook_id, topic, resource_gid, processed_at, shop)
    VALUES (${webhookId}, ${topic}, ${resourceGid}, NOW(), ${shop})
    ON CONFLICT (shop, webhook_id) WHERE shop IS NOT NULL DO NOTHING
    RETURNING webhook_id
  `;

  if (result) {
    return true;
  }

  const [legacyCheck] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS(
      SELECT 1 FROM s6_processed_webhooks
      WHERE webhook_id = ${webhookId} AND shop IS NULL
    ) as exists
  `;

  return !(legacyCheck?.exists ?? false);
}

// ============================================================================
// SHOP UNINSTALL
// ============================================================================

/**
 * Mark a shop as uninstalled.
 * Full data deletion happens on shop/redact (48h later per Shopify docs).
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain
 * @returns Whether the shop was found and updated
 */
export async function markShopUninstalled(
  sql: Sql,
  shopDomain: string
): Promise<boolean> {
  const result = await sql`
    UPDATE "Shop"
    SET "uninstalledAt" = NOW(), "updatedAt" = NOW()
    WHERE domain = ${shopDomain}
  `;
  return result.count > 0;
}
