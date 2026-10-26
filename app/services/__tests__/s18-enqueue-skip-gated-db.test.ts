/**
 * DB-backed integration tests for gating behavior in reminder send/catch-up.
 *
 * Design: SQL does NOT filter gated accounts. SQL enqueues all open due invoices.
 * TS (sendPaymentReminder, sendCatchupReminder) is the sole gating point,
 * checking PLAN_GATING_ENFORCED env var via isAccountActive().
 *
 * This prevents SQL and TS from disagreeing on gating policy. Trade-off:
 * a gated invoice may be re-enqueued daily, but TS drops it before any
 * Resend call, claim, or cap reservation. Re-enqueue is bounded by catch-up window.
 *
 * Clock source: These tests use the database's NOW() as the single time source.
 * The shop timezone is computed from DB's UTC hour so the business-hour check
 * in s18_enqueue_reminders() (which uses NOW()) sees a local hour of ~12.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Compute a fixed-offset Etc/GMT±N timezone where the DB's current local hour is ~12.
 * Uses DB's NOW() as the single clock source so the timezone choice aligns with the
 * business-hour check in s18_enqueue_reminders() which also uses NOW().
 * PostgreSQL uses POSIX convention where Etc/GMT+5 means UTC-5 (opposite of ISO).
 */
async function getTestTimezone(sql: ReturnType<typeof postgres>): Promise<string> {
  const [row] = await sql<{ utc_hour: number }[]>`
    SELECT EXTRACT(HOUR FROM NOW() AT TIME ZONE 'UTC')::int AS utc_hour
  `;
  const utcHour = row.utc_hour;
  const offsetToMakeNoon = utcHour - 12;
  if (offsetToMakeNoon === 0) {
    return "Etc/GMT";
  } else if (offsetToMakeNoon > 0) {
    return `Etc/GMT+${offsetToMakeNoon}`;
  } else {
    return `Etc/GMT${offsetToMakeNoon}`;
  }
}

