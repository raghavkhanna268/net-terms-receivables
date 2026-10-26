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
import { getAppHandle } from "~/lib/plan-url";
import {
  parseRecipientAllowlist,
  isRecipientAllowed,
  isAllowlistEnforced,
} from "~/services/recipient-allowlist.server";

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
 * Deletion counts returned by deleteShop.
 */
export interface DeleteShopResult {
  deleted: boolean;
  shopId: string | null;
  /** True when the shop row exists but was skipped because it reinstalled (uninstalledAt IS NULL) */
  skippedReinstalled: boolean;
  sessionsDeleted: number;
  refetchNullPurged: number;
  bulkOperationsPurged: number;
  reconcileClaimsPurged: number;
  orderGapPurged: number;
  piiFallbackPurged: number;
  pgmqSyncQueuePurged: number;
  pgmqBulkQueuePurged: number;
  pgmqSyncArchivePurged: number;
  pgmqBulkArchivePurged: number;
  deadLetterPurged: number;
  processedWebhooksPurged: number;
  webhookReceiptsPurged: number;
}

/**
 * Delete s6_processed_webhooks rows linked to a shop's webhook_receipts.
 *
 * Uses exact-match join: deletes processed webhook rows where the webhook_id
 * matches a receipt for this shop. This handles Shopify webhook ids that don't
 * embed the shop domain.
 *
 * Intentionally NOT purged (expire under 7-day TTL instead):
 * - credit_* keys: carry no shop domain, internal credit-status markers
 * - Shopify webhook ids with no matching receipt (orphaned or pre-S20)
 *
 * MUST be called BEFORE webhook_receipts are deleted for this shop.
 *
 * Used by:
 * - deleteShop (shop/redact): within transaction, before receipts delete
 * - app/uninstalled: within transaction with receipts delete
 *
 * @param sql - postgres.js SQL client (or transaction)
 * @param shopDomain - Shop domain
 * @returns Number of processed webhook rows deleted
 */
export async function deleteProcessedWebhooksViaReceipts(
  sql: Sql,
  shopDomain: string
): Promise<number> {
  const result = await sql`
    DELETE FROM s6_processed_webhooks p
    USING webhook_receipts r
    WHERE r.shop = ${shopDomain}
      AND r.webhook_id = p.webhook_id
  `;
  return result.count;
}

/**
 * Delete a shop and all its data via ON DELETE CASCADE.
 * This is the final step in the shop/redact webhook handler.
 *
 * The CASCADE FKs ensure all shop data is deleted:
 * - Shop -> AccountSource, BuyerAccount, BankImport, ReminderRule, AuditEvent
 * - Shop -> Invoice, Payment, Match, ReminderLog (direct FKs)
 * - Shop -> s8_tagged_customers, s8_draft_orders (S22 FKs)
 * - Shop -> s22_data_requests (S22 FK)
 * - Shop -> backstop_processed_orders (S13 FK)
 * - Shop -> s18_shop_reminder_settings (S18 FK)
 *
 * Also deletes non-FK-linked data (no FK, shop text column or shop in JSON):
 * - s10b_order_refetch_null (aggregate counter, shop text column)
 * - s6_bulk_operations (bulk op tracking, shop text column)
 * - order_outstanding_missing (aggregate counter, shop text column)
 * - s10b_customer_pii_fallback (aggregate counter, shop text column)
 * - s6_dead_letter (dead-letter queue, shop in message JSON)
 * - s6_processed_webhooks (reconcile ids embed domain; Shopify webhook ids via receipts join)
 * - webhook_receipts (edge deduplication, shop text column)
 *
 * All deletes are wrapped in a single transaction for atomicity.
 * If any statement fails, the entire operation rolls back.
 *
 * Per Shopify docs, shop/redact is sent 48 hours after app/uninstalled.
 * See: https://shopify.dev/docs/apps/build/privacy-law-compliance
 *
 * @param sql - postgres.js SQL client
 * @param shopDomain - Shop domain to delete
 * @returns Object with deletion result and counts
 */
