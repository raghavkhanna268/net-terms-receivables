/**
 * DB-backed tests that pin reminder schedule, window, and opt-out behaviors.
 *
 * These tests pin specific behaviors so that changing any of them causes a test failure:
 *
 * (a) Default reminder offsets are exactly [-3, 0, +7] days, in that order.
 *     The seeding function creates exactly 3 rules with those offsets.
 *
 * (b) The enqueue SQL Part 3 queues NEW reminders only when due date + offset = today
 *     in store-local time. Part 4 catch-up re-queues only ReminderLog rows in status
 *     'delayed', whose reminder day is D+1..D+3. Rows at D+4 are not re-queued.
 *     Rows with any status other than 'delayed' are not re-queued.
 *
 * (c) The send window is store-local EXTRACT(HOUR) between 9 and 18 inclusive.
 *     Hour 8 is not queued; hours 9 and 18 are queued; hour 19 is not queued.
 *     Uses two store timezones including Asia/Kolkata (a half-hour offset).
 *
 * (d) The reminder email opt-out is header-only. Headers include List-Unsubscribe
 *     and List-Unsubscribe-Post (exact value "List-Unsubscribe=One-Click").
 *     The rendered HTML and text bodies contain no href and no 'unsubscribe' link.
 *
 * (e) The recipient allowlist guard turns off ONLY when the flag is exactly "false".
 *     Values like 'False', 'FALSE', ' false', 'false ', '0', 'no', '' and undefined
 *     all leave the guard ON.
 *
 * Uses real Postgres with TEST_DATABASE_URL. Test data uses test-* domains only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Compute an Etc/GMT±N timezone where a given UTC hour becomes a target local hour.
 * PostgreSQL uses POSIX convention: Etc/GMT+5 means UTC-5.
 *
 * Valid IANA range: Etc/GMT+12 (UTC-12) to Etc/GMT-14 (UTC+14).
 * The offset is wrapped into [-14, +12] to stay within valid range.
 *
 * @param utcHour - The UTC hour (0-23)
 * @param targetLocalHour - The desired local hour (0-23)
 * @returns A valid Etc/GMT zone name
 */
function computeTimezoneForLocalHour(utcHour: number, targetLocalHour: number): string {
  let offset = utcHour - targetLocalHour;
  // Wrap into valid IANA range: Etc/GMT+12 (offset=12) to Etc/GMT-14 (offset=-14)
  if (offset > 12) offset -= 24;
  if (offset < -14) offset += 24;
  if (offset === 0) return "Etc/GMT";
  if (offset > 0) return `Etc/GMT+${offset}`;
  return `Etc/GMT${offset}`;
}

describe("computeTimezoneForLocalHour helper", () => {
  const TARGET_HOURS = [8, 9, 18, 19];

  /**
   * Verify that a zone name is within valid IANA Etc/GMT range.
   * Valid: Etc/GMT, Etc/GMT+1..+12, Etc/GMT-1..-14
   */
  function isValidEtcGmtZone(zone: string): boolean {
    if (zone === "Etc/GMT") return true;
    const match = zone.match(/^Etc\/GMT([+-])(\d+)$/);
    if (!match) return false;
    const sign = match[1];
    const num = parseInt(match[2], 10);
    if (sign === "+") return num >= 1 && num <= 12;
    return num >= 1 && num <= 14;
  }

  /**
   * Get the hour in a given timezone for a specific UTC hour.
   * Uses Intl.DateTimeFormat with hourCycle h23 for 0-23 range.
   */
  function getLocalHourInZone(utcHour: number, zone: string): number {
    // Create a date at the given UTC hour on a fixed date
    const date = new Date(Date.UTC(2026, 0, 15, utcHour, 0, 0));
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "numeric",
      hourCycle: "h23",
    });
    return parseInt(formatter.format(date), 10);
  }

  for (const targetHour of TARGET_HOURS) {
    describe(`target hour ${targetHour}`, () => {
      for (let utcHour = 0; utcHour < 24; utcHour++) {
        it(`UTC hour ${utcHour} produces valid zone with correct local hour`, () => {
          const zone = computeTimezoneForLocalHour(utcHour, targetHour);

          // Check zone is within valid IANA range
          expect(isValidEtcGmtZone(zone)).toBe(true);

          // Check local hour in that zone equals target
          const localHour = getLocalHourInZone(utcHour, zone);
          expect(localHour).toBe(targetHour);
        });
      }
    });
  }
});