describeWithDb("Gating: SQL enqueues all, TS gates (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-enqueue-gated";
  const TEST_SHOP_ID = `shop-enqueue-gated-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `enqueue-gated-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_GATED_ACCOUNT_ID = `acc-gated-enqueue-${TEST_SUFFIX}`;
  const TEST_ACTIVE_ACCOUNT_ID = `acc-active-enqueue-${TEST_SUFFIX}`;
  const TEST_GATED_INVOICE_ID = `inv-gated-enqueue-${TEST_SUFFIX}`;
  const TEST_ACTIVE_INVOICE_ID = `inv-active-enqueue-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-enqueue-${TEST_SUFFIX}`;
  let testTimezone: string;
  let originalEnv: string | undefined;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    testTimezone = await getTestTimezone(sql);

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
        "syncPending", "syncVersion", gated_at, "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_GATED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${'gid://shopify/Customer/gated-' + TEST_SUFFIX},
        'Gated Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACTIVE_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        NULL, NULL, ${'gid://shopify/Customer/active-' + TEST_SUFFIX},
        'Active Account', 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES 
        (${TEST_SHOP_ID}, ${'gid://shopify/Customer/gated-' + TEST_SUFFIX}, 'gated-buyer@test-reminders.example', 'Gated Buyer', NOW()),
        (${TEST_SHOP_ID}, ${'gid://shopify/Customer/active-' + TEST_SUFFIX}, 'active-buyer@test-reminders.example', 'Active Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO NOTHING
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    originalEnv = process.env.PLAN_GATING_ENFORCED;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_global_sends`;
  });

  afterEach(async () => {
    if (originalEnv !== undefined) {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = originalEnv;
    } else {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = undefined;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function createInvoiceDueToday(
    accountId: string,
    invoiceId: string,
    invoiceName: string
  ): Promise<void> {
    const orderId = `gid://shopify/Order/${invoiceId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
        ${invoiceName}, 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '5 days',
        ((NOW() AT TIME ZONE ${testTimezone})::DATE)::timestamp AT TIME ZONE ${testTimezone},
        NOW(), NOW()
      )
    `;
  }

  async function createInvoiceDueYesterday(
    accountId: string,
    invoiceId: string,
    invoiceName: string
  ): Promise<void> {
    const orderId = `gid://shopify/Order/${invoiceId}`;
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${TEST_SHOP_ID}, ${accountId}, ${orderId},
        ${invoiceName}, 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '6 days',
        ((NOW() AT TIME ZONE ${testTimezone})::DATE - INTERVAL '1 day')::timestamp AT TIME ZONE ${testTimezone},
        NOW(), NOW()
      )
    `;
  }

  async function callEnqueueAndGetInvoiceIds(): Promise<string[]> {
    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'topic' IN ('REMINDER_SEND', 'REMINDER_CATCHUP')
    `;

    return rows.map((r) => r.invoiceId);
  }

  async function setupNoonMock() {
    const luxon = await import("luxon");
    const mockNow = luxon.DateTime.fromObject({ hour: 12, minute: 0 }, { zone: testTimezone });
    return vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
  }

  describe("SQL enqueues gated accounts (TS gates)", () => {
    it("SQL enqueues gated account (TS gates)", async () => {
      await createInvoiceDueToday(
        TEST_GATED_ACCOUNT_ID,
        TEST_GATED_INVOICE_ID,
        "#GATED-DUE-1"
      );

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(TEST_GATED_INVOICE_ID);
    });

    it("SQL enqueues both gated and active account invoices", async () => {
      await createInvoiceDueToday(
        TEST_GATED_ACCOUNT_ID,
        TEST_GATED_INVOICE_ID,
        "#GATED-BOTH-1"
      );
      await createInvoiceDueToday(
        TEST_ACTIVE_ACCOUNT_ID,
        TEST_ACTIVE_INVOICE_ID,
        "#ACTIVE-BOTH-1"
      );

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(TEST_GATED_INVOICE_ID);
      expect(enqueuedIds).toContain(TEST_ACTIVE_INVOICE_ID);
      expect(enqueuedIds).toHaveLength(2);
    });
  });

  describe("TS send path gating (PLAN_GATING_ENFORCED)", () => {
    const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "gated-buyer@test-reminders.example,active-buyer@test-reminders.example" };

    it("flag false sends to gated account on send path", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";
      const { sendPaymentReminder } = await import("../reminders.server");

      const invoiceId = `inv-send-gated-false-${TEST_SUFFIX}`;
      await createInvoiceDueToday(TEST_GATED_ACCOUNT_ID, invoiceId, "#SEND-GATED-FALSE");

      const luxonSpy = await setupNoonMock();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "email-gated-send" }) });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const result = await sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, 0, testTimezone, validEnv);
        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");
        expect(mockFetch).toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("flag true skips gated account on send path with no claim/cap", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";
      const { sendPaymentReminder } = await import("../reminders.server");

      const invoiceId = `inv-send-gated-true-${TEST_SUFFIX}`;
      await createInvoiceDueToday(TEST_GATED_ACCOUNT_ID, invoiceId, "#SEND-GATED-TRUE");

      const luxonSpy = await setupNoonMock();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "should-not-send" }) });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const result = await sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, 0, testTimezone, validEnv);

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("gated");
        expect(mockFetch).not.toHaveBeenCalled();

        const [logRow] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::INT AS count FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logRow.count).toBe(0);

        const [capRow] = await sql<{ count: number }[]>`
          SELECT COALESCE(SUM(daily_count), 0)::INT AS count FROM s18_global_sends
        `;
        expect(capRow.count).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("TS catch-up path gating (PLAN_GATING_ENFORCED)", () => {
    const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "gated-buyer@test-reminders.example,active-buyer@test-reminders.example" };

    it("flag false sends to gated account on catch-up path", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";
      const { sendCatchupReminder } = await import("../reminders.server");

      const invoiceId = `inv-catchup-gated-false-${TEST_SUFFIX}`;
      const logId = `log-catchup-false-${TEST_SUFFIX}`;
      await createInvoiceDueYesterday(TEST_GATED_ACCOUNT_ID, invoiceId, "#CATCHUP-GATED-FALSE");

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (
          ${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId},
          'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day'
        )
      `;

      const luxonSpy = await setupNoonMock();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "email-catchup-gated" }) });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const result = await sendCatchupReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, logId, 0, testTimezone, validEnv);
        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");
        expect(mockFetch).toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("flag true skips gated account on catch-up path with no claim/cap", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "true";
      const { sendCatchupReminder } = await import("../reminders.server");

      const invoiceId = `inv-catchup-gated-true-${TEST_SUFFIX}`;
      const logId = `log-catchup-true-${TEST_SUFFIX}`;
      await createInvoiceDueYesterday(TEST_GATED_ACCOUNT_ID, invoiceId, "#CATCHUP-GATED-TRUE");

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (
          ${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId},
          'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day'
        )
      `;

      const luxonSpy = await setupNoonMock();
      const mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: "should-not-send" }) });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const result = await sendCatchupReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, logId, 0, testTimezone, validEnv);

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("gated");
        expect(mockFetch).not.toHaveBeenCalled();

        const [logRow] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logRow).toBeUndefined();

        const [capRow] = await sql<{ count: number }[]>`
          SELECT COALESCE(SUM(daily_count), 0)::INT AS count FROM s18_global_sends
        `;
        expect(capRow.count).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("catch-up Phase A claim under lock (BLOCKER 2 fix)", () => {
    const validEnv = { RESEND_API_KEY: "re_test_1234", RESEND_FROM: "noreply@test-reminders.example", REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake", SHOPIFY_APP_URL: "https://app.example.com", RESEND_TEST_RECIPIENTS: "gated-buyer@test-reminders.example,active-buyer@test-reminders.example" };

    it("stage 1 delayed + stage 2 due today: exactly 1 Resend call", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";
      const { sendPaymentReminder, sendCatchupReminder } = await import("../reminders.server");

      const invoiceId = `inv-race-${TEST_SUFFIX}`;
      await createInvoiceDueYesterday(TEST_ACTIVE_ACCOUNT_ID, invoiceId, "#RACE-TEST");

      const rule1Id = `rule-stage1-${TEST_SUFFIX}`;
      const rule2Id = `rule-stage2-${TEST_SUFFIX}`;
      const logId = `log-stage1-${TEST_SUFFIX}`;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES 
          (${rule1Id}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW()),
          (${rule2Id}, ${TEST_SHOP_ID}, 1, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (
          ${logId}, ${TEST_SHOP_ID}, ${rule1Id}, ${invoiceId},
          'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day'
        )
      `;

      const luxonSpy = await setupNoonMock();
      let resendCallCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        resendCallCount++;
        return { ok: true, json: async () => ({ id: `email-race-${resendCallCount}` }) };
      });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const [catchupResult, sendResult] = await Promise.all([
          sendCatchupReminder(sql, TEST_SHOP_ID, invoiceId, rule1Id, logId, 0, testTimezone, validEnv),
          sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, rule2Id, 1, testTimezone, validEnv),
        ]);

        const sentCount = [catchupResult, sendResult].filter(r => r.action === "sent").length;
        const skippedCount = [catchupResult, sendResult].filter(r => r.action === "skipped").length;

        expect(sentCount).toBe(1);
        expect(skippedCount).toBe(1);
        expect(resendCallCount).toBe(1);

        const [sentRows] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::INT AS count FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId} AND status = 'sent'::"ReminderLogStatus"
        `;
        expect(sentRows.count).toBe(1);
      } finally {
        luxonSpy.mockRestore();
        await sql`DELETE FROM "ReminderLog" WHERE "ruleId" = ${rule1Id} OR "ruleId" = ${rule2Id}`;
        await sql`DELETE FROM "ReminderRule" WHERE id = ${rule1Id} OR id = ${rule2Id}`;
      }
    });

    it("catch-up reverts claim on send failure", async () => {
      (process.env as Record<string, string | undefined>).PLAN_GATING_ENFORCED = "false";
      const { sendCatchupReminder } = await import("../reminders.server");

      const invoiceId = `inv-revert-${Date.now()}-${TEST_SUFFIX}`;
      const logId = `log-revert-${Date.now()}-${TEST_SUFFIX}`;
      await createInvoiceDueYesterday(TEST_ACTIVE_ACCOUNT_ID, invoiceId, "#REVERT-TEST");

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (
          ${logId}, ${TEST_SHOP_ID}, ${TEST_RULE_ID}, ${invoiceId},
          'delayed'::"ReminderLogStatus", NOW() - INTERVAL '1 day'
        )
      `;

      const luxonSpy = await setupNoonMock();
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Server error" });
      vi.stubGlobal("fetch", mockFetch);

      try {
        const result = await sendCatchupReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, logId, 0, testTimezone, validEnv);

        expect(result.success).toBe(false);
        expect(result.retryable).toBe(true);
        expect(mockFetch).toHaveBeenCalled();

        const [logRow] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logRow.status).toBe("delayed");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("idempotency and edge cases", () => {
    it("does not enqueue already-logged reminders even for active accounts", async () => {
      await createInvoiceDueToday(
        TEST_ACTIVE_ACCOUNT_ID,
        TEST_ACTIVE_INVOICE_ID,
        "#LOGGED-1"
      );

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt", status)
        VALUES (
          ${'log-' + TEST_SUFFIX},
          ${TEST_SHOP_ID},
          ${TEST_RULE_ID},
          ${TEST_ACTIVE_INVOICE_ID},
          NOW(),
          'sent'::"ReminderLogStatus"
        )
      `;

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(TEST_ACTIVE_INVOICE_ID);
    });

    it("does not enqueue paid invoices", async () => {
      const paidInvoiceId = `inv-paid-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/${paidInvoiceId}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${paidInvoiceId}, ${TEST_SHOP_ID}, ${TEST_ACTIVE_ACCOUNT_ID}, ${orderId},
          '#PAID-1', 10000.00, 0.00, 'paid',
          NOW() - INTERVAL '10 days',
          ((NOW() AT TIME ZONE ${testTimezone})::DATE)::timestamp AT TIME ZONE ${testTimezone},
          NOW(), NOW()
        )
      `;

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(paidInvoiceId);
    });

    it("handles shop with no accounts gracefully", async () => {
      const emptyShopId = `shop-empty-${TEST_SUFFIX}`;
      const emptyShopDomain = `empty-${TEST_SUFFIX}.myshopify.com`;

      await sql`
        INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
        VALUES (${emptyShopId}, ${emptyShopDomain}, 'INR', ${testTimezone}, 'free', NOW(), NOW())
      `;
      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${emptyShopId}, true, NOW(), NOW())
      `;
      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${'rule-empty-' + TEST_SUFFIX}, ${emptyShopId}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      try {
        await sql`SELECT public.s18_enqueue_reminders()`;

        const [result] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::INT AS count
          FROM pgmq.q_s6_sync
          WHERE message->>'shop' = ${emptyShopDomain}
        `;
        expect(result.count).toBe(0);
      } finally {
        await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${emptyShopId}`;
        await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${emptyShopId}`;
        await sql`DELETE FROM "Shop" WHERE id = ${emptyShopId}`;
      }
    });
  });
});