export async function deleteShop(
  sql: Sql,
  shopDomain: string
): Promise<DeleteShopResult> {
  return sql.begin(async (tx) => {
    // LOCK ORDER: Shop row first, then s6_bulk_operations/claims rows. This order
    // must match enqueueReconcileStage and reinstall reset to prevent deadlock.
    // Lock the Shop row to serialize with drain's FOR SHARE guards (#239) and
    // concurrent reinstalls. Fetch uninstalledAt to check if the shop reinstalled
    // within the 48h window before shop/redact arrived.
    const [lockedShop] = await tx<{ id: string; uninstalledAt: Date | null }[]>`
      SELECT id, "uninstalledAt" FROM "Shop" WHERE domain = ${shopDomain} FOR UPDATE
    `;

    // If the shop exists but uninstalledAt is NULL, the shop reinstalled after
    // the uninstall that triggered this shop/redact. Skip deletion to preserve
    // the reinstalled shop's data. See issue #291.
    if (lockedShop && lockedShop.uninstalledAt === null) {
      return {
        deleted: false,
        shopId: lockedShop.id,
        skippedReinstalled: true,
        sessionsDeleted: 0,
        refetchNullPurged: 0,
        bulkOperationsPurged: 0,
        reconcileClaimsPurged: 0,
        orderGapPurged: 0,
        piiFallbackPurged: 0,
        pgmqSyncQueuePurged: 0,
        pgmqBulkQueuePurged: 0,
        pgmqSyncArchivePurged: 0,
        pgmqBulkArchivePurged: 0,
        deadLetterPurged: 0,
        processedWebhooksPurged: 0,
        webhookReceiptsPurged: 0,
      };
    }

    // Delete non-FK-linked tables first (shop text column or shop in JSON)

    // Session table: delete all OAuth sessions for this shop.
    // Moved here from webhooks.compliance.tsx to ensure sessions are only deleted
    // when the shop is actually being erased (not skipped by reinstall guard).
    // See issue #291.
    const sessionsResult = await tx`
      DELETE FROM "Session" WHERE shop = ${shopDomain}
    `;

    // s10b_order_refetch_null (aggregate counter, shop text column)
    const refetchResult = await tx`
      DELETE FROM s10b_order_refetch_null
      WHERE shop = ${shopDomain}
    `;

    // s6_bulk_operations (bulk op tracking, shop text column)
    const bulkOpsResult = await tx`
      DELETE FROM s6_bulk_operations
      WHERE shop = ${shopDomain}
    `;

    // s6_reconcile_stage_claims (S25 exactly-once reconcile claims, shop text column)
    const reconcileClaimsResult = await tx`
      DELETE FROM s6_reconcile_stage_claims
      WHERE shop = ${shopDomain}
    `;

    // order_outstanding_missing (aggregate counter, shop text column)
    const outstandingResult = await tx`
      DELETE FROM order_outstanding_missing
      WHERE shop = ${shopDomain}
    `;

    // s10b_customer_pii_fallback (aggregate counter, shop text column)
    const piiResult = await tx`
      DELETE FROM s10b_customer_pii_fallback
      WHERE shop = ${shopDomain}
    `;

    // pgmq queue and archive tables (message jsonb column at message->>'shop')
    // Tables created by pgmq.create() at prisma/migrations/20261023000000_s6_pgmq_queues/migration.sql:70,75
    // Schema: pgmq.q_<name> (queue), pgmq.a_<name> (archive), message column is jsonb
    //
    // Safety: A drain worker holding a message under its visibility timeout (VT) will later
    // call pgmq.archive() or pgmq.delete() on that msg_id. If we delete the row here first,
    // the worker's subsequent call returns false (0 rows affected) without throwing - this is
    // the documented pgmq behavior (tested in shop-redact-complete-db.test.ts in-flight case).
    //
    // We use raw DELETE for direct control over the WHERE clause (exact shop match).
    // pgmq.delete(queue, msg_id) requires knowing msg_ids upfront; a SELECT+DELETE would be
    // two round-trips. Raw DELETE on the queue table is safe because we're only removing
    // messages, not modifying queue metadata.
    const pgmqSyncQueueResult = await tx`
      DELETE FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${shopDomain}
    `;
    const pgmqBulkQueueResult = await tx`
      DELETE FROM pgmq.q_s6_bulk
      WHERE message->>'shop' = ${shopDomain}
    `;
    const pgmqSyncArchiveResult = await tx`
      DELETE FROM pgmq.a_s6_sync
      WHERE message->>'shop' = ${shopDomain}
    `;
    const pgmqBulkArchiveResult = await tx`
      DELETE FROM pgmq.a_s6_bulk
      WHERE message->>'shop' = ${shopDomain}
    `;

    // s6_dead_letter (dead-letter queue, shop in message JSON at message->>'shop')
    // Producer: app/services/drain/processor.server.ts:968-991 (moveToDeadLetter function)
    // The message JSON contains { shop: string, topic: string, webhookId: string, ... }
    const deadLetterResult = await tx`
      DELETE FROM s6_dead_letter
      WHERE message->>'shop' = ${shopDomain}
    `;

    // s6_processed_webhooks (no shop column; ids may embed the domain)
    // Two deletion strategies for the two id formats:
    //
    // 1. Reconcile ids: embed domain as 'reconcile:<shop>:<date>:<stage>'
    //    See: reconcile.server.ts:61, reconcile-handlers.server.ts:175/178, initial-sync.server.ts:140
    //    Use anchored prefix match with left() - no LIKE wildcards so _ and % are safe
    const reconcilePrefix = `reconcile:${shopDomain}:`;
    const processedReconcileResult = await tx`
      DELETE FROM s6_processed_webhooks
      WHERE left(webhook_id, length(${reconcilePrefix})) = ${reconcilePrefix}
    `;

    // 2. Shopify webhook ids (domain-free): join to webhook_receipts
    //    This MUST run BEFORE webhook_receipts are deleted
    //    NOTE: credit_* rows and orphan Shopify ids (no matching receipt) are
    //    intentionally NOT purged - they carry no shop domain and expire under 7-day TTL.
    const processedReceiptsJoinCount = await deleteProcessedWebhooksViaReceipts(
      tx,
      shopDomain
    );

    const processedWebhooksPurged =
      processedReconcileResult.count + processedReceiptsJoinCount;

    // webhook_receipts (edge deduplication, shop text column)
    // Moved here from webhooks.compliance.tsx to ensure join delete runs first
    const webhookReceiptsResult = await tx`
      DELETE FROM webhook_receipts WHERE shop = ${shopDomain}
    `;

    // Delete shop - all FK-linked data cascades
    const [result] = await tx<{ id: string }[]>`
      DELETE FROM "Shop"
      WHERE domain = ${shopDomain}
      RETURNING id
    `;

    return {
      deleted: result !== undefined,
      shopId: result?.id ?? null,
      skippedReinstalled: false,
      sessionsDeleted: sessionsResult.count,
      refetchNullPurged: refetchResult.count,
      bulkOperationsPurged: bulkOpsResult.count,
      reconcileClaimsPurged: reconcileClaimsResult.count,
      orderGapPurged: outstandingResult.count,
      piiFallbackPurged: piiResult.count,
      pgmqSyncQueuePurged: pgmqSyncQueueResult.count,
      pgmqBulkQueuePurged: pgmqBulkQueueResult.count,
      pgmqSyncArchivePurged: pgmqSyncArchiveResult.count,
      pgmqBulkArchivePurged: pgmqBulkArchiveResult.count,
      deadLetterPurged: deadLetterResult.count,
      processedWebhooksPurged,
      webhookReceiptsPurged: webhookReceiptsResult.count,
    };
  });
}

