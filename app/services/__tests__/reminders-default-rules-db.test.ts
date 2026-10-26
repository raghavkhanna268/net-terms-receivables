/**
 * DB-backed integration tests for ensureDefaultReminderRules.
 *
 * Tests verify:
 * - (a) Migrated shop with 3 ReminderRule rows and NO settings row:
 *       after ensureDefaultReminderRules runs, still has exactly 3 rules,
 *       and a settings row now exists. [fails on revert]
 * - (b) Fresh shop with no rules and no settings row gets exactly 3 rules
 *       (-3/0/+7) plus a settings row. [positive control]
 * - (c) Running ensureDefaultReminderRules twice is idempotent: still 3 rules
 *       and 1 settings row; migrated variant also stays at 3. [fails on revert]
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, name, "creditLimit", "holdState", bypass, "manualHold",
          "defaultTermsDays", "defaultTermsSource", "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${BUYER_ACCOUNT_ID}, ${SHOP_ID}, 'TAGGED_CUSTOMER', 'Test Buyer',
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
});
