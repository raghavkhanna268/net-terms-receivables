/**
 * DB-backed integration tests for S18 payment reminder cap enforcement.
 *
 * Tests verify that reserveGlobalSendSlot and sendPaymentReminder correctly
 * enforce daily/monthly caps with atomic reservations via pg_advisory_xact_lock.
 *
 * These tests hit real Postgres and use the sequential DB project from vitest config.
 * They scope their own rows and do not truncate globally.
 *
 * Uses a FIXED date (2026-10-15) to avoid edge cases when running on the 1st of month.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describeWithDb("S18 reminder cap enforcement (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-cap-db";
  const TEST_SHOP_ID = `shop-cap-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-s18-cap-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-cap-${TEST_SUFFIX}`;
  const TEST_CUSTOMER_ID = `gid://shopify/Customer/cap-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-cap-${TEST_SUFFIX}`;

  // Use a FIXED date (Oct 15, 2026) to avoid issues when running on the 1st of month
  const FIXED_DATE = new Date("2026-10-15T12:00:00Z");
  const FIXED_DATE_STR = "2026-10-15";
  const FIXED_MONTH_STR = "2026-10";
  // Earlier day in the same month for monthly volume
  const EARLIER_DATE_STR = "2026-10-01";

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Clean up any existing rows for the fixed month before tests
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
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${TEST_CUSTOMER_ID},
        'Cap Test Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TEST_CUSTOMER_ID}, 'cap-buyer@test-example.com', 'Cap Test Buyer', NOW())
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
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;

    // Clean up all rows for the fixed month
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

    // Clean up ALL rows for the fixed month to ensure test isolation
    await sql`
      DELETE FROM s18_global_sends 
      WHERE send_key = 'global' AND send_month = ${FIXED_MONTH_STR}
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("reserveGlobalSendSlot - daily cap", () => {
    it("100 sequential reservations succeed and the 101st returns daily_cap", async () => {
      const { reserveGlobalSendSlot, DAILY_SEND_CAP } = await import("../reminders.server");
      expect(DAILY_SEND_CAP).toBe(100);

      for (let i = 1; i <= 100; i++) {
        const result = await reserveGlobalSendSlot(sql, FIXED_DATE);
        expect(result.reserved).toBe(true);
        if (result.reserved) {
          expect(result.daily).toBe(i);
        }
      }

      const result101 = await reserveGlobalSendSlot(sql, FIXED_DATE);
      expect(result101.reserved).toBe(false);
      if (!result101.reserved) {
        expect(result101.reason).toBe("daily_cap");
      }
    });

    it("N concurrent reservations starting at 99 give exactly 1 reserved", async () => {
      const { reserveGlobalSendSlot } = await import("../reminders.server");

      await sql`
        INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
        VALUES ('global', ${FIXED_DATE_STR}::DATE, ${FIXED_MONTH_STR}, 99, 0, NOW())
      `;

      const N = 20;
      const results = await Promise.all(
        Array.from({ length: N }, () => reserveGlobalSendSlot(sql, FIXED_DATE))
      );

      const reserved = results.filter((r) => r.reserved);
      const capped = results.filter((r) => !r.reserved);

      expect(reserved.length).toBe(1);
      expect(capped.length).toBe(N - 1);
      capped.forEach((r) => {
        if (!r.reserved) {
          expect(r.reason).toBe("daily_cap");
        }
      });
    });
  });

  describe("reserveGlobalSendSlot - monthly cap", () => {
    it("reservations 2996..3000 succeed and 3001 returns monthly_cap", async () => {
      const { reserveGlobalSendSlot, MONTHLY_SEND_CAP } = await import("../reminders.server");
      expect(MONTHLY_SEND_CAP).toBe(3000);

      // Put 2995 emails on an EARLIER day in the same month
      // This keeps today's daily_count at 0, so daily cap (100) isn't hit
      await sql`
        INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
        VALUES ('global', ${EARLIER_DATE_STR}::DATE, ${FIXED_MONTH_STR}, 2995, 0, NOW())
      `;

      // Reservations 2996, 2997, 2998, 2999, 3000 should succeed (5 total)
      for (let i = 2996; i <= 3000; i++) {
        const result = await reserveGlobalSendSlot(sql, FIXED_DATE);
        expect(result.reserved).toBe(true);
        if (result.reserved) {
          expect(result.monthly).toBe(i);
        }
      }

      // Reservation 3001 should fail with monthly_cap
      const result3001 = await reserveGlobalSendSlot(sql, FIXED_DATE);
      expect(result3001.reserved).toBe(false);
      if (!result3001.reserved) {
        expect(result3001.reason).toBe("monthly_cap");
      }
    });

    it("concurrent reservations at monthly boundary give exactly the remaining count", async () => {
      const { reserveGlobalSendSlot, MONTHLY_SEND_CAP } = await import("../reminders.server");
      expect(MONTHLY_SEND_CAP).toBe(3000);

      const remainingSlots = 5;
      const monthlyVolumeOnEarlierDay = MONTHLY_SEND_CAP - remainingSlots; // 2995

      // Put monthly volume on EARLIER day, keeping today's daily_count at 0
      await sql`
        INSERT INTO s18_global_sends (send_key, send_date, send_month, daily_count, monthly_count, updated_at)
        VALUES ('global', ${EARLIER_DATE_STR}::DATE, ${FIXED_MONTH_STR}, ${monthlyVolumeOnEarlierDay}, 0, NOW())
      `;

      const N = 10;
      const results = await Promise.all(
        Array.from({ length: N }, () => reserveGlobalSendSlot(sql, FIXED_DATE))
      );

      const reserved = results.filter((r) => r.reserved);
      const capped = results.filter((r) => !r.reserved);

      expect(reserved.length).toBe(remainingSlots);
      expect(capped.length).toBe(N - remainingSlots);
      capped.forEach((r) => {
        if (!r.reserved) {
          expect(r.reason).toBe("monthly_cap");
        }
      });
    });
  });

  describe("sendPaymentReminder - multiple invoices same day", () => {
    it("two different invoices on the same day both send", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-example.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "cap-buyer@test-example.com" };

      const invoiceId1 = `inv-multi-1-${TEST_SUFFIX}`;
      const invoiceId2 = `inv-multi-2-${TEST_SUFFIX}`;
      const orderId1 = `gid://shopify/Order/multi-1-${TEST_SUFFIX}`;
      const orderId2 = `gid://shopify/Order/multi-2-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${invoiceId1}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId1},
           '#MULTI-1', 10000.00, 10000.00, 'open',
           NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()),
          (${invoiceId2}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId2},
           '#MULTI-2', 20000.00, 20000.00, 'open',
           NOW() - INTERVAL '5 days', NOW(), NOW(), NOW())
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "email-1" }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "email-2" }) });

      try {
        const [result1, result2] = await Promise.all([
          sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId1, TEST_RULE_ID, 0, validEnv),
          sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId2, TEST_RULE_ID, 0, validEnv),
        ]);

        expect(result1.success).toBe(true);
        expect(result1.action).toBe("sent");
        expect(result2.success).toBe(true);
        expect(result2.action).toBe("sent");

        expect(mockFetch).toHaveBeenCalledTimes(2);

        const logs = await sql<{ invoiceId: string }[]>`
          SELECT "invoiceId" FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "ruleId" = ${TEST_RULE_ID}
        `;
        expect(logs.length).toBe(2);
        expect(logs.map((l) => l.invoiceId).sort()).toEqual([invoiceId1, invoiceId2].sort());
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("sendPaymentReminder - idempotency under concurrency", () => {
    it("concurrent sendPaymentReminder calls for the same invoice and rule give exactly 1 fetch and exactly 1 ReminderLog row", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-example.com", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "cap-buyer@test-example.com" };

      const invoiceId = `inv-idem-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/idem-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${orderId},
          '#IDEM-1', 10000.00, 10000.00, 'open',
          NOW() - INTERVAL '5 days', NOW(), NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-idem" }) });

      try {
        const N = 5;
        const results = await Promise.all(
          Array.from({ length: N }, () =>
            sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, 0, validEnv)
          )
        );

        const sent = results.filter((r) => r.action === "sent");
        const skipped = results.filter((r) => r.action === "skipped" && r.skipReason?.includes("already sent"));

        expect(sent.length).toBe(1);
        expect(skipped.length).toBe(N - 1);

        expect(mockFetch).toHaveBeenCalledTimes(1);

        const logs = await sql<{ id: string }[]>`
          SELECT id FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND "ruleId" = ${TEST_RULE_ID}
        `;
        expect(logs.length).toBe(1);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });
});
