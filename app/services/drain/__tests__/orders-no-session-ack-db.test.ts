/**
 * DB-backed integration test for ORDERS_* no-session ACK behavior (#239 extension).
 *
 * Tests that ORDERS_* webhooks for uninstalled shops are ACKed (not DLQ'd):
 * - No s6_dead_letter row created
 * - No backstop.failed AuditEvent (recordBackstopFailure not called)
 * - Message removed from queue
 *
 * Also tests that installed shops with no session still go to DLQ as before,
 * AND trigger recordBackstopFailure (creates AuditEvent with type='backstop.failed').
 *
 * This test uses the "Sequential DB" project via the *-db.test.ts naming pattern.
 *
 * Queue isolation: Before each test, stale messages from other test files are
 * archived to prevent batch pollution. This ensures runDrain processes only
 * this test's messages, avoiding flakes from shared queue state.
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
const SUFFIX = Date.now().toString(36) + "-orders-nosession";

/**
 * Archive all messages in q_s6_sync that don't belong to our test shops.
 * This prevents batch pollution from other test files' leftover messages.
 *
 * Notes:
 * - Archives ALL foreign rows regardless of vt (visibility timeout) or read_ct,
 *   because rows read by an earlier drain (vt +30s) can reappear mid-file.
 * - Handles messages with NULL shop key (message->>'shop' IS NULL).
 * - Uses pgmq.archive batch overload for efficiency.
 */
async function archiveStaleQueueMessages(
  sql: ReturnType<typeof postgres>,
  ourDomains: string[]
): Promise<number> {
  const result = await sql<{ msg_id: string }[]>`
    SELECT msg_id::text FROM pgmq.q_s6_sync
    WHERE message->>'shop' IS NULL
       OR message->>'shop' NOT IN ${sql(ourDomains)}
  `;

  if (result.length === 0) {
    return 0;
  }

  const msgIds = result.map((r) => r.msg_id);
  await sql`SELECT pgmq.archive('s6_sync', ${sql.array(msgIds)}::bigint[])`;

  return result.length;
}

const UNINSTALLED_SHOP = {
  id: `shop-uninstalled-${SUFFIX}`,
  domain: `test-uninstalled-${SUFFIX}.myshopify.com`,
};

const INSTALLED_SHOP = {
  id: `shop-installed-${SUFFIX}`,
  domain: `test-installed-${SUFFIX}.myshopify.com`,
};

const BUYER_ACCOUNT_UNINSTALLED = {
  id: `ba-uninstalled-${SUFFIX}`,
  companyId: `gid://shopify/Company/test-uninstalled-${SUFFIX}`,
  companyLocationId: `gid://shopify/CompanyLocation/test-uninstalled-${SUFFIX}`,
};

const BUYER_ACCOUNT_INSTALLED = {
  id: `ba-installed-${SUFFIX}`,
  companyId: `gid://shopify/Company/test-installed-${SUFFIX}`,
  companyLocationId: `gid://shopify/CompanyLocation/test-installed-${SUFFIX}`,
};

const INVOICE_UNINSTALLED = {
  id: `inv-uninstalled-${SUFFIX}`,
  orderId: `gid://shopify/Order/uninstalled-${SUFFIX}`,
};

const INVOICE_INSTALLED = {
  id: `inv-installed-${SUFFIX}`,
  orderId: `gid://shopify/Order/installed-${SUFFIX}`,
};

let sqlRef: ReturnType<typeof postgres>;

vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: vi.fn().mockImplementation(async () => {
      return {
        success: false,
        error: "No session found",
        errorCode: "no_session",
        retryable: false,
      };
    }),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
  };
});

