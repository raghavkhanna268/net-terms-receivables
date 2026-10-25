/**
 * DB-backed integration tests for S18 reminder status queries.
 *
 * Tests verify:
 * - getReminderStatusCounts returns correct counts per status
 * - getDelayedReminders returns delayed reminders with catchUpBy
 * - Shop isolation: another shop's rows aren't counted or listed
 * - catchUpBy computation matches the migration (lines 103-104)
 * - Timezone boundary case (Asia/Kolkata vs UTC around midnight)
 * - EXPLAIN test: shopId index is used, no sequential scan
 *
 * Uses real Postgres. Test domains are test-* only. No real customer data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("S18 reminder status queries (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-status";
  const TEST_SHOP_ID = `shop-status-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-status-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-status-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/status-${TEST_SUFFIX}`;
  const TEST_RULE_ID_0 = `rule-status-0-${TEST_SUFFIX}`;
  const TEST_RULE_ID_7 = `rule-status-7-${TEST_SUFFIX}`;

  const OTHER_SHOP_ID = `shop-status-other-${TEST_SUFFIX}`;
  const OTHER_SHOP_DOMAIN = `test-status-other-${TEST_SUFFIX}.myshopify.com`;
  const OTHER_ACCOUNT_ID = `acc-status-other-${TEST_SUFFIX}`;
  const OTHER_CUSTOMER_ID = `gid://shopify/Customer/status-other-${TEST_SUFFIX}`;
  const OTHER_RULE_ID = `rule-status-other-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create main test shop with Asia/Kolkata timezone
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW(), NOW())
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
        'Status Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'status-buyer@test-status.example', 'Status Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES 
        (${TEST_RULE_ID_0}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW()),
        (${TEST_RULE_ID_7}, ${TEST_SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    // Create other shop for isolation tests (UTC timezone)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${OTHER_SHOP_ID}, ${OTHER_SHOP_DOMAIN}, 'USD', 'UTC', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${OTHER_SHOP_ID}, true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${OTHER_ACCOUNT_ID}, ${OTHER_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${OTHER_CUSTOMER_ID},
        'Other Shop Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${OTHER_SHOP_ID}, ${OTHER_CUSTOMER_ID}, 'other-buyer@test-status.example', 'Other Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${OTHER_RULE_ID}, ${OTHER_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    // Clean up other shop
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${OTHER_SHOP_ID}`;

    // Clean up main shop
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
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${OTHER_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${OTHER_SHOP_ID}`;
  });

  describe("getReminderStatusCounts", () => {
    it("returns zeros when there are no rows", async () => {
      const { getReminderStatusCounts } = await import("../reminder-status.server");
      
      const counts = await getReminderStatusCounts(sql, TEST_SHOP_ID);

      expect(counts).toEqual({
        sent: 0,
        delayed: 0,
        skippedDailyLimit: 0,
      });
    });

    it("returns correct counts per status", async () => {
      const { getReminderStatusCounts } = await import("../reminder-status.server");

      // Create invoices
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          ('inv-sent-1-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/sent1-${TEST_SUFFIX}',
           '#SENT-1', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-sent-2-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/sent2-${TEST_SUFFIX}',
           '#SENT-2', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-delayed-1-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/delayed1-${TEST_SUFFIX}',
           '#DELAYED-1', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-skipped-1-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/skipped1-${TEST_SUFFIX}',
           '#SKIPPED-1', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      // Create reminder logs with different statuses
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-sent-1-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW(), NULL),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-sent-2-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW(), NULL),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-delayed-1-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NULL, NOW()),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-skipped-1-${TEST_SUFFIX}', 'skipped_daily_limit'::"ReminderLogStatus", NULL, NOW())
      `;

      const counts = await getReminderStatusCounts(sql, TEST_SHOP_ID);

      expect(counts.sent).toBe(2);
      expect(counts.delayed).toBe(1);
      expect(counts.skippedDailyLimit).toBe(1);
    });

    it("shop isolation: another shop's rows aren't counted", async () => {
      const { getReminderStatusCounts } = await import("../reminder-status.server");

      // Create invoice and log for other shop
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES ('inv-other-${TEST_SUFFIX}', ${OTHER_SHOP_ID}, ${OTHER_ACCOUNT_ID}, 'gid://shopify/Order/other-${TEST_SUFFIX}',
                '#OTHER', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${OTHER_SHOP_ID}, ${OTHER_RULE_ID}, 'inv-other-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW())
      `;

      // Query main shop - should not see other shop's rows
      const counts = await getReminderStatusCounts(sql, TEST_SHOP_ID);

      expect(counts.sent).toBe(0);
      expect(counts.delayed).toBe(0);
      expect(counts.skippedDailyLimit).toBe(0);
    });
  });

  describe("getDelayedReminders", () => {
    it("returns delayed reminders with correct catchUpBy", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      // Create invoice with known dueAt (2026-10-25) in Asia/Kolkata timezone
      // Shop timezone is Asia/Kolkata
      // catchUpBy should be: dueAt::date + offsetDays + 3 = 2026-10-25 + 0 + 3 = 2026-10-28
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES ('inv-catchup-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/catchup-${TEST_SUFFIX}',
                '#CATCHUP-TEST', 10000.00, 10000.00, 'open', 
                '2026-10-20'::TIMESTAMPTZ, '2026-10-25 00:00:00+05:30'::TIMESTAMPTZ, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES ('log-catchup-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-catchup-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NOW())
      `;

      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID);

      expect(reminders.length).toBe(1);
      expect(reminders[0].id).toBe(`log-catchup-${TEST_SUFFIX}`);
      expect(reminders[0].invoiceName).toBe('#CATCHUP-TEST');
      expect(reminders[0].offsetDays).toBe(0);
      expect(reminders[0].firstCappedAt).toBeDefined();
      
      // catchUpBy = 2026-10-25 (dueAt in Asia/Kolkata) + 0 (offsetDays) + 3 = 2026-10-28
      const catchUpByDate = new Date(reminders[0].catchUpBy);
      expect(catchUpByDate.getUTCFullYear()).toBe(2026);
      expect(catchUpByDate.getUTCMonth()).toBe(9); // October (0-indexed)
      expect(catchUpByDate.getUTCDate()).toBe(28);
    });

    it("catchUpBy computation with non-zero offsetDays", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      // Create invoice with dueAt 2026-10-20
      // With offsetDays=7, catchUpBy = 2026-10-20 + 7 + 3 = 2026-10-30
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES ('inv-offset7-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/offset7-${TEST_SUFFIX}',
                '#OFFSET7-TEST', 10000.00, 10000.00, 'open', 
                '2026-10-15'::TIMESTAMPTZ, '2026-10-20 00:00:00+05:30'::TIMESTAMPTZ, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES ('log-offset7-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_RULE_ID_7}, 'inv-offset7-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NOW())
      `;

      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID);

      expect(reminders.length).toBe(1);
      expect(reminders[0].offsetDays).toBe(7);
      
      // catchUpBy = 2026-10-20 + 7 + 3 = 2026-10-30
      const catchUpByDate = new Date(reminders[0].catchUpBy);
      expect(catchUpByDate.getUTCFullYear()).toBe(2026);
      expect(catchUpByDate.getUTCMonth()).toBe(9); // October
      expect(catchUpByDate.getUTCDate()).toBe(30);
    });

    it("timezone boundary case: Asia/Kolkata vs UTC around midnight", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      // Test timezone boundary: 2026-10-25 23:00 UTC = 2026-10-26 04:30 IST
      // dueAt is stored as timestamptz, when converted to Asia/Kolkata date should be Oct 26
      // In Asia/Kolkata, this should be Oct 26, not Oct 25
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES ('inv-tz-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/tz-${TEST_SUFFIX}',
                '#TZ-TEST', 10000.00, 10000.00, 'open', 
                '2026-10-20'::TIMESTAMPTZ, '2026-10-25 23:00:00+00'::TIMESTAMPTZ, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES ('log-tz-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-tz-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NOW())
      `;

      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID);

      expect(reminders.length).toBe(1);
      
      // In Asia/Kolkata (UTC+5:30), 2026-10-25 23:00 UTC = 2026-10-26 04:30 IST
      // So the date in shop timezone is Oct 26
      // catchUpBy = 2026-10-26 + 0 + 3 = 2026-10-29
      const catchUpByDate = new Date(reminders[0].catchUpBy);
      expect(catchUpByDate.getUTCFullYear()).toBe(2026);
      expect(catchUpByDate.getUTCMonth()).toBe(9); // October
      expect(catchUpByDate.getUTCDate()).toBe(29);
    });

    it("shop isolation: another shop's delayed rows aren't listed", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      // Create delayed log for other shop
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES ('inv-other-delayed-${TEST_SUFFIX}', ${OTHER_SHOP_ID}, ${OTHER_ACCOUNT_ID}, 'gid://shopify/Order/other-delayed-${TEST_SUFFIX}',
                '#OTHER-DELAYED', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${OTHER_SHOP_ID}, ${OTHER_RULE_ID}, 'inv-other-delayed-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NOW())
      `;

      // Query main shop - should not see other shop's delayed rows
      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID);

      expect(reminders.length).toBe(0);
    });

    it("orders by catchUpBy ascending", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      // Create multiple invoices with different due dates
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          ('inv-order-later-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/order-later-${TEST_SUFFIX}',
           '#ORDER-LATER', 10000.00, 10000.00, 'open', NOW(), '2026-10-30 00:00:00+05:30'::TIMESTAMPTZ, NOW(), NOW()),
          ('inv-order-earlier-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/order-earlier-${TEST_SUFFIX}',
           '#ORDER-EARLIER', 10000.00, 10000.00, 'open', NOW(), '2026-10-20 00:00:00+05:30'::TIMESTAMPTZ, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          ('log-order-later-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-order-later-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NOW()),
          ('log-order-earlier-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-order-earlier-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NOW())
      `;

      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID);

      expect(reminders.length).toBe(2);
      // Earlier catchUpBy should come first
      expect(reminders[0].invoiceName).toBe('#ORDER-EARLIER');
      expect(reminders[1].invoiceName).toBe('#ORDER-LATER');
    });

    it("does not select sent or skipped_daily_limit rows", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          ('inv-sent-filter-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/sent-filter-${TEST_SUFFIX}',
           '#SENT-FILTER', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-skipped-filter-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/skipped-filter-${TEST_SUFFIX}',
           '#SKIPPED-FILTER', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-sent-filter-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW(), NULL),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-skipped-filter-${TEST_SUFFIX}', 'skipped_daily_limit'::"ReminderLogStatus", NULL, NOW())
      `;

      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID);

      expect(reminders.length).toBe(0);
    });

    it("respects limit parameter", async () => {
      const { getDelayedReminders } = await import("../reminder-status.server");

      // Create 5 invoices with delayed logs
      for (let i = 1; i <= 5; i++) {
        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (${`inv-limit-${i}-${TEST_SUFFIX}`}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${`gid://shopify/Order/limit-${i}-${TEST_SUFFIX}`},
                  ${`#LIMIT-${i}`}, 10000.00, 10000.00, 'open', NOW(), ${`2026-10-${20 + i} 00:00:00+05:30`}::TIMESTAMPTZ, NOW(), NOW())
        `;
        await sql`
          INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
          VALUES (${`log-limit-${i}-${TEST_SUFFIX}`}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, ${`inv-limit-${i}-${TEST_SUFFIX}`}, 'delayed'::"ReminderLogStatus", NOW())
        `;
      }

      const reminders = await getDelayedReminders(sql, TEST_SHOP_ID, 3);

      expect(reminders.length).toBe(3);
    });
  });

  describe("getShopSentTodayCount", () => {
    it("returns 0 when no reminders sent today", async () => {
      const { getShopSentTodayCount } = await import("../reminder-status.server");

      const count = await getShopSentTodayCount(sql, TEST_SHOP_ID);

      expect(count).toBe(0);
    });

    it("counts only sent reminders from today in shop timezone", async () => {
      const { getShopSentTodayCount } = await import("../reminder-status.server");

      // Create invoices
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          ('inv-today-1-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/today1-${TEST_SUFFIX}',
           '#TODAY-1', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-today-2-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/today2-${TEST_SUFFIX}',
           '#TODAY-2', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-yesterday-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/yesterday-${TEST_SUFFIX}',
           '#YESTERDAY', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      // Create sent logs - 2 from today, 1 from yesterday
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-today-1-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW()),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-today-2-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW()),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_7}, 'inv-yesterday-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const count = await getShopSentTodayCount(sql, TEST_SHOP_ID);

      // Should only count the 2 sent today
      expect(count).toBe(2);
    });

    it("does not count delayed or skipped reminders", async () => {
      const { getShopSentTodayCount } = await import("../reminder-status.server");

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          ('inv-status-sent-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/status-sent-${TEST_SUFFIX}',
           '#STATUS-SENT', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-status-delayed-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/status-delayed-${TEST_SUFFIX}',
           '#STATUS-DELAYED', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW()),
          ('inv-status-skipped-${TEST_SUFFIX}', ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, 'gid://shopify/Order/status-skipped-${TEST_SUFFIX}',
           '#STATUS-SKIPPED', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-status-sent-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW(), NULL),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-status-delayed-${TEST_SUFFIX}', 'delayed'::"ReminderLogStatus", NULL, NOW()),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_0}, 'inv-status-skipped-${TEST_SUFFIX}', 'skipped_daily_limit'::"ReminderLogStatus", NULL, NOW())
      `;

      const count = await getShopSentTodayCount(sql, TEST_SHOP_ID);

      // Should only count the 1 sent, not delayed or skipped
      expect(count).toBe(1);
    });

    it("shop isolation: another shop's sent rows aren't counted", async () => {
      const { getShopSentTodayCount } = await import("../reminder-status.server");

      // Create invoice and sent log for other shop
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES ('inv-other-sent-${TEST_SUFFIX}', ${OTHER_SHOP_ID}, ${OTHER_ACCOUNT_ID}, 'gid://shopify/Order/other-sent-${TEST_SUFFIX}',
                '#OTHER-SENT', 10000.00, 10000.00, 'open', NOW(), NOW(), NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${OTHER_SHOP_ID}, ${OTHER_RULE_ID}, 'inv-other-sent-${TEST_SUFFIX}', 'sent'::"ReminderLogStatus", NOW())
      `;

      // Query main shop - should not see other shop's sent rows
      const count = await getShopSentTodayCount(sql, TEST_SHOP_ID);

      expect(count).toBe(0);
    });
  });

  describe("EXPLAIN: shopId index usage", () => {
    it("counts query uses shopId index, no sequential scan", async () => {
      // Run inside a transaction with enable_seqscan off
      const result = await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        
        const explainRows = await tx<{ "QUERY PLAN": string }[]>`
          EXPLAIN (FORMAT TEXT)
          SELECT status::TEXT, COUNT(*)::TEXT AS count
          FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID}
          GROUP BY status
        `;
        
        return explainRows.map((r) => r["QUERY PLAN"]).join("\n");
      });

      // Assert no sequential scan on ReminderLog
      expect(result).not.toMatch(/Seq Scan on "ReminderLog"/);
      
      // Assert the shopId index is used (ReminderLog_shopId_idx)
      expect(result).toMatch(/ReminderLog_shopId_idx/);
      
      // Log for PR body
      console.log("EXPLAIN output for counts query:\n" + result);
    });
  });
});
