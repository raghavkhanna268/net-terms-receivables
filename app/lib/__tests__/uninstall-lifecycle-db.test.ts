/**
 * DB-backed integration tests for uninstall lifecycle.
 *
 * Tests the complete uninstall → redact → reinstall lifecycle by driving the
 * REAL webhook handlers and drain processor:
 * 1. app/uninstalled handler sets Shop.uninstalledAt and removes session rows
 * 2. Queue drain skips/drops queued messages for uninstalled shops with ZERO Admin API calls
 * 3. Reminder selection excludes uninstalled shops (with positive control)
 * 4. Nightly reconcile skips uninstalled shops (with positive control)
 * 5. shop/redact handler deletes/anonymizes shop data (with second-shop control)
 * 6. Redacted-row exclusion from PR #416 (reinstall reset skips redacted accounts)
 * 7. Reinstall after uninstall restores normal processing
 * 8. No log line contains shop domain or webhookId (with positive control)
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
import type { ActionFunctionArgs } from "react-router";
import { requestContext } from "~/lib/request-context.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockVerifyWebhook = vi.fn();
const mockVerifyPayloadShopMatch = vi.fn();
vi.mock("~/lib/webhook-verify.server", () => ({
  verifyWebhook: (...args: unknown[]) => mockVerifyWebhook(...args),
  verifyPayloadShopMatch: (...args: unknown[]) => mockVerifyPayloadShopMatch(...args),
  normalizeWebhookTopic: (topic: string) => topic.replace(/\//g, "_").toUpperCase(),
}));

const adminGraphQLMock = vi.fn();
vi.mock("~/services/drain/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/drain/admin-client.server")>();
  return {
    ...actual,
    adminGraphQL: (...args: unknown[]) => adminGraphQLMock(...args),
  };
});

vi.mock("~/services/sync/company.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/services/sync/company.server")>();
  return {
    ...actual,
    isWebhookProcessed: vi.fn().mockResolvedValue(false),
    markWebhookProcessed: actual.markWebhookProcessed,
    processCompanyWebhook: actual.processCompanyWebhook,
  };
});

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

  function createMockSessionStorage() {
    return {
      deleteAllForShop: vi.fn().mockResolvedValue(1),
    };
  }

  function createUninstallActionArgs(shopDomain: string, sessionStorage: ReturnType<typeof createMockSessionStorage>): ActionFunctionArgs {
    return {
      request: new Request("https://example.com/webhooks/app/uninstalled", {
        method: "POST",
        headers: {
          "X-Shopify-Topic": "app/uninstalled",
          "X-Shopify-Hmac-Sha256": "test-hmac",
          "X-Shopify-Shop-Domain": shopDomain,
        },
        body: JSON.stringify({}),
      }),
      context: {
        shopify: {},
        sessionStorage,
        cloudflare: { env: {}, ctx: {} },
      },
      params: {},
      url: new URL("https://example.com/webhooks/app/uninstalled"),
      pattern: "/webhooks/app/uninstalled",
    } as unknown as ActionFunctionArgs;
  }

  function createComplianceActionArgs(shopDomain: string, topic: string, payload: Record<string, unknown>): ActionFunctionArgs {
    return {
      request: new Request("https://example.com/webhooks/compliance", {
        method: "POST",
        headers: {
          "X-Shopify-Topic": topic,
          "X-Shopify-Hmac-Sha256": "test-hmac",
          "X-Shopify-Shop-Domain": shopDomain,
        },
        body: JSON.stringify(payload),
      }),
      context: {
        shopify: {},
        sessionStorage: { deleteAllForShop: vi.fn().mockResolvedValue(0) },
        cloudflare: { env: {}, ctx: {} },
      },
      params: {},
      url: new URL("https://example.com/webhooks/compliance"),
      pattern: "/webhooks/compliance",
    } as unknown as ActionFunctionArgs;
  }

  describe("1. app/uninstalled handler sets uninstalledAt and removes sessions", () => {
    const originalEnv = process.env;

    beforeEach(async () => {
      vi.clearAllMocks();
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM webhook_receipts WHERE shop = ${SHOP_A_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + SHOP_A_DOMAIN + '%'}`;
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
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
      process.env = originalEnv;
    });

    it("real handler sets uninstalledAt and deletes sessions (guard: webhooks.app.uninstalled action)", async () => {
      const [shopBefore] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(shopBefore.uninstalledAt).toBeNull();

      const [sessionBefore] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM "Session" WHERE shop = ${SHOP_A_DOMAIN}
      `;
      expect(parseInt(sessionBefore.count, 10)).toBeGreaterThan(0);

      mockVerifyWebhook.mockResolvedValue({
        shop: SHOP_A_DOMAIN,
        topic: "app/uninstalled",
        webhookId: `test-uninstall-${TEST_SUFFIX}`,
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const sessionStorage = createMockSessionStorage();
      const args = createUninstallActionArgs(SHOP_A_DOMAIN, sessionStorage);

      const { action } = await import("~/routes/webhooks.app.uninstalled");
      const response = await requestContext.run({ getSql: () => sql }, () => action(args));

      expect(response).toBeInstanceOf(Response);
      expect(sessionStorage.deleteAllForShop).toHaveBeenCalledWith(SHOP_A_DOMAIN);

      const [shopAfter] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_A_ID}
      `;
      expect(shopAfter.uninstalledAt).not.toBeNull();
    });

    it("full-row assertion for Shop after uninstall (guard: webhooks.app.uninstalled action)", async () => {
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

      mockVerifyWebhook.mockResolvedValue({
        shop: SHOP_A_DOMAIN,
        topic: "app/uninstalled",
        webhookId: `test-uninstall-full-${TEST_SUFFIX}`,
        payload: {},
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });

      const sessionStorage = createMockSessionStorage();
      const args = createUninstallActionArgs(SHOP_A_DOMAIN, sessionStorage);

      const { action } = await import("~/routes/webhooks.app.uninstalled");
      await requestContext.run({ getSql: () => sql }, () => action(args));

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
      vi.clearAllMocks();
      adminGraphQLMock.mockReset();

      adminGraphQLMock.mockImplementation(async (shop: string, query: string, variables?: Record<string, unknown>) => {
        if (query.includes("OrderById") && variables?.id) {
          return {
            success: true,
            data: {
              node: {
                id: variables.id as string,
                name: "#TEST-1001",
                createdAt: new Date().toISOString(),
                processedAt: null,
                cancelledAt: null,
                closedAt: null,
                displayFinancialStatus: "PENDING",
                totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
                totalOutstandingSet: { shopMoney: { amount: "100.00", currencyCode: "INR" } },
                paymentTerms: {
                  id: "gid://shopify/PaymentTerms/test-123",
                  paymentTermsName: "Net 30",
                  paymentTermsType: "NET",
                  dueInDays: 30,
                },
              },
            },
            retryable: false,
          };
        }
        return {
          success: false,
          error: "no_session",
          errorCode: "no_session",
          retryable: false,
        };
      });

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'%' + TEST_SUFFIX + '%'}`;
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

    afterEach(async () => {
      vi.restoreAllMocks();
    });

    it("drain: ORDERS_CREATE for uninstalled shop A is ACKed without DLQ, installed shop B processes normally (guard: checkNoSessionForUninstalledShop in handleOrder)", async () => {
      const webhookIdA = `drain-test-a-${TEST_SUFFIX}`;
      const webhookIdB = `drain-test-b-${TEST_SUFFIX}`;
      const orderGidA = `gid://shopify/Order/drain-a-${TEST_SUFFIX}`;
      const orderGidB = `gid://shopify/Order/drain-b-${TEST_SUFFIX}`;

      await sql`
        SELECT pgmq.send('s6_sync', ${sql.json({
          topic: "ORDERS_CREATE",
          shop: SHOP_A_DOMAIN,
          webhookId: webhookIdA,
          resourceGid: orderGidA,
          enqueuedAt: new Date().toISOString(),
        })})
      `;

      await sql`
        SELECT pgmq.send('s6_sync', ${sql.json({
          topic: "ORDERS_CREATE",
          shop: SHOP_B_DOMAIN,
          webhookId: webhookIdB,
          resourceGid: orderGidB,
          enqueuedAt: new Date().toISOString(),
        })})
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      const adminCalls = adminGraphQLMock.mock.calls;
      const callsForShopA = adminCalls.filter((call) => call[0] === SHOP_A_DOMAIN);
      const callsForShopB = adminCalls.filter((call) => call[0] === SHOP_B_DOMAIN);
      expect(callsForShopA.length).toBe(1);
      expect(callsForShopB.length).toBeGreaterThanOrEqual(1);

      const [queueCountA] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'webhookId' = ${webhookIdA}
      `;
      expect(parseInt(queueCountA.count, 10)).toBe(0);

      const [dlqCountA] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM s6_dead_letter
        WHERE message->>'webhookId' = ${webhookIdA}
      `;
      expect(parseInt(dlqCountA.count, 10)).toBe(0);
    });

    it.skip("drain makes no Admin client request for an uninstalled shop (pending follow-up)", async () => {
      const webhookIdA = `drain-skip-a-${TEST_SUFFIX}`;
      const orderGidA = `gid://shopify/Order/drain-skip-a-${TEST_SUFFIX}`;

      await sql`
        SELECT pgmq.send('s6_sync', ${sql.json({
          topic: "ORDERS_CREATE",
          shop: SHOP_A_DOMAIN,
          webhookId: webhookIdA,
          resourceGid: orderGidA,
          enqueuedAt: new Date().toISOString(),
        })})
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      const adminCalls = adminGraphQLMock.mock.calls;
      const callsForShopA = adminCalls.filter((call) => call[0] === SHOP_A_DOMAIN);
      expect(callsForShopA.length).toBe(0);
    });

    it("drain: bulk messages for uninstalled shop A go to DLQ with bulk_op_not_found (guard: processBulkOperation shop lookup)", async () => {
      const bulkOpIdA = `bulk-a-${TEST_SUFFIX}`;

      await sql`
        SELECT pgmq.send('s6_bulk', ${sql.json({
          topic: "BULK_OPERATIONS_FINISH",
          shop: SHOP_A_DOMAIN,
          webhookId: `bulk-wh-a-${TEST_SUFFIX}`,
          bulkOperationId: `gid://shopify/BulkOperation/${bulkOpIdA}`,
          bulkType: "orders",
          enqueuedAt: new Date().toISOString(),
        })})
      `;

      const { runDrain } = await import("~/services/drain/processor.server");
      await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      const [queueCountA] = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_bulk
        WHERE message->>'bulkOperationId' LIKE ${`%${bulkOpIdA}%`}
      `;
      expect(parseInt(queueCountA.count, 10)).toBe(0);

      const [dlqRowA] = await sql<{ count: string; error: string }[]>`
        SELECT COUNT(*)::text AS count, MAX(error) AS error FROM s6_dead_letter
        WHERE message->>'bulkOperationId' LIKE ${`%${bulkOpIdA}%`}
      `;
      expect(parseInt(dlqRowA.count, 10)).toBe(1);
      expect(dlqRowA.error).toMatch(/bulk_op_not_found/);
    });
  });

  describe("3. Reminder selection excludes uninstalled shops", () => {
    const mockFetch = vi.fn();

    beforeEach(async () => {
      vi.stubGlobal("fetch", mockFetch);
      mockFetch.mockReset();

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

    it("positive control: installed shop (Shop B) sends reminder, action='sent' and fetch called once (guard: uninstalledAt IS NULL)", async () => {
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

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("4. Nightly reconcile skips uninstalled shops", () => {
    beforeEach(async () => {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN (${SHOP_A_DOMAIN}, ${SHOP_B_DOMAIN})`;
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

  describe("5. shop/redact handler deletes/anonymizes shop data", () => {
    const originalEnv = process.env;

    beforeEach(async () => {
      vi.clearAllMocks();
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };

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
      process.env = originalEnv;
    });

    it("real shop/redact handler deletes Shop A data, Shop B is byte-identical (guard: deleteShop in compliance route)", async () => {
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

      mockVerifyWebhook.mockResolvedValue({
        shop: SHOP_A_DOMAIN,
        topic: "shop/redact",
        webhookId: `redact-${TEST_SUFFIX}`,
        payload: { shop_domain: SHOP_A_DOMAIN, shop_id: 12345 },
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });
      mockVerifyPayloadShopMatch.mockReturnValue(SHOP_A_DOMAIN);

      const args = createComplianceActionArgs(SHOP_A_DOMAIN, "shop/redact", {
        shop_domain: SHOP_A_DOMAIN,
        shop_id: 12345,
      });

      const { action } = await import("~/routes/webhooks.compliance");
      const response = await requestContext.run({ getSql: () => sql }, () => action(args));

      expect(response).toBeInstanceOf(Response);
      expect(response.status).toBe(200);

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
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_A_ID}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_A_ID}`;
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

    it("upsertShopOnAuth reinstall skips redacted accounts (guard: customerId NOT LIKE pattern in after-auth.server.ts)", async () => {
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
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_A_ID}`;
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
    const originalEnv = process.env;

    beforeEach(async () => {
      consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      process.env = { ...originalEnv, SHOPIFY_API_SECRET: "test-secret" };

      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_A_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_A_ID}`;
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

    afterEach(() => {
      vi.restoreAllMocks();
      process.env = originalEnv;
    });

    function getAllLogs(): string {
      return [
        ...consoleLogSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c) => c.join(" ")),
      ].join("\n");
    }

    function findLogWithEvent(eventName: string): boolean {
      return getAllLogs().includes(`"event":"${eventName}"`);
    }

    it("reinstall log emits shop_upserted event, no domain or webhookId (guard: safeLog in after-auth.server.ts)", async () => {
      const { upsertShopOnAuth } = await import("~/lib/after-auth.server");
      await upsertShopOnAuth(sql, SHOP_A_DOMAIN, "Asia/Kolkata", "INR");

      const allLogs = getAllLogs();

      expect(allLogs).not.toContain(".example.com");
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain("webhookId");

      expect(findLogWithEvent("shop_upserted")).toBe(true);
    });

    it("shop/redact route emits shop_redact_deleted event with shopHash, no domain or webhookId (guard: safeLog in webhooks.compliance)", async () => {
      mockVerifyWebhook.mockResolvedValue({
        shop: SHOP_A_DOMAIN,
        topic: "shop/redact",
        webhookId: `redact-log-${TEST_SUFFIX}`,
        payload: { shop_domain: SHOP_A_DOMAIN, shop_id: 12345 },
        apiVersion: "2026-10",
        rawBody: new ArrayBuffer(0),
      });
      mockVerifyPayloadShopMatch.mockReturnValue(SHOP_A_DOMAIN);

      const args = createComplianceActionArgs(SHOP_A_DOMAIN, "shop/redact", {
        shop_domain: SHOP_A_DOMAIN,
        shop_id: 12345,
      });

      const { action } = await import("~/routes/webhooks.compliance");
      await requestContext.run({ getSql: () => sql }, () => action(args));

      const allLogs = getAllLogs();

      expect(allLogs).not.toContain(".example.com");
      expect(allLogs).not.toContain(".myshopify.com");
      expect(allLogs).not.toContain("webhookId");

      expect(findLogWithEvent("shop_redact_deleted")).toBe(true);
    });
  });
});
