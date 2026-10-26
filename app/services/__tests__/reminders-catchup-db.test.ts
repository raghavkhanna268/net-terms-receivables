/**
 * DB-backed integration tests for S18 reminder catch-up behavior (#230).
 *
 * Tests verify:
 * - Cap boundary: capped reminders are stored as 'delayed' not deleted
 * - Oldest-first ordering in catch-up
 * - Stage collapse: latest stage wins, older stages become skipped_daily_limit
 * - Payment mid-window: delayed row deleted silently when eligibility fails
 * - Expiry after D+3: delayed rows become skipped_daily_limit
 * - At most one per invoice per day
 * - Migration backfill: existing rows remain status='sent'
 *
 * Uses real Postgres. Test domains are test-* only. No real customer data.
 *
 * TIMEZONE TESTING:
 * ONE CLOCK = THE DB CLOCK. Tests read NOW() from Postgres, then sync the JS
 * clock to it with vi.setSystemTime(). All date values (dueAt, issuedAt, cap
 * dates, sentAt) are derived from that same DB instant. The shop timezone is
 * computed so the DB's local hour is ~12 (inside the 09-18 send window).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { DateTime } from "luxon";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * Compute a fixed-offset Etc/GMT±N timezone where the DB's current local hour is ~12.
 * Uses the provided DB instant as the clock source so the timezone choice aligns with
 * the business-hour check in s18_enqueue_reminders() which also uses NOW().
 * PostgreSQL uses POSIX convention where Etc/GMT+5 means UTC-5 (opposite of ISO).
 */
function computeTestTimezone(dbNow: Date): string {
  const utcHour = dbNow.getUTCHours();
  const offsetToMakeNoon = utcHour - 12;
  if (offsetToMakeNoon === 0) {
    return "Etc/GMT";
  } else if (offsetToMakeNoon > 0) {
    return `Etc/GMT+${offsetToMakeNoon}`;
  } else {
    return `Etc/GMT${offsetToMakeNoon}`;
  }
}

/**
 * Helper to compute dates relative to a DB instant.
 * Computes dates in the test timezone (for dueAt, issuedAt) and UTC (for cap rows).
 * @param dbNow - The DB's NOW() instant
 * @param testTimezone - The computed test timezone (Etc/GMT±N)
 */
function computeDatesFromDbNow(dbNow: Date, testTimezone: string) {
  const utcDt = DateTime.fromJSDate(dbNow, { zone: "UTC" });
  const localDt = DateTime.fromJSDate(dbNow, { zone: testTimezone });
  const utcDateStr = utcDt.toISODate()!;
  const localDateStr = localDt.toISODate()!;
  const localNoon = localDt.set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  return {
    dbNow,
    todayLocal: localDateStr,
    todayUTC: utcDateStr,
    todayLocalNoon: localNoon.toJSDate(),
    monthStrLocal: localDateStr.substring(0, 7),
    monthStrUTC: utcDateStr.substring(0, 7),
    daysAgo: (n: number) => localNoon.minus({ days: n }).toJSDate(),
    hoursAgo: (n: number) => localNoon.minus({ hours: n }).toJSDate(),
  };
}

/**
 * Read NOW() from the database and sync JS clock to it.
 * Returns the DB instant and computed test timezone.
 */
async function syncClockToDb(sql: ReturnType<typeof postgres>) {
  const [row] = await sql<{ now: Date }[]>`SELECT NOW() AS now`;
  const dbNow = row.now;
  const testTimezone = computeTestTimezone(dbNow);
  vi.setSystemTime(dbNow);
  return { dbNow, testTimezone };
}