/**
 * Legacy pgmq message purge function (no longer needed).
 *
 * As of this version, deleteShop() removes the shop's messages from the pgmq
 * queue tables (pgmq.q_s6_sync, pgmq.q_s6_bulk) and archive tables
 * (pgmq.a_s6_sync, pgmq.a_s6_bulk) directly within its transaction.
 *
 * This function remains for backward compatibility with callers but performs
 * no operation. The returned reason documents the current behavior.
 *
 * Note: Drain-side handling of in-flight messages (where a worker holds a
 * message under its visibility timeout when the shop is deleted) is tracked
 * in https://github.com/raghavkhanna268/net-terms-receivables/issues/239.
 * The worker's subsequent pgmq.archive() or pgmq.delete() on the missing
 * msg_id returns false without throwing, which is safe but should be logged.
 *
 * @param sql - postgres.js SQL client (unused)
 * @param _shopDomain - Shop domain (unused)
 * @returns Documentation that deleteShop handles this now
 */
export async function purgePgmqMessages(
  _sql: Sql,
  _shopDomain: string
): Promise<{ purged: false; reason: string }> {
  return {
    purged: false,
    reason:
      "deleteShop() now removes the shop's queue and archive messages directly. " +
      "See https://github.com/raghavkhanna268/net-terms-receivables/issues/239 " +
      "for drain-side ack of shop_not_found on in-flight retries.",
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
  b2bMainContactsRedacted: number;
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

    // Null B2B main contact fields where mainContactCustomerId matches
    // This handles company locations whose main contact is being redacted
    const b2bMainContactResult = await tx`
      UPDATE "BuyerAccount"
      SET 
        "mainContactEmail" = NULL,
        "mainContactName" = NULL,
        "mainContactCustomerId" = NULL,
        "updatedAt" = NOW()
      WHERE "shopId" = ${shopId}
        AND "mainContactCustomerId" = ${customerGid}
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
      b2bMainContactsRedacted: b2bMainContactResult.count,
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
    /**
     * B2B buyer accounts where this customer is the main contact.
     * Includes contact fields (email, name, customer ID) for this customer only.
     */
    b2bMainContactAccounts: Array<{
      id: string;
      name: string;
      kind: string;
      mainContactEmail: string | null;
      mainContactName: string | null;
      mainContactCustomerId: string;
    }>;
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

  // Fetch B2B buyer accounts where this customer is the main contact
  // This includes COMPANY accounts where mainContactCustomerId matches
  const b2bMainContactAccounts = await sql<{
    id: string;
    name: string;
    kind: string;
    mainContactEmail: string | null;
    mainContactName: string | null;
    mainContactCustomerId: string;
  }[]>`
    SELECT 
      id, name, kind::text,
      "mainContactEmail",
      "mainContactName",
      "mainContactCustomerId"
    FROM "BuyerAccount"
    WHERE "shopId" = ${shopId}
      AND "mainContactCustomerId" = ${customerGid}
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
      b2bMainContactAccounts: b2bMainContactAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        mainContactEmail: a.mainContactEmail,
        mainContactName: a.mainContactName,
        mainContactCustomerId: a.mainContactCustomerId,
      })),
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
 * @returns Embedded admin URL, or null if app handle is not configured
 */