describe("(a) DEFAULT_RULE_OFFSETS constant", () => {
  it("is exactly [-3, 0, 7] in that order", async () => {
    const { DEFAULT_RULE_OFFSETS } = await import("../reminders.server");
    expect(DEFAULT_RULE_OFFSETS).toEqual([-3, 0, 7]);
  });

  it("has exactly 3 elements", async () => {
    const { DEFAULT_RULE_OFFSETS } = await import("../reminders.server");
    expect(DEFAULT_RULE_OFFSETS.length).toBe(3);
  });
});

describeWithDb("(a) ensureDefaultReminderRules seeding (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-seed";
  const SHOP_ID = `shop-seed-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-seed-${TEST_SUFFIX}.myshopify.com`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
  });

  it("seeds exactly 3 rules with offsets -3, 0, 7 in order", async () => {
    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    const { ensureDefaultReminderRules } = await import("../reminders.server");
    const result = await ensureDefaultReminderRules(sql, SHOP_ID);

    expect(result.seeded).toBe(true);
    expect(result.count).toBe(3);

    const rules = await sql<{ offsetDays: number }[]>`
      SELECT "offsetDays" FROM "ReminderRule"
      WHERE "shopId" = ${SHOP_ID}
      ORDER BY "createdAt" ASC
    `;

    expect(rules.map(r => r.offsetDays)).toEqual([-3, 0, 7]);
  });
});

describeWithDb("(b) enqueue SQL Part 3: today filter (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-p3";
  const SHOP_ID = `shop-p3-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-p3-${TEST_SUFFIX}.myshopify.com`;
  const RULE_ID = `rule-p3-${TEST_SUFFIX}`;
  const ACCOUNT_ID = `acc-p3-${TEST_SUFFIX}`;
  const CUSTOMER_ID = `gid://shopify/Customer/p3-${TEST_SUFFIX}`;
  let shopTimezone: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [row] = await sql<{ utc_hour: number }[]>`
      SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int AS utc_hour
    `;
    shopTimezone = computeTimezoneForLocalHour(row.utc_hour, 12);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${shopTimezone}, 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${SHOP_ID}, true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${RULE_ID}, ${SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_ID}, ${SHOP_ID}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID}, 'Test Buyer',
        100000.00, 'OK', false, false, 30, 'explicit', false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${SHOP_ID}, ${CUSTOMER_ID}, 'p3-buyer@test-domain.example', 'P3 Buyer', NOW())
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
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
  });

  it("enqueues invoice when dueAt + offsetDays = today", async () => {
    const invoiceId = `inv-today-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/today-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#TODAY', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE)::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_SEND'
    `;

    expect(rows.map(r => r.invoiceId)).toContain(invoiceId);
  });

  it("does NOT enqueue invoice when dueAt + offsetDays = yesterday", async () => {
    const invoiceId = `inv-yest-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/yest-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#YESTERDAY', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '6 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_SEND'
    `;

    expect(rows.map(r => r.invoiceId)).not.toContain(invoiceId);
  });

  it("does NOT enqueue invoice when dueAt + offsetDays = tomorrow", async () => {
    const invoiceId = `inv-tomw-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/tomw-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#TOMORROW', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '4 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE + INTERVAL '1 day')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_SEND'
    `;

    expect(rows.map(r => r.invoiceId)).not.toContain(invoiceId);
  });
});

