/**
 * S22 Compliance service for GDPR/CCPA webhook handling.
 *
 * Handles:
 * - shop/redact: Full shop data deletion via CASCADE
 * - customers/redact: Customer data purge and anonymization
 * - customers/data_request: Data export for customer
 * - PII minimisation: Null inactive customer PII
 * - Retention: Scheduled purge of raw narration on old unmatched payments
 *
 * All operations are designed for the 10ms CPU budget:
 * - Small, targeted queries
 * - No full-table scans
 * - Indexed lookups only
 */

import type { Sql } from "~/lib/db-light.server";
import { safeLog, shopHash, toErrorCode } from "~/lib/log.server";

// ============================================================================
// RETENTION CONSTANTS
// ============================================================================

/**
 * Retention window (in days) for raw narration/payerText on UNMATCHED payments.
 *
 * After this window, the pg_cron job s22_purge_unmatched_narration clears:
 * - Payment.narration → '[RETENTION_PURGED]'
 * - Payment.payerText → NULL
 *
 * This preserves: amount, UTR, rail, valueDate, and match history.
 *
 * Matched payments retain narration until customers/redact or shop/redact.
 *
 * *** SINGLE SOURCE OF TRUTH: s22_unmatched_narration_retention_days() SQL function ***
 * See migration 20261101000000_s22_followups. This TS constant documents
 * the same value for application code reference; the SQL function is
 * authoritative for the pg_cron job.
 */