function buildDataRequestsAdminUrl(shopDomain: string): string | null {
  const appHandle = getAppHandle();
  if (appHandle === null) {
    safeLog("warn", "plan_url_app_handle_missing", {});
    return null;
  }
  const shopName = shopDomain.replace(".myshopify.com", "");
  return `https://admin.shopify.com/store/${shopName}/apps/${appHandle}/app/data-requests`;
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

  const downloadLinkHtml = downloadUrl
    ? `<p><a href="${downloadUrl}">Download Customer Data Export</a></p>`
    : `<p>Open the Net Terms Receivables app in your Shopify admin and go to Data Requests.</p>`;

  const downloadLinkText = downloadUrl
    ? downloadUrl
    : "Open the Net Terms Receivables app in your Shopify admin and go to Data Requests.";

  const htmlContent = `
      <p>Hello,</p>
      <p>A customer has requested a copy of their data under GDPR/CCPA regulations.</p>
      <p>The data export is ready for download in your Shopify admin:</p>
      ${downloadLinkHtml}
      <p>Please review and provide this data to the customer within the required timeframe.</p>
      <p>The export will be available for 30 days.</p>
      <p>— Net Terms Receivables</p>
    `.trim();

  const textContent = `Hello,

A customer has requested a copy of their data under GDPR/CCPA regulations.

The data export is ready for download in your Shopify admin:
${downloadLinkText}

Please review and provide this data to the customer within the required timeframe.
The export will be available for 30 days.

— Net Terms Receivables`;

  // Pre-launch recipient allowlist check (fail closed)
  // When RESEND_RECIPIENT_ALLOWLIST_ENFORCED is exactly "false", skip this gate.
  const allowlist = parseRecipientAllowlist(process.env.RESEND_TEST_RECIPIENTS);
  const enforced = isAllowlistEnforced();
  if (enforced && allowlist.size === 0) {
    safeLog("info", "data_request_email_skipped", {
      shopHash: hash,
      requestId,
      reason: "recipient_allowlist_empty",
    });
    return { sent: false, skippedReason: "recipient_allowlist_empty" };
  }
  if (enforced && !isRecipientAllowed(shopOwnerEmail, allowlist)) {
    safeLog("info", "data_request_email_skipped", {
      shopHash: hash,
      requestId,
      reason: "recipient_not_allowlisted",
    });
    return { sent: false, skippedReason: "recipient_not_allowlisted" };
  }

  const emailBody = {
    from: resendFrom,
    to: shopOwnerEmail,
    subject: "Customer Data Request Ready for Download",
    html: htmlContent,
    text: textContent,
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
 * Also invalidates the plan cache so that on reinstall, the app fetches fresh
 * subscription status from Shopify. Without this, a cancelled subscription
 * would show as active if the cache TTL hasn't expired.
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
    SET "uninstalledAt" = NOW(), "updatedAt" = NOW(), plan_cached_at = NULL
    WHERE domain = ${shopDomain}
  `;
  return result.count > 0;
}