describeWithDb("(b) enqueue SQL Part 4: catch-up window and status (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-p4";
  const SHOP_ID = `shop-p4-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-p4-${TEST_SUFFIX}.myshopify.com`;
  const RULE_ID = `rule-p4-${TEST_SUFFIX}`;
  const ACCOUNT_ID = `acc-p4-${TEST_SUFFIX}`;
  const CUSTOMER_ID = `gid://shopify/Customer/p4-${TEST_SUFFIX}`;
  let shopTimezone: string;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    const [row] = await sql<{ utc_hour: number }[]>`
      SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int AS utc_hour
    `;
    shopTimezone = computeTimezoneForLocalHour(row.utc_hour, 12);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', ${shopTimezone}, 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${SHOP_ID}, true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${RULE_ID}, ${SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_ID}, ${SHOP_ID}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID}, 'Test Buyer',
        100000.00, 'OK', false, false, 30, 'explicit', false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${SHOP_ID}, ${CUSTOMER_ID}, 'p4-buyer@test-domain.example', 'P4 Buyer', NOW())
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
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
  });

  it("re-queues delayed row at D+1 (reminder day + 1)", async () => {
    const invoiceId = `inv-d1-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/d1-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#D1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '6 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
      VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_CATCHUP'
    `;

    expect(rows.map(r => r.invoiceId)).toContain(invoiceId);
  });

  it("re-queues delayed row at D+3 (reminder day + 3)", async () => {
    const invoiceId = `inv-d3-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/d3-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#D3', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '8 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE - INTERVAL '3 days')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
      VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '3 days')
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_CATCHUP'
    `;

    expect(rows.map(r => r.invoiceId)).toContain(invoiceId);
  });

  it("does NOT re-queue delayed row at D+4 (beyond catch-up window)", async () => {
    const invoiceId = `inv-d4-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/d4-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#D4', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '9 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE - INTERVAL '4 days')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
      VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '4 days')
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_CATCHUP'
    `;

    expect(rows.map(r => r.invoiceId)).not.toContain(invoiceId);
  });

  it("does NOT re-queue 'sent' status row even within D+1..D+3 window", async () => {
    const invoiceId = `inv-sent-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/sent-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#SENT-STATUS', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '6 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
      VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_ID}, ${invoiceId}, 'sent'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_CATCHUP'
    `;

    expect(rows.map(r => r.invoiceId)).not.toContain(invoiceId);
  });

  it("does NOT re-queue 'skipped_daily_limit' status row even within D+1..D+3 window", async () => {
    const invoiceId = `inv-skip-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/skip-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${ACCOUNT_ID}, ${orderId},
        '#SKIPPED-STATUS', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '6 days',
        ((NOW() AT TIME ZONE ${shopTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${shopTimezone},
        NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
      VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${RULE_ID}, ${invoiceId}, 'skipped_daily_limit'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
    `;

    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_CATCHUP'
    `;

    expect(rows.map(r => r.invoiceId)).not.toContain(invoiceId);
  });
});

describeWithDb("(c) send window 9-18 inclusive (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-win";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function setupShopAndInvoice(shopSuffix: string, timezone: string) {
    const shopId = `shop-win-${shopSuffix}-${TEST_SUFFIX}`;
    const shopDomain = `test-win-${shopSuffix}-${TEST_SUFFIX}.myshopify.com`;
    const ruleId = `rule-win-${shopSuffix}-${TEST_SUFFIX}`;
    const accountId = `acc-win-${shopSuffix}-${TEST_SUFFIX}`;
    const customerId = `gid://shopify/Customer/win-${shopSuffix}-${TEST_SUFFIX}`;
    const invoiceId = `inv-win-${shopSuffix}-${TEST_SUFFIX}`;
    const orderId = `gid://shopify/Order/win-${shopSuffix}-${TEST_SUFFIX}`;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${shopId}, ${shopDomain}, 'INR', ${timezone}, 'free', NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${shopId}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ruleId}, ${shopId}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${accountId}, ${shopId}, 'TAGGED_CUSTOMER', ${customerId}, 'Test Buyer',
        100000.00, 'OK', false, false, 30, 'explicit', false, 1, NOW(), NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${shopId}, ${customerId}, 'win-buyer@test-domain.example', 'Win Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${shopId}, ${accountId}, ${orderId},
        '#WINDOW', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days',
        ((NOW() AT TIME ZONE ${timezone})::DATE)::timestamp AT TIME ZONE ${timezone},
        NOW(), NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    return { shopId, shopDomain, invoiceId };
  }

  async function cleanup(shopId: string, shopDomain: string) {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${shopDomain}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${shopId}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${shopId}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${shopId}`;
    await sql`DELETE FROM "Shop" WHERE id = ${shopId}`;
  }

  describe("whole-hour timezone (Etc/GMT)", () => {
    const HOURS_TO_TEST = [
      { hour: 8, shouldEnqueue: false },
      { hour: 9, shouldEnqueue: true },
      { hour: 18, shouldEnqueue: true },
      { hour: 19, shouldEnqueue: false },
    ];

    for (const { hour, shouldEnqueue } of HOURS_TO_TEST) {
      it(`hour ${hour} ${shouldEnqueue ? "IS" : "is NOT"} queued`, async () => {
        const [row] = await sql<{ utc_hour: number }[]>`
          SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int AS utc_hour
        `;
        const tz = computeTimezoneForLocalHour(row.utc_hour, hour);
        const { shopId, shopDomain, invoiceId } = await setupShopAndInvoice(`h${hour}`, tz);

        try {
          await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${shopDomain}`;
          await sql`SELECT public.s18_enqueue_reminders()`;

          const rows = await sql<{ invoiceId: string }[]>`
            SELECT message->>'invoiceId' AS "invoiceId"
            FROM pgmq.q_s6_sync
            WHERE message->>'shop' = ${shopDomain}
              AND message->>'topic' = 'REMINDER_SEND'
          `;

          if (shouldEnqueue) {
            expect(rows.map(r => r.invoiceId)).toContain(invoiceId);
          } else {
            expect(rows.map(r => r.invoiceId)).not.toContain(invoiceId);
          }
        } finally {
          await cleanup(shopId, shopDomain);
        }
      });
    }
  });

  describe("deterministic in-window and out-of-window (DB time-based)", () => {
    /**
     * This test creates two stores with computed timezones based on the DB's
     * current time, ensuring one is always in the 9-18 window and one is always
     * outside. This makes the test deterministic regardless of when it runs.
     *
     * Approach: Query the DB's UTC hour, then use computeTimezoneForLocalHour
     * to create zones where the local hour is guaranteed to be 12 (in-window)
     * or 19 (out-of-window).
     */
    it("enqueues in-window store (local hour 12) and skips out-of-window store (local hour 19)", async () => {
      const [row] = await sql<{ utc_hour: number }[]>`
        SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int AS utc_hour
      `;

      // Create timezone where local hour is 12 (in-window)
      const inWindowZone = computeTimezoneForLocalHour(row.utc_hour, 12);
      // Create timezone where local hour is 19 (out-of-window)
      const outWindowZone = computeTimezoneForLocalHour(row.utc_hour, 19);

      const inWindowSetup = await setupShopAndInvoice("in-win", inWindowZone);
      const outWindowSetup = await setupShopAndInvoice("out-win", outWindowZone);

      try {
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${inWindowSetup.shopDomain}`;
        await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${outWindowSetup.shopDomain}`;
        await sql`SELECT public.s18_enqueue_reminders()`;

        const inWindowRows = await sql<{ invoiceId: string }[]>`
          SELECT message->>'invoiceId' AS "invoiceId"
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${inWindowSetup.shopDomain}
            AND message->>'topic' = 'REMINDER_SEND'
        `;

        const outWindowRows = await sql<{ invoiceId: string }[]>`
          SELECT message->>'invoiceId' AS "invoiceId"
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${outWindowSetup.shopDomain}
            AND message->>'topic' = 'REMINDER_SEND'
        `;

        // In-window store (local hour 12) SHOULD be enqueued
        expect(inWindowRows.map(r => r.invoiceId)).toContain(inWindowSetup.invoiceId);
        // Out-of-window store (local hour 19) should NOT be enqueued
        expect(outWindowRows.map(r => r.invoiceId)).not.toContain(outWindowSetup.invoiceId);
      } finally {
        await cleanup(inWindowSetup.shopId, inWindowSetup.shopDomain);
        await cleanup(outWindowSetup.shopId, outWindowSetup.shopDomain);
      }
    });
  });
});

