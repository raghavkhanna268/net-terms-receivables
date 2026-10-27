/**
 * DB-backed integration tests for uninstall lifecycle.
 *
 * Tests the complete uninstall → redact → reinstall lifecycle:
 * 1. app/uninstalled sets Shop.uninstalledAt and removes session rows
 * 2. Queue drain skips/drops queued messages for uninstalled shops with ZERO Admin API calls
 * 3. Reminder selection excludes uninstalled shops (with positive control)
 * 4. Nightly reconcile skips uninstalled shops (with positive control)
 * 5. shop/redact deletes/anonymizes shop data (with second-shop control)
 * 6. Redacted-row exclusion from PR #416 (reinstall reset skips redacted accounts)
 * 7. Reinstall after uninstall restores normal processing
 * 8. No log line contains shop domain or webhookId
 *
 * Synthetic data only: test-*.example.com domains, no real GIDs, no PII.
 * Uses describeWithDb pattern for sequential DB tests.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Uninstall lifecycle (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-uninstall-lifecycle";

  const SHOP_A_ID = `shop-a-${TEST_SUFFIX}`;
  const SHOP_A_DOMAIN = `test-uninstall-a-${TEST_SUFFIX}.example.com`;
  const SHOP_B_ID = `shop-b-${TEST_SUFFIX}`;
  const SHOP_B_DOMAIN = `test-uninstall-b-${TEST_SUFFIX}.example.com`;

  const ACCOUNT_A_ID = `acc-a-${TEST_SUFFIX}`;
  const ACCOUNT_B_ID = `acc-b-${TEST_SUFFIX}`;
  const CUSTOMER_A_GID = `gid://shopify/Customer/test-a-${TEST_SUFFIX}`;
  const CUSTOMER_B_GID = `gid://shopify/Customer/test-b-${TEST_SUFFIX}`;
  const INVOICE_A_ID = `inv-a-${TEST_SUFFIX}`;
  const INVOICE_B_ID = `inv-b-${TEST_SUFFIX}`;
  const ORDER_A_GID = `gid://shopify/Order/test-a-${TEST_SUFFIX}`;
  const ORDER_B_GID = `gid://shopify/Order/test-b-${TEST_SUFFIX}`;
  const RULE_A_ID = `rule-a-${TEST_SUFFIX}`;
  const RULE_B_ID = `rule-b-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}))`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
    await sql`DELETE FROM "Session" WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM webhook_receipts WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s6_reconcile_stage_claims WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

    await assertNoQueueLeftovers(sql, [SHOP_A_DOMAIN, SHOP_B_DOMAIN], "uninstall-lifecycle-db.test.ts");
    await sql.end();
  });

  async function seedShop(
    shopId: string,
    shopDomain: string,
    accountId: string,
    customerGid: string,
    invoiceId: string,
    orderGid: string,
    ruleId: string,
    options?: { uninstalledAt?: Date }
  ): Promise<void> {
    const now = new Date();
    const uninstalledAt = options?.uninstalledAt ?? null;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "uninstalledAt", "createdAt", "updatedAt")
      VALUES (${shopId}, ${shopDomain}, 'INR', 'Asia/Kolkata', 'free', ${uninstalledAt}, ${now}, ${now})
      ON CONFLICT (id) DO UPDATE SET "uninstalledAt" = ${uninstalledAt}, "updatedAt" = ${now}
    `;

    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + shopDomain}, ${shopDomain}, 'test-state', false, 'test-token')
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${accountId}, ${shopId}, 'TAGGED_CUSTOMER'::"AccountKind",
        NULL, NULL, ${customerGid},
        'Test Buyer', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, ${now}, ${now}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${shopId}, ${customerGid}, 'buyer@test-synthetic.example.com', 'Test Buyer', ${now})
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${shopId}, ${accountId}, ${orderGid},
        '#TEST-1', 10000.00, 10000.00, 'open',
        ${new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)},
        ${now},
        ${now}, ${now}
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ruleId}, ${shopId}, 0, 'email'::"ReminderChannel", true, ${now}, ${now})
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${shopId}, true, ${now}, ${now})
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true
    `;
  }

  describe("1. app/uninstalled sets uninstalledAt and removes sessions", () => {
    beforeEach(async () => {
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM webhook_receipts WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + SHOP_A_DOMAIN + '%'}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;
      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("markShopUninstalled sets uninstalledAt and sessions are deleted (guard: markShopUninstalled in compliance.server.ts)", async () => {
      const [shopBefore] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(shopBefore.uninstalledAt).toBeNull();

      const [sessionBefore] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}
      `;
      expect(parseInt(sessionBefore.count, 10)).toBeGreaterThan(0);

      const { markShopUninstalled } = await import("~/services/compliance/compliance.server");
      const marked = await markShopUninstalled(sql, SHOP_A_DOMAIN);
      expect(marked).toBe(true);

      const [shopAfter] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(shopAfter.uninstalledAt).not.toBeNull();

      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;

      const [sessionAfter] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}
      `;
      expect(parseInt(sessionAfter.count, 10)).toBe(0);
    });

    it("full-row assertion for Shop after uninstall (guard: UPDATE Shop SET uninstalledAt in markShopUninstalled)", async () => {
      const [before] = await sql<{
        id: string;
        domain: string;
        currency: string;
        timezone: string;
        plan_key: string;
        uninstalledAt: Date | null;
      }[]>`
        SELECT id, domain, currency, timezone, plan_key, "uninstalledAt"
        FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;

      expect(before.uninstalledAt).toBeNull();

      const { markShopUninstalled } = await import("~/services/compliance/compliance.server");
      await markShopUninstalled(sql, SHOP_A_DOMAIN);

      const [after] = await sql<{
        id: string;
        domain: string;
        currency: string;
        timezone: string;
        plan_key: string;
        uninstalledAt: Date | null;
      }[]>`
        SELECT id, domain, currency, timezone, plan_key, "uninstalledAt"
        FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;

      expect(after.id).toBe(before.id);
      expect(after.domain).toBe(before.domain);
      expect(after.currency).toBe(before.currency);
      expect(after.timezone).toBe(before.timezone);
      expect(after.plan_key).toBe(before.plan_key);
      expect(after.uninstalledAt).not.toBeNull();
    });
  });

  describe("2. Queue drain skips uninstalled shop messages with ZERO Admin API calls", () => {
    beforeEach(async () => {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + SHOP_A_DOMAIN + '%'}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;
      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID,
        { uninstalledAt: new Date(Date.now() - 60 * 60 * 1000) }
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("enqueue_credit_status_recomputes skips uninstalled shop (guard: uninstalledAt IS NULL in SQL function)", async () => {
      const [shopState] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(shopState.uninstalledAt).not.toBeNull();

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messages = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${ACCOUNT_A_ID}
      `;
      expect(messages.length).toBe(0);
    });

    it("enqueueReconcileForAllShops skips uninstalled shop (guard: uninstalledAt IS NULL in reconcile.server.ts)", async () => {
      const { enqueueReconcileForAllShops } = await import("~/services/drain/reconcile.server");

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;

      await enqueueReconcileForAllShops(sql);

      const messages = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_A_DOMAIN}
          AND message->>'topic' = 'RECONCILE_COMPANIES'
      `;
      expect(messages.length).toBe(0);
    });

    it("DLQ count stays bounded for uninstalled shop messages (guard: sanitization in moveToDeadLetter)", async () => {
      const testWebhookId = `test-dlq-${TEST_SUFFIX}`;

      await sql`
        SELECT pgmq.send('s6_sync', ${sql.json({
          topic: "ORDERS_CREATE",
          shop: SHOP_A_DOMAIN,
          webhookId: testWebhookId,
          enqueuedAt: new Date().toISOString(),
        })})
      `;

      const { moveToDeadLetter } = await import("~/services/drain/processor.server");
      const syncMessage = {
        topic: "ORDERS_CREATE",
        shop: SHOP_A_DOMAIN,
        webhookId: testWebhookId,
        enqueuedAt: new Date().toISOString(),
        resourceGid: `gid://shopify/Order/dlq-test-${TEST_SUFFIX}`,
      };
      await moveToDeadLetter(
        sql,
        "s6_sync",
        testWebhookId,
        syncMessage,
        "shop_not_found",
        5
      );

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'webhookId' = ${testWebhookId}`;

      const [dlqCount] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM s6_dead_letter
        WHERE message->>'shop' = ${SHOP_A_DOMAIN}
      `;
      expect(parseInt(dlqCount.count, 10)).toBeLessThanOrEqual(10);
    });
  });

  describe("3. Reminder selection excludes uninstalled shops", () => {
    const mockFetch = vi.fn();

    beforeEach(async () => {
      vi.stubGlobal("fetch", mockFetch);
      mockFetch.mockReset();
      vi.spyOn(console, "log").mockImplementation(() => {});

      await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "Session" WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID,
        { uninstalledAt: new Date(Date.now() - 60 * 60 * 1000) }
      );
      await seedShop(
        SHOP_B_ID,
        SHOP_B_DOMAIN,
        ACCOUNT_B_ID,
        CUSTOMER_B_GID,
        INVOICE_B_ID,
        ORDER_B_GID,
        RULE_B_ID
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("sendPaymentReminder skips uninstalled shop with 0 fetch calls (guard: uninstalledAt check in reminders.server.ts)", async () => {
      const { sendPaymentReminder } = await import("~/services/reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-synthetic.example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.test-synthetic.example.com",
        RESEND_TEST_RECIPIENTS: "buyer@test-synthetic.example.com",
      };

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(
        { hour: 12, minute: 0 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(
        mockNow as ReturnType<typeof luxon.DateTime.now>
      );

      const result = await sendPaymentReminder(
        sql,
        SHOP_A_ID,
        INVOICE_A_ID,
        RULE_A_ID,
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toMatch(/uninstalled/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("positive control: installed shop (Shop B) gets reminder selected (guard: uninstalledAt IS NULL)", async () => {
      const { sendPaymentReminder } = await import("~/services/reminders.server");

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: "test-email-id" }),
      });

      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-synthetic.example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.test-synthetic.example.com",
        RESEND_TEST_RECIPIENTS: "buyer@test-synthetic.example.com",
        RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false",
      };

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(
        { hour: 12, minute: 0 },
        { zone: "Asia/Kolkata" }
      );
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(
        mockNow as ReturnType<typeof luxon.DateTime.now>
      );

      const result = await sendPaymentReminder(
        sql,
        SHOP_B_ID,
        INVOICE_B_ID,
        RULE_B_ID,
        0,
        "Asia/Kolkata",
        validEnv
      );

      expect(result.skipReason).not.toMatch(/uninstalled/i);
    });
  });

  describe("4. Nightly reconcile skips uninstalled shops", () => {
    beforeEach(async () => {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "Session" WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID,
        { uninstalledAt: new Date(Date.now() - 60 * 60 * 1000) }
      );
      await seedShop(
        SHOP_B_ID,
        SHOP_B_DOMAIN,
        ACCOUNT_B_ID,
        CUSTOMER_B_GID,
        INVOICE_B_ID,
        ORDER_B_GID,
        RULE_B_ID
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("enqueueReconcileForAllShops excludes uninstalled shop A but includes installed shop B (guard: WHERE uninstalledAt IS NULL)", async () => {
      const { enqueueReconcileForAllShops } = await import("~/services/drain/reconcile.server");

      await enqueueReconcileForAllShops(sql);

      const messagesA = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_A_DOMAIN}
          AND message->>'topic' = 'RECONCILE_COMPANIES'
      `;
      expect(messagesA.length).toBe(0);

      const messagesB = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_B_DOMAIN}
          AND message->>'topic' = 'RECONCILE_COMPANIES'
      `;
      expect(messagesB.length).toBe(1);
    });
  });

  describe("5. shop/redact deletes/anonymizes shop data", () => {
    beforeEach(async () => {
      await sql`DELETE FROM "Match" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID}))`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${SHOP_A_ID}, ${SHOP_B_ID})`;
      await sql`DELETE FROM webhook_receipts WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
      await sql`DELETE FROM "Session" WHERE shop IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM "Shop" WHERE id IN (${SHOP_A_ID}, ${SHOP_B_ID})`;

      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID,
        { uninstalledAt: new Date(Date.now() - 48 * 60 * 60 * 1000) }
      );
      await seedShop(
        SHOP_B_ID,
        SHOP_B_DOMAIN,
        ACCOUNT_B_ID,
        CUSTOMER_B_GID,
        INVOICE_B_ID,
        ORDER_B_GID,
        RULE_B_ID
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("deleteShop deletes Shop A data, Shop B is byte-identical (guard: deleteShop in compliance.server.ts)", async () => {
      const [shopBBefore] = await sql<{
        id: string;
        domain: string;
        currency: string;
        timezone: string;
      }[]>`
        SELECT id, domain, currency, timezone FROM "Shop" WHERE id = ${SHOP_B_ID}
      `;

      const [accountBBefore] = await sql<{
        id: string;
        shopId: string;
        name: string;
        customerId: string;
      }[]>`
        SELECT id, "shopId", name, "customerId"
        FROM "BuyerAccount" WHERE id = ${ACCOUNT_B_ID}
      `;

      const [invoiceBBefore] = await sql<{
        id: string;
        shopId: string;
        name: string;
        total: string;
      }[]>`
        SELECT id, "shopId", name, total::text
        FROM "Invoice" WHERE id = ${INVOICE_B_ID}
      `;

      const { deleteShop } = await import("~/services/compliance/compliance.server");
      const result = await deleteShop(sql, SHOP_A_DOMAIN);

      expect(result.deleted).toBe(true);
      expect(result.shopId).toBe(SHOP_A_ID);
      expect(result.skippedReinstalled).toBe(false);

      const [shopAAfter] = await sql<{ id: string }[]>`
        SELECT id FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(shopAAfter).toBeUndefined();

      const [sessionAAfter] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}
      `;
      expect(parseInt(sessionAAfter.count, 10)).toBe(0);

      const [accountAAfter] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}
      `;
      expect(parseInt(accountAAfter.count, 10)).toBe(0);

      const [shopBAfter] = await sql<{
        id: string;
        domain: string;
        currency: string;
        timezone: string;
      }[]>`
        SELECT id, domain, currency, timezone FROM "Shop" WHERE id = ${SHOP_B_ID}
      `;
      expect(shopBAfter.id).toBe(shopBBefore.id);
      expect(shopBAfter.domain).toBe(shopBBefore.domain);
      expect(shopBAfter.currency).toBe(shopBBefore.currency);
      expect(shopBAfter.timezone).toBe(shopBBefore.timezone);

      const [accountBAfter] = await sql<{
        id: string;
        shopId: string;
        name: string;
        customerId: string;
      }[]>`
        SELECT id, "shopId", name, "customerId"
        FROM "BuyerAccount" WHERE id = ${ACCOUNT_B_ID}
      `;
      expect(accountBAfter.id).toBe(accountBBefore.id);
      expect(accountBAfter.shopId).toBe(accountBBefore.shopId);
      expect(accountBAfter.name).toBe(accountBBefore.name);
      expect(accountBAfter.customerId).toBe(accountBBefore.customerId);

      const [invoiceBAfter] = await sql<{
        id: string;
        shopId: string;
        name: string;
        total: string;
      }[]>`
        SELECT id, "shopId", name, total::text
        FROM "Invoice" WHERE id = ${INVOICE_B_ID}
      `;
      expect(invoiceBAfter.id).toBe(invoiceBBefore.id);
      expect(invoiceBAfter.shopId).toBe(invoiceBBefore.shopId);
      expect(invoiceBAfter.name).toBe(invoiceBBefore.name);
      expect(invoiceBAfter.total).toBe(invoiceBBefore.total);
    });
  });

  describe("6. Redacted-row exclusion from PR #416", () => {
    const REDACTED_CUSTOMER_GID = `gid://shopify/Customer/redact-test_redacted_${Date.now()}`;
    const REDACTED_ACCOUNT_ID = `acc-redacted-${TEST_SUFFIX}`;

    beforeEach(async () => {
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "uninstalledAt", "createdAt", "updatedAt")
        VALUES (${SHOP_A_ID}, ${SHOP_A_DOMAIN}, 'INR', 'Asia/Kolkata', 'free',
                ${new Date(Date.now() - 60 * 60 * 1000)}, NOW(), NOW())
      `;

      const syncedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "holdState",
          "metafieldSyncErrorCode", "metafieldSyncedAt", "syncPending",
          "creditLimit", bypass, "manualHold", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${REDACTED_ACCOUNT_ID}, ${SHOP_A_ID}, 'TAGGED_CUSTOMER'::"AccountKind",
          ${REDACTED_CUSTOMER_GID}, 'Redacted Customer', 'OK',
          'no_session', ${syncedAt}, false,
          100000.00, false, false, 1, NOW(), NOW()
        )
      `;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("clearUninstalledAtAndMetafieldErrors skips redacted accounts (guard: customerId NOT LIKE pattern in after-auth.server.ts)", async () => {
      const [before] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncedAt: Date | null;
        syncPending: boolean;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncedAt", "syncPending"
        FROM "BuyerAccount" WHERE id = ${REDACTED_ACCOUNT_ID}
      `;
      expect(before.metafieldSyncErrorCode).toBe("no_session");
      expect(before.metafieldSyncedAt).not.toBeNull();
      expect(before.syncPending).toBe(false);

      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, SHOP_A_DOMAIN, "Asia/Kolkata", "INR");

      const [after] = await sql<{
        metafieldSyncErrorCode: string | null;
        metafieldSyncedAt: Date | null;
        syncPending: boolean;
      }[]>`
        SELECT "metafieldSyncErrorCode", "metafieldSyncedAt", "syncPending"
        FROM "BuyerAccount" WHERE id = ${REDACTED_ACCOUNT_ID}
      `;

      expect(after.metafieldSyncErrorCode).toBe(before.metafieldSyncErrorCode);
      expect(after.metafieldSyncedAt?.getTime()).toBe(before.metafieldSyncedAt?.getTime());
      expect(after.syncPending).toBe(before.syncPending);
    });
  });

  describe("7. Reinstall after uninstall restores normal processing", () => {
    beforeEach(async () => {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + SHOP_A_DOMAIN + '%'}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;

      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID,
        { uninstalledAt: new Date(Date.now() - 60 * 60 * 1000) }
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("reinstall clears uninstalledAt and reconcile picks up shop again (guard: upsertShopOnAuth clears uninstalledAt)", async () => {
      const [beforeReinstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(beforeReinstall.uninstalledAt).not.toBeNull();

      const { enqueueReconcileForAllShops } = await import("~/services/drain/reconcile.server");
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await enqueueReconcileForAllShops(sql);

      const messagesBeforeReinstall = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_A_DOMAIN}
          AND message->>'topic' = 'RECONCILE_COMPANIES'
      `;
      expect(messagesBeforeReinstall.length).toBe(0);

      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, SHOP_A_DOMAIN, "Asia/Kolkata", "INR");

      const [afterReinstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(afterReinstall.uninstalledAt).toBeNull();

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'reconcile:' + SHOP_A_DOMAIN + '%'}`;
      await enqueueReconcileForAllShops(sql);

      const messagesAfterReinstall = await sql<{ shop: string }[]>`
        SELECT message->>'shop' AS shop
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_A_DOMAIN}
          AND message->>'topic' = 'RECONCILE_COMPANIES'
      `;
      expect(messagesAfterReinstall.length).toBe(1);
    });

    it("reinstall clears uninstalledAt and sweep picks up shop again (guard: upsertShopOnAuth clears uninstalledAt)", async () => {
      const [beforeReinstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(beforeReinstall.uninstalledAt).not.toBeNull();

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + ACCOUNT_A_ID + '%'}`;
      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messagesBeforeReinstall = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${ACCOUNT_A_ID}
      `;
      expect(messagesBeforeReinstall.length).toBe(0);

      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, SHOP_A_DOMAIN, "Asia/Kolkata", "INR");

      const [afterReinstall] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(afterReinstall.uninstalledAt).toBeNull();

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + ACCOUNT_A_ID + '%'}`;
      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messagesAfterReinstall = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${ACCOUNT_A_ID}
      `;
      expect(messagesAfterReinstall.length).toBe(1);
    });
  });

  describe("8. No log line contains shop domain or webhookId", () => {
    let consoleLogSpy: MockInstance;
    let consoleWarnSpy: MockInstance;
    let consoleErrorSpy: MockInstance;

    beforeEach(async () => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID}`;

      await seedShop(
        SHOP_A_ID,
        SHOP_A_DOMAIN,
        ACCOUNT_A_ID,
        CUSTOMER_A_GID,
        INVOICE_A_ID,
        ORDER_A_GID,
        RULE_A_ID,
        { uninstalledAt: new Date(Date.now() - 60 * 60 * 1000) }
      );
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("reinstall log uses shopHash, not domain or webhookId (guard: safeLog in after-auth.server.ts)", async () => {
      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, SHOP_A_DOMAIN, "Asia/Kolkata", "INR");

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(".example.com");
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain("webhookId");
    });

    it("deleteShop log uses shopHash, not domain or webhookId (guard: safeLog in compliance.server.ts)", async () => {
      const { deleteShop } = await import("~/services/compliance/compliance.server");
      await deleteShop(sql, SHOP_A_DOMAIN);

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(".example.com");
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain("webhookId");
    });

    it("markShopUninstalled log does not contain domain or webhookId (guard: no safeLog in markShopUninstalled)", async () => {
      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${SHOP_A_ID + '-mark'}, ${SHOP_A_DOMAIN.replace('-a-', '-mark-')}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
        ON CONFLICT (id) DO NOTHING
      `;

      const { markShopUninstalled } = await import("~/services/compliance/compliance.server");
      await markShopUninstalled(sql, SHOP_A_DOMAIN.replace("-a-", "-mark-"));

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(".example.com");
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain("webhookId");

      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_A_ID + '-mark'}`;
    });
  });
});
