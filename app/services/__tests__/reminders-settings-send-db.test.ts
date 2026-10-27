/**
 * DB-backed integration tests for honouring the shop reminder setting at
 * send time (S18).
 *
 * The enqueue function only enqueues reminders for shops whose settings row is
 * enabled, but a shop can change that toggle after a message is already on the
 * queue. These tests verify the send path re-reads the flag just before
 * sending and follows the same skip handling as the other send-time gates.
 *
 * Scenarios covered:
 * - Toggle turned off between enqueue and send: no Resend call, no ReminderLog
 *   send row, and the queued message is archived by the drain.
 * - Toggle on: sends exactly as before.
 * - Settings row absent: behaviour is unchanged (still sends).
 * - Pre-existing per-buyer opt-out: honoured at send time.
 *
 * Uses real Postgres/pgmq and real safeLog (no vi.mock of log.server.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { assertNoQueueLeftovers } from "../../../tests/helpers/queue-leftovers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describeWithDb("S18 reminder settings re-check at send time (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-settings-send";
  const TEST_SHOP_ID = `shop-settings-send-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-settings-send-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-settings-send-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `cust-settings-send-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-settings-send-${TEST_SUFFIX}`;
  const TEST_EMAIL = "settings-send-buyer@example.com";

  const FIXED_MONTH_STR = "2026-10";
  const FIXED_TODAY = "2026-10-15";
  const FIXED_TODAY_IST = { year: 2026, month: 10, day: 15, hour: 12, minute: 0 };

  const validEnv = {
    RESEND_API_KEY: "re_test_1234",
    RESEND_FROM: "noreply@example.com",
    REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
    SHOPIFY_APP_URL: "https://app.example.com",
    RESEND_TEST_RECIPIENTS: TEST_EMAIL,
  };

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
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${TEST_CUSTOMER_ID}, 'Settings Send Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, ${TEST_EMAIL}, 'Settings Send Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
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

    const allDomains = [TEST_SHOP_DOMAIN];
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;

    await assertNoQueueLeftovers(sql, allDomains, "reminders-settings-send-db.test.ts");

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
    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true, updated_at = NOW()
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL, "updatedAt" = NOW()
      WHERE "shopId" = ${TEST_SHOP_ID}
    `;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function insertInvoice(invoiceId: string, name: string): Promise<void> {
    const orderId = `order-${invoiceId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
        ${name}, 10000.00, 10000.00, 'open',
        ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
      )
    `;
  }

  it("does not send when the shop setting is turned off before send", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-off-${TEST_SUFFIX}`;
    await insertInvoice(invoiceId, "#SETTINGS-OFF");

    await sql`
      UPDATE s18_shop_reminder_settings SET enabled = false, updated_at = NOW()
      WHERE shop_id = ${TEST_SHOP_ID}
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
      expect(result.skipReason).toBe("Shop reminders disabled");

      expect(mockFetch).not.toHaveBeenCalled();

      const logs = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
      `;
      expect(logs.length).toBe(0);

      const [counts] = await sql<{ dailyCount: number }[]>`
        SELECT COALESCE(daily_count, 0) AS "dailyCount"
        FROM s18_global_sends
        WHERE send_key = 'global' AND send_date = ${FIXED_TODAY}::DATE
      `;
      expect(counts?.dailyCount ?? 0).toBe(0);
    } finally {
      luxonSpy.mockRestore();
    }
  });

  it("archives the queued message through the drain when the setting is off", async () => {
    const invoiceId = `inv-drain-off-${TEST_SUFFIX}`;
    await insertInvoice(invoiceId, "#SETTINGS-DRAIN-OFF");

    await sql`
      UPDATE s18_shop_reminder_settings SET enabled = false, updated_at = NOW()
      WHERE shop_id = ${TEST_SHOP_ID}
    `;

    const env = process.env as Record<string, string | undefined>;
    const savedEnv: Record<string, string | undefined> = {};
    const envKeys = ["RESEND_API_KEY", "RESEND_FROM", "REMINDER_UNSUBSCRIBE_SECRET", "SHOPIFY_APP_URL", "RESEND_TEST_RECIPIENTS"] as const;
    for (const key of envKeys) {
      savedEnv[key] = env[key];
      env[key] = validEnv[key as keyof typeof validEnv];
    }

    const luxon = await import("luxon");
    const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
    const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

    try {
      const message = {
        topic: "REMINDER_SEND",
        shop: TEST_SHOP_DOMAIN,
        shopId: TEST_SHOP_ID,
        invoiceId,
        ruleId: TEST_RULE_ID,
        offsetDays: 0,
        timezone: "Asia/Kolkata",
        webhookId: `s18_${invoiceId}_${TEST_RULE_ID}_${FIXED_TODAY}`,
        enqueuedAt: `${FIXED_TODAY}T06:30:00Z`,
      };

      await sql`SELECT pgmq.send('s6_sync', ${sql.json(message)})`;

      const { runDrain } = await import("~/services/drain/processor.server");
      const drainResult = await runDrain(sql, { batchSize: 10, timeBudgetMs: 10000 });

      expect(drainResult.skipped).toBeGreaterThanOrEqual(1);

      expect(mockFetch).not.toHaveBeenCalled();

      const queued = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
      `;
      expect(parseInt(queued[0].count, 10)).toBe(0);

      const logs = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
      `;
      expect(logs.length).toBe(0);
    } finally {
      luxonSpy.mockRestore();
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete env[key];
        else env[key] = savedEnv[key];
      }
    }
  });

  it("sends when the shop setting is on", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-on-${TEST_SUFFIX}`;
    await insertInvoice(invoiceId, "#SETTINGS-ON");

    const luxon = await import("luxon");
    const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
    const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-settings-on" }) });

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

  it("sends when the settings row is absent", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-missing-${TEST_SUFFIX}`;
    await insertInvoice(invoiceId, "#SETTINGS-MISSING");

    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;

    const luxon = await import("luxon");
    const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
    const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-settings-missing" }) });

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

  it("does not send when the buyer has opted out", async () => {
    const { sendPaymentReminder } = await import("../reminders.server");

    const invoiceId = `inv-buyer-optout-${TEST_SUFFIX}`;
    await insertInvoice(invoiceId, "#SETTINGS-BUYER-OPTOUT");

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

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID}
      `;
      expect(log.status).toBe("skipped_opted_out");
    } finally {
      luxonSpy.mockRestore();
    }
  });
});