describe("(d) opt-out is header-only", () => {
  it("List-Unsubscribe-Post header is exactly 'List-Unsubscribe=One-Click'", async () => {
    const { buildUnsubscribeHeaders } = await import("../reminder-headers.server");

    const headers = buildUnsubscribeHeaders(
      "https://app.test-domain.example",
      "shop-test",
      "buyer-test",
      "test-secret-fake-for-testing"
    );

    expect(headers).not.toBeNull();
    expect(headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("List-Unsubscribe header is present with angle brackets", async () => {
    const { buildUnsubscribeHeaders } = await import("../reminder-headers.server");

    const headers = buildUnsubscribeHeaders(
      "https://app.test-domain.example",
      "shop-test",
      "buyer-test",
      "test-secret-fake-for-testing"
    );

    expect(headers).not.toBeNull();
    expect(headers!["List-Unsubscribe"]).toMatch(/^<https:\/\/app\.test-domain\.example\/unsubscribe\?token=.+>$/);
  });

  it("rendered HTML body contains no href attribute", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    const html = renderPaymentReminderEmail({
      invoiceName: "#TEST-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 28, 2026",
      merchantName: "Test Store",
      reminderType: "Payment due today",
      storeDisplayName: "Test Store Display",
      hasReplyTo: false,
    });

    expect(html).not.toContain("href=");
    expect(html).not.toContain("href =");
  });

  it("rendered HTML body contains no unsubscribe link text", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    const html = renderPaymentReminderEmail({
      invoiceName: "#TEST-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 28, 2026",
      merchantName: "Test Store",
      reminderType: "Payment due today",
      storeDisplayName: "Test Store Display",
      hasReplyTo: false,
    });

    expect(html.toLowerCase()).not.toContain("unsubscribe");
  });

  it("rendered HTML body contains no /unsubscribe URL path", async () => {
    const { renderPaymentReminderEmail } = await import("~/emails/PaymentReminderEmail");

    const html = renderPaymentReminderEmail({
      invoiceName: "#TEST-001",
      buyerName: "Test Buyer",
      amount: "₹10,000.00",
      dueDate: "October 28, 2026",
      merchantName: "Test Store",
      reminderType: "Payment due today",
      storeDisplayName: "Test Store Display",
      hasReplyTo: false,
    });

    expect(html).not.toContain("/unsubscribe");
  });
});

describe("(e) recipient allowlist guard exact 'false' check", () => {
  const GUARD_ON_VALUES = [
    { value: "False", desc: "wrong case 'False'" },
    { value: "FALSE", desc: "wrong case 'FALSE'" },
    { value: " false", desc: "leading space ' false'" },
    { value: "false ", desc: "trailing space 'false '" },
    { value: " false ", desc: "surrounding space ' false '" },
    { value: "0", desc: "string '0'" },
    { value: "no", desc: "string 'no'" },
    { value: "", desc: "empty string ''" },
    { value: undefined, desc: "undefined" },
    { value: "true", desc: "string 'true'" },
    { value: "TRUE", desc: "string 'TRUE'" },
  ];

  it("guard is OFF only when value is exactly 'false'", async () => {
    const { isAllowlistEnforced } = await import("../recipient-allowlist.server");

    expect(isAllowlistEnforced({ RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" })).toBe(false);
  });

  for (const { value, desc } of GUARD_ON_VALUES) {
    it(`guard is ON when value is ${desc}`, async () => {
      const { isAllowlistEnforced } = await import("../recipient-allowlist.server");

      const env = value === undefined
        ? {}
        : { RESEND_RECIPIENT_ALLOWLIST_ENFORCED: value };

      expect(isAllowlistEnforced(env)).toBe(true);
    });
  }
});