describeWithDb("ORDERS_* no-session ACK behavior (#239 extension)", () => {
  beforeAll(async () => {
    sqlRef = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Clean up any leftover data from previous runs
    const allDomains = [UNINSTALLED_SHOP.domain, INSTALLED_SHOP.domain];
    const allShopIds = [UNINSTALLED_SHOP.id, INSTALLED_SHOP.id];
    const allBuyerAccountIds = [BUYER_ACCOUNT_UNINSTALLED.id, BUYER_ACCOUNT_INSTALLED.id];
    const allInvoiceIds = [INVOICE_UNINSTALLED.id, INVOICE_INSTALLED.id];
    const allOrderGids = [INVOICE_UNINSTALLED.orderId, INVOICE_INSTALLED.orderId];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM "AuditEvent" WHERE "shopId" IN ${sqlRef(allShopIds)}`;
    await sqlRef`DELETE FROM backstop_processed_orders WHERE order_gid IN ${sqlRef(allOrderGids)}`;
    await sqlRef`DELETE FROM "Invoice" WHERE id IN ${sqlRef(allInvoiceIds)}`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE id IN ${sqlRef(allBuyerAccountIds)}`;
    await sqlRef`DELETE FROM "Shop" WHERE id IN ${sqlRef(allShopIds)}`;
  });

  afterAll(async () => {
    const allDomains = [UNINSTALLED_SHOP.domain, INSTALLED_SHOP.domain];
    const allShopIds = [UNINSTALLED_SHOP.id, INSTALLED_SHOP.id];
    const allBuyerAccountIds = [BUYER_ACCOUNT_UNINSTALLED.id, BUYER_ACCOUNT_INSTALLED.id];
    const allInvoiceIds = [INVOICE_UNINSTALLED.id, INVOICE_INSTALLED.id];
    const allOrderGids = [INVOICE_UNINSTALLED.orderId, INVOICE_INSTALLED.orderId];

    await sqlRef`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sqlRef(allDomains)}`;
    await sqlRef`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${`%${SUFFIX}%`}`;
    await sqlRef`DELETE FROM "AuditEvent" WHERE "shopId" IN ${sqlRef(allShopIds)}`;
    await sqlRef`DELETE FROM backstop_processed_orders WHERE order_gid IN ${sqlRef(allOrderGids)}`;
    await sqlRef`DELETE FROM "Invoice" WHERE id IN ${sqlRef(allInvoiceIds)}`;
    await sqlRef`DELETE FROM "BuyerAccount" WHERE id IN ${sqlRef(allBuyerAccountIds)}`;
    await sqlRef`DELETE FROM "Shop" WHERE id IN ${sqlRef(allShopIds)}`;

    await sqlRef.end();
  });

  beforeEach(async () => {
    const allDomains = [UNINSTALLED_SHOP.domain, INSTALLED_SHOP.domain];
    await archiveStaleQueueMessages(sqlRef, allDomains);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ORDERS_CREATE for uninstalled shop: ACKed, no DLQ, no backstop.failed AuditEvent", async () => {
    const now = new Date();
    const uninstalledAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    // Create shop with uninstalledAt set
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${UNINSTALLED_SHOP.id}, ${UNINSTALLED_SHOP.domain}, 'INR', ${now}, ${now}, ${uninstalledAt})
    `;

    // Create BuyerAccount so resolveInvoiceForOrder can find the invoice
    // kind='COMPANY' requires companyId AND companyLocationId per BuyerAccount_kind_consistency
    await sqlRef`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
      VALUES (
        ${BUYER_ACCOUNT_UNINSTALLED.id},
        ${UNINSTALLED_SHOP.id},
        'COMPANY',
        ${BUYER_ACCOUNT_UNINSTALLED.companyId},
        ${BUYER_ACCOUNT_UNINSTALLED.companyLocationId},
        'Test Buyer',
        ${now},
        ${now}
      )
    `;

    // Create Invoice linked to the order so resolveInvoiceForOrder returns a result
    await sqlRef`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt")
      VALUES (
        ${INVOICE_UNINSTALLED.id},
        ${UNINSTALLED_SHOP.id},
        ${BUYER_ACCOUNT_UNINSTALLED.id},
        ${INVOICE_UNINSTALLED.orderId},
        '#TEST-UNINSTALLED',
        1000.00,
        1000.00,
        ${now}
      )
    `;

    const orderMsg = {
      shop: UNINSTALLED_SHOP.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-orders-create-${SUFFIX}`,
      resourceGid: INVOICE_UNINSTALLED.orderId,
      enqueuedAt: now.toISOString(),
    };

    await sqlRef`SELECT pgmq.send('s6_sync', ${sqlRef.json(orderMsg)})`;

    const [queueCountBefore] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${orderMsg.webhookId}
    `;
    expect(parseInt(queueCountBefore.count, 10)).toBe(1);

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

    // Message should be removed from the queue (ACKed)
    const [queueCountAfter] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${orderMsg.webhookId}
    `;
    expect(parseInt(queueCountAfter.count, 10), "message removed from q_s6_sync").toBe(0);

    // No DLQ entry for this shop (ACKed, not dead-lettered)
    const [dlqCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter
      WHERE message->>'webhookId' = ${orderMsg.webhookId}
    `;
    expect(parseInt(dlqCount.count, 10), "no DLQ entry for uninstalled shop").toBe(0);

    // No backstop.failed AuditEvent (recordBackstopFailure not called because ACKed)
    const [backstopFailedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${UNINSTALLED_SHOP.id}
        AND type = 'backstop.failed'
    `;
    expect(parseInt(backstopFailedCount.count, 10), "no backstop.failed AuditEvent").toBe(0);
  });

  it("ORDERS_CREATE for installed shop with no session: goes to DLQ with backstop.failed", async () => {
    const now = new Date();

    // Create installed shop (no uninstalledAt)
    await sqlRef`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${INSTALLED_SHOP.id}, ${INSTALLED_SHOP.domain}, 'INR', ${now}, ${now})
    `;

    // Create BuyerAccount so resolveInvoiceForOrder can find the invoice
    // kind='COMPANY' requires companyId AND companyLocationId per BuyerAccount_kind_consistency
    await sqlRef`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, "companyId", "companyLocationId", name, "createdAt", "updatedAt")
      VALUES (
        ${BUYER_ACCOUNT_INSTALLED.id},
        ${INSTALLED_SHOP.id},
        'COMPANY',
        ${BUYER_ACCOUNT_INSTALLED.companyId},
        ${BUYER_ACCOUNT_INSTALLED.companyLocationId},
        'Test Buyer Installed',
        ${now},
        ${now}
      )
    `;

    // Create Invoice linked to the order so resolveInvoiceForOrder returns a result
    await sqlRef`
      INSERT INTO "Invoice" (id, "shopId", "buyerAccountId", "orderId", name, total, outstanding, "issuedAt")
      VALUES (
        ${INVOICE_INSTALLED.id},
        ${INSTALLED_SHOP.id},
        ${BUYER_ACCOUNT_INSTALLED.id},
        ${INVOICE_INSTALLED.orderId},
        '#TEST-INSTALLED',
        1000.00,
        1000.00,
        ${now}
      )
    `;

    const orderMsg = {
      shop: INSTALLED_SHOP.domain,
      topic: "ORDERS_CREATE",
      webhookId: `wh-orders-create-installed-${SUFFIX}`,
      resourceGid: INVOICE_INSTALLED.orderId,
      enqueuedAt: now.toISOString(),
    };

    // Insert with read_ct=4 so next read triggers DLQ (maxRetries=5)
    await sqlRef`
      INSERT INTO pgmq.q_s6_sync (vt, read_ct, enqueued_at, message)
      VALUES (NOW() - interval '1 second', 4, NOW(), ${sqlRef.json(orderMsg)}::jsonb)
    `;

    const [queueCountBefore] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${orderMsg.webhookId}
    `;
    expect(parseInt(queueCountBefore.count, 10)).toBe(1);

    const { runDrain } = await import("~/services/drain/processor.server");
    await runDrain(sqlRef, { batchSize: 10, timeBudgetMs: 5000 });

    // Message should be removed from the queue
    const [queueCountAfter] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM pgmq.q_s6_sync
      WHERE message->>'webhookId' = ${orderMsg.webhookId}
    `;
    expect(parseInt(queueCountAfter.count, 10), "message removed from q_s6_sync").toBe(0);

    // DLQ entry should exist for installed shop with no_session
    const [dlqCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM s6_dead_letter
      WHERE message->>'webhookId' = ${orderMsg.webhookId}
    `;
    expect(parseInt(dlqCount.count, 10), "installed shop no_session goes to DLQ").toBe(1);

    // backstop.failed AuditEvent should exist (recordBackstopFailure called on DLQ)
    const [backstopFailedCount] = await sqlRef<[{ count: string }]>`
      SELECT COUNT(*)::text as count FROM "AuditEvent"
      WHERE "shopId" = ${INSTALLED_SHOP.id}
        AND type = 'backstop.failed'
    `;
    expect(parseInt(backstopFailedCount.count, 10), "backstop.failed AuditEvent created").toBe(1);
  });
});
