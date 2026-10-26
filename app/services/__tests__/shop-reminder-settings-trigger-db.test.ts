/**
 * DB test for s18_shop_reminder_settings trigger fix.
 *
 * Verifies that UPDATE operations on s18_shop_reminder_settings succeed
 * and that updated_at advances on each update.
 *
 * Background: The original trigger used set_updated_at() which writes to
 * NEW."updatedAt" (camelCase), but the table uses snake_case column names.
 * This caused UPDATE statements to fail once a row existed.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { updateShopReminderSettings } from "../reminders.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("s18_shop_reminder_settings trigger", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-trigger";
  const TEST_SHOP_ID = `shop-trigger-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-trigger-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  afterEach(async () => {
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
  });

  it("updateShopReminderSettings succeeds on first call (INSERT)", async () => {
    await updateShopReminderSettings(sql, TEST_SHOP_ID, true);

    const [row] = await sql<{ enabled: boolean; updatedAt: Date }[]>`
      SELECT enabled, updated_at AS "updatedAt"
      FROM s18_shop_reminder_settings
      WHERE shop_id = ${TEST_SHOP_ID}
    `;

    expect(row).toBeDefined();
    expect(row.enabled).toBe(true);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  it("updateShopReminderSettings succeeds on second call (UPDATE) and updated_at advances", async () => {
    await updateShopReminderSettings(sql, TEST_SHOP_ID, true);

    const [firstRow] = await sql<{ enabled: boolean; updatedAt: Date }[]>`
      SELECT enabled, updated_at AS "updatedAt"
      FROM s18_shop_reminder_settings
      WHERE shop_id = ${TEST_SHOP_ID}
    `;
    expect(firstRow).toBeDefined();
    const firstUpdatedAt = firstRow.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 10));

    await updateShopReminderSettings(sql, TEST_SHOP_ID, false);

    const [secondRow] = await sql<{ enabled: boolean; updatedAt: Date }[]>`
      SELECT enabled, updated_at AS "updatedAt"
      FROM s18_shop_reminder_settings
      WHERE shop_id = ${TEST_SHOP_ID}
    `;
    expect(secondRow).toBeDefined();
    expect(secondRow.enabled).toBe(false);
    expect(secondRow.updatedAt.getTime()).toBeGreaterThan(firstUpdatedAt.getTime());
  });

  it("multiple consecutive updates all succeed with advancing timestamps", async () => {
    const timestamps: Date[] = [];

    await updateShopReminderSettings(sql, TEST_SHOP_ID, true);
    const [row1] = await sql<{ updatedAt: Date }[]>`
      SELECT updated_at AS "updatedAt" FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}
    `;
    timestamps.push(row1.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 10));

    await updateShopReminderSettings(sql, TEST_SHOP_ID, false);
    const [row2] = await sql<{ updatedAt: Date }[]>`
      SELECT updated_at AS "updatedAt" FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}
    `;
    timestamps.push(row2.updatedAt);

    await new Promise((resolve) => setTimeout(resolve, 10));

    await updateShopReminderSettings(sql, TEST_SHOP_ID, true);
    const [row3] = await sql<{ updatedAt: Date }[]>`
      SELECT updated_at AS "updatedAt" FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}
    `;
    timestamps.push(row3.updatedAt);

    expect(timestamps[1].getTime()).toBeGreaterThan(timestamps[0].getTime());
    expect(timestamps[2].getTime()).toBeGreaterThan(timestamps[1].getTime());
  });
});