describeWithDb("S18 reminder catch-up behavior (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  let testTimezone: string;
  let dbNow: Date;
  const TEST_SUFFIX = Date.now().toString(36) + "-catchup";
  const TEST_SHOP_ID = `shop-catchup-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-catchup-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-catchup-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/catchup-${TEST_SUFFIX}`;
  const TEST_RULE_ID_1 = `rule-catchup-1-${TEST_SUFFIX}`;
  const TEST_RULE_ID_2 = `rule-catchup-2-${TEST_SUFFIX}`;
  const TEST_RULE_ID_3 = `rule-catchup-3-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Read DB clock once for setup, compute timezone
    const sync = await syncClockToDb(sql);
    dbNow = sync.dbNow;
    testTimezone = sync.testTimezone;
    const dates = computeDatesFromDbNow(dbNow, testTimezone);

    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${dates.monthStrUTC}
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', ${testTimezone}, 'free', NOW(), NOW())
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
        'Catchup Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'catchup-buyer@test-reminders.example', 'Catchup Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES 
        (${TEST_RULE_ID_1}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW()),
        (${TEST_RULE_ID_2}, ${TEST_SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW()),
        (${TEST_RULE_ID_3}, ${TEST_SHOP_ID}, 14, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    const dates = computeDatesFromDbNow(dbNow, testTimezone);
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${dates.monthStrUTC}
    `;

    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

    await assertNoQueueLeftovers(sql, [TEST_SHOP_DOMAIN], "reminders-catchup-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Re-sync JS clock to DB clock before each test
    const sync = await syncClockToDb(sql);
    dbNow = sync.dbNow;
    // testTimezone stays the same (computed in beforeAll)

    const dates = computeDatesFromDbNow(dbNow, testTimezone);
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockFetch.mockReset();
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${dates.monthStrUTC}
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("cap boundary - delayed instead of deleted", () => {
    it("upserts as delayed when daily cap is reached", async () => {
      const { sendPaymentReminder, DAILY_SEND_CAP } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-cap-delayed-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/cap-delayed-${TEST_SUFFIX}`;

      // Invoice dueAt is TODAY in shop timezone (so offsetDays=0 fires today)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CAP-DELAYED', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.todayLocalNoon}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // Cap row uses UTC date (product's reserveGlobalSendSlot uses date.toISOString().split('T')[0])
      await sql`
        INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
        VALUES ('global', ${dates.todayUTC}::DATE, ${dates.monthStrUTC}, ${DAILY_SEND_CAP}, 0, ${dates.dbNow})
        ON CONFLICT (send_key, send_date) DO UPDATE SET daily_count = ${DAILY_SEND_CAP}
      `;

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("capped");

      const [log] = await sql<{ status: string; firstCappedAt: Date | null; sentAt: Date | null }[]>`
        SELECT status, "firstCappedAt", "sentAt"
        FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;

      expect(log).toBeDefined();
      expect(log.status).toBe("delayed");
      expect(log.firstCappedAt).not.toBeNull();
      expect(log.sentAt).toBeNull();
    });
  });

  describe("stage collapse - latest stage wins", () => {
    it("older delayed stages become skipped when later stage exists", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-stage-collapse-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/stage-collapse-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#STAGE-COLLAPSE', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(15)}, ${dates.daysAgo(14)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_3}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.dbNow})
      `;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const logs = await sql<{ ruleId: string; offsetDays: number; status: string }[]>`
        SELECT rl."ruleId", r."offsetDays", rl.status
        FROM "ReminderLog" rl
        INNER JOIN "ReminderRule" r ON r.id = rl."ruleId"
        WHERE rl."invoiceId" = ${invoiceId}
        ORDER BY r."offsetDays" ASC
      `;

      expect(logs.length).toBe(3);
      
      const offset0Log = logs.find(l => l.offsetDays === 0);
      const offset7Log = logs.find(l => l.offsetDays === 7);
      const offset14Log = logs.find(l => l.offsetDays === 14);

      expect(offset0Log?.status).toBe("skipped_daily_limit");
      expect(offset7Log?.status).toBe("skipped_daily_limit");
      expect(offset14Log?.status).toBe("delayed");
    });

    it("older delayed stage skipped when newer stage is already sent", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-sent-newer-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/sent-newer-${TEST_SUFFIX}`;
      const logIdDelayed = `log-old-delayed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#SENT-NEWER', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(3)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // Older stage (offsetDays=0) is delayed from 2 days ago
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdDelayed}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      // Newer stage (offsetDays=7) was already sent yesterday
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId}, 'sent'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      const result = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logIdDelayed,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Newer stage exists");

      // Verify the older delayed stage is now skipped_daily_limit
      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE id = ${logIdDelayed}
      `;
      expect(log.status).toBe("skipped_daily_limit");
    });
  });

  describe("payment mid-window - delayed row deleted silently", () => {
    it("deletes delayed row when invoice is paid before catch-up", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-paid-mid-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/paid-mid-${TEST_SUFFIX}`;
      const logId = `log-paid-mid-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#PAID-MID', 10000.00, 0.00, 'paid',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      const result = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("paid");

      const [log] = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;

      expect(log).toBeUndefined();
    });
  });

  describe("expiry after D+3 - becomes skipped_daily_limit", () => {
    it("marks delayed rows past D+3 as skipped_daily_limit", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-expired-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/expired-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#EXPIRED', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(10)}, ${dates.daysAgo(5)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(5)})
      `;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;

      expect(log.status).toBe("skipped_daily_limit");
    });
  });

  describe("at most one per invoice per day", () => {
    it("skips catch-up when invoice already has sent reminder today", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-one-per-day-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/one-per-day-${TEST_SUFFIX}`;
      const logIdDelayed = `log-delayed-opd-${TEST_SUFFIX}`;
      const logIdSent = `log-sent-opd-${TEST_SUFFIX}`;
      const ruleId3 = `rule-catch-opd-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleId3}, ${TEST_SHOP_ID}, 14, 'email'::"ReminderChannel", true, ${dates.dbNow}, ${dates.dbNow})
      `;

      // Invoice due 15 days ago. With offsetDays=14, reminder was due 1 day ago (D+1 is in catch-up window).
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ONE-PER-DAY', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(20)}, ${dates.daysAgo(15)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // Create delayed log for rule 3 (offsetDays=14) - this has the highest offsetDays, so no "newer stage"
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdDelayed}, ${TEST_SHOP_ID}, ${ruleId3}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      // Rule 1 (offsetDays=0) was sent TODAY - this should block the catch-up (one per invoice per day)
      // Use DB NOW() for sentAt so it matches hasReminderSentToday SQL check
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (${logIdSent}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'sent'::"ReminderLogStatus", NOW())
      `;

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          ruleId3,
          logIdDelayed,
          14,
          testTimezone,
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("already sent today");
      } finally {
        await sql`DELETE FROM "ReminderLog" WHERE "ruleId" = ${ruleId3}`;
        await sql`DELETE FROM "ReminderRule" WHERE id = ${ruleId3}`;
      }
    });

    it("REMINDER_SEND skips when another stage already sent today", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-concurrent-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/concurrent-${TEST_SUFFIX}`;

      // Invoice due today, so offsetDays=0 is due TODAY
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CONCURRENT', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.todayLocalNoon}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-concurrent" }) });

      // First: REMINDER_SEND for offsetDays=0 (due today)
      const sendResult1 = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        0,
        testTimezone,
        validEnv
      );
      expect(sendResult1.action).toBe("sent");

      // Second: REMINDER_SEND for same invoice, same rule (idempotent)
      const sendResult2 = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        0,
        testTimezone,
        validEnv
      );

      expect(sendResult2.success).toBe(true);
      expect(sendResult2.action).toBe("skipped");
      expect(sendResult2.skipReason).toContain("already sent");

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("duplicate catch-up messages", () => {
    it("second catch-up message skips when first already sent", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-dup-catchup-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/dup-catchup-${TEST_SUFFIX}`;
      const logId = `log-dup-catchup-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#DUP-CATCHUP', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-dup" }) });

      // First catch-up sends
      const result1 = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        testTimezone,
        validEnv
      );
      expect(result1.action).toBe("sent");

      // Second catch-up message (duplicate from hourly enqueue) skips
      const result2 = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        testTimezone,
        validEnv
      );

      expect(result2.success).toBe(true);
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("not in delayed state");

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("oldest-first ordering", () => {
    it("enqueues catch-up messages oldest reminder date first", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId1 = `inv-oldest-1-${TEST_SUFFIX}`;
      const invoiceId2 = `inv-oldest-2-${TEST_SUFFIX}`;
      const orderId1 = `gid://shopify/Order/oldest-1-${TEST_SUFFIX}`;
      const orderId2 = `gid://shopify/Order/oldest-2-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceId1}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId1},
           '#OLDEST-1', 10000.00, 10000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(3)}, ${dates.dbNow}, ${dates.dbNow}),
          (${invoiceId2}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId2},
           '#OLDEST-2', 10000.00, 10000.00, 'open',
           ${dates.daysAgo(7)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId1}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(3)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId2}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_CATCHUP'
        ORDER BY msg_id ASC
      `;

      expect(messages.length).toBe(2);
      expect(messages[0].invoiceId).toBe(invoiceId1);
      expect(messages[1].invoiceId).toBe(invoiceId2);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });
  });

  describe("migration backfill", () => {
    it("existing rows stay status=sent after migration", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceIdPre = `inv-pre-migration-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/pre-migration-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceIdPre}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#PRE-MIGRATION', 10000.00, 0.00, 'paid',
          ${dates.daysAgo(30)}, ${dates.daysAgo(25)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdPre}, 'sent'::"ReminderLogStatus", ${dates.daysAgo(25)})
      `;

      const [log] = await sql<{ status: string; sentAt: Date | null; firstCappedAt: Date | null }[]>`
        SELECT status, "sentAt", "firstCappedAt"
        FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceIdPre}
      `;

      expect(log.status).toBe("sent");
      expect(log.sentAt).not.toBeNull();
      expect(log.firstCappedAt).toBeNull();
    });

    it("verifies CHECK constraints hold for sent status", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-check-sent-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/check-sent-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CHECK-SENT', 10000.00, 0.00, 'paid',
          ${dates.daysAgo(10)}, ${dates.daysAgo(5)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // status='sent' with sentAt=NULL should fail
      await expect(
        sql`
          INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
          VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'sent'::"ReminderLogStatus", NULL, NULL)
        `
      ).rejects.toThrow();

      // status='sent' with sentAt AND firstCappedAt is VALID (sent late = was delayed, then sent)
      const result = await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'sent'::"ReminderLogStatus", NOW(), NOW())
        RETURNING id
      `;
      expect(result.length).toBe(1);
    });

    it("verifies CHECK constraints hold for delayed status", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-check-delayed-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/check-delayed-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CHECK-DELAYED', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.todayLocalNoon}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await expect(
        sql`
          INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
          VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW(), NOW())
        `
      ).rejects.toThrow();

      const result = await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt", "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NULL, NOW())
        RETURNING id
      `;
      expect(result.length).toBe(1);
    });
  });

  describe("partly paid invoice - sends with outstanding balance", () => {
    it("sends reminder for partly paid invoice (outstanding > 0)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-partly-paid-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/partly-paid-${TEST_SUFFIX}`;

      // Invoice with total=10000 but outstanding=3000 (partly paid)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#PARTLY-PAID', 10000.00, 3000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.todayLocalNoon}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-partly-paid" }) });

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;
      expect(log.status).toBe("sent");
    });

    it("skips invoice when outstanding is zero", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-zero-outstanding-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/zero-outstanding-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ZERO-OUTSTANDING', 10000.00, 0.00, 'open',
          ${dates.daysAgo(5)}, ${dates.todayLocalNoon}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("outstanding is zero");

      expect(mockFetch).not.toHaveBeenCalled();

      const logs = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;
      expect(logs.length).toBe(0);
    });
  });

  describe("delayed-to-sent transition preserves firstCappedAt", () => {
    it("markDelayedAsSent keeps firstCappedAt for 'sent late' tracking", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-sent-late-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/sent-late-${TEST_SUFFIX}`;
      const logId = `log-sent-late-${TEST_SUFFIX}`;
      const firstCappedAtTime = dates.daysAgo(1);

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#SENT-LATE', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${firstCappedAtTime})
      `;

      const [before] = await sql<{ firstCappedAt: Date | null }[]>`
        SELECT "firstCappedAt" FROM "ReminderLog" WHERE id = ${logId}
      `;
      expect(before.firstCappedAt).not.toBeNull();

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-sent-late" }) });

      const result = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");

      const [after] = await sql<{ status: string; sentAt: Date | null; firstCappedAt: Date | null }[]>`
        SELECT status, "sentAt", "firstCappedAt" FROM "ReminderLog" WHERE id = ${logId}
      `;
      expect(after.status).toBe("sent");
      expect(after.sentAt).not.toBeNull();
      expect(after.firstCappedAt).not.toBeNull();
    });
  });

  describe("one reminder per invoice per day - newer stage wins", () => {
    it("stage 1 delayed becomes skipped when stage 2 is due today, only stage 2 sends", async () => {
      const { sendPaymentReminder, sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-newer-stage-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/newer-stage-${TEST_SUFFIX}`;
      const logIdStage1 = `log-stage1-${TEST_SUFFIX}`;

      // Create invoice due 7 days ago:
      // - stage 1 (offset 0) was due 7 days ago -> delayed row exists
      // - stage 2 (offset 7) is due TODAY
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#NEWER-STAGE', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(14)}, ${dates.daysAgo(7)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdStage1}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(7)})
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-stage2" }) });

      // First, try catch-up for stage 1 - should be skipped (newer stage due today)
      const resultCatchup = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logIdStage1,
        0,
        testTimezone,
        validEnv
      );
      expect(resultCatchup.success).toBe(true);
      expect(resultCatchup.action).toBe("skipped");

      // Now send stage 2 (offset 7, due today)
      const resultSend = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_2,
        7,
        testTimezone,
        validEnv
      );
      expect(resultSend.success).toBe(true);
      expect(resultSend.action).toBe("sent");

      expect(mockFetch).toHaveBeenCalledTimes(1);

      const logs = await sql<{ ruleId: string; status: string }[]>`
        SELECT "ruleId", status FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId}
        ORDER BY "ruleId"
      `;

      const stage1Log = logs.find(l => l.ruleId === TEST_RULE_ID_1);
      expect(stage1Log).toBeDefined();
      expect(stage1Log!.status).toBe("skipped_daily_limit");

      const stage2Log = logs.find(l => l.ruleId === TEST_RULE_ID_2);
      expect(stage2Log).toBeDefined();
      expect(stage2Log!.status).toBe("sent");
    });
  });

  describe("SQL-level enqueue behavior", () => {
    it("Part 2.5: marks delayed as skipped when newer stage is due today", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-part25-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/part25-${TEST_SUFFIX}`;

      // Invoice due 7 days ago in shop timezone:
      // - Rule 1 (offsetDays=0): reminder date = 7 days ago (outside D+3 catch-up window)
      // - Rule 2 (offsetDays=7): reminder date = 7 days ago + 7 = today
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#PART25', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(10)},
          ${dates.daysAgo(7)},
          ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // Rule 1 (offsetDays=0) is delayed from yesterday
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;

      expect(log.status).toBe("skipped_daily_limit");

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });

    it("Part 4: excludes invoices with any stage due today from catch-up", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-part4-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/part4-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#PART4', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(14)},
          ${dates.daysAgo(7)},
          ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(7)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const catchupMessages = await sql<{ topic: string }[]>`
        SELECT message->>'topic' AS topic
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
          AND message->>'topic' = 'REMINDER_CATCHUP'
      `;

      expect(catchupMessages.length).toBe(0);

      const newMessages = await sql<{ topic: string }[]>`
        SELECT message->>'topic' AS topic
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
          AND message->>'topic' = 'REMINDER_SEND'
      `;

      expect(newMessages.length).toBe(1);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });

    it("backfill: newly delayed row has firstCappedAt for 'sent late' tracking", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-backfill-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/backfill-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#BACKFILL', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.todayLocalNoon}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      const { upsertDelayedReminder } = await import("../reminders.server");

      await upsertDelayedReminder(sql, TEST_SHOP_ID, TEST_RULE_ID_1, invoiceId);

      const [log] = await sql<{ status: string; firstCappedAt: Date | null; sentAt: Date | null }[]>`
        SELECT status, "firstCappedAt", "sentAt"
        FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;

      expect(log.status).toBe("delayed");
      expect(log.firstCappedAt).not.toBeNull();
      expect(log.sentAt).toBeNull();
    });
  });

  describe("auth error logging", () => {
    it("logs reminders_catchup_auth_error on 401 response", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_invalid", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-auth-error-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/auth-error-${TEST_SUFFIX}`;
      const logId = `log-auth-error-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#AUTH-ERROR', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "Invalid API key",
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          validEnv
        );

        expect(result.success).toBe(false);
        expect(result.errorCode).toBe("resend_auth_error");
        expect(result.retryable).toBe(false);

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining("reminders_catchup_auth_error")
        );
      } finally {
        consoleSpy.mockRestore();
      }
    });
  });

  describe("PLAN_GATING_ENFORCED flag for catch-up", () => {
    const TEST_GATED_ACCOUNT_ID = `acc-gated-catchup-${TEST_SUFFIX}`;
    const TEST_GATED_CUSTOMER_ID = `gid://shopify/Customer/gated-catchup-${TEST_SUFFIX}`;

    beforeAll(async () => {
      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
        )
        VALUES (
          ${TEST_GATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
          NULL, NULL, ${TEST_GATED_CUSTOMER_ID},
          'Gated Catchup Account', 100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NOW(), NOW(), NOW()
        )
        ON CONFLICT DO NOTHING
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${TEST_SHOP_ID}, ${TEST_GATED_CUSTOMER_ID}, 'gated-catchup@test-reminders.example', 'Gated Catchup', NOW())
        ON CONFLICT (shop_id, customer_id) DO UPDATE SET email = 'gated-catchup@test-reminders.example'
      `;
    });

    afterAll(async () => {
      await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
      await sql`DELETE FROM "Invoice" WHERE "buyerAccountId" = ${TEST_GATED_ACCOUNT_ID}`;
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID} AND customer_id = ${TEST_GATED_CUSTOMER_ID}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${TEST_GATED_ACCOUNT_ID}`;
    });

    it("flag=false: catch-up sends to gated account", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "gated-catchup@test-reminders.example" };
      const originalEnv = process.env.PLAN_GATING_ENFORCED;

      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-catchup-gated-send-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/catchup-gated-send-${TEST_SUFFIX}`;
      const logId = `log-catchup-gated-send-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#CATCHUP-GATED-SEND', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-catchup-gated" }) });

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");
        expect(mockFetch).toHaveBeenCalled();
      } finally {
        (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
      }
    });

    it("flag=true: catch-up skips gated account", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };
      const originalEnv = process.env.PLAN_GATING_ENFORCED;

      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-catchup-gated-skip-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/catchup-gated-skip-${TEST_SUFFIX}`;
      const logId = `log-catchup-gated-skip-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_GATED_ACCOUNT_ID}, ${orderId},
          '#CATCHUP-GATED-SKIP', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      mockFetch.mockReset();

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("gated");
        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(log).toBeUndefined();
      } finally {
        (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
      }
    });
  });

  describe("recipient allowlist enforcement on catch-up", () => {
    it("skips with success=true when recipient not in allowlist, keeps delayed row, no cap consumed", async () => {
      const { sendCatchupReminder, getGlobalSendCounts } = await import("../reminders.server");
      const envWithAllowlist = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-allowlist-skip-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/allowlist-skip-${TEST_SUFFIX}`;
      const logId = `log-allowlist-skip-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ALLOWLIST-SKIP', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: testTimezone });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      const countsBefore = await getGlobalSendCounts(sql);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          envWithAllowlist
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("allowlist");
        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(log.status).toBe("delayed");

        const countsAfter = await getGlobalSendCounts(sql);
        expect(countsAfter.daily).toBe(countsBefore.daily);
        expect(countsAfter.monthly).toBe(countsBefore.monthly);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("skips with success=true when allowlist is empty, keeps delayed row, no cap consumed", async () => {
      const { sendCatchupReminder, getGlobalSendCounts } = await import("../reminders.server");
      const envEmptyAllowlist = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "",
      };

      const invoiceId = `inv-empty-allowlist-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/empty-allowlist-${TEST_SUFFIX}`;
      const logId = `log-empty-allowlist-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#EMPTY-ALLOWLIST', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: testTimezone });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      const countsBefore = await getGlobalSendCounts(sql);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          envEmptyAllowlist
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("allowlist");
        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(log.status).toBe("delayed");

        const countsAfter = await getGlobalSendCounts(sql);
        expect(countsAfter.daily).toBe(countsBefore.daily);
        expect(countsAfter.monthly).toBe(countsBefore.monthly);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("skips with success=true when allowlist env var is absent (undefined), keeps delayed row, no cap consumed", async () => {
      // Make test hermetic: ensure process.env.RESEND_TEST_RECIPIENTS is unset
      // so the ?? process.env fallback in sendCatchupReminder sees undefined
      vi.stubEnv("RESEND_TEST_RECIPIENTS", "");
      const originalEnvValue = process.env.RESEND_TEST_RECIPIENTS;
      delete process.env.RESEND_TEST_RECIPIENTS;

      const { sendCatchupReminder, getGlobalSendCounts } = await import("../reminders.server");
      const envUnsetAllowlist = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: undefined,
      };

      const invoiceId = `inv-unset-allowlist-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/unset-allowlist-${TEST_SUFFIX}`;
      const logId = `log-unset-allowlist-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#UNSET-ALLOWLIST', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: testTimezone });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      const countsBefore = await getGlobalSendCounts(sql);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          envUnsetAllowlist
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("allowlist");
        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(log.status).toBe("delayed");

        const countsAfter = await getGlobalSendCounts(sql);
        expect(countsAfter.daily).toBe(countsBefore.daily);
        expect(countsAfter.monthly).toBe(countsBefore.monthly);
      } finally {
        luxonSpy.mockRestore();
        // Restore process.env
        if (originalEnvValue !== undefined) {
          process.env.RESEND_TEST_RECIPIENTS = originalEnvValue;
        }
        vi.unstubAllEnvs();
      }
    });
  });

  describe("amount tiebreak ordering (#230)", () => {
    it("orders by outstanding DESC when reminder dates are equal (larger amount first)", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      // IDs chosen so invoiceId ASC order is OPPOSITE of amount DESC order:
      // - inv-a-... has SMALL amount (1000) but sorts FIRST by invoiceId
      // - inv-b-... has MEDIUM amount (5000) 
      // - inv-c-... has LARGE amount (9000) but sorts LAST by invoiceId
      // With old ORDER BY (invoiceId ASC only), order would be: a, b, c
      // With new ORDER BY (outstanding DESC), order should be: c, b, a
      const invoiceIdA = `inv-a-small-${TEST_SUFFIX}`;
      const invoiceIdB = `inv-b-medium-${TEST_SUFFIX}`;
      const invoiceIdC = `inv-c-large-${TEST_SUFFIX}`;
      const orderIdA = `gid://shopify/Order/a-small-${TEST_SUFFIX}`;
      const orderIdB = `gid://shopify/Order/b-medium-${TEST_SUFFIX}`;
      const orderIdC = `gid://shopify/Order/c-large-${TEST_SUFFIX}`;

      // All invoices due 2 days ago (same reminder date)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceIdA}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdA},
           '#A-SMALL', 10000.00, 1000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}),
          (${invoiceIdB}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdB},
           '#B-MEDIUM', 10000.00, 5000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}),
          (${invoiceIdC}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdC},
           '#C-LARGE', 10000.00, 9000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdA}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdB}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdC}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_CATCHUP'
        ORDER BY msg_id ASC
      `;

      expect(messages.length).toBe(3);
      // New ORDER BY: outstanding DESC, so largest first
      // This would FAIL with old ORDER BY (invoiceId ASC): would be a, b, c
      expect(messages[0].invoiceId).toBe(invoiceIdC);  // 9000 (largest)
      expect(messages[1].invoiceId).toBe(invoiceIdB);  // 5000 (medium)
      expect(messages[2].invoiceId).toBe(invoiceIdA);  // 1000 (smallest)

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });

    it("falls back to invoiceId ASC when amounts are equal", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      // Two invoices with SAME outstanding, different IDs
      const invoiceIdFirst = `inv-equal-aaa-${TEST_SUFFIX}`;
      const invoiceIdSecond = `inv-equal-zzz-${TEST_SUFFIX}`;
      const orderIdFirst = `gid://shopify/Order/equal-aaa-${TEST_SUFFIX}`;
      const orderIdSecond = `gid://shopify/Order/equal-zzz-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceIdFirst}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdFirst},
           '#EQUAL-AAA', 10000.00, 5000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}),
          (${invoiceIdSecond}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdSecond},
           '#EQUAL-ZZZ', 10000.00, 5000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdFirst}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdSecond}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_CATCHUP'
        ORDER BY msg_id ASC
      `;

      expect(messages.length).toBe(2);
      // Equal amounts -> fall back to invoiceId ASC
      expect(messages[0].invoiceId).toBe(invoiceIdFirst);   // aaa < zzz
      expect(messages[1].invoiceId).toBe(invoiceIdSecond);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });

    it("older reminder date sorts before newer date even with smaller amount", async () => {
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      // Two invoices: older date with smaller amount vs newer date with larger amount
      // reminder_date ASC should win over outstanding DESC
      const invoiceIdOlder = `inv-older-small-${TEST_SUFFIX}`;
      const invoiceIdNewer = `inv-newer-large-${TEST_SUFFIX}`;
      const orderIdOlder = `gid://shopify/Order/older-small-${TEST_SUFFIX}`;
      const orderIdNewer = `gid://shopify/Order/newer-large-${TEST_SUFFIX}`;

      // Older invoice: due 3 days ago (reminder date = 3 days ago), small amount
      // Newer invoice: due 2 days ago (reminder date = 2 days ago), large amount
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceIdOlder}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdOlder},
           '#OLDER-SMALL', 10000.00, 1000.00, 'open',
           ${dates.daysAgo(10)}, ${dates.daysAgo(3)}, ${dates.dbNow}, ${dates.dbNow}),
          (${invoiceIdNewer}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdNewer},
           '#NEWER-LARGE', 10000.00, 9000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdOlder}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(3)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdNewer}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_CATCHUP'
        ORDER BY msg_id ASC
      `;

      expect(messages.length).toBe(2);
      // reminder_date ASC wins: older date first, even though amount is smaller
      expect(messages[0].invoiceId).toBe(invoiceIdOlder);  // 3 days ago, 1000
      expect(messages[1].invoiceId).toBe(invoiceIdNewer);  // 2 days ago, 9000

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });

    it("same-invoice multiple rules: only latest stage survives (Part 2 logic)", async () => {
      // NOTE: Part 2 marks older stages as skipped when a newer stage exists for
      // the same invoice. So two rules with different offsetDays on the SAME invoice
      // will result in only the latest stage being enqueued.
      // This test verifies that behaviour, not ruleId ordering.
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-multi-rule-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/multi-rule-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#MULTI-RULE', 10000.00, 5000.00, 'open',
          ${dates.daysAgo(10)}, ${dates.daysAgo(5)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // Two delayed logs for same invoice but different rules (different offsetDays)
      // Rule 1 has offsetDays=0, Rule 2 has offsetDays=7 (later stage)
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(5)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      // Part 2 should mark the older stage (rule 1, offsetDays=0) as skipped
      const [rule1Log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;
      expect(rule1Log.status).toBe("skipped_daily_limit");

      // Only the newer stage should be enqueued (if within window) or still delayed
      const messages = await sql<{ invoiceId: string; ruleId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId", message->>'ruleId' AS "ruleId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_CATCHUP'
          AND message->>'invoiceId' = ${invoiceId}
        ORDER BY msg_id ASC
      `;

      // Only one message (the later stage) if it's within D+1..D+3 window
      expect(messages.length).toBeLessThanOrEqual(1);
      if (messages.length === 1) {
        expect(messages[0].ruleId).toBe(TEST_RULE_ID_2);
      }

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });

    it("ruleId ASC tiebreaker for different invoices with same date, amount, and invoiceId prefix", async () => {
      // Test ruleId ordering when all other fields tie.
      // Create two DIFFERENT invoices (to avoid Part 2 stage collapse) that happen
      // to have the same reminder date and same outstanding amount.
      // Order by invoiceId should distinguish them, but we verify ruleId is also in sort.
      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId1 = `inv-tie-rule-1-${TEST_SUFFIX}`;
      const invoiceId2 = `inv-tie-rule-2-${TEST_SUFFIX}`;
      const orderId1 = `gid://shopify/Order/tie-rule-1-${TEST_SUFFIX}`;
      const orderId2 = `gid://shopify/Order/tie-rule-2-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceId1}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId1},
           '#TIE-RULE-1', 10000.00, 5000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}),
          (${invoiceId2}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId2},
           '#TIE-RULE-2', 10000.00, 5000.00, 'open',
           ${dates.daysAgo(8)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow})
      `;

      // Each invoice gets a delayed log with a different rule
      // invoiceId1 with rule2, invoiceId2 with rule1
      // This tests that invoiceId sorts before ruleId
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId1}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)}),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId2}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string; ruleId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId", message->>'ruleId' AS "ruleId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'topic' = 'REMINDER_CATCHUP'
        ORDER BY msg_id ASC
      `;

      expect(messages.length).toBe(2);
      // Same date, same amount -> invoiceId ASC: inv-tie-rule-1 < inv-tie-rule-2
      expect(messages[0].invoiceId).toBe(invoiceId1);
      expect(messages[1].invoiceId).toBe(invoiceId2);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });
  });

  describe("never-twice across runs (#230)", () => {
    it("second enqueue run does not re-enqueue already-sent reminder", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-never-twice-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/never-twice-${TEST_SUFFIX}`;
      const logId = `log-never-twice-${TEST_SUFFIX}`;

      // Invoice due 2 days ago
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#NEVER-TWICE', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(7)}, ${dates.daysAgo(2)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      // Create delayed log
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-never-twice" }) });

      // First drain: catch-up sends successfully
      const result1 = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        testTimezone,
        validEnv
      );
      expect(result1.action).toBe("sent");

      // Verify log is now 'sent'
      const [logAfterSend] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog" WHERE id = ${logId}
      `;
      expect(logAfterSend.status).toBe("sent");

      // Clear queue and run second enqueue
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`SELECT public.s18_enqueue_reminders()`;

      // Should NOT enqueue again because ReminderLog already exists
      const messagesAfterSecondEnqueue = await sql<{ invoiceId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
      `;

      expect(messagesAfterSecondEnqueue.length).toBe(0);

      // Verify only one send happened
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });
  });

  describe("re-check skips for carried-over reminders (#230)", () => {
    it("skips and deletes delayed row when invoice status is cancelled", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-cancelled-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/cancelled-${TEST_SUFFIX}`;
      const logId = `log-cancelled-${TEST_SUFFIX}`;

      // Invoice was cancelled after being delayed
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CANCELLED', 10000.00, 10000.00, 'cancelled',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      const result = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        testTimezone,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("cancelled");

      // Verify delayed row was deleted
      const [log] = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
      `;
      expect(log).toBeUndefined();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("transitions delayed row to skipped_opted_out when buyer opted out", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-opted-out-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/opted-out-${TEST_SUFFIX}`;
      const logId = `log-opted-out-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#OPTED-OUT', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      // Mark buyer as opted out
      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("opted out");

        // Verify delayed row was transitioned to skipped_opted_out
        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
        `;
        expect(log.status).toBe("skipped_opted_out");

        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        // Reset opt-out status
        await sql`
          UPDATE "BuyerAccount"
          SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL
          WHERE id = ${TEST_ACCOUNT_ID}
        `;
      }
    });
  });

  describe("HELD buyer still receives reminders (#230)", () => {
    it("catch-up sends for buyer with holdState=HELD - status becomes sent", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "catchup-buyer@test-reminders.example" };

      const dates = computeDatesFromDbNow(dbNow, testTimezone);
      const invoiceId = `inv-held-buyer-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/held-buyer-${TEST_SUFFIX}`;
      const logId = `log-held-buyer-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#HELD-BUYER', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.dbNow}, ${dates.dbNow}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      // Set buyer account to HELD state
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD'::"HoldState", "manualHold" = true
        WHERE id = ${TEST_ACCOUNT_ID}
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-held-buyer" }) });

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          testTimezone,
          validEnv
        );

        // HELD buyers still receive reminders
        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");

        // Verify log is now 'sent'
        const [log] = await sql<{ status: string; sentAt: Date | null }[]>`
          SELECT status, "sentAt" FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(log.status).toBe("sent");
        expect(log.sentAt).not.toBeNull();

        // Verify exactly one send happened
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        // Reset hold state
        await sql`
          UPDATE "BuyerAccount"
          SET "holdState" = 'OK'::"HoldState", "manualHold" = false
          WHERE id = ${TEST_ACCOUNT_ID}
        `;
      }
    });
  });

});

/**
 * Pure-JS date helper tests with IST boundary instants.
 * These don't touch the database and can test with arbitrary instants.
 */
describe("isReminderDueToday (pure JS, boundary instants)", () => {
  const BOUNDARY_INSTANTS = [
    { name: "12:00 IST (baseline)", utc: "2026-10-15T06:30:00Z", istDate: "2026-10-15" },
    { name: "23:59 IST", utc: "2026-10-15T18:29:00Z", istDate: "2026-10-15" },
    { name: "00:00 IST", utc: "2026-10-14T18:30:00Z", istDate: "2026-10-15" },
    { name: "18:29 UTC (23:59 IST Oct 14)", utc: "2026-10-14T18:29:00Z", istDate: "2026-10-14" },
    { name: "18:31 UTC (00:01 IST Oct 15)", utc: "2026-10-14T18:31:00Z", istDate: "2026-10-15" },
    { name: "05:29 IST", utc: "2026-10-14T23:59:00Z", istDate: "2026-10-15" },
    { name: "00:00 UTC (05:30 IST)", utc: "2026-10-15T00:00:00Z", istDate: "2026-10-15" },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe.each(BOUNDARY_INSTANTS)("at $name", ({ utc, istDate }) => {
    it("returns true when dueAt + offsetDays = today in IST", async () => {
      vi.setSystemTime(new Date(utc));
      const { isReminderDueToday } = await import("../reminders.server");

      // dueAt is today at noon IST
      const dueAt = DateTime.fromISO(`${istDate}T12:00:00`, { zone: "Asia/Kolkata" }).toJSDate();
      expect(isReminderDueToday(dueAt, 0, "Asia/Kolkata")).toBe(true);
    });

    it("returns false when dueAt + offsetDays != today in IST", async () => {
      vi.setSystemTime(new Date(utc));
      const { isReminderDueToday } = await import("../reminders.server");

      // dueAt is yesterday at noon IST
      const yesterday = DateTime.fromISO(istDate, { zone: "Asia/Kolkata" }).minus({ days: 1 });
      const dueAt = yesterday.set({ hour: 12 }).toJSDate();
      expect(isReminderDueToday(dueAt, 0, "Asia/Kolkata")).toBe(false);
    });
  });
});

/**
 * Migration diff test: asserts the s18_enqueue_reminders function body in
 * 20261122000000 differs from 20261112000000 ONLY in the ORDER BY line.
 * Does not require database access.
 */
describe("migration diff: 20261122000000 vs 20261112000000 (#230)", () => {
  it("function bodies differ ONLY in the ORDER BY line", async () => {
    const fs = await import("fs/promises");
    const path = await import("path");

    const baseMigrationPath = path.resolve(
      __dirname,
      "../../../prisma/migrations/20261112000000_s18_reminder_catchup/migration.sql"
    );
    const newMigrationPath = path.resolve(
      __dirname,
      "../../../prisma/migrations/20261122000000_s18_catchup_amount_ordering/migration.sql"
    );

    const baseSql = await fs.readFile(baseMigrationPath, "utf-8");
    const newSql = await fs.readFile(newMigrationPath, "utf-8");

    const extractFunctionBody = (sql: string): string => {
      const match = sql.match(
        /CREATE OR REPLACE FUNCTION public\.s18_enqueue_reminders\(\)[\s\S]*?\$func\$;/
      );
      if (!match) throw new Error("Function body not found in migration");
      return match[0];
    };

    const baseBody = extractFunctionBody(baseSql);
    const newBody = extractFunctionBody(newSql);

    const normalizeWhitespace = (s: string): string[] =>
      s.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

    const baseLines = normalizeWhitespace(baseBody);
    const newLines = normalizeWhitespace(newBody);

    expect(baseLines.length).toBe(newLines.length);

    const differences: { lineNum: number; base: string; new: string }[] = [];
    for (let i = 0; i < baseLines.length; i++) {
      if (baseLines[i] !== newLines[i]) {
        differences.push({ lineNum: i + 1, base: baseLines[i], new: newLines[i] });
      }
    }

    expect(differences.length).toBe(1);
    expect(differences[0].base).toContain("ORDER BY reminder_date ASC, rl.\"invoiceId\" ASC");
    expect(differences[0].new).toContain("ORDER BY reminder_date ASC, i.outstanding DESC, rl.\"invoiceId\" ASC, rl.\"ruleId\" ASC");
  });
});
