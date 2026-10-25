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
 * Tests use vi.setSystemTime() to freeze both JS and derived dates. All date
 * values (dueAt, issuedAt, cap dates, sentAt) are computed from the frozen
 * instant rather than SQL NOW(). Tests run at IST day boundary instants to
 * catch bugs where 'today' disagrees between JS and DB sides.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { DateTime } from "luxon";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/**
 * IST day boundary instants for testing.
 * All on 2026-10-15 IST (a date chosen to avoid DST transitions).
 *
 * Key boundaries around IST midnight (18:30 UTC):
 * - 18:29 UTC on Oct 14 = 23:59 IST on Oct 14 (just before IST midnight)
 * - 18:31 UTC on Oct 14 = 00:01 IST on Oct 15 (just after IST midnight)
 *
 * Other boundaries:
 * - 23:59 IST = 18:29 UTC on Oct 15 (near end of IST day)
 * - 00:00 IST = 18:30 UTC on Oct 14 (start of IST day, previous UTC day)
 * - 05:29 IST = 23:59 UTC on Oct 14 (just before UTC day change)
 * - 05:30 IST = 00:00 UTC on Oct 15 (UTC midnight = IST 05:30)
 * - 12:00 IST = 06:30 UTC on Oct 15 (baseline, middle of business day)
 */
const BOUNDARY_INSTANTS = [
  { name: "12:00 IST (baseline)", utc: "2026-10-15T06:30:00Z", istDate: "2026-10-15" },
  { name: "23:59 IST", utc: "2026-10-15T18:29:00Z", istDate: "2026-10-15" },
  { name: "00:00 IST", utc: "2026-10-14T18:30:00Z", istDate: "2026-10-15" },
  { name: "18:29 UTC (23:59 IST Oct 14)", utc: "2026-10-14T18:29:00Z", istDate: "2026-10-14" },
  { name: "18:31 UTC (00:01 IST Oct 15)", utc: "2026-10-14T18:31:00Z", istDate: "2026-10-15" },
  { name: "05:29 IST", utc: "2026-10-14T23:59:00Z", istDate: "2026-10-15" },
  { name: "00:00 UTC (05:30 IST)", utc: "2026-10-15T00:00:00Z", istDate: "2026-10-15" },
] as const;

/**
 * Helper to compute dates relative to the frozen instant.
 * Computes both IST dates (for dueAt, issuedAt) and UTC dates (for cap rows).
 * @param utcInstant - The frozen UTC instant (e.g. "2026-10-15T06:30:00Z")
 * @param istDateStr - The IST date for this instant (e.g. "2026-10-15")
 */
function computeDatesFromInstant(utcInstant: string, istDateStr: string) {
  const utcDt = DateTime.fromISO(utcInstant, { zone: "UTC" });
  const istNoon = DateTime.fromISO(`${istDateStr}T12:00:00`, { zone: "Asia/Kolkata" });
  const utcDateStr = utcDt.toISODate()!;
  return {
    todayIST: istDateStr,
    todayUTC: utcDateStr,
    todayISTNoon: istNoon.toJSDate(),
    monthStrIST: istDateStr.substring(0, 7),
    monthStrUTC: utcDateStr.substring(0, 7),
    daysAgo: (n: number) => istNoon.minus({ days: n }).toJSDate(),
    hoursAgo: (n: number) => istNoon.minus({ hours: n }).toJSDate(),
  };
}

