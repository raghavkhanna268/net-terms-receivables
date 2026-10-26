/**
 * DB-backed integration tests for ensureDefaultReminderRules and duplicate-rule guards.
 *
 * Tests verify:
 * - (a) Migrated shop with 3 ReminderRule rows and NO settings row:
 *       after ensureDefaultReminderRules runs, still has exactly 3 rules,
 *       and a settings row now exists. [fails on revert]
 * - (b) Fresh shop with no rules and no settings row gets exactly 3 rules
 *       (-3/0/+7) plus a settings row. [positive control]
 * - (c) Running ensureDefaultReminderRules twice is idempotent: still 3 rules
 *       and 1 settings row; migrated variant also stays at 3. [fails on revert]
 * - hasSiblingRuleSent catch-up guard (4 tests): [helper test fails on revert]
 * - End-to-end: 2 duplicate rules produce exactly 1 send [fails on revert]
 * - sendCatchupReminder: skips when sibling already sent [fails on revert]
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("Sequential DB", () => {
  describe("ensureDefaultReminderRules duplicate-rule fix", () => {
    let sql: ReturnType<typeof postgres>;
    const TEST_SUFFIX = Date.now().toString(36) + "defr";

    beforeAll(async () => {
      sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    });

    afterAll(async () => {
      await sql.end();
    });

    describe("(a) migrated shop with rules but no settings row", () => {
      const SHOP_ID = `shop-migrated-${TEST_SUFFIX}`;
      const SHOP_DOMAIN = `test-migrated-${TEST_SUFFIX}.myshopify.com`;

      beforeEach(async () => {
        await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      });

      afterAll(async () => {
        await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      });

      it("keeps exactly 3 rules and creates settings row (migration scenario)", async () => {
        await sql`
          INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
          VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
        `;

        await sql`
          INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
          VALUES 
            (gen_random_uuid()::TEXT, ${SHOP_ID}, -3, 'email'::"ReminderChannel", true, NOW(), NOW()),
            (gen_random_uuid()::TEXT, ${SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW()),
            (gen_random_uuid()::TEXT, ${SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW())
        `;

        const [beforeSettings] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}
        `;
        expect(beforeSettings.count).toBe(0);

        const [beforeRules] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(beforeRules.count).toBe(3);

        const { ensureDefaultReminderRules } = await import("../reminders.server");
        const result = await ensureDefaultReminderRules(sql, SHOP_ID);

        expect(result.seeded).toBe(false);
        expect(result.count).toBe(0);

        const [afterSettings] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}
        `;
        expect(afterSettings.count).toBe(1);

        const [afterRules] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(afterRules.count).toBe(3);

        const offsets = await sql<{ offsetDays: number }[]>`
          SELECT "offsetDays" FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID} ORDER BY "offsetDays"
        `;
        expect(offsets.map(r => r.offsetDays)).toEqual([-3, 0, 7]);
      });
    });

    describe("(b) fresh shop with no rules and no settings", () => {
      const SHOP_ID = `shop-fresh-${TEST_SUFFIX}`;
      const SHOP_DOMAIN = `test-fresh-${TEST_SUFFIX}.myshopify.com`;

      beforeEach(async () => {
        await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      });

      afterAll(async () => {
        await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      });

      it("creates exactly 3 rules (-3/0/+7) and settings row", async () => {
        await sql`
          INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
          VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
        `;

        const [beforeSettings] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}
        `;
        expect(beforeSettings.count).toBe(0);

        const [beforeRules] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(beforeRules.count).toBe(0);

        const { ensureDefaultReminderRules } = await import("../reminders.server");
        const result = await ensureDefaultReminderRules(sql, SHOP_ID);

        expect(result.seeded).toBe(true);
        expect(result.count).toBe(3);

        const [afterSettings] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}
        `;
        expect(afterSettings.count).toBe(1);

        const [afterRules] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(afterRules.count).toBe(3);

        const offsets = await sql<{ offsetDays: number }[]>`
          SELECT "offsetDays" FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID} ORDER BY "offsetDays"
        `;
        expect(offsets.map(r => r.offsetDays)).toEqual([-3, 0, 7]);
      });
    });

    describe("(c) idempotency - running twice", () => {
      const SHOP_ID = `shop-idempotent-${TEST_SUFFIX}`;
      const SHOP_DOMAIN = `test-idempotent-${TEST_SUFFIX}.myshopify.com`;

      beforeEach(async () => {
        await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      });

      afterAll(async () => {
        await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      });

      it("is idempotent: still 3 rules and 1 settings row after two calls", async () => {
        await sql`
          INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
          VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
        `;

        const { ensureDefaultReminderRules } = await import("../reminders.server");

        const result1 = await ensureDefaultReminderRules(sql, SHOP_ID);
        expect(result1.seeded).toBe(true);
        expect(result1.count).toBe(3);

        const result2 = await ensureDefaultReminderRules(sql, SHOP_ID);
        expect(result2.seeded).toBe(false);
        expect(result2.count).toBe(0);

        const [settingsCount] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}
        `;
        expect(settingsCount.count).toBe(1);

        const [rulesCount] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(rulesCount.count).toBe(3);
      });

      it("is idempotent for migrated shop: still 3 rules after two calls", async () => {
        await sql`
          INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
          VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
        `;

        await sql`
          INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
          VALUES 
            (gen_random_uuid()::TEXT, ${SHOP_ID}, -3, 'email'::"ReminderChannel", true, NOW(), NOW()),
            (gen_random_uuid()::TEXT, ${SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW()),
            (gen_random_uuid()::TEXT, ${SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW())
        `;

        const { ensureDefaultReminderRules } = await import("../reminders.server");

        const result1 = await ensureDefaultReminderRules(sql, SHOP_ID);
        expect(result1.seeded).toBe(false);

        const result2 = await ensureDefaultReminderRules(sql, SHOP_ID);
        expect(result2.seeded).toBe(false);

        const [settingsCount] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}
        `;
        expect(settingsCount.count).toBe(1);

        const [rulesCount] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}
        `;
        expect(rulesCount.count).toBe(3);
      });
    });
  });

  describe("hasSiblingRuleSent catch-up guard", () => {
    let sql: ReturnType<typeof postgres>;
    const TEST_SUFFIX = Date.now().toString(36) + "sib";
    const SHOP_ID = `shop-sibling-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-sibling-${TEST_SUFFIX}.myshopify.com`;
    const INVOICE_ID = `inv-sibling-${TEST_SUFFIX}`;
    const RULE_A_ID = `rule-a-${TEST_SUFFIX}`;
    const RULE_B_ID = `rule-b-${TEST_SUFFIX}`;
    const BUYER_ACCOUNT_ID = `acc-sibling-${TEST_SUFFIX}`;
    const OFFSET_DAYS = 0;

    beforeAll(async () => {
      sql = postgres(TEST_DATABASE_URL!, sqlOptions);

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
      `;

      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_ID}, true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES
          (${RULE_A_ID}, ${SHOP_ID}, ${OFFSET_DAYS}, 'email'::"ReminderChannel", true, NOW(), NOW()),
          (${RULE_B_ID}, ${SHOP_ID}, ${OFFSET_DAYS}, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      const CUSTOMER_ID = `gid://shopify/Customer/sibling-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "creditLimit", "holdState", bypass, "manualHold",
          "defaultTermsDays", "defaultTermsSource", "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${BUYER_ACCOUNT_ID}, ${SHOP_ID}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID}, 'Test Buyer',
          100000.00, 'OK', false, false, 30, 'explicit', false, 1, NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID}, ${SHOP_ID}, ${BUYER_ACCOUNT_ID},
          'gid://shopify/Order/sibling-test', '#SIBLING-TEST', 10000.00, 10000.00,
          'open', NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      await sql.end();
    });

    beforeEach(async () => {
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    });

    it("skips catch-up when sibling rule already sent [fails on revert]", async () => {
      const { hasSiblingRuleSent } = await import("../reminders.server");

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_A_ID}, ${INVOICE_ID}, NOW(), 'sent'::"ReminderLogStatus")
      `;

      const result = await hasSiblingRuleSent(sql, SHOP_ID, INVOICE_ID, RULE_B_ID, OFFSET_DAYS);

      expect(result).toBe(true);
    });

    it("allows catch-up when no sibling rule has sent", async () => {
      const { hasSiblingRuleSent } = await import("../reminders.server");

      const result = await hasSiblingRuleSent(sql, SHOP_ID, INVOICE_ID, RULE_B_ID, OFFSET_DAYS);

      expect(result).toBe(false);
    });

    it("allows catch-up when sibling rule has different offsetDays", async () => {
      const { hasSiblingRuleSent } = await import("../reminders.server");

      const RULE_C_ID = `rule-c-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${RULE_C_ID}, ${SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_C_ID}, ${INVOICE_ID}, NOW(), 'sent'::"ReminderLogStatus")
      `;

      const result = await hasSiblingRuleSent(sql, SHOP_ID, INVOICE_ID, RULE_B_ID, OFFSET_DAYS);

      expect(result).toBe(false);

      await sql`DELETE FROM "ReminderLog" WHERE "ruleId" = ${RULE_C_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE id = ${RULE_C_ID}`;
    });

    it("ignores sibling rules with delayed status", async () => {
      const { hasSiblingRuleSent } = await import("../reminders.server");

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_A_ID}, ${INVOICE_ID}, 'delayed'::"ReminderLogStatus", NOW())
      `;

      const result = await hasSiblingRuleSent(sql, SHOP_ID, INVOICE_ID, RULE_B_ID, OFFSET_DAYS);

      expect(result).toBe(false);
    });
  });

  describe("duplicate-rule end-to-end: enqueue + TS send", () => {
    let sql: ReturnType<typeof postgres>;
    const TEST_SUFFIX = Date.now().toString(36) + "e2e";
    const SHOP_ID = `shop-e2e-${TEST_SUFFIX}`;
    const SHOP_DOMAIN = `test-e2e-${TEST_SUFFIX}.myshopify.com`;
    const INVOICE_ID = `inv-e2e-${TEST_SUFFIX}`;
    const RULE_A_ID = `rule-e2e-a-${TEST_SUFFIX}`;
    const RULE_B_ID = `rule-e2e-b-${TEST_SUFFIX}`;
    const BUYER_ACCOUNT_ID = `acc-e2e-${TEST_SUFFIX}`;
    const CUSTOMER_ID = `gid://shopify/Customer/e2e-${TEST_SUFFIX}`;
    const OFFSET_DAYS = 0;

    let SHOP_TIMEZONE: string;
    let FIXED_MONTH_STR: string;
    let DUE_DATE_STR: string;

    const CANDIDATE_ZONES = [
      "Pacific/Auckland", "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata",
      "Asia/Dubai", "Europe/Moscow", "Europe/Berlin", "Europe/London",
      "Atlantic/Azores", "America/Sao_Paulo", "America/New_York",
      "America/Chicago", "America/Denver", "America/Los_Angeles",
      "Pacific/Honolulu",
    ];

    const mockFetch = vi.fn();

    beforeAll(async () => {
      vi.stubGlobal("fetch", mockFetch);
      sql = postgres(TEST_DATABASE_URL!, sqlOptions);

      const [pgNow] = await sql<{ now: Date }[]>`SELECT NOW() AS now`;

      let foundTz: string | null = null;
      for (const tz of CANDIDATE_ZONES) {
        const [hourRow] = await sql<{ h: number }[]>`
          SELECT EXTRACT(HOUR FROM (${pgNow.now}::TIMESTAMPTZ AT TIME ZONE ${tz}))::INT AS h
        `;
        if (hourRow.h >= 9 && hourRow.h <= 18) {
          foundTz = tz;
          break;
        }
      }
      if (!foundTz) {
        throw new Error(
          `No candidate timezone has local hour 09-18 at Postgres NOW(). ` +
          `This should not happen with the given candidate list.`
        );
      }
      SHOP_TIMEZONE = foundTz;

      const [dateRow] = await sql<{ d: string; m: string }[]>`
        SELECT 
          (${pgNow.now}::TIMESTAMPTZ AT TIME ZONE ${SHOP_TIMEZONE})::DATE::TEXT AS d,
          TO_CHAR(${pgNow.now}::TIMESTAMPTZ AT TIME ZONE ${SHOP_TIMEZONE}, 'YYYY-MM') AS m
      `;
      DUE_DATE_STR = dateRow.d;
      FIXED_MONTH_STR = dateRow.m;

      await sql`
        DELETE FROM s18_global_sends 
        WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
      `;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${SHOP_TIMEZONE}, 'free', NOW(), NOW())
      `;

      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_ID}, true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES
          (${RULE_A_ID}, ${SHOP_ID}, ${OFFSET_DAYS}, 'email'::"ReminderChannel", true, NOW(), NOW()),
          (${RULE_B_ID}, ${SHOP_ID}, ${OFFSET_DAYS}, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "creditLimit", "holdState", bypass, "manualHold",
          "defaultTermsDays", "defaultTermsSource", "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${BUYER_ACCOUNT_ID}, ${SHOP_ID}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID}, 'E2E Test Buyer',
          100000.00, 'OK', false, false, 30, 'explicit', false, 1, NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${SHOP_ID}, ${CUSTOMER_ID}, 'e2e-buyer@test-reminders.example', 'E2E Buyer', NOW())
        ON CONFLICT (shop_id, customer_id) DO NOTHING
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
      await sql`
        DELETE FROM s18_global_sends 
        WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
      `;
      vi.unstubAllGlobals();
      await sql.end();
    });

    beforeEach(async () => {
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
      await sql`
        DELETE FROM s18_global_sends 
        WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
      `;
      mockFetch.mockReset();
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "resend-e2e-id" }) });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("enqueue + send: 2 duplicate rules produce exactly 1 send and 1 sent row [fails on revert]", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "e2e-buyer@test-reminders.example",
      };

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${INVOICE_ID}, ${SHOP_ID}, ${BUYER_ACCOUNT_ID},
          'gid://shopify/Order/e2e-test', '#E2E-DUP', 10000.00, 10000.00,
          'open', NOW() - INTERVAL '5 days', ${DUE_DATE_STR}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: SHOP_TIMEZONE });
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ ruleId: string; invoiceId: string }[]>`
        SELECT message->>'ruleId' AS "ruleId", message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_SEND'
        ORDER BY msg_id ASC
      `;

      expect(messages.length).toBe(2);
      expect(messages.map(m => m.ruleId).sort()).toEqual([RULE_A_ID, RULE_B_ID].sort());

      for (const msg of messages) {
        await sendPaymentReminder(
          sql,
          SHOP_ID,
          msg.invoiceId,
          msg.ruleId,
          OFFSET_DAYS,
          SHOP_TIMEZONE,
          validEnv
        );
      }

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const logs = await sql<{ ruleId: string; status: string }[]>`
        SELECT "ruleId", status FROM "ReminderLog"
        WHERE "shopId" = ${SHOP_ID} AND "invoiceId" = ${INVOICE_ID}
      `;

      const sentLogs = logs.filter(l => l.status === "sent");
      expect(sentLogs.length).toBe(1);
    });

    it("sendCatchupReminder: skips when sibling already sent [fails on revert]", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "e2e-buyer@test-reminders.example",
      };

      const catchupInvoiceId = `inv-catchup-e2e-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${catchupInvoiceId}, ${SHOP_ID}, ${BUYER_ACCOUNT_ID},
          'gid://shopify/Order/catchup-e2e', '#CATCHUP-E2E', 10000.00, 10000.00,
          'open', NOW() - INTERVAL '5 days', ${DUE_DATE_STR}::DATE - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_A_ID}, ${catchupInvoiceId}, NOW() - INTERVAL '1 day', 'sent'::"ReminderLogStatus")
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_B_ID}, ${catchupInvoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: SHOP_TIMEZONE });
      vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      const result = await sendCatchupReminder(
        sql,
        SHOP_ID,
        catchupInvoiceId,
        RULE_B_ID,
        "log-id-placeholder",
        OFFSET_DAYS,
        SHOP_TIMEZONE,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Sibling rule already sent");

      expect(mockFetch).not.toHaveBeenCalled();

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${SHOP_ID} AND "invoiceId" = ${catchupInvoiceId} AND "ruleId" = ${RULE_B_ID}
      `;
      expect(log.status).toBe("skipped_daily_limit");
    });
  });
});
