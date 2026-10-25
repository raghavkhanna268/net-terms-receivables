/**
 * S22 shop/redact complete DB integration test.
 *
 * Verifies that shop/redact deletes every shop-scoped row:
 * - All FK-cascade tables (Session, AccountSource, BuyerAccount, Invoice, BankImport,
 *   Payment, Match, PayerAlias, RejectedMatch, ReminderRule, ReminderLog, AuditEvent,
 *   s8_tagged_customers, s8_draft_orders, s22_data_requests, backstop_processed_orders,
 *   s18_shop_reminder_settings)
 * - webhook_receipts (deleted before deleteShop call)
 * - s10b_order_refetch_null, s6_bulk_operations, order_outstanding_missing,
 *   s10b_customer_pii_fallback, s6_dead_letter (no FK, shop column or shop in JSON)
 *
 * Test seeds two shops, A and B, each with at least one row in every shop-scoped table.
 * Runs shop/redact for A and asserts:
 * - 0 rows for A in every table
 * - B's row count unchanged in every table
 * - Re-running for A is idempotent (no throw, no changes, B intact)
 *
 * NOTE: This test requires a running PostgreSQL instance with the schema applied.
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

  const CUSTOMER_GID = `gid://shopify/Customer/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    // Cleanup any remaining test data in case of failures
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
    await sql`DELETE FROM webhook_receipts WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM "Session" WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
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

    // s6_dead_letter (no FK, shop inside message JSON)
    await sql`
      INSERT INTO s6_dead_letter (original_queue, original_msg_id, message, error, dead_lettered_at)
      VALUES ('s6_sync', ${'msg-' + suffix}, ${sql.json({ shop: shopDomain, topic: 'ORDERS_CREATE', webhookId: 'test-wh', resourceGid: 'gid://shopify/Order/123', enqueuedAt: now.toISOString() })}, 'test_error', ${now})
    `;
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
});