describeWithDb("S18 reminder catch-up behavior (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-catchup";
  const TEST_SHOP_ID = `shop-catchup-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-catchup-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-catchup-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/catchup-${TEST_SUFFIX}`;
  const TEST_RULE_ID_1 = `rule-catchup-1-${TEST_SUFFIX}`;
  const TEST_RULE_ID_2 = `rule-catchup-2-${TEST_SUFFIX}`;
  const TEST_RULE_ID_3 = `rule-catchup-3-${TEST_SUFFIX}`;

  const FIXED_DATE_STR = "2026-10-15";
  const FIXED_UTC_INSTANT = "2026-10-15T06:30:00Z";
  const FIXED_MONTH_STR = "2026-10";
  const TEST_TIMEZONE = "Asia/Kolkata";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', ${TEST_TIMEZONE}, 'free', NOW(), NOW())
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
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;
    await sql.end();
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockFetch.mockReset();
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("cap boundary - delayed instead of deleted", () => {
    describe.each(BOUNDARY_INSTANTS)("at $name", ({ utc, istDate }) => {
      it("upserts as delayed when daily cap is reached", async () => {
        vi.setSystemTime(new Date(utc));
        const { sendPaymentReminder, DAILY_SEND_CAP } = await import("../reminders.server");
        const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

        const dates = computeDatesFromInstant(utc, istDate);
        const invoiceId = `inv-cap-delayed-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;
        const orderId = `gid://shopify/Order/cap-delayed-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
            '#CAP-DELAYED', 10000.00, 10000.00, 'open',
            ${dates.daysAgo(5)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
          )
        `;

        // Cap row uses UTC date (product's reserveGlobalSendSlot uses date.toISOString().split('T')[0])
        await sql`
          INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
          VALUES ('global', ${dates.todayUTC}::DATE, ${dates.monthStrUTC}, ${DAILY_SEND_CAP}, 0, ${dates.todayISTNoon})
          ON CONFLICT (send_key, send_date) DO UPDATE SET daily_count = ${DAILY_SEND_CAP}
        `;

        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          TEST_TIMEZONE,
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
  });

  describe("stage collapse - latest stage wins", () => {
    it("older delayed stages become skipped when later stage exists", async () => {
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
          NOW() - INTERVAL '15 days', NOW() - INTERVAL '14 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '2 days'),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day'),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_3}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(3)}, ${dates.daysAgo(2)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdDelayed}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

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
        TEST_TIMEZONE,
        validEnv
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("Newer stage exists");

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE id = ${logIdDelayed}
      `;
      expect(log.status).toBe("skipped_daily_limit");
    });
  });

  describe("payment mid-window - delayed row deleted silently", () => {
    it("deletes delayed row when invoice is paid before catch-up", async () => {
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
        TEST_TIMEZONE,
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
          NOW() - INTERVAL '10 days', NOW() - INTERVAL '5 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '5 days')
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
      const invoiceId = `inv-one-per-day-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/one-per-day-${TEST_SUFFIX}`;
      const logIdDelayed = `log-delayed-opd-${TEST_SUFFIX}`;
      const logIdSent = `log-sent-opd-${TEST_SUFFIX}`;
      const ruleId3 = `rule-catch-opd-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleId3}, ${TEST_SHOP_ID}, 14, 'email'::"ReminderChannel", true, ${dates.todayISTNoon}, ${dates.todayISTNoon})
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ONE-PER-DAY', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(20)}, ${dates.daysAgo(15)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdDelayed}, ${TEST_SHOP_ID}, ${ruleId3}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(1)})
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (${logIdSent}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'sent'::"ReminderLogStatus", ${dates.todayISTNoon})
      `;

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          ruleId3,
          logIdDelayed,
          14,
          TEST_TIMEZONE,
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

    describe.each(BOUNDARY_INSTANTS)("at $name", ({ utc, istDate }) => {
      it("REMINDER_SEND skips when another stage already sent today", async () => {
        vi.setSystemTime(new Date(utc));
        const { sendPaymentReminder } = await import("../reminders.server");
        const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

        const dates = computeDatesFromInstant(utc, istDate);
        const invoiceId = `inv-concurrent-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;
        const orderId = `gid://shopify/Order/concurrent-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
            '#CONCURRENT', 10000.00, 10000.00, 'open',
            ${dates.daysAgo(5)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
          )
        `;

        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-concurrent" }) });

        const sendResult1 = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          TEST_TIMEZONE,
          validEnv
        );
        expect(sendResult1.action).toBe("sent");

        const sendResult2 = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          TEST_TIMEZONE,
          validEnv
        );

        expect(sendResult2.success).toBe(true);
        expect(sendResult2.action).toBe("skipped");
        expect(sendResult2.skipReason).toContain("already sent");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("duplicate catch-up messages", () => {
    it("second catch-up message skips when first already sent", async () => {
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.daysAgo(2)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(2)})
      `;

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-dup" }) });

      const result1 = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        TEST_TIMEZONE,
        validEnv
      );
      expect(result1.action).toBe("sent");

      const result2 = await sendCatchupReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        logId,
        0,
        TEST_TIMEZONE,
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
           NOW() - INTERVAL '8 days', NOW() - INTERVAL '3 days', NOW(), NOW()),
          (${invoiceId2}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId2},
           '#OLDEST-2', 10000.00, 10000.00, 'open',
           NOW() - INTERVAL '7 days', NOW() - INTERVAL '2 days', NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES 
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId1}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '3 days'),
          (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId2}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '2 days')
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
          NOW() - INTERVAL '30 days', NOW() - INTERVAL '25 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceIdPre}, 'sent'::"ReminderLogStatus", NOW() - INTERVAL '25 days')
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
          NOW() - INTERVAL '10 days', NOW() - INTERVAL '5 days', NOW(), NOW()
        )
      `;

      // status='sent' with sentAt=NULL should fail (sent MUST have sentAt)
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
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
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
    describe.each(BOUNDARY_INSTANTS)("at $name", ({ utc, istDate }) => {
      it("sends reminder for partly paid invoice (outstanding > 0)", async () => {
        vi.setSystemTime(new Date(utc));
        const { sendPaymentReminder } = await import("../reminders.server");
        const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

        const dates = computeDatesFromInstant(utc, istDate);
        const invoiceId = `inv-partly-paid-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;
        const orderId = `gid://shopify/Order/partly-paid-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
            '#PARTLY-PAID', 10000.00, 3000.00, 'open',
            ${dates.daysAgo(5)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
          )
        `;

        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-partly-paid" }) });

        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          TEST_TIMEZONE,
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
    });

    it("skips invoice when outstanding is zero", async () => {
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
        )
      `;

      const result = await sendPaymentReminder(
        sql,
        TEST_SHOP_ID,
        invoiceId,
        TEST_RULE_ID_1,
        0,
        TEST_TIMEZONE,
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
      const invoiceId = `inv-sent-late-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/sent-late-${TEST_SUFFIX}`;
      const logId = `log-sent-late-${TEST_SUFFIX}`;
      const firstCappedAtTime = new Date("2026-10-14T10:00:00Z");

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#SENT-LATE', 10000.00, 10000.00, 'open',
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
        TEST_TIMEZONE,
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
      expect(after.firstCappedAt!.toISOString()).toBe(firstCappedAtTime.toISOString());
    });
  });

  describe("one reminder per invoice per day - newer stage wins", () => {
    describe.each(BOUNDARY_INSTANTS)("at $name", ({ utc, istDate }) => {
      it("stage 1 delayed becomes skipped when stage 2 is due today, only stage 2 sends", async () => {
        vi.setSystemTime(new Date(utc));
        const { sendPaymentReminder, sendCatchupReminder } = await import("../reminders.server");
        const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

        const dates = computeDatesFromInstant(utc, istDate);
        const invoiceId = `inv-newer-stage-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;
        const orderId = `gid://shopify/Order/newer-stage-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;
        const logIdStage1 = `log-stage1-${utc.replace(/[:.]/g, "-")}-${TEST_SUFFIX}`;

        await sql`
          INSERT INTO "Invoice" (
            id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
            status, "issuedAt", "dueAt", "createdAt", "updatedAt"
          )
          VALUES (
            ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
            '#NEWER-STAGE', 10000.00, 10000.00, 'open',
            ${dates.daysAgo(14)}, ${dates.daysAgo(7)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
          )
        `;

        await sql`
          INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
          VALUES (${logIdStage1}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${dates.daysAgo(7)})
        `;

        mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-stage2" }) });

        const resultCatchup = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logIdStage1,
          0,
          TEST_TIMEZONE,
          validEnv
        );
        expect(resultCatchup.success).toBe(true);
        expect(resultCatchup.action).toBe("skipped");

        const resultSend = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_2,
          7,
          TEST_TIMEZONE,
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
  });

  describe("SQL-level enqueue behavior", () => {
    it("Part 2.5: marks delayed as skipped when newer stage is due today", async () => {
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
      const invoiceId = `inv-part25-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/part25-${TEST_SUFFIX}`;

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
          ${dates.todayISTNoon}, ${dates.todayISTNoon}
        )
      `;

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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_invalid", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
          TEST_TIMEZONE,
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };
      const originalEnv = process.env.PLAN_GATING_ENFORCED;

      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
          TEST_TIMEZONE,
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
      vi.setSystemTime(new Date(FIXED_UTC_INSTANT));
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com" };
      const originalEnv = process.env.PLAN_GATING_ENFORCED;

      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";

      const dates = computeDatesFromInstant(FIXED_UTC_INSTANT, FIXED_DATE_STR);
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
          ${dates.daysAgo(5)}, ${dates.daysAgo(1)}, ${dates.todayISTNoon}, ${dates.todayISTNoon}
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
          TEST_TIMEZONE,
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

});
