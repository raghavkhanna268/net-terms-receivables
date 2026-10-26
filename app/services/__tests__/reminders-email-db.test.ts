/**
 * Payment Reminder Email DB Suite (S18).
 *
 * Tests reminder selection, exclusion guards, idempotency, allowlist enforcement,
 * the #490 updated_at trigger, and log redaction against a real Postgres database.
 *
 * Uses:
 * - Real Postgres via TEST_DATABASE_URL
 * - Mocked Resend (fetch boundary)
 * - vi.setSystemTime for clock control (explicit IST dates)
 * - Synthetic data: example.com emails, test-*.myshopify.com shops
 *
 * @module
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { DateTime } from "luxon";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@sentry/cloudflare", () => ({
  withSentry: vi.fn((_configFn, handler) => handler),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const FAKE_RESEND_KEY = "re_test_SYNTH_KEY_remdb_123";

describeWithDb("Reminder Email DB Suite", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-remdb";
  const SHOP_ID = `shop-remdb-${TEST_SUFFIX}`;
  const SHOP_DOMAIN = `test-remdb-${TEST_SUFFIX}.myshopify.com`;
  const ACCOUNT_ID = `acc-remdb-${TEST_SUFFIX}`;
  const CUSTOMER_ID = `cust-remdb-${TEST_SUFFIX}`;
  const TEST_EMAIL = "buyer-remdb@example.com";

  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  const validEnv = {
    RESEND_API_KEY: FAKE_RESEND_KEY,
    RESEND_FROM: "reminders-test@example.com",
    REMINDER_UNSUBSCRIBE_SECRET: "test-secret-remdb-xyz",
    SHOPIFY_APP_URL: "https://test-remdb-app.example.com",
    RESEND_TEST_RECIPIENTS: TEST_EMAIL,
    RESEND_RECIPIENT_ALLOWLIST_ENFORCED: undefined as string | undefined,
  };

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    await sql`
      INSERT INTO "Shop" (id, domain, currency, timezone, plan_key, "createdAt", "updatedAt")
      VALUES (${SHOP_ID}, ${SHOP_DOMAIN}, 'INR', 'Asia/Kolkata', 'free', NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name, "creditLimit", "holdState",
        bypass, "manualHold", "createdAt", "updatedAt"
      )
      VALUES (
        ${ACCOUNT_ID}, ${SHOP_ID}, 'TAGGED_CUSTOMER', ${CUSTOMER_ID},
        'RemDB Test Account', 100000.00, 'OK', false, false, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${SHOP_ID}, ${CUSTOMER_ID}, ${TEST_EMAIL}, 'RemDB Test Buyer', NOW())
      ON CONFLICT (shop_id, customer_id) DO UPDATE SET email = ${TEST_EMAIL}, updated_at = NOW()
    `;

    await sql`
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${SHOP_ID}, true, NOW(), NOW())
      ON CONFLICT (shop_id) DO UPDATE SET enabled = true, updated_at = NOW()
    `;
  });

  afterAll(async () => {
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${SHOP_ID}`;
    await sql.end();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockFetch.mockReset();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.RESEND_RECIPIENT_ALLOWLIST_ENFORCED;
  });

  afterEach(async () => {
    vi.useRealTimers();
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${SHOP_ID}`;
  });

  /**
   * Helper to create an invoice for testing.
   * @param suffix - Unique suffix for invoice IDs
   * @param dueAt - Due date for the invoice
   * @param opts - Additional options (status, outstanding)
   */
  async function createInvoice(
    suffix: string,
    dueAt: Date,
    opts: { status?: "open" | "paid" | "cancelled"; outstanding?: string; accountId?: string } = {}
  ): Promise<string> {
    const invoiceId = `inv-remdb-${suffix}-${TEST_SUFFIX}`;
    const orderId = `ord-remdb-${suffix}-${TEST_SUFFIX}`;
    const status = opts.status ?? "open";
    const outstanding = opts.outstanding ?? "50000.00";
    const accountId = opts.accountId ?? ACCOUNT_ID;

    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${invoiceId}, ${SHOP_ID}, ${accountId}, ${orderId},
        ${`#REMDB-${suffix}`}, 50000.00, ${outstanding}::DECIMAL(14,2),
        ${status}::"InvoiceStatus",
        ${dueAt} - INTERVAL '10 days', ${dueAt}, NOW(), NOW()
      )
    `;
    return invoiceId;
  }

  /**
   * Helper to create a reminder rule.
   * @param suffix - Unique suffix for rule ID
   * @param offsetDays - Days offset from due date
   * @param enabled - Whether the rule is enabled
   */
  async function createRule(suffix: string, offsetDays: number, enabled = true): Promise<string> {
    const ruleId = `rule-remdb-${suffix}-${TEST_SUFFIX}`;
    await sql`
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${ruleId}, ${SHOP_ID}, ${offsetDays}, 'email'::"ReminderChannel", ${enabled}, NOW(), NOW())
    `;
    return ruleId;
  }

  /**
   * Helper to set a fixed system time from IST components.
   * @param year - Year
   * @param month - Month (1-12)
   * @param day - Day of month
   * @param hour - Hour (0-23)
   * @param minute - Minute (0-59)
   */
  function setISTTime(year: number, month: number, day: number, hour: number, minute: number) {
    const dt = DateTime.fromObject(
      { year, month, day, hour, minute, second: 0 },
      { zone: "Asia/Kolkata" }
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(dt.toJSDate());
  }

  // ===========================================================================
  // Case 1: Due-soon, due-today and overdue selection at IST day boundaries
  // Guard pinned: reminders.server.ts:isReminderDueToday (line ~300)
  // ===========================================================================
  describe("Case 1: IST day boundary selection", () => {
    it("selects due-today invoice at 23:59 IST (same IST day)", async () => {
      // Guard: isReminderDueToday compares (dueAt + offsetDays) == today in shop TZ
      setISTTime(2026, 10, 30, 23, 59);
      const { isReminderDueToday } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const result = isReminderDueToday(dueAt, 0, "Asia/Kolkata");
      expect(result).toBe(true);
    });

    it("selects due-today invoice at 00:00 IST (start of IST day)", async () => {
      // Guard: isReminderDueToday compares (dueAt + offsetDays) == today in shop TZ
      setISTTime(2026, 10, 30, 0, 0);
      const { isReminderDueToday } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const result = isReminderDueToday(dueAt, 0, "Asia/Kolkata");
      expect(result).toBe(true);
    });

    it("does NOT select when UTC date differs from IST date (18:29Z = 23:59 IST Oct 29)", async () => {
      // Guard: isReminderDueToday uses shop TZ, not UTC
      // 18:29 UTC on Oct 29 = 23:59 IST on Oct 29
      setISTTime(2026, 10, 29, 23, 59);
      const { isReminderDueToday } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const result = isReminderDueToday(dueAt, 0, "Asia/Kolkata");
      expect(result).toBe(false);
    });

    it("DOES select when 18:30Z = 00:00 IST Oct 30 (IST day boundary crossed)", async () => {
      // Guard: isReminderDueToday uses shop TZ, not UTC
      // 18:30 UTC on Oct 29 = 00:00 IST on Oct 30
      setISTTime(2026, 10, 30, 0, 0);
      const { isReminderDueToday } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const result = isReminderDueToday(dueAt, 0, "Asia/Kolkata");
      expect(result).toBe(true);
    });

    it("selects due-soon invoice (offset -3) exactly 3 days before", async () => {
      // Guard: isReminderDueToday compares (dueAt + offsetDays) == today
      setISTTime(2026, 10, 27, 12, 0);
      const { isReminderDueToday } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const result = isReminderDueToday(dueAt, -3, "Asia/Kolkata");
      expect(result).toBe(true);
    });

    it("selects overdue invoice (offset +7) exactly 7 days after due", async () => {
      // Guard: isReminderDueToday compares (dueAt + offsetDays) == today
      setISTTime(2026, 11, 6, 12, 0);
      const { isReminderDueToday } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const result = isReminderDueToday(dueAt, 7, "Asia/Kolkata");
      expect(result).toBe(true);
    });

    it("full send path with exact invoice set at IST boundary", async () => {
      // Guard: sendPaymentReminder gate 7 calls isReminderDueToday
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("boundary-send", dueAt);
      const ruleId = await createRule("boundary-send", 0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-boundary-123" }),
      });

      const result = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("sent");

      const [log] = await sql<{ status: string }[]>`
        SELECT status FROM "ReminderLog"
        WHERE "shopId" = ${SHOP_ID} AND "invoiceId" = ${invoiceId}
      `;
      expect(log.status).toBe("sent");
    });
  });

  // ===========================================================================
  // Case 2: Exclusions - disabled shop, buyer opt-out, paid/voided invoices
  // Guards pinned:
  //   - reminders.server.ts:sendPaymentReminder gate 9 (shop disabled via settings check)
  //   - reminders.server.ts:sendPaymentReminder gate 10b (buyer opt-out)
  //   - reminders.server.ts:sendPaymentReminder gate 5 (invoice status)
  //   - reminders.server.ts:sendPaymentReminder gate 6 (outstanding <= 0)
  // ===========================================================================
  describe("Case 2: Exclusions", () => {
    it("skips when shop reminder settings disabled (with positive control)", async () => {
      // Guard: sendCatchupReminder gate 9 checks getShopReminderSettings
      setISTTime(2026, 10, 30, 12, 0);

      const { sendCatchupReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 29, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("shop-disabled", dueAt);
      const ruleId = await createRule("shop-disabled", 0);

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${ruleId}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
      `;

      await sql`UPDATE s18_shop_reminder_settings SET enabled = false WHERE shop_id = ${SHOP_ID}`;

      const resultDisabled = await sendCatchupReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        "log-disabled",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultDisabled.action).toBe("skipped");
      expect(resultDisabled.skipReason).toBe("Shop reminders disabled");
      expect(mockFetch).not.toHaveBeenCalled();

      await sql`UPDATE s18_shop_reminder_settings SET enabled = true WHERE shop_id = ${SHOP_ID}`;

      await sql`
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", status, "firstCappedAt")
        VALUES (gen_random_uuid()::TEXT, ${SHOP_ID}, ${ruleId}, ${invoiceId}, 'delayed'::"ReminderLogStatus", NOW())
        ON CONFLICT ("ruleId", "invoiceId") DO UPDATE SET status = 'delayed'::"ReminderLogStatus", "sentAt" = NULL
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-enabled-123" }),
      });

      const resultEnabled = await sendCatchupReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        "log-enabled",
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultEnabled.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("skips when buyer opted out (with positive control)", async () => {
      // Guard: sendPaymentReminder gate 10b calls isBuyerOptedOut
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceIdOptedOut = await createInvoice("buyer-optout", dueAt);
      const invoiceIdNotOptedOut = await createInvoice("buyer-notoptout", dueAt);
      const ruleId = await createRule("buyer-optout", 0);

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${ACCOUNT_ID}
      `;

      const resultOptedOut = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceIdOptedOut,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultOptedOut.action).toBe("skipped");
      expect(resultOptedOut.skipReason).toContain("opted out");
      expect(mockFetch).not.toHaveBeenCalled();

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL
        WHERE id = ${ACCOUNT_ID}
      `;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-noopt-123" }),
      });

      const resultNotOptedOut = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceIdNotOptedOut,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultNotOptedOut.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("skips paid invoice (with positive control)", async () => {
      // Guard: sendPaymentReminder gate 5 checks invoice.status !== "open"
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const paidInvoiceId = await createInvoice("paid-inv", dueAt, { status: "paid" });
      const openInvoiceId = await createInvoice("open-inv", dueAt, { status: "open" });
      const ruleId = await createRule("paid-test", 0);

      const resultPaid = await sendPaymentReminder(
        sql,
        SHOP_ID,
        paidInvoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultPaid.action).toBe("skipped");
      expect(resultPaid.skipReason).toContain("status is paid");
      expect(mockFetch).not.toHaveBeenCalled();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-open-123" }),
      });

      const resultOpen = await sendPaymentReminder(
        sql,
        SHOP_ID,
        openInvoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultOpen.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("skips cancelled (voided) invoice (with positive control)", async () => {
      // Guard: sendPaymentReminder gate 5 checks invoice.status !== "open"
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const voidedInvoiceId = await createInvoice("voided-inv", dueAt, { status: "cancelled" });
      const openInvoiceId = await createInvoice("open-inv-2", dueAt, { status: "open" });
      const ruleId = await createRule("voided-test", 0);

      const resultVoided = await sendPaymentReminder(
        sql,
        SHOP_ID,
        voidedInvoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultVoided.action).toBe("skipped");
      expect(resultVoided.skipReason).toContain("status is cancelled");
      expect(mockFetch).not.toHaveBeenCalled();

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-open2-123" }),
      });

      const resultOpen = await sendPaymentReminder(
        sql,
        SHOP_ID,
        openInvoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(resultOpen.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Case 3: Idempotency - running send twice for same invoice/stage/day
  // Guard pinned: reminders.server.ts:claimReminderSlot (line ~494) uses
  //               INSERT ... ON CONFLICT DO NOTHING on unique (ruleId, invoiceId)
  // ===========================================================================
  describe("Case 3: Idempotency", () => {
    it("sends exactly once when called twice for same invoice/stage/day", async () => {
      // Guard: claimReminderSlot INSERT...ON CONFLICT DO NOTHING
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("idem-test", dueAt);
      const ruleId = await createRule("idem-test", 0);

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: "resend-idem-123" }),
      });

      const result1 = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(result1.success).toBe(true);
      expect(result1.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const result2 = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      expect(result2.success).toBe(true);
      expect(result2.action).toBe("skipped");
      expect(result2.skipReason).toContain("already sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const logs = await sql<{ id: string }[]>`
        SELECT id FROM "ReminderLog"
        WHERE "shopId" = ${SHOP_ID} AND "ruleId" = ${ruleId} AND "invoiceId" = ${invoiceId}
      `;
      expect(logs.length).toBe(1);
    });
  });

  // ===========================================================================
  // Case 4: Regression guard for #490 trigger - updated_at changes on UPDATE
  // Guard pinned: prisma/migrations/20261123000000_s18_shop_reminder_settings_trigger_fix
  //               trigger: s18_shop_reminder_settings_updated_at -> update_updated_at_column()
  //               Raw SQL UPDATE without explicit updated_at must still advance it.
  // ===========================================================================
  describe("Case 4: #490 trigger regression guard", () => {
    it("raw SQL UPDATE (not setting updated_at) still advances updated_at via trigger", async () => {
      // Guard: trigger s18_shop_reminder_settings_updated_at fires on UPDATE
      // This test FAILS if the trigger is dropped because updated_at stays at seeded value.
      // NOTE: NOW() in Postgres is transaction time, not vi.setSystemTime, so we seed
      // an explicit older timestamp and compare against that.

      await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${SHOP_ID}`;

      // Seed with an explicit older timestamp (year 2020) so trigger advancement is detectable
      const seededTime = new Date("2020-01-01T00:00:00Z");
      await sql`
        INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
        VALUES (${SHOP_ID}, true, ${seededTime}, ${seededTime})
      `;

      // Verify seeded value
      const [before] = await sql<{ updatedAt: Date }[]>`
        SELECT updated_at AS "updatedAt" FROM s18_shop_reminder_settings
        WHERE shop_id = ${SHOP_ID}
      `;
      expect(before).toBeDefined();
      expect(before.updatedAt.getTime()).toBe(seededTime.getTime());

      // Raw SQL UPDATE that toggles `enabled` but does NOT set `updated_at`
      // The trigger must fire and set updated_at = NOW()
      await sql`
        UPDATE s18_shop_reminder_settings
        SET enabled = false
        WHERE shop_id = ${SHOP_ID}
      `;

      // Verify trigger fired: updated_at must be strictly greater than seeded value
      const [after] = await sql<{ updatedAt: Date }[]>`
        SELECT updated_at AS "updatedAt" FROM s18_shop_reminder_settings
        WHERE shop_id = ${SHOP_ID}
      `;
      expect(after).toBeDefined();
      expect(after.updatedAt.getTime()).toBeGreaterThan(seededTime.getTime());
    });
  });

  // ===========================================================================
  // Case 5: Allowlist enforcement
  // Guard pinned: reminders.server.ts:sendPaymentReminder gate 10d (line ~1117)
  //               uses isAllowlistEnforced and isRecipientAllowed
  //               When RESEND_RECIPIENT_ALLOWLIST_ENFORCED is absent (not "false"),
  //               the allowlist is enforced and non-allowlisted recipients are blocked.
  // ===========================================================================
  describe("Case 5: Allowlist enforcement", () => {
    it("blocks non-allowlisted recipient when allowlist enforced (env var absent)", async () => {
      // Guard: Gate 10d checks isAllowlistEnforced() && !isRecipientAllowed()
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const otherAccountId = `acc-remdb-other-${TEST_SUFFIX}`;
      const otherCustomerId = `cust-remdb-other-${TEST_SUFFIX}`;
      const nonAllowlistedEmail = "notallowed@example.com";

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "customerId", name, "holdState", "createdAt", "updatedAt"
        )
        VALUES (
          ${otherAccountId}, ${SHOP_ID}, 'TAGGED_CUSTOMER', ${otherCustomerId},
          'Other Buyer', 'OK', NOW(), NOW()
        )
        ON CONFLICT DO NOTHING
      `;

      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${SHOP_ID}, ${otherCustomerId}, ${nonAllowlistedEmail}, 'Not Allowed Buyer', NOW())
        ON CONFLICT (shop_id, customer_id) DO UPDATE SET email = ${nonAllowlistedEmail}, updated_at = NOW()
      `;

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("allowlist-block", dueAt, { accountId: otherAccountId });
      const ruleId = await createRule("allowlist-block", 0);

      const result = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        {
          ...validEnv,
          RESEND_TEST_RECIPIENTS: TEST_EMAIL,
        }
      );

      expect(result.action).toBe("skipped");
      expect(result.skipReason).toContain("not in pre-launch allowlist");
      expect(mockFetch).not.toHaveBeenCalled();

      await sql`DELETE FROM "Invoice" WHERE id = ${invoiceId}`;
      await sql`DELETE FROM s8_tagged_customers WHERE customer_id = ${otherCustomerId}`;
      await sql`DELETE FROM "BuyerAccount" WHERE id = ${otherAccountId}`;
    });

    it("allows allowlisted recipient when allowlist enforced", async () => {
      // Guard: Gate 10d checks isRecipientAllowed() - passes when email in allowlist
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("allowlist-pass", dueAt);
      const ruleId = await createRule("allowlist-pass", 0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-allowed-123" }),
      });

      const result = await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        {
          ...validEnv,
          RESEND_TEST_RECIPIENTS: TEST_EMAIL,
        }
      );

      expect(result.action).toBe("sent");
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [, fetchOpts] = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchOpts.body as string);
      expect(body.to).toContain(TEST_EMAIL);
    });
  });

  // ===========================================================================
  // Case 6: Log redaction - no email, shop domain, or money value in logs
  // Guard pinned: app/lib/log.server.ts:safeLog redactFields/redactString
  //               SENSITIVE_VALUE_PATTERNS blocks @, .myshopify.com
  //               Non-allowlisted keys have all values redacted (including numbers)
  // ===========================================================================
  describe("Case 6: Log redaction", () => {
    it("logs do not contain email address, shop domain, or money values", async () => {
      // Guard: safeLog in reminders.server.ts filters PII via SENSITIVE_VALUE_PATTERNS
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("log-redact", dueAt);
      const ruleId = await createRule("log-redact", 0);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: "resend-logtest-123" }),
      });

      await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(TEST_EMAIL);
      expect(allLogs).not.toContain("buyer-remdb@");
      expect(allLogs).not.toContain("@example.com");

      expect(allLogs).not.toContain(SHOP_DOMAIN);
      expect(allLogs).not.toContain(".myshopify.com");

      expect(allLogs).not.toContain("50000");
      expect(allLogs).not.toContain("₹50,000");
      expect(allLogs).not.toContain("50,000.00");
    });

    it("API key never appears in logs", async () => {
      // Guard: FAKE_RESEND_KEY should never leak via safeLog
      setISTTime(2026, 10, 30, 12, 0);

      const { sendPaymentReminder } = await import("../reminders.server");

      const dueAt = DateTime.fromObject(
        { year: 2026, month: 10, day: 30, hour: 0, minute: 0 },
        { zone: "Asia/Kolkata" }
      ).toJSDate();

      const invoiceId = await createInvoice("log-key", dueAt);
      const ruleId = await createRule("log-key", 0);

      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await sendPaymentReminder(
        sql,
        SHOP_ID,
        invoiceId,
        ruleId,
        0,
        "Asia/Kolkata",
        { ...validEnv, RESEND_RECIPIENT_ALLOWLIST_ENFORCED: "false" }
      );

      const allLogs = [
        ...consoleLogSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleWarnSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
        ...consoleErrorSpy.mock.calls.map((c: unknown[]) => c.join(" ")),
      ].join("\n");

      expect(allLogs).not.toContain(FAKE_RESEND_KEY);
      expect(allLogs).not.toContain("re_test_");
    });
  });
});
