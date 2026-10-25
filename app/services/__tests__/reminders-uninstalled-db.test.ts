/**
 * DB-backed integration tests for S18 payment reminder uninstalled shop handling.
 *
 * Tests verify that sendPaymentReminder and sendCatchupReminder correctly
 * skip reminders when Shop.uninstalledAt is set (shop was uninstalled after
 * the message was queued).
 *
 * These tests hit real Postgres and use the sequential DB project from vitest config.
 * They scope their own rows and do not truncate globally.
 *
 * The shop is seeded with uninstalledAt = NOW() - 1 hour to simulate an
 * uninstall that happened after the reminder message was queued.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describeWithDb("S18 reminder uninstalled shop handling (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-uninstall-db";
  const TEST_SHOP_ID = `shop-uninstall-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s18-uninstall-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-uninstall-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/uninstall-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-uninstall-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create shop with uninstalledAt = NOW() - 1 hour (uninstalled BEFORE test runs)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "uninstalledAt", "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW() - INTERVAL '1 hour', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${TEST_CUSTOMER_ID},
        'Uninstall Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'uninstall-buyer@example.test', 'Uninstall Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    // Create enabled offset-0 email rule
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    // Enable reminders for this shop
    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("sendPaymentReminder - uninstalled shop", () => {
    it("skips with shop_uninstalled, no fetch, 0 ReminderLog rows", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake" };

      const invoiceId = `inv-uninstall-send-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/uninstall-send-${TEST_SUFFIX}`;

      // Create open invoice due today
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#UNINSTALL-SEND', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          validEnv
        );

        // Expect action 'skipped', skipReason matching /uninstalled/i
        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toMatch(/uninstalled/i);

        // Verify NO fetch was called (no email sent)
        expect(mockFetch).not.toHaveBeenCalled();

        // Verify 0 ReminderLog rows
        const logs = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog"
          WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID}
        `;
        expect(logs.length).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("sendCatchupReminder - uninstalled shop", () => {
    it("deletes pre-existing delayed row when shop uninstalled", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake" };

      const invoiceId = `inv-uninstall-catchup-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/uninstall-catchup-${TEST_SUFFIX}`;
      const logId = `log-uninstall-catchup-${TEST_SUFFIX}`;

      // Create open invoice due yesterday
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#UNINSTALL-CATCHUP', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      // Create pre-existing delayed ReminderLog row
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      // Verify delayed row exists before catch-up
      const before = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog" WHERE id = ${logId}
      `;
      expect(before.length).toBe(1);

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID,
          logId,
          0,
          "Asia/Kolkata",
          validEnv
        );

        // Expect action 'skipped', skipReason matching /uninstalled/i
        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toMatch(/uninstalled/i);

        // Verify NO fetch was called (no email sent)
        expect(mockFetch).not.toHaveBeenCalled();

        // Verify delayed row was DELETED (not just left as delayed)
        const after = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(after.length).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });
});
