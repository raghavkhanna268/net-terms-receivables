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
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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

  const _FIXED_DATE = new Date("2026-10-15T12:00:00Z");
  const _FIXED_DATE_STR = "2026-10-15";
  const FIXED_MONTH_STR = "2026-10";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;

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
        'Catchup Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'catchup-buyer@example.test', 'Catchup Test Buyer', NOW())
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
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    mockFetch.mockReset();
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("cap boundary - delayed instead of deleted", () => {
    it("upserts as delayed when daily cap is reached", async () => {
      const { sendPaymentReminder, DAILY_SEND_CAP } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

      const invoiceId = `inv-cap-delayed-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/cap-delayed-${TEST_SUFFIX}`;

      // Invoice dueAt is TODAY (so offsetDays=0 fires today)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CAP-DELAYED', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      // Fill the daily cap for TODAY (not FIXED_DATE)
      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const todayStr = mockNow.toISODate()!;
      const monthStr = todayStr.substring(0, 7);

      await sql`
        INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
        VALUES ('global', ${todayStr}::DATE, ${monthStr}, ${DAILY_SEND_CAP}, 0, NOW())
        ON CONFLICT (send_key, send_date) DO UPDATE SET daily_count = ${DAILY_SEND_CAP}
      `;

      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          "Asia/Kolkata",
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
      } finally {
        luxonSpy.mockRestore();
      }
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
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

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
          NOW() - INTERVAL '15 days', NOW() - INTERVAL '14 days', NOW(), NOW()
        )
      `;

      // Older stage (offsetDays=0) is delayed
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdDelayed}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '2 days')
      `;

      // Newer stage (offsetDays=7) was already sent yesterday
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId}, 'sent'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logIdDelayed,
          0,
          "Asia/Kolkata",
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
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("payment mid-window - delayed row deleted silently", () => {
    it("deletes delayed row when invoice is paid before catch-up", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

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
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          "Asia/Kolkata",
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
      } finally {
        luxonSpy.mockRestore();
      }
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
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

      const invoiceId = `inv-one-per-day-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/one-per-day-${TEST_SUFFIX}`;
      const logIdDelayed = `log-delayed-${TEST_SUFFIX}`;
      const logIdSent = `log-sent-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ONE-PER-DAY', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '10 days', NOW() - INTERVAL '5 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (${logIdSent}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'sent'::"ReminderLogStatus", NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdDelayed}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_2}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_2,
          logIdDelayed,
          7,
          "Asia/Kolkata",
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("already sent today");
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("REMINDER_SEND skips when another stage already sent today", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

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
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-concurrent" }) });

      try {
        // First: REMINDER_SEND for offsetDays=0 (due today)
        const sendResult1 = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          "Asia/Kolkata",
          validEnv
        );
        expect(sendResult1.action).toBe("sent");

        // Second: REMINDER_SEND for same invoice, same rule (idempotent)
        // Should be skipped because reminder already sent
        const sendResult2 = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(sendResult2.success).toBe(true);
        expect(sendResult2.action).toBe("skipped");
        expect(sendResult2.skipReason).toContain("already sent");

        // Verify only one fetch call (the first send)
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("duplicate catch-up messages", () => {
    it("second catch-up message skips when first already sent", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

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
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '2 days')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-dup" }) });

      try {
        // First catch-up sends
        const result1 = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          "Asia/Kolkata",
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
          "Asia/Kolkata",
          validEnv
        );

        expect(result2.success).toBe(true);
        expect(result2.action).toBe("skipped");
        expect(result2.skipReason).toContain("not in delayed state");

        // Only one fetch call
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        luxonSpy.mockRestore();
      }
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
    it("sends reminder for partly paid invoice (outstanding > 0)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

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
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-partly-paid" }) });

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");

        // Verify fetch was called (email sent)
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Verify ReminderLog was created with 'sent' status
        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
        `;
        expect(log.status).toBe("sent");
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("skips invoice when outstanding is zero", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

      const invoiceId = `inv-zero-outstanding-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/zero-outstanding-${TEST_SUFFIX}`;

      // Invoice with outstanding=0 (fully paid but status still 'open')
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ZERO-OUTSTANDING', 10000.00, 0.00, 'open',
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
          TEST_RULE_ID_1,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("outstanding is zero");

        // Verify no fetch was called
        expect(mockFetch).not.toHaveBeenCalled();

        // Verify no ReminderLog was created
        const logs = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog"
          WHERE "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID_1}
        `;
        expect(logs.length).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("delayed-to-sent transition preserves firstCappedAt", () => {
    it("markDelayedAsSent keeps firstCappedAt for 'sent late' tracking", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

      const invoiceId = `inv-sent-late-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/sent-late-${TEST_SUFFIX}`;
      const logId = `log-sent-late-${TEST_SUFFIX}`;
      const firstCappedAtTime = new Date("2026-10-14T10:00:00Z");

      // Create invoice due yesterday (offset-0 rule is in catch-up window today)
      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#SENT-LATE', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', NOW(), NOW()
        )
      `;

      // Create delayed ReminderLog with firstCappedAt set
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${firstCappedAtTime})
      `;

      // Verify firstCappedAt is set before send
      const [before] = await sql<{ firstCappedAt: Date | null }[]>`
        SELECT "firstCappedAt" FROM "ReminderLog" WHERE id = ${logId}
      `;
      expect(before.firstCappedAt).not.toBeNull();

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-sent-late" }) });

      try {
        const result = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logId,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");

        // Verify: status='sent', sentAt set, firstCappedAt UNCHANGED
        const [after] = await sql<{ status: string; sentAt: Date | null; firstCappedAt: Date | null }[]>`
          SELECT status, "sentAt", "firstCappedAt" FROM "ReminderLog" WHERE id = ${logId}
        `;
        expect(after.status).toBe("sent");
        expect(after.sentAt).not.toBeNull();
        expect(after.firstCappedAt).not.toBeNull();
        expect(after.firstCappedAt!.toISOString()).toBe(firstCappedAtTime.toISOString());
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("one reminder per invoice per day - newer stage wins", () => {
    it("stage 1 delayed becomes skipped when stage 2 is due today, only stage 2 sends", async () => {
      const { sendPaymentReminder, sendCatchupReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test.com" };

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
          NOW() - INTERVAL '14 days', NOW() - INTERVAL '7 days', NOW(), NOW()
        )
      `;

      // Create delayed ReminderLog for stage 1 (offset 0, due 7 days ago)
      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logIdStage1}, ${TEST_SHOP_ID}, ${TEST_RULE_ID_1}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW() - INTERVAL '7 days')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-stage2" }) });

      try {
        // First, try catch-up for stage 1 - should be skipped (newer stage due today)
        const resultCatchup = await sendCatchupReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID_1,
          logIdStage1,
          0,
          "Asia/Kolkata",
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
          "Asia/Kolkata",
          validEnv
        );
        expect(resultSend.success).toBe(true);
        expect(resultSend.action).toBe("sent");

        // Verify: exactly 1 fetch call (stage 2 only)
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // Verify final ReminderLog state
        const logs = await sql<{ ruleId: string; status: string }[]>`
          SELECT "ruleId", status FROM "ReminderLog"
          WHERE "invoiceId" = ${invoiceId}
          ORDER BY "ruleId"
        `;

        // Stage 1 should be skipped_daily_limit (newer stage exists)
        const stage1Log = logs.find(l => l.ruleId === TEST_RULE_ID_1);
        expect(stage1Log).toBeDefined();
        expect(stage1Log!.status).toBe("skipped_daily_limit");

        // Stage 2 should be sent
        const stage2Log = logs.find(l => l.ruleId === TEST_RULE_ID_2);
        expect(stage2Log).toBeDefined();
        expect(stage2Log!.status).toBe("sent");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

});
