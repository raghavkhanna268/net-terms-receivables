/**
 * DB-backed integration tests for S18 buyer opt-out in reminder send paths (#232).
 *
 * Tests verify:
 * - sendPaymentReminder skips when buyer opted out (no Resend, no slot, records skipped_opted_out)
 * - sendCatchupReminder transitions delayed to skipped_opted_out when buyer opted out
 * - Re-enable doesn't resend a skipped_opted_out stage
 * - Missing REMINDER_UNSUBSCRIBE_SECRET: no send
 * - Unsubscribe headers are present in the Resend call
 * - Shop isolation for opt-out checks
 *
 * Uses real Postgres and real safeLog (no vi.mock of log.server.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describeWithDb("S18 reminder opt-out send paths (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-optout-send";
  const TEST_SHOP_ID = `shop-optout-send-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-optout-send-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-optout-send-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/optout-send-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-optout-send-${TEST_SUFFIX}`;
  const OTHER_SHOP_ID = `shop-other-${TEST_SUFFIX}`;
  const OTHER_SHOP_DOMAIN = `test-other-${TEST_SUFFIX}.myshopify.com`;
  const OTHER_ACCOUNT_ID = `acc-other-${TEST_SUFFIX}`;
  const OTHER_CUSTOMER_ID = `gid://shopify/Customer/other-${TEST_SUFFIX}`;

  const FIXED_MONTH_STR = "2026-10";
  const FIXED_TODAY = "2026-10-15";
  const FIXED_TODAY_IST = { year: 2026, month: 10, day: 15, hour: 12, minute: 0 };

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
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${OTHER_SHOP_ID}, ${OTHER_SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${TEST_CUSTOMER_ID}, 'Opt-out Send Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${OTHER_ACCOUNT_ID}, ${OTHER_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${OTHER_CUSTOMER_ID}, 'Other Shop Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'optout-buyer@test-reminders.example', 'Opt-out Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${OTHER_SHOP_ID}, ${OTHER_CUSTOMER_ID}, 'other-buyer@test-reminders.example', 'Other Shop Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "Shop" WHERE id IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;

    const allDomains = [TEST_SHOP_DOMAIN, OTHER_SHOP_DOMAIN];
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;

    await assertNoQueueLeftovers(sql, allDomains, "reminders-optout-send-db.test.ts");

    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})`;
    mockFetch.mockReset();
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL, "updatedAt" = NOW()
      WHERE "shopId" IN (${TEST_SHOP_ID}, ${OTHER_SHOP_ID})
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("sendPaymentReminder - opt-out between enqueue and send", () => {
    it("skips with skipped_opted_out when buyer opted out, no Resend call, no slot reserved", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-optout-send-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/optout-send-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#OPTOUT-SEND', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
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

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("opted out");

        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string; sentAt: Date | null }[]>`
          SELECT status, "sentAt" FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID}
        `;

        expect(log).toBeDefined();
        expect(log.status).toBe("skipped_opted_out");
        expect(log.sentAt).toBeNull();

        const luxonToday = mockNow.toISODate()!;
        const [counts] = await sql<{ dailyCount: number }[]>`
          SELECT COALESCE(daily_count, 0) AS "dailyCount"
          FROM s18_global_sends
          WHERE send_key = 'global' AND send_date = ${luxonToday}::DATE
        `;
        expect(counts?.dailyCount ?? 0).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("sends normally when buyer NOT opted out", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-not-optout-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/not-optout-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#NOT-OPTOUT', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-not-optout" }) });

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

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");

        expect(mockFetch).toHaveBeenCalledTimes(1);

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID}
        `;

        expect(log.status).toBe("sent");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("sendCatchupReminder - opt-out transitions delayed to skipped_opted_out", () => {
    it("transitions delayed row to skipped_opted_out when buyer opted out", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-catchup-optout-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/catchup-optout-${TEST_SUFFIX}`;
      const logId = `log-catchup-optout-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CATCHUP-OPTOUT', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE - INTERVAL '2 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${FIXED_TODAY}::DATE - INTERVAL '2 days')
      `;

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
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

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("opted out");

        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE id = ${logId}
        `;

        expect(log.status).toBe("skipped_opted_out");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("re-enable doesn't resend skipped_opted_out stage", () => {
    it("skipped_opted_out stage is NOT resent after clearBuyerOptOut", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const { clearBuyerOptOut } = await import("../reminder-optout.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-reenable-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/reenable-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#REENABLE', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, 'skipped_opted_out'::"ReminderLogStatus", NULL)
      `;

      await clearBuyerOptOut(sql, TEST_SHOP_ID, TEST_ACCOUNT_ID);

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
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

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("idempotent");

        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID}
        `;

        expect(log.status).toBe("skipped_opted_out");
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("Part 3 enqueue excludes invoices with skipped_opted_out log", async () => {
      const invoiceId = `inv-enqueue-skip-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/enqueue-skip-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#ENQUEUE-SKIP', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "sentAt")
        VALUES (gen_random_uuid()::TEXT, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, 'skipped_opted_out'::"ReminderLogStatus", NULL)
      `;

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await sql`SELECT public.s18_enqueue_reminders()`;

      const messages = await sql<{ invoiceId: string }[]>`
        SELECT message->>'invoiceId' AS "invoiceId"
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
      `;

      expect(messages.length).toBe(0);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    });
  });

  describe("missing REMINDER_UNSUBSCRIBE_SECRET", () => {
    it("sendPaymentReminder skips when secret is missing", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const envWithoutSecret = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
      };

      const invoiceId = `inv-no-secret-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/no-secret-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#NO-SECRET', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          envWithoutSecret
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("REMINDER_UNSUBSCRIBE_SECRET");

        expect(mockFetch).not.toHaveBeenCalled();

        const logs = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logs.length).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("sendCatchupReminder skips when secret is missing (delayed row preserved)", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const envWithoutSecret = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
      };

      const invoiceId = `inv-catchup-no-secret-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/catchup-no-secret-${TEST_SUFFIX}`;
      const logId = `log-catchup-no-secret-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CATCHUP-NO-SECRET', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE - INTERVAL '2 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${FIXED_TODAY}::DATE - INTERVAL '2 days')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
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
          envWithoutSecret
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("REMINDER_UNSUBSCRIBE_SECRET");

        expect(mockFetch).not.toHaveBeenCalled();

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE id = ${logId}
        `;
        expect(log.status).toBe("delayed");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("unsubscribe headers are present in Resend call", () => {
    it("includes List-Unsubscribe and List-Unsubscribe-Post headers", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-headers-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/headers-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#HEADERS', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-headers" }) });

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

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");

        expect(mockFetch).toHaveBeenCalledTimes(1);

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);

        expect(requestBody.headers).toBeDefined();
        expect(requestBody.headers["List-Unsubscribe"]).toMatch(/^<https:\/\/example\.com\/unsubscribe\?token=.+>$/);
        expect(requestBody.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("includes headers in catch-up send", async () => {
      const { sendCatchupReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceId = `inv-catchup-headers-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/catchup-headers-${TEST_SUFFIX}`;
      const logId = `log-catchup-headers-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#CATCHUP-HEADERS', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE - INTERVAL '2 days', NOW(), NOW()
        )
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId}, 'delayed'::"ReminderLogStatus", ${FIXED_TODAY}::DATE - INTERVAL '2 days')
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-catchup-headers" }) });

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

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");

        expect(mockFetch).toHaveBeenCalledTimes(1);

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);

        expect(requestBody.headers).toBeDefined();
        expect(requestBody.headers["List-Unsubscribe"]).toBeDefined();
        expect(requestBody.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("shop isolation for opt-out checks", () => {
    it("opted-out buyer in shop A doesn't affect sends for shop B", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@test-reminders.example",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://example.com",
        RESEND_TEST_RECIPIENTS: "optout-buyer@test-reminders.example,other-buyer@test-reminders.example",
      };

      const invoiceIdA = `inv-shop-a-${TEST_SUFFIX}`;
      const invoiceIdB = `inv-shop-b-${TEST_SUFFIX}`;
      const orderIdA = `gid://shopify/Order/shop-a-${TEST_SUFFIX}`;
      const orderIdB = `gid://shopify/Order/shop-b-${TEST_SUFFIX}`;
      const ruleIdB = `rule-shop-b-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${ruleIdB}, ${OTHER_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${OTHER_SHOP_ID}, true, NOW(), NOW())
        ON CONFLICT (shop_id) DO UPDATE SET enabled = true
      `;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceIdA}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderIdA},
           '#SHOP-A', 10000.00, 10000.00, 'open',
           ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()),
          (${invoiceIdB}, ${OTHER_SHOP_ID}, ${OTHER_ACCOUNT_ID}, ${orderIdB},
           '#SHOP-B', 10000.00, 10000.00, 'open',
           ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW())
      `;

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${TEST_ACCOUNT_ID} AND "shopId" = ${TEST_SHOP_ID}
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-shop-b" }) });

      try {
        const resultA = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceIdA,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(resultA.success).toBe(true);
        expect(resultA.action).toBe("skipped");
        expect(resultA.skipReason).toContain("opted out");

        const resultB = await sendPaymentReminder(
          sql,
          OTHER_SHOP_ID,
          invoiceIdB,
          ruleIdB,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(resultB.success).toBe(true);
        expect(resultB.action).toBe("sent");

        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        luxonSpy.mockRestore();
        await sql`DELETE FROM "ReminderLog" WHERE "ruleId" = ${ruleIdB}`;
        await sql`DELETE FROM "ReminderRule" WHERE id = ${ruleIdB}`;
      }
    });
  });
});
