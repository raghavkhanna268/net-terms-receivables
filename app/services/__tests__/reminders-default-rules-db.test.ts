/**
 * DB-backed integration tests for ensureDefaultReminderRules.
 *
 * Tests verify:
 * - (a) Migrated shop with 3 ReminderRule rows and NO settings row:
 *       after ensureDefaultReminderRules runs, still has exactly 3 rules,
 *       and a settings row now exists.
 * - (b) Fresh shop with no rules and no settings row gets exactly 3 rules
 *       (-3/0/+7) plus a settings row.
 * - (c) Running ensureDefaultReminderRules twice is idempotent: still 3 rules
 *       and 1 settings row.
 *
 * All tests fail on revert of the fix.
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
});
