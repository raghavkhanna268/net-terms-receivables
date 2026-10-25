/**
 * S22 shop/redact complete DB integration test.
 *
 * Verifies that shop/redact deletes every shop-scoped row:
 * - FK-cascade tables via Shop delete (AccountSource, BuyerAccount, Invoice, BankImport,
 *   Payment, Match, PayerAlias, RejectedMatch, ReminderRule, ReminderLog, AuditEvent,
 *   s8_tagged_customers, s8_draft_orders, s22_data_requests, backstop_processed_orders,
 *   s18_shop_reminder_settings)
 * - Session (deleted via sessionStorage.deleteAllForShop before deleteShop)
 * - webhook_receipts (deleted via deleteWebhookReceiptsForShop before deleteShop)
 * - s10b_order_refetch_null, s6_bulk_operations, order_outstanding_missing,
 *   s10b_customer_pii_fallback (no FK, shop text column)
 * - pgmq.q_s6_sync, pgmq.q_s6_bulk, pgmq.a_s6_sync, pgmq.a_s6_bulk (message->>'shop')
 * - s6_dead_letter (message->>'shop')
 *
 * Test seeds two shops, A and B, each with at least one row in every shop-scoped table.
 * Also seeds near-miss rows (extended domain, uppercase domain) that must survive.
 * Runs shop/redact for A and asserts:
 * - 0 rows for A in every table
 * - B's row count unchanged in every table
 * - Near-miss rows unchanged
 * - Re-running for A is idempotent (no throw, no changes, B intact)
 * - In-flight pgmq messages: read with VT, redact, then archive/delete returns false (no error)
 *
 * NOTE: This test requires a running PostgreSQL instance with pgmq extension.
 * Run in the "Sequential DB" vitest project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { deleteShop } from "~/services/compliance/compliance.server";
import { deleteWebhookReceiptsForShop } from "~/lib/webhook-receipts.server";
import { LightSessionStorage } from "~/lib/session-storage-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("shop/redact complete DB deletion", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-redact-complete";

  // Shop A - will be deleted
  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-a-${TEST_SUFFIX}.myshopify.com`;

  // Shop B - should remain intact
  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-b-${TEST_SUFFIX}.myshopify.com`;

  // Near-miss domains for Shop A (should NOT be deleted)
  // 1. Longer domain that starts with Shop A's prefix (e.g. "test-a-xxx-extra.myshopify.com")
  const SHOP_A_EXTENDED_DOMAIN = `test-a-${TEST_SUFFIX}-extra.myshopify.com`;
  // 2. Uppercase version of Shop A's domain
  const SHOP_A_UPPER_DOMAIN = `TEST-A-${TEST_SUFFIX}.MYSHOPIFY.COM`;

  const CUSTOMER_GID = `gid://shopify/Customer/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    // Cleanup any remaining test data in case of failures
    // All domains to clean (including near-miss)
    const allDomains = [SHOP_A_DOMAIN, SHOP_B_DOMAIN, SHOP_A_EXTENDED_DOMAIN, SHOP_A_UPPER_DOMAIN];

    // Delete in reverse FK order
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM rejected_matches WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}))`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM webhook_receipts WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sql(allDomains)}`;
    // pgmq queue and archive tables
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM "Session" WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql.end();
  });

  async function seedShopData(
    shopId: string,
    shopDomain: string,
    suffix: string
  ): Promise<void> {
    const accountId = `acc-${suffix}`;
    const importId = `import-${suffix}`;
    const invoiceId = `invoice-${suffix}`;
    const paymentId = `payment-${suffix}`;
    const matchId = `match-${suffix}`;
    const aliasId = `alias-${suffix}`;
    const rejectedMatchId = `rejected-${suffix}`;
    const ruleId = `rule-${suffix}`;
    const logId = `log-${suffix}`;
    const auditId = `audit-${suffix}`;
    const backstopGid = `gid://shopify/Order/${suffix}`;
    const draftOrderGid = `gid://shopify/DraftOrder/${suffix}`;
    const bulkOpId = `gid://shopify/BulkOperation/${suffix}`;
    const sessionId = `offline_${shopDomain}`;

    const now = new Date();

    // Shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${shopId}, ${shopDomain}, 'INR', ${now}, ${now})
    `;

    // Session (FK-cascade via shop domain index, but not FK-linked)
    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${sessionId}, ${shopDomain}, 'test-state', false, 'test-token')
    `;

    // AccountSource (FK-cascade)
    await sql`
      INSERT INTO "AccountSource" (id, "shopId", tag, "defaultTermsDays", "createdAt", "updatedAt")
      VALUES (${`source-${suffix}`}, ${shopId}, 'net-terms', 30, ${now}, ${now})
    `;

    // BuyerAccount (FK-cascade)
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "customerId", "createdAt", "updatedAt")
      VALUES (${accountId}, ${shopId}, 'TAGGED_CUSTOMER', 'Test Buyer', ${CUSTOMER_GID}, ${now}, ${now})
    `;

    // BankImport (FK-cascade)
    await sql`
      INSERT INTO "BankImport" (id, "shopId", bank, "fileName", "rowCount", "createdAt")
      VALUES (${importId}, ${shopId}, 'test', 'test.csv', 1, ${now})
    `;

    // Invoice (FK-cascade via shopId)
    await sql`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, status, "issuedAt", "createdAt", "updatedAt")
      VALUES (${invoiceId}, ${shopId}, ${accountId}, ${'gid://shopify/Order/' + suffix}, '#001', 1000.00, 1000.00, 'open', ${now}, ${now}, ${now})
    `;

    // Payment (FK-cascade via shopId)
    await sql`
      INSERT INTO "Payment" (id, "shopId", "importId", "valueDate", amount, rail, narration, status, "createdAt", "updatedAt")
      VALUES (${paymentId}, ${shopId}, ${importId}, ${now}, 1000.00, 'NEFT', 'Test payment', 'unmatched', ${now}, ${now})
    `;

    // Match (FK-cascade via shopId)
    await sql`
      INSERT INTO "Match" (id, "shopId", "paymentId", "invoiceId", amount, score, reasons, state, "createdAt", "updatedAt")
      VALUES (${matchId}, ${shopId}, ${paymentId}, ${invoiceId}, 1000.00, 100, '[]'::jsonb, 'confirmed', ${now}, ${now})
    `;

    // PayerAlias (FK-cascade via BuyerAccount)
    await sql`
      INSERT INTO "PayerAlias" (id, "buyerAccountId", "payerKey", "createdAt")
      VALUES (${aliasId}, ${accountId}, 'test-payer-key', ${now})
    `;

    // RejectedMatch (FK-cascade via shopId)
    await sql`
      INSERT INTO rejected_matches (id, "shopId", "paymentId", "invoiceId", "rejectedBy", "rejectedAt")
      VALUES (${rejectedMatchId}, ${shopId}, ${paymentId}, ${invoiceId}, 'user-test', ${now})
    `;

    // ReminderRule (FK-cascade)
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ruleId}, ${shopId}, -3, 'email', true, ${now}, ${now})
    `;

    // ReminderLog (FK-cascade via shopId)
    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt")
      VALUES (${logId}, ${shopId}, ${ruleId}, ${invoiceId}, ${now})
    `;

    // AuditEvent (FK-cascade)
    await sql`
      INSERT INTO "AuditEvent" (id, "shopId", actor, type, data, at)
      VALUES (${auditId}, ${shopId}, 'system', 'test.event', '{}'::jsonb, ${now})
    `;

    // s8_tagged_customers (FK-cascade via shop_id FK)
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at, updated_at)
      VALUES (${shopId}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${now}, ${now})
    `;

    // s8_draft_orders (FK-cascade via shop_id FK)
    await sql`
      INSERT INTO s8_draft_orders (shop_id, draft_order_id, name, total, has_payment_terms, status, created_at, updated_at)
      VALUES (${shopId}, ${draftOrderGid}, '#D1', 500.00, true, 'open', ${now}, ${now})
    `;

    // s22_data_requests (FK-cascade via shop_id FK)
    await sql`
      INSERT INTO s22_data_requests (shop_id, customer_gid, request_id, received_at, status, created_at)
      VALUES (${shopId}, ${CUSTOMER_GID}, ${'req-' + suffix}, ${now}, 'pending', ${now})
    `;

    // backstop_processed_orders (FK-cascade via shop_id FK)
    await sql`
      INSERT INTO backstop_processed_orders (shop_id, order_gid, action, processed_at)
      VALUES (${shopId}, ${backstopGid}, 'held', ${now})
    `;

    // s18_shop_reminder_settings (FK-cascade via shop_id FK)
    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${shopId}, true, ${now}, ${now})
    `;

    // webhook_receipts (no FK, shop text column - deleted separately before deleteShop)
    await sql`
      INSERT INTO webhook_receipts (shop, webhook_id, topic, received_at)
      VALUES (${shopDomain}, ${'wh-' + suffix}, 'ORDERS_CREATE', ${now})
    `;

    // s10b_order_refetch_null (no FK, shop text column)
    await sql`
      INSERT INTO s10b_order_refetch_null (shop, day, count)
      VALUES (${shopDomain}, ${now.toISOString().slice(0, 10)}::date, 1)
    `;

    // s6_bulk_operations (no FK, shop text column)
    await sql`
      INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, started_at)
      VALUES (${bulkOpId}, ${shopDomain}, 'orders', ${now})
    `;

    // order_outstanding_missing (no FK, shop text column)
    await sql`
      INSERT INTO order_outstanding_missing (shop, day, count)
      VALUES (${shopDomain}, ${now.toISOString().slice(0, 10)}::date, 1)
    `;

    // s10b_customer_pii_fallback (no FK, shop text column)
    await sql`
      INSERT INTO s10b_customer_pii_fallback (shop, day, count)
      VALUES (${shopDomain}, ${now.toISOString().slice(0, 10)}::date, 1)
    `;

    // pgmq.q_s6_sync (queue table, message jsonb with shop key)
    await sql`SELECT pgmq.send('s6_sync', ${sql.json({ shop: shopDomain, topic: 'ORDERS_CREATE', webhookId: 'wh-queue-' + suffix, resourceGid: 'gid://shopify/Order/' + suffix, enqueuedAt: now.toISOString() })})`;

    // pgmq.q_s6_bulk (queue table, message jsonb with shop key)
    await sql`SELECT pgmq.send('s6_bulk', ${sql.json({ shop: shopDomain, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-bulk-' + suffix, bulkOperationId: 'gid://shopify/BulkOperation/' + suffix, bulkType: 'orders', enqueuedAt: now.toISOString() })})`;

    // pgmq.a_s6_sync (archive table - send then archive)
    const [syncArchiveMsg] = await sql<[{ send: string }]>`SELECT pgmq.send('s6_sync', ${sql.json({ shop: shopDomain, topic: 'ORDERS_UPDATE', webhookId: 'wh-archive-sync-' + suffix, resourceGid: 'gid://shopify/Order/archive-' + suffix, enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.archive('s6_sync', ${syncArchiveMsg.send}::bigint)`;

    // pgmq.a_s6_bulk (archive table - send then archive)
    const [bulkArchiveMsg] = await sql<[{ send: string }]>`SELECT pgmq.send('s6_bulk', ${sql.json({ shop: shopDomain, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-archive-bulk-' + suffix, bulkOperationId: 'gid://shopify/BulkOperation/archive-' + suffix, bulkType: 'companies', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.archive('s6_bulk', ${bulkArchiveMsg.send}::bigint)`;

    // s6_dead_letter (no FK, shop inside message JSON)
    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES ('s6_sync', ${'msg-' + suffix}, ${sql.json({ shop: shopDomain, topic: 'ORDERS_CREATE', webhookId: 'test-wh', resourceGid: 'gid://shopify/Order/123', enqueuedAt: now.toISOString() })}, 'test_error', ${now})
    `;
  }

  /**
   * Seeds near-miss rows for tables that use exact shop domain matching.
   * These rows should NOT be deleted when shop A is redacted.
   * Near-miss variants:
   * - Extended domain: Shop A's domain + '-extra' suffix
   * - Uppercase domain: Shop A's domain in uppercase
   */
  async function seedNearMissData(): Promise<void> {
    const now = new Date();

    // Near-miss rows for Session (exact shop match)
    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_nearmiss_extended_' + TEST_SUFFIX}, ${SHOP_A_EXTENDED_DOMAIN}, 'test-state', false, 'test-token')
    `;
    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_nearmiss_upper_' + TEST_SUFFIX}, ${SHOP_A_UPPER_DOMAIN}, 'test-state', false, 'test-token')
    `;

    // Near-miss rows for webhook_receipts (exact shop match)
    await sql`
      INSERT INTO webhook_receipts (shop, webhook_id, topic, received_at)
      VALUES (${SHOP_A_EXTENDED_DOMAIN}, ${'wh-nearmiss-extended-' + TEST_SUFFIX}, 'ORDERS_CREATE', ${now})
    `;
    await sql`
      INSERT INTO webhook_receipts (shop, webhook_id, topic, received_at)
      VALUES (${SHOP_A_UPPER_DOMAIN}, ${'wh-nearmiss-upper-' + TEST_SUFFIX}, 'ORDERS_CREATE', ${now})
    `;

    // Near-miss rows for s10b_order_refetch_null (exact shop match)
    await sql`
      INSERT INTO s10b_order_refetch_null (shop, day, count)
      VALUES (${SHOP_A_EXTENDED_DOMAIN}, ${now.toISOString().slice(0, 10)}::date, 99)
    `;
    await sql`
      INSERT INTO s10b_order_refetch_null (shop, day, count)
      VALUES (${SHOP_A_UPPER_DOMAIN}, ${now.toISOString().slice(0, 10)}::date, 99)
    `;

    // Near-miss rows for s6_bulk_operations (exact shop match)
    await sql`
      INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, started_at)
      VALUES (${'gid://shopify/BulkOperation/nearmiss-extended-' + TEST_SUFFIX}, ${SHOP_A_EXTENDED_DOMAIN}, 'orders', ${now})
    `;
    await sql`
      INSERT INTO s6_bulk_operations (bulk_operation_id, shop, bulk_type, started_at)
      VALUES (${'gid://shopify/BulkOperation/nearmiss-upper-' + TEST_SUFFIX}, ${SHOP_A_UPPER_DOMAIN}, 'orders', ${now})
    `;

    // Near-miss rows for order_outstanding_missing (exact shop match)
    await sql`
      INSERT INTO order_outstanding_missing (shop, day, count)
      VALUES (${SHOP_A_EXTENDED_DOMAIN}, ${now.toISOString().slice(0, 10)}::date, 99)
    `;
    await sql`
      INSERT INTO order_outstanding_missing (shop, day, count)
      VALUES (${SHOP_A_UPPER_DOMAIN}, ${now.toISOString().slice(0, 10)}::date, 99)
    `;

    // Near-miss rows for s10b_customer_pii_fallback (exact shop match)
    await sql`
      INSERT INTO s10b_customer_pii_fallback (shop, day, count)
      VALUES (${SHOP_A_EXTENDED_DOMAIN}, ${now.toISOString().slice(0, 10)}::date, 99)
    `;
    await sql`
      INSERT INTO s10b_customer_pii_fallback (shop, day, count)
      VALUES (${SHOP_A_UPPER_DOMAIN}, ${now.toISOString().slice(0, 10)}::date, 99)
    `;

    // Near-miss rows for pgmq.q_s6_sync (exact message->>'shop' match)
    await sql`SELECT pgmq.send('s6_sync', ${sql.json({ shop: SHOP_A_EXTENDED_DOMAIN, topic: 'ORDERS_CREATE', webhookId: 'wh-nearmiss-ext-sync-' + TEST_SUFFIX, resourceGid: 'gid://shopify/Order/nearmiss', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.send('s6_sync', ${sql.json({ shop: SHOP_A_UPPER_DOMAIN, topic: 'ORDERS_CREATE', webhookId: 'wh-nearmiss-upper-sync-' + TEST_SUFFIX, resourceGid: 'gid://shopify/Order/nearmiss', enqueuedAt: now.toISOString() })})`;

    // Near-miss rows for pgmq.q_s6_bulk (exact message->>'shop' match)
    await sql`SELECT pgmq.send('s6_bulk', ${sql.json({ shop: SHOP_A_EXTENDED_DOMAIN, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-nearmiss-ext-bulk-' + TEST_SUFFIX, bulkOperationId: 'gid://shopify/BulkOperation/nearmiss', bulkType: 'orders', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.send('s6_bulk', ${sql.json({ shop: SHOP_A_UPPER_DOMAIN, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-nearmiss-upper-bulk-' + TEST_SUFFIX, bulkOperationId: 'gid://shopify/BulkOperation/nearmiss', bulkType: 'orders', enqueuedAt: now.toISOString() })})`;

    // Near-miss rows for pgmq.a_s6_sync archive (send then archive)
    const [extSyncArchive] = await sql<[{ send: string }]>`SELECT pgmq.send('s6_sync', ${sql.json({ shop: SHOP_A_EXTENDED_DOMAIN, topic: 'ORDERS_UPDATE', webhookId: 'wh-nearmiss-ext-archive-sync-' + TEST_SUFFIX, resourceGid: 'gid://shopify/Order/nearmiss-archive', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.archive('s6_sync', ${extSyncArchive.send}::bigint)`;
    const [upperSyncArchive] = await sql<[{ send: string }]>`SELECT pgmq.send('s6_sync', ${sql.json({ shop: SHOP_A_UPPER_DOMAIN, topic: 'ORDERS_UPDATE', webhookId: 'wh-nearmiss-upper-archive-sync-' + TEST_SUFFIX, resourceGid: 'gid://shopify/Order/nearmiss-archive', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.archive('s6_sync', ${upperSyncArchive.send}::bigint)`;

    // Near-miss rows for pgmq.a_s6_bulk archive (send then archive)
    const [extBulkArchive] = await sql<[{ send: string }]>`SELECT pgmq.send('s6_bulk', ${sql.json({ shop: SHOP_A_EXTENDED_DOMAIN, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-nearmiss-ext-archive-bulk-' + TEST_SUFFIX, bulkOperationId: 'gid://shopify/BulkOperation/nearmiss-archive', bulkType: 'companies', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.archive('s6_bulk', ${extBulkArchive.send}::bigint)`;
    const [upperBulkArchive] = await sql<[{ send: string }]>`SELECT pgmq.send('s6_bulk', ${sql.json({ shop: SHOP_A_UPPER_DOMAIN, topic: 'BULK_OPERATIONS_FINISH', webhookId: 'wh-nearmiss-upper-archive-bulk-' + TEST_SUFFIX, bulkOperationId: 'gid://shopify/BulkOperation/nearmiss-archive', bulkType: 'companies', enqueuedAt: now.toISOString() })})`;
    await sql`SELECT pgmq.archive('s6_bulk', ${upperBulkArchive.send}::bigint)`;

    // Near-miss rows for s6_dead_letter (exact message->>'shop' match)
    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES ('s6_sync', ${'msg-nearmiss-extended-' + TEST_SUFFIX}, ${sql.json({ shop: SHOP_A_EXTENDED_DOMAIN, topic: 'ORDERS_CREATE', webhookId: 'test-wh', resourceGid: 'gid://shopify/Order/123', enqueuedAt: now.toISOString() })}, 'test_error', ${now})
    `;
    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES ('s6_sync', ${'msg-nearmiss-upper-' + TEST_SUFFIX}, ${sql.json({ shop: SHOP_A_UPPER_DOMAIN, topic: 'ORDERS_CREATE', webhookId: 'test-wh', resourceGid: 'gid://shopify/Order/123', enqueuedAt: now.toISOString() })}, 'test_error', ${now})
    `;
  }

  /**
   * Gets counts of near-miss rows that should survive shop A's deletion.
   */
  async function getNearMissCounts(): Promise<Record<string, number>> {
    const [result] = await sql<[{
      sessionExtended: string;
      sessionUpper: string;
      webhookReceiptsExtended: string;
      webhookReceiptsUpper: string;
      refetchNullExtended: string;
      refetchNullUpper: string;
      bulkOpsExtended: string;
      bulkOpsUpper: string;
      outstandingExtended: string;
      outstandingUpper: string;
      piiFallbackExtended: string;
      piiFallbackUpper: string;
      pgmqSyncQueueExtended: string;
      pgmqSyncQueueUpper: string;
      pgmqBulkQueueExtended: string;
      pgmqBulkQueueUpper: string;
      pgmqSyncArchiveExtended: string;
      pgmqSyncArchiveUpper: string;
      pgmqBulkArchiveExtended: string;
      pgmqBulkArchiveUpper: string;
      deadLetterExtended: string;
      deadLetterUpper: string;
    }]>`
      SELECT
        (SELECT COUNT(*)::text FROM "Session" WHERE shop = ${SHOP_A_EXTENDED_DOMAIN}) as "sessionExtended",
        (SELECT COUNT(*)::text FROM "Session" WHERE shop = ${SHOP_A_UPPER_DOMAIN}) as "sessionUpper",
        (SELECT COUNT(*)::text FROM webhook_receipts WHERE shop = ${SHOP_A_EXTENDED_DOMAIN}) as "webhookReceiptsExtended",
        (SELECT COUNT(*)::text FROM webhook_receipts WHERE shop = ${SHOP_A_UPPER_DOMAIN}) as "webhookReceiptsUpper",
        (SELECT COUNT(*)::text FROM s10b_order_refetch_null WHERE shop = ${SHOP_A_EXTENDED_DOMAIN}) as "refetchNullExtended",
        (SELECT COUNT(*)::text FROM s10b_order_refetch_null WHERE shop = ${SHOP_A_UPPER_DOMAIN}) as "refetchNullUpper",
        (SELECT COUNT(*)::text FROM s6_bulk_operations WHERE shop = ${SHOP_A_EXTENDED_DOMAIN}) as "bulkOpsExtended",
        (SELECT COUNT(*)::text FROM s6_bulk_operations WHERE shop = ${SHOP_A_UPPER_DOMAIN}) as "bulkOpsUpper",
        (SELECT COUNT(*)::text FROM order_outstanding_missing WHERE shop = ${SHOP_A_EXTENDED_DOMAIN}) as "outstandingExtended",
        (SELECT COUNT(*)::text FROM order_outstanding_missing WHERE shop = ${SHOP_A_UPPER_DOMAIN}) as "outstandingUpper",
        (SELECT COUNT(*)::text FROM s10b_customer_pii_fallback WHERE shop = ${SHOP_A_EXTENDED_DOMAIN}) as "piiFallbackExtended",
        (SELECT COUNT(*)::text FROM s10b_customer_pii_fallback WHERE shop = ${SHOP_A_UPPER_DOMAIN}) as "piiFallbackUpper",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_EXTENDED_DOMAIN}) as "pgmqSyncQueueExtended",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_UPPER_DOMAIN}) as "pgmqSyncQueueUpper",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${SHOP_A_EXTENDED_DOMAIN}) as "pgmqBulkQueueExtended",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${SHOP_A_UPPER_DOMAIN}) as "pgmqBulkQueueUpper",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_sync WHERE message->>'shop' = ${SHOP_A_EXTENDED_DOMAIN}) as "pgmqSyncArchiveExtended",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_sync WHERE message->>'shop' = ${SHOP_A_UPPER_DOMAIN}) as "pgmqSyncArchiveUpper",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${SHOP_A_EXTENDED_DOMAIN}) as "pgmqBulkArchiveExtended",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${SHOP_A_UPPER_DOMAIN}) as "pgmqBulkArchiveUpper",
        (SELECT COUNT(*)::text FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_A_EXTENDED_DOMAIN}) as "deadLetterExtended",
        (SELECT COUNT(*)::text FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_A_UPPER_DOMAIN}) as "deadLetterUpper"
    `;

    return {
      Session_extended: parseInt(result.sessionExtended, 10),
      Session_upper: parseInt(result.sessionUpper, 10),
      webhook_receipts_extended: parseInt(result.webhookReceiptsExtended, 10),
      webhook_receipts_upper: parseInt(result.webhookReceiptsUpper, 10),
      s10b_order_refetch_null_extended: parseInt(result.refetchNullExtended, 10),
      s10b_order_refetch_null_upper: parseInt(result.refetchNullUpper, 10),
      s6_bulk_operations_extended: parseInt(result.bulkOpsExtended, 10),
      s6_bulk_operations_upper: parseInt(result.bulkOpsUpper, 10),
      order_outstanding_missing_extended: parseInt(result.outstandingExtended, 10),
      order_outstanding_missing_upper: parseInt(result.outstandingUpper, 10),
      s10b_customer_pii_fallback_extended: parseInt(result.piiFallbackExtended, 10),
      s10b_customer_pii_fallback_upper: parseInt(result.piiFallbackUpper, 10),
      pgmq_q_s6_sync_extended: parseInt(result.pgmqSyncQueueExtended, 10),
      pgmq_q_s6_sync_upper: parseInt(result.pgmqSyncQueueUpper, 10),
      pgmq_q_s6_bulk_extended: parseInt(result.pgmqBulkQueueExtended, 10),
      pgmq_q_s6_bulk_upper: parseInt(result.pgmqBulkQueueUpper, 10),
      pgmq_a_s6_sync_extended: parseInt(result.pgmqSyncArchiveExtended, 10),
      pgmq_a_s6_sync_upper: parseInt(result.pgmqSyncArchiveUpper, 10),
      pgmq_a_s6_bulk_extended: parseInt(result.pgmqBulkArchiveExtended, 10),
      pgmq_a_s6_bulk_upper: parseInt(result.pgmqBulkArchiveUpper, 10),
      s6_dead_letter_extended: parseInt(result.deadLetterExtended, 10),
      s6_dead_letter_upper: parseInt(result.deadLetterUpper, 10),
    };
  }

  async function getRowCounts(shopId: string, shopDomain: string): Promise<Record<string, number>> {
    const [result] = await sql<[{
      session: string;
      accountSource: string;
      buyerAccount: string;
      invoice: string;
      bankImport: string;
      payment: string;
      match: string;
      payerAlias: string;
      rejectedMatch: string;
      reminderRule: string;
      reminderLog: string;
      auditEvent: string;
      taggedCustomers: string;
      draftOrders: string;
      dataRequests: string;
      backstopProcessedOrders: string;
      reminderSettings: string;
      webhookReceipts: string;
      refetchNull: string;
      bulkOperations: string;
      outstandingMissing: string;
      piiFallback: string;
      pgmqSyncQueue: string;
      pgmqBulkQueue: string;
      pgmqSyncArchive: string;
      pgmqBulkArchive: string;
      deadLetter: string;
      shop: string;
    }]>`
      SELECT
        (SELECT COUNT(*)::text FROM "Session" WHERE shop = ${shopDomain}) as session,
        (SELECT COUNT(*)::text FROM "AccountSource" WHERE "shopId" = ${shopId}) as "accountSource",
        (SELECT COUNT(*)::text FROM "BuyerAccount" WHERE "shopId" = ${shopId}) as "buyerAccount",
        (SELECT COUNT(*)::text FROM "Invoice" WHERE "shopId" = ${shopId}) as invoice,
        (SELECT COUNT(*)::text FROM "BankImport" WHERE "shopId" = ${shopId}) as "bankImport",
        (SELECT COUNT(*)::text FROM "Payment" WHERE "shopId" = ${shopId}) as payment,
        (SELECT COUNT(*)::text FROM "Match" WHERE "shopId" = ${shopId}) as match,
        (SELECT COUNT(*)::text FROM "PayerAlias" pa JOIN "BuyerAccount" ba ON pa."buyerAccountId" = ba.id WHERE ba."shopId" = ${shopId}) as "payerAlias",
        (SELECT COUNT(*)::text FROM rejected_matches WHERE "shopId" = ${shopId}) as "rejectedMatch",
        (SELECT COUNT(*)::text FROM "ReminderRule" WHERE "shopId" = ${shopId}) as "reminderRule",
        (SELECT COUNT(*)::text FROM "ReminderLog" WHERE "shopId" = ${shopId}) as "reminderLog",
        (SELECT COUNT(*)::text FROM "AuditEvent" WHERE "shopId" = ${shopId}) as "auditEvent",
        (SELECT COUNT(*)::text FROM s8_tagged_customers WHERE shop_id = ${shopId}) as "taggedCustomers",
        (SELECT COUNT(*)::text FROM s8_draft_orders WHERE shop_id = ${shopId}) as "draftOrders",
        (SELECT COUNT(*)::text FROM s22_data_requests WHERE shop_id = ${shopId}) as "dataRequests",
        (SELECT COUNT(*)::text FROM backstop_processed_orders WHERE shop_id = ${shopId}) as "backstopProcessedOrders",
        (SELECT COUNT(*)::text FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}) as "reminderSettings",
        (SELECT COUNT(*)::text FROM webhook_receipts WHERE shop = ${shopDomain}) as "webhookReceipts",
        (SELECT COUNT(*)::text FROM s10b_order_refetch_null WHERE shop = ${shopDomain}) as "refetchNull",
        (SELECT COUNT(*)::text FROM s6_bulk_operations WHERE shop = ${shopDomain}) as "bulkOperations",
        (SELECT COUNT(*)::text FROM order_outstanding_missing WHERE shop = ${shopDomain}) as "outstandingMissing",
        (SELECT COUNT(*)::text FROM s10b_customer_pii_fallback WHERE shop = ${shopDomain}) as "piiFallback",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_sync WHERE message->>'shop' = ${shopDomain}) as "pgmqSyncQueue",
        (SELECT COUNT(*)::text FROM pgmq.q_s6_bulk WHERE message->>'shop' = ${shopDomain}) as "pgmqBulkQueue",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_sync WHERE message->>'shop' = ${shopDomain}) as "pgmqSyncArchive",
        (SELECT COUNT(*)::text FROM pgmq.a_s6_bulk WHERE message->>'shop' = ${shopDomain}) as "pgmqBulkArchive",
        (SELECT COUNT(*)::text FROM s6_dead_letter WHERE message->>'shop' = ${shopDomain}) as "deadLetter",
        (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopId}) as shop
    `;

    return {
      Session: parseInt(result.session, 10),
      AccountSource: parseInt(result.accountSource, 10),
      BuyerAccount: parseInt(result.buyerAccount, 10),
      Invoice: parseInt(result.invoice, 10),
      BankImport: parseInt(result.bankImport, 10),
      Payment: parseInt(result.payment, 10),
      Match: parseInt(result.match, 10),
      PayerAlias: parseInt(result.payerAlias, 10),
      RejectedMatch: parseInt(result.rejectedMatch, 10),
      ReminderRule: parseInt(result.reminderRule, 10),
      ReminderLog: parseInt(result.reminderLog, 10),
      AuditEvent: parseInt(result.auditEvent, 10),
      s8_tagged_customers: parseInt(result.taggedCustomers, 10),
      s8_draft_orders: parseInt(result.draftOrders, 10),
      s22_data_requests: parseInt(result.dataRequests, 10),
      backstop_processed_orders: parseInt(result.backstopProcessedOrders, 10),
      s18_shop_reminder_settings: parseInt(result.reminderSettings, 10),
      webhook_receipts: parseInt(result.webhookReceipts, 10),
      s10b_order_refetch_null: parseInt(result.refetchNull, 10),
      s6_bulk_operations: parseInt(result.bulkOperations, 10),
      order_outstanding_missing: parseInt(result.outstandingMissing, 10),
      s10b_customer_pii_fallback: parseInt(result.piiFallback, 10),
      pgmq_q_s6_sync: parseInt(result.pgmqSyncQueue, 10),
      pgmq_q_s6_bulk: parseInt(result.pgmqBulkQueue, 10),
      pgmq_a_s6_sync: parseInt(result.pgmqSyncArchive, 10),
      pgmq_a_s6_bulk: parseInt(result.pgmqBulkArchive, 10),
      s6_dead_letter: parseInt(result.deadLetter, 10),
      Shop: parseInt(result.shop, 10),
    };
  }

  it("deletes all shop A rows and leaves shop B intact", async () => {
    // Seed data for both shops
    await seedShopData(SHOP_A_ID, SHOP_A_DOMAIN, `a-${TEST_SUFFIX}`);
    await seedShopData(SHOP_B_ID, SHOP_B_DOMAIN, `b-${TEST_SUFFIX}`);

    // Verify both shops have data
    const countsBeforeA = await getRowCounts(SHOP_A_ID, SHOP_A_DOMAIN);
    const countsBeforeB = await getRowCounts(SHOP_B_ID, SHOP_B_DOMAIN);

    // Assert each table has exactly 1 row for each shop
    for (const [table, count] of Object.entries(countsBeforeA)) {
      expect(count, `Shop A ${table} before should be 1`).toBe(1);
    }
    for (const [table, count] of Object.entries(countsBeforeB)) {
      expect(count, `Shop B ${table} before should be 1`).toBe(1);
    }

    // Run shop/redact path for Shop A
    // 1. Delete sessions (as the webhook handler does)
    const sessionStorage = new LightSessionStorage(sql);
    await sessionStorage.deleteAllForShop(SHOP_A_DOMAIN);

    // 2. Delete webhook receipts (as the webhook handler does)
    await deleteWebhookReceiptsForShop(sql, SHOP_A_DOMAIN);

    // 3. Delete shop and all related data (this is what we're testing)
    const result = await deleteShop(sql, SHOP_A_DOMAIN);
    expect(result.deleted).toBe(true);
    expect(result.shopId).toBe(SHOP_A_ID);

    // Verify Shop A is completely deleted
    const countsAfterA = await getRowCounts(SHOP_A_ID, SHOP_A_DOMAIN);
    for (const [table, count] of Object.entries(countsAfterA)) {
      expect(count, `Shop A ${table} after should be 0`).toBe(0);
    }

    // Verify Shop B is completely intact
    const countsAfterB = await getRowCounts(SHOP_B_ID, SHOP_B_DOMAIN);
    for (const [table, count] of Object.entries(countsAfterB)) {
      expect(count, `Shop B ${table} after should be 1`).toBe(1);
    }
  });

  it("is idempotent: second call for already-deleted shop does not throw and leaves B intact", async () => {
    // Shop A should already be deleted from previous test
    // Run shop/redact again for Shop A
    const sessionStorage = new LightSessionStorage(sql);
    await sessionStorage.deleteAllForShop(SHOP_A_DOMAIN);
    await deleteWebhookReceiptsForShop(sql, SHOP_A_DOMAIN);
    const result = await deleteShop(sql, SHOP_A_DOMAIN);

    // Should not throw and should report not deleted (already gone)
    expect(result.deleted).toBe(false);
    expect(result.shopId).toBeNull();

    // Verify Shop A still has 0 rows
    const countsA = await getRowCounts(SHOP_A_ID, SHOP_A_DOMAIN);
    for (const [table, count] of Object.entries(countsA)) {
      expect(count, `Shop A ${table} on replay should be 0`).toBe(0);
    }

    // Verify Shop B is still intact
    const countsB = await getRowCounts(SHOP_B_ID, SHOP_B_DOMAIN);
    for (const [table, count] of Object.entries(countsB)) {
      expect(count, `Shop B ${table} on replay should be 1`).toBe(1);
    }
  });

  it("near-miss domains (extended prefix and uppercase) are not deleted", async () => {
    // Seed near-miss data (extended domain, uppercase domain)
    await seedNearMissData();

    // Get baseline counts
    const nearMissCountsBefore = await getNearMissCounts();

    // Verify near-miss rows exist (all should be 1)
    for (const [key, count] of Object.entries(nearMissCountsBefore)) {
      expect(count, `Near-miss ${key} before should be 1`).toBe(1);
    }

    // Create a temporary shop C with A's domain for deletion test
    const SHOP_C_ID = `shop-c-${TEST_SUFFIX}`;
    const now = new Date();
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${SHOP_C_ID}, ${SHOP_A_DOMAIN}, 'INR', ${now}, ${now})
    `;

    // Run shop/redact for shop A's domain (which shop C now has)
    const sessionStorage = new LightSessionStorage(sql);
    await sessionStorage.deleteAllForShop(SHOP_A_DOMAIN);
    await deleteWebhookReceiptsForShop(sql, SHOP_A_DOMAIN);
    const result = await deleteShop(sql, SHOP_A_DOMAIN);

    expect(result.deleted).toBe(true);
    expect(result.shopId).toBe(SHOP_C_ID);

    // Verify near-miss rows are still intact
    const nearMissCountsAfter = await getNearMissCounts();
    for (const [key, count] of Object.entries(nearMissCountsAfter)) {
      expect(count, `Near-miss ${key} after should be 1`).toBe(1);
    }

    // Shop B should also still be intact
    const countsB = await getRowCounts(SHOP_B_ID, SHOP_B_DOMAIN);
    for (const [table, count] of Object.entries(countsB)) {
      expect(count, `Shop B ${table} after near-miss test should be 1`).toBe(1);
    }
  });

  it("in-flight pgmq messages: worker holding message under VT can safely archive/delete after shop redact", async () => {
    // This test proves that when a drain worker holds a message under its visibility timeout (VT)
    // and shop/redact deletes the message row, the worker's subsequent pgmq.archive() or
    // pgmq.delete() call returns false (0 rows affected) without throwing an error.
    // This is the documented pgmq v1.5.1 behavior.

    const IN_FLIGHT_SUFFIX = `inflight-${TEST_SUFFIX}`;
    const IN_FLIGHT_SHOP_ID = `shop-inflight-${TEST_SUFFIX}`;
    const IN_FLIGHT_DOMAIN = `test-inflight-${TEST_SUFFIX}.myshopify.com`;

    // Create a shop for this test
    const now = new Date();
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${IN_FLIGHT_SHOP_ID}, ${IN_FLIGHT_DOMAIN}, 'INR', ${now}, ${now})
    `;

    // 1. Send messages to both queues
    const [syncMsg] = await sql<[{ send: string }]>`
      SELECT pgmq.send('s6_sync', ${sql.json({
        shop: IN_FLIGHT_DOMAIN,
        topic: 'ORDERS_CREATE',
        webhookId: `wh-inflight-sync-${IN_FLIGHT_SUFFIX}`,
        resourceGid: `gid://shopify/Order/inflight-sync`,
        enqueuedAt: now.toISOString()
      })})
    `;
    const [bulkMsg] = await sql<[{ send: string }]>`
      SELECT pgmq.send('s6_bulk', ${sql.json({
        shop: IN_FLIGHT_DOMAIN,
        topic: 'BULK_OPERATIONS_FINISH',
        webhookId: `wh-inflight-bulk-${IN_FLIGHT_SUFFIX}`,
        bulkOperationId: `gid://shopify/BulkOperation/inflight`,
        bulkType: 'orders',
        enqueuedAt: now.toISOString()
      })})
    `;

    const syncMsgId = syncMsg.send;
    const bulkMsgId = bulkMsg.send;

    // 2. Simulate drain workers reading messages with VT (visibility timeout)
    // pgmq.read(queue, vt_seconds, limit) returns up to `limit` messages and makes them invisible for vt seconds.
    // We read with a limit high enough to include our test messages, then verify they were returned.
    // Using pgmq.read_with_poll would be more accurate but read() is simpler for test purposes.
    const readSyncResults = await sql<{ msg_id: string; message: unknown }[]>`
      SELECT msg_id::text, message FROM pgmq.read('s6_sync', 30, 100)
    `;
    const readBulkResults = await sql<{ msg_id: string; message: unknown }[]>`
      SELECT msg_id::text, message FROM pgmq.read('s6_bulk', 30, 100)
    `;

    // Find our specific messages in the results
    const readSync = readSyncResults.find(r => r.msg_id === syncMsgId);
    const readBulk = readBulkResults.find(r => r.msg_id === bulkMsgId);

    expect(readSync, `Message ${syncMsgId} should be in s6_sync read results`).toBeDefined();
    expect(readBulk, `Message ${bulkMsgId} should be in s6_bulk read results`).toBeDefined();

    // 3. Run shop/redact to delete the messages from the queue
    const sessionStorage = new LightSessionStorage(sql);
    await sessionStorage.deleteAllForShop(IN_FLIGHT_DOMAIN);
    await deleteWebhookReceiptsForShop(sql, IN_FLIGHT_DOMAIN);
    const result = await deleteShop(sql, IN_FLIGHT_DOMAIN);

    expect(result.deleted).toBe(true);
    expect(result.shopId).toBe(IN_FLIGHT_SHOP_ID);
    expect(result.pgmqSyncQueuePurged).toBe(1);
    expect(result.pgmqBulkQueuePurged).toBe(1);

    // 4. Now simulate what the drain worker does after processing:
    // it calls pgmq.archive() (or pgmq.delete()) on the msg_id.
    // Since we deleted the row, these should return false (not throw).
    const [archiveSyncResult] = await sql<[{ archive: boolean }]>`
      SELECT pgmq.archive('s6_sync', ${syncMsgId}::bigint)
    `;
    const [deleteBulkResult] = await sql<[{ delete: boolean }]>`
      SELECT pgmq.delete('s6_bulk', ${bulkMsgId}::bigint)
    `;

    // pgmq.archive() and pgmq.delete() return false when the msg_id doesn't exist
    // This is the safe behavior - no error thrown, just returns false
    expect(archiveSyncResult.archive).toBe(false);
    expect(deleteBulkResult.delete).toBe(false);

    // Verify the messages are indeed gone from both queue and archive
    const [syncQueueCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync WHERE msg_id = ${syncMsgId}::bigint
    `;
    const [bulkQueueCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_bulk WHERE msg_id = ${bulkMsgId}::bigint
    `;
    const [syncArchiveCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_sync WHERE msg_id = ${syncMsgId}::bigint
    `;
    const [bulkArchiveCount] = await sql<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.a_s6_bulk WHERE msg_id = ${bulkMsgId}::bigint
    `;

    expect(parseInt(syncQueueCount.count, 10)).toBe(0);
    expect(parseInt(bulkQueueCount.count, 10)).toBe(0);
    expect(parseInt(syncArchiveCount.count, 10)).toBe(0);
    expect(parseInt(bulkArchiveCount.count, 10)).toBe(0);
  });
});