export const UNMATCHED_NARRATION_RETENTION_DAYS = 180;

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
 * Also deletes non-FK-linked data:
 * - s10b_order_refetch_null (aggregate counter, no FK)
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
): Promise<{ deleted: boolean; shopId: string | null; refetchNullPurged: number }> {
  // Delete s10b_order_refetch_null first (not FK-linked)
  const refetchResult = await sql`
    DELETE FROM s10b_order_refetch_null
    WHERE shop = ${shopDomain}
  `;

  // Delete shop - all FK-linked data cascades
  const [result] = await sql<{ id: string }[]>`
    DELETE FROM "Shop"
    WHERE domain = ${shopDomain}
    RETURNING id
  `;

  return {
    deleted: result !== undefined,
    shopId: result?.id ?? null,
    refetchNullPurged: refetchResult.count,
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

// ============================================================================
// CUSTOMERS/REDACT
// ============================================================================

/**
 * Redact all customer data for customers/redact webhook.
 *
 * Purge strategy:
 * - s8_tagged_customers: DELETE (no legal retention requirement)
 * - s8_draft_orders: DELETE (no legal retention requirement)
 * - s22_data_requests: DELETE or null export_data (contains customer PII)
 * - PayerAlias: DELETE (contains payer keys learned from matching)
 * - BuyerAccount: Keep for financial history, anonymize name
 * - Payments: Redact payments linked via Match→Invoice→BuyerAccount
 *
 * Note: Invoices have no customer-identifying fields to anonymize.
 * The buyer relationship is through BuyerAccount which is anonymized.
 *
 * Legal retention reasoning:
 * - Invoices must be retained for tax compliance (typically 7+ years in India)
 * - The invoice itself is a business record; the buyer link is anonymized
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
  dataRequestsDeleted: number;
  payerAliasesDeleted: number;
  buyerAccountAnonymized: boolean;
  paymentsRedacted: number;
}> {
  // Wrap all operations in a single transaction for atomicity.
  // If any statement fails, the entire operation rolls back, so Shopify's
  // retry can safely re-execute from scratch.
  return sql.begin(async (tx) => {
    // Delete tagged customer tracking record
    const taggedResult = await tx`
      DELETE FROM s8_tagged_customers
      WHERE shop_id = ${shopId} AND customer_id = ${customerGid}
    `;

    // Delete draft orders linked to customer's buyer account
    const draftResult = await tx`
      DELETE FROM s8_draft_orders
      WHERE shop_id = ${shopId}
        AND buyer_account_id IN (
          SELECT id FROM "BuyerAccount"
          WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
        )
    `;

    // Delete data request exports for this customer (contains PII)
    const dataRequestResult = await tx`
      DELETE FROM s22_data_requests
      WHERE shop_id = ${shopId} AND customer_gid = ${customerGid}
    `;

    // Find buyer account for this customer
    const [buyerAccount] = await tx<{ id: string }[]>`
      SELECT id FROM "BuyerAccount"
      WHERE "shopId" = ${shopId} AND "customerId" = ${customerGid}
    `;

    let buyerAccountAnonymized = false;
    let paymentsRedacted = 0;
    let payerAliasesDeleted = 0;

    if (buyerAccount) {
      // Redact payments linked to this buyer via Match→Invoice→BuyerAccount FIRST.
      // This must happen before BuyerAccount anonymization rewrites customerId,
      // so a failed retry can still find the account.
      //
      // Shop scoping on Payment, Match, and Invoice ensures isolation.
      //
      // NOTE: A payment matched to multiple buyers (split payment scenario) is FULLY
      // redacted when ANY linked buyer is redacted. This is the conservative/safe
      // approach for GDPR compliance: we cannot selectively redact portions of
      // payerText/narration, and retaining any part risks exposing the redacted
      // customer's identity through the shared payment context.
      const paymentResult = await tx`
        UPDATE "Payment" p
        SET
          "payerText" = NULL,
          narration = '[REDACTED]',
          "updatedAt" = NOW()
        WHERE p.id IN (
          SELECT DISTINCT m."paymentId"
          FROM "Match" m
          JOIN "Invoice" i ON m."invoiceId" = i.id
          WHERE i."buyerAccountId" = ${buyerAccount.id}
            AND i."shopId" = ${shopId}
            AND m."shopId" = ${shopId}
        )
        AND p."shopId" = ${shopId}
      `;
      paymentsRedacted = paymentResult.count;

      // Delete PayerAlias rows for this buyer account (learned payer keys).
      // PayerAlias has no shopId column, so we scope via BuyerAccount join.
      const aliasResult = await tx`
        DELETE FROM "PayerAlias"
        WHERE "buyerAccountId" = ${buyerAccount.id}
          AND "buyerAccountId" IN (
            SELECT id FROM "BuyerAccount"
            WHERE "shopId" = ${shopId}
          )
      `;
      payerAliasesDeleted = aliasResult.count;

      // Anonymize buyer account (keep for financial history)
      await tx`
        UPDATE "BuyerAccount"
        SET 
          name = 'Redacted Customer',
          "customerId" = ${customerGid + '_redacted_' + Date.now()},
          "updatedAt" = NOW()
        WHERE id = ${buyerAccount.id}
          AND "shopId" = ${shopId}
      `;
      buyerAccountAnonymized = true;
    }

    return {
      taggedCustomersDeleted: taggedResult.count,
      draftOrdersDeleted: draftResult.count,
      dataRequestsDeleted: dataRequestResult.count,
      payerAliasesDeleted,
      buyerAccountAnonymized,
      paymentsRedacted,
    };
  });
}

// ============================================================================
// CUSTOMERS/DATA_REQUEST
// ============================================================================

/**
 * Customer data export for data_request webhook.
 *
 * IMPORTANT: This export is limited to Protected Customer Data Level 1 fields:
 * - Email and display name (when CUSTOMER_PII_FIELDS is enabled)
 * - NO phone numbers or addresses are ever stored or exported
 *
 * See: https://shopify.dev/docs/apps/launch/protected-customer-data
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
    paymentMatches: Array<{
      id: string;
      invoiceId: string;
      amount: string;
      state: string;
      confirmedAt: string | null;
      createdAt: string;
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

  // No LIMIT - data request should be complete
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
      `
    : [];

  // Fetch payment matches for the customer's invoices (S16)
  // NOTE: We intentionally exclude Payment.payerText and Payment.narration
  // as they may contain PII from bank statements. Only match metadata is exported.
  // Shop scoping via m."shopId" AND i."shopId" ensures cross-tenant isolation.
  const paymentMatches = buyerAccount
    ? await sql<{
        id: string;
        invoiceId: string;
        amount: string;
        state: string;
        confirmedAt: Date | null;
        createdAt: Date;
      }[]>`
        SELECT 
          m.id, 
          m."invoiceId",
          m.amount::text,
          m.state::text,
          m."confirmedAt",
          m."createdAt"
        FROM "Match" m
        JOIN "Invoice" i ON m."invoiceId" = i.id
        WHERE m."shopId" = ${shopId}
          AND i."shopId" = ${shopId}
          AND i."buyerAccountId" = ${buyerAccount.id}
        ORDER BY m."createdAt" DESC
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
      paymentMatches: paymentMatches.map((m) => ({
        id: m.id,
        invoiceId: m.invoiceId,
        amount: m.amount,
        state: m.state,
        confirmedAt: m.confirmedAt?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
    },
  };
}

/**
 * Persist a data request record with 30-day expiration.
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
      shop_id, customer_gid, request_id, received_at, status, export_data, completed_at, expires_at
    ) VALUES (
      ${shopId}, ${customerGid}, ${requestId}, NOW(), 'completed', ${exportJson}, NOW(), NOW() + INTERVAL '30 days'
    )
    RETURNING id
  `;

  return { id: result.id, alreadyExists: false };
}

/**
 * Purge expired data request exports for a shop.
 * Called on access to /app/data-requests and in customers/data_request handler.
 * This provides in-app purge for databases without pg_cron.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @returns Number of expired requests purged
 */
export async function purgeExpiredDataRequests(
  sql: Sql,
  shopId: string
): Promise<number> {
  const result = await sql`
    DELETE FROM s22_data_requests
    WHERE shop_id = ${shopId}
      AND expires_at IS NOT NULL
      AND expires_at < NOW()
  `;
  return result.count;
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
    expiresAt: Date | null;
  }>
> {
  return sql<{
    id: string;
    customerGid: string;
    requestId: string;
    receivedAt: Date;
    status: string;
    expiresAt: Date | null;
  }[]>`
    SELECT 
      id, 
      customer_gid as "customerGid",
      request_id as "requestId",
      received_at as "receivedAt",
      status,
      expires_at as "expiresAt"
    FROM s22_data_requests
    WHERE shop_id = ${shopId}
      AND status IN ('pending', 'completed')
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY received_at DESC
    LIMIT 50
  `;
}

/**
 * Get a data request export by ID (for download).
 * Does NOT mark as downloaded - caller should do that after successful delivery.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID (for access control)
 * @param requestId - Request ID
 * @returns Export data or null if not found/expired
 */
export async function getDataRequestExport(
  sql: Sql,
  shopId: string,
  requestId: string
): Promise<CustomerDataExport | null> {
  const [result] = await sql<{ export_data: CustomerDataExport }[]>`
    SELECT export_data
    FROM s22_data_requests
    WHERE shop_id = ${shopId} 
      AND request_id = ${requestId}
      AND (expires_at IS NULL OR expires_at > NOW())
  `;

  return result?.export_data ?? null;
}

/**
 * Mark a data request as downloaded.
 *
 * @param sql - postgres.js SQL client
 * @param shopId - Shop ID
 * @param requestId - Request ID
 */
export async function markDataRequestDownloaded(
  sql: Sql,
  shopId: string,
  requestId: string
): Promise<void> {
  await sql`
    UPDATE s22_data_requests
    SET status = 'downloaded', downloaded_at = NOW()
    WHERE shop_id = ${shopId} AND request_id = ${requestId}
  `;
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
 * @param shopOwnerEmail - Shop owner email (fetched by caller via Admin API)
 * @param requestId - Data request ID (for logging only, not in email body)
 * @returns Email result
 */
export async function sendDataRequestNotification(
  shopDomain: string,
  shopOwnerEmail: string,
  requestId: string
): Promise<DataRequestEmailResult> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFrom = process.env.RESEND_FROM;
  const hash = await shopHash(shopDomain);

  if (!resendApiKey) {
    safeLog("info", "data_request_email_skipped", {
      shopHash: hash,
      requestId,
      reason: "no_api_key",
    });
    return { sent: false, skippedReason: "no_api_key" };
  }

  if (!resendFrom) {
    safeLog("info", "data_request_email_skipped", {
      shopHash: hash,
      requestId,
      reason: "no_sender",
    });
    return { sent: false, skippedReason: "no_sender" };
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
      <p>The export will be available for 30 days.</p>
      <p>— Net Terms Receivables</p>
    `.trim(),
    text: `Hello,

A customer has requested a copy of their data under GDPR/CCPA regulations.

The data export is ready for download in your Shopify admin:
${downloadUrl}

Please review and provide this data to the customer within the required timeframe.
The export will be available for 30 days.

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
      safeLog("info", "data_request_email_failed", {
        shopHash: hash,
        requestId,
        httpStatus: response.status,
      });
      return { sent: false, error: `resend_api_error_${response.status}` };
    }

    safeLog("info", "data_request_email_sent", {
      shopHash: hash,
      requestId,
    });
    return { sent: true };
  } catch (err) {
    safeLog("info", "data_request_email_failed", {
      shopHash: hash,
      requestId,
      err: toErrorCode(err),
    });
    return { sent: false, error: toErrorCode(err) };
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
