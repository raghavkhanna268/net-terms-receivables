/**
 * DB-backed integration tests for B2B contact payment reminders.
 *
 * Tests verify:
 * - B2B (COMPANY) accounts receive reminders to mainContactEmail
 * - No email skips with a code (no error)
 * - Opted-out B2B contact is skipped
 * - Mixed shop (B2B + tagged) sends to correct recipients
 * - Gated B2B account is skipped when PLAN_GATING_ENFORCED=true
 * - customers/redact nulls main contact fields
 * - PII leak test: no email/name/domain in safeLog output
 *
 * Uses real Postgres and real safeLog (no vi.mock of log.server.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describeWithDb("B2B contact payment reminders (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "b2b";
  const TEST_SHOP_ID = `shop-b2b-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `test-b2b-${TEST_SUFFIX}.myshopify.com`;
  const B2B_ACCOUNT_ID = `acc-b2b-${TEST_SUFFIX}`;
  const TAGGED_ACCOUNT_ID = `acc-tag-${TEST_SUFFIX}`;
  const B2B_COMPANY_ID = `gid://shopify/Company/b2b-${TEST_SUFFIX}`;
  const B2B_LOCATION_ID = `gid://shopify/CompanyLocation/loc-${TEST_SUFFIX}`;
  const B2B_CONTACT_CUSTOMER_ID = `gid://shopify/Customer/contact-${TEST_SUFFIX}`;
  const TAGGED_CUSTOMER_ID = `gid://shopify/Customer/tagged-${TEST_SUFFIX}`;
  const TEST_RULE_ID = `rule-b2b-${TEST_SUFFIX}`;

  const B2B_EMAIL = "b2b-buyer@example.com";
  const B2B_CONTACT_DISPLAY = "B2B Contact";
  const TAGGED_EMAIL = "tagged-buyer@example.com";
  const TAGGED_DISPLAY = "Tagged Buyer";

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
      INSERT INTO s18_shop_reminder_settings (shop_id, enabled, created_at, updated_at)
      VALUES (${TEST_SHOP_ID}, true, NOW(), NOW())
    `;

    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "mainContactEmail", "mainContactName", "mainContactCustomerId",
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${B2B_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${B2B_COMPANY_ID}, ${B2B_LOCATION_ID}, 'B2B Test Company',
        ${B2B_EMAIL}, ${B2B_CONTACT_DISPLAY}, ${B2B_CONTACT_CUSTOMER_ID},
        100000.00, 'OK', false, false, 30, 'explicit',
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
        ${TAGGED_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${TAGGED_CUSTOMER_ID}, 'Tagged Test Account',
        100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;

    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
      VALUES (${TEST_SHOP_ID}, ${TAGGED_CUSTOMER_ID}, ${TAGGED_EMAIL}, ${TAGGED_DISPLAY}, NOW())
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
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL, 
          "mainContactEmail" = ${B2B_EMAIL}, "mainContactName" = ${B2B_CONTACT_DISPLAY},
          "mainContactCustomerId" = ${B2B_CONTACT_CUSTOMER_ID}, gated_at = NULL,
          name = 'B2B Test Company',
          "updatedAt" = NOW()
      WHERE id = ${B2B_ACCOUNT_ID}
    `;
    await sql`
      UPDATE "BuyerAccount"
      SET "reminderOptOutAt" = NULL, "reminderOptOutSource" = NULL, gated_at = NULL, "updatedAt" = NOW()
      WHERE id = ${TAGGED_ACCOUNT_ID}
    `;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("B2B account sends to mainContactEmail", () => {
    it("sends to mainContactEmail for due invoice", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      const invoiceId = `inv-b2b-due-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-due-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-DUE', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-b2b-due" }) });

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
        expect(requestBody.to).toEqual([B2B_EMAIL]);

        const [log] = await sql<{ status: string }[]>`
          SELECT status FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(log.status).toBe("sent");
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("sends to mainContactEmail for overdue invoice", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const overdueRuleId = `rule-overdue-${TEST_SUFFIX}`;
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
        VALUES (${overdueRuleId}, ${TEST_SHOP_ID}, 7, 'email'::"ReminderChannel", true, NOW(), NOW())
      `;

      const invoiceId = `inv-b2b-overdue-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-overdue-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-OVERDUE', 15000.00, 15000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '14 days', ${FIXED_TODAY}::DATE - INTERVAL '7 days', NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-b2b-overdue" }) });

      try {
        const result = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          invoiceId,
          overdueRuleId,
          7,
          "Asia/Kolkata",
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("sent");
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        luxonSpy.mockRestore();
        await sql`DELETE FROM "ReminderLog" WHERE "ruleId" = ${overdueRuleId}`;
        await sql`DELETE FROM "ReminderRule" WHERE id = ${overdueRuleId}`;
      }
    });
  });

  describe("B2B account with no mainContactEmail", () => {
    it("skips with skip code when mainContactEmail is null", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        UPDATE "BuyerAccount"
        SET "mainContactEmail" = NULL, "mainContactName" = NULL
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      const invoiceId = `inv-b2b-noemail-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-noemail-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-NOEMAIL', 10000.00, 10000.00, 'open',
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
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("no email");
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("B2B greeting name fallback", () => {
    it("uses mainContactName when set", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      const invoiceId = `inv-b2b-contact-name-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-contact-name-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-CONTACT', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-contact-name" }) });

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

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);
        expect(requestBody.html).toContain(`Dear ${B2B_CONTACT_DISPLAY},`);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("falls back to account name when mainContactName is NULL", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        UPDATE "BuyerAccount"
        SET "mainContactName" = NULL, name = 'Test Buyer Co'
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      const invoiceId = `inv-b2b-acct-name-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-acct-name-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-ACCT', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-acct-name" }) });

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

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);
        expect(requestBody.html).toContain("Dear Test Buyer Co,");
        expect(requestBody.html).not.toContain(`Dear ${B2B_CONTACT_DISPLAY},`);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("falls back to Customer when both mainContactName and name are NULL", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        UPDATE "BuyerAccount"
        SET "mainContactName" = NULL, name = NULL
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      const invoiceId = `inv-b2b-no-name-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-no-name-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-NONAME', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-no-name" }) });

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

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);
        expect(requestBody.html).toContain("Dear Customer,");
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("treats whitespace-only mainContactName as missing", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        UPDATE "BuyerAccount"
        SET "mainContactName" = '   ', name = 'Test Contact Fallback'
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      const invoiceId = `inv-b2b-ws-name-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-ws-name-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-WS', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-ws-name" }) });

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

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);
        expect(requestBody.html).toContain("Dear Test Contact Fallback,");
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("B2B opt-out", () => {
    it("skips when B2B contact opted out", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        UPDATE "BuyerAccount"
        SET "reminderOptOutAt" = NOW(), "reminderOptOutSource" = 'link'::"ReminderOptOutSource"
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      const invoiceId = `inv-b2b-optout-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-optout-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-OPTOUT', 10000.00, 10000.00, 'open',
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
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("opted out");
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("partly paid B2B invoice", () => {
    it("sends with outstanding amount for partly paid B2B invoice", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      const invoiceId = `inv-b2b-partial-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-partial-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-PARTIAL', 10000.00, 3000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-partial" }) });

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
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("skips when B2B invoice fully paid (outstanding=0)", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      const invoiceId = `inv-b2b-paid-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-paid-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-PAID', 10000.00, 0.00, 'open',
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
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("paid");
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("mixed shop (B2B + tagged)", () => {
    it("sends to each correct recipient", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      const b2bInvoiceId = `inv-mixed-b2b-${TEST_SUFFIX}`;
      const taggedInvoiceId = `inv-mixed-tag-${TEST_SUFFIX}`;
      const b2bOrderId = `gid://shopify/Order/mixed-b2b-${TEST_SUFFIX}`;
      const taggedOrderId = `gid://shopify/Order/mixed-tag-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES 
          (${b2bInvoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${b2bOrderId},
           '#MIXED-B2B', 10000.00, 10000.00, 'open',
           ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()),
          (${taggedInvoiceId}, ${TEST_SHOP_ID}, ${TAGGED_ACCOUNT_ID}, ${taggedOrderId},
           '#MIXED-TAG', 15000.00, 15000.00, 'open',
           ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW())
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-mixed" }) });

      try {
        const b2bResult = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          b2bInvoiceId,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(b2bResult.success).toBe(true);
        expect(b2bResult.action).toBe("sent");

        const taggedResult = await sendPaymentReminder(
          sql,
          TEST_SHOP_ID,
          taggedInvoiceId,
          TEST_RULE_ID,
          0,
          "Asia/Kolkata",
          validEnv
        );

        expect(taggedResult.success).toBe(true);
        expect(taggedResult.action).toBe("sent");

        expect(mockFetch).toHaveBeenCalledTimes(2);

        const firstCall = JSON.parse(mockFetch.mock.calls[0][1].body as string);
        const secondCall = JSON.parse(mockFetch.mock.calls[1][1].body as string);

        expect(firstCall.to).toEqual([B2B_EMAIL]);
        expect(secondCall.to).toEqual([TAGGED_EMAIL]);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("tagged customer greeting name fallback", () => {
    it("uses display_name from s8_tagged_customers when set", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      const invoiceId = `inv-tag-display-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/tag-display-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TAGGED_ACCOUNT_ID}, ${orderId},
          '#TAG-DISPLAY', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-tag-display" }) });

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

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);
        expect(requestBody.html).toContain(`Dear ${TAGGED_DISPLAY},`);
      } finally {
        luxonSpy.mockRestore();
      }
    });

    it("falls back to account name when display_name is NULL", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      await sql`
        UPDATE s8_tagged_customers
        SET display_name = NULL
        WHERE shop_id = ${TEST_SHOP_ID} AND customer_id = ${TAGGED_CUSTOMER_ID}
      `;

      const invoiceId = `inv-tag-acct-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/tag-acct-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${TAGGED_ACCOUNT_ID}, ${orderId},
          '#TAG-ACCT', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);
      mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: "email-tag-acct" }) });

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

        const fetchCall = mockFetch.mock.calls[0];
        const requestBody = JSON.parse(fetchCall[1].body as string);
        expect(requestBody.html).toContain("Dear Tagged Test Account,");
      } finally {
        luxonSpy.mockRestore();
        await sql`
          UPDATE s8_tagged_customers
          SET display_name = ${TAGGED_DISPLAY}
          WHERE shop_id = ${TEST_SHOP_ID} AND customer_id = ${TAGGED_CUSTOMER_ID}
        `;
      }
    });
  });

  describe("gated B2B account", () => {
    it("skips when B2B account is gated and PLAN_GATING_ENFORCED=true", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: `${B2B_EMAIL},${TAGGED_EMAIL}`,
      };

      vi.stubEnv("PLAN_GATING_ENFORCED", "true");

      await sql`
        UPDATE "BuyerAccount"
        SET gated_at = NOW()
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      const invoiceId = `inv-b2b-gated-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/b2b-gated-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#B2B-GATED', 10000.00, 10000.00, 'open',
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
          validEnv
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("gated");
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("customers/redact for B2B main contact", () => {
    it("nulls mainContactEmail, mainContactName, mainContactCustomerId", async () => {
      const { redactCustomer } = await import("../compliance/compliance.server");

      const [before] = await sql<{ mainContactEmail: string | null; mainContactName: string | null; mainContactCustomerId: string | null }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      expect(before.mainContactEmail).toBe(B2B_EMAIL);
      expect(before.mainContactName).toBe(B2B_CONTACT_DISPLAY);
      expect(before.mainContactCustomerId).toBe(B2B_CONTACT_CUSTOMER_ID);

      const result = await redactCustomer(sql, TEST_SHOP_ID, B2B_CONTACT_CUSTOMER_ID);

      expect(result.b2bMainContactsRedacted).toBe(1);

      const [after] = await sql<{ mainContactEmail: string | null; mainContactName: string | null; mainContactCustomerId: string | null }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      expect(after.mainContactEmail).toBeNull();
      expect(after.mainContactName).toBeNull();
      expect(after.mainContactCustomerId).toBeNull();
    });
  });

  describe("PII leak test", () => {
    it("no email, name, or shop domain in safeLog output on failure path", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");
      const consoleSpy = vi.spyOn(console, "log");

      const invoiceId = `inv-pii-leak-${TEST_SUFFIX}`;
      const orderId = `gid://shopify/Order/pii-leak-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "Invoice" (
          id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
          status, "issuedAt", "dueAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${invoiceId}, ${TEST_SHOP_ID}, ${B2B_ACCOUNT_ID}, ${orderId},
          '#PII-LEAK', 10000.00, 10000.00, 'open',
          ${FIXED_TODAY}::DATE - INTERVAL '5 days', ${FIXED_TODAY}::DATE, NOW(), NOW()
        )
      `;

      const luxon = await import("luxon");
      const mockNow = luxon.DateTime.fromObject(FIXED_TODAY_IST, { zone: "Asia/Kolkata" });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: B2B_EMAIL,
      };

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

        expect(result.success).toBe(false);
        expect(result.errorCode).toBeDefined();
        expect(result.errorCode).toContain("resend");

        expect(mockFetch).toHaveBeenCalledTimes(1);

        const allLogCalls = consoleSpy.mock.calls.map(call => JSON.stringify(call)).join("\n");

        expect(allLogCalls).not.toContain(B2B_EMAIL);
        expect(allLogCalls).not.toContain(B2B_CONTACT_DISPLAY);
        expect(allLogCalls).not.toContain(TEST_SHOP_DOMAIN);
        expect(allLogCalls).not.toContain(".myshopify.com");
      } finally {
        luxonSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    });
  });

  describe("customers/redact negative case", () => {
    it("does not change contact fields when customerId does not match", async () => {
      const { redactCustomer } = await import("../compliance/compliance.server");

      const [before] = await sql<{ mainContactEmail: string | null; mainContactName: string | null; mainContactCustomerId: string | null }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      expect(before.mainContactEmail).toBe(B2B_EMAIL);
      expect(before.mainContactName).toBe(B2B_CONTACT_DISPLAY);
      expect(before.mainContactCustomerId).toBe(B2B_CONTACT_CUSTOMER_ID);

      const nonMatchingCustomerId = "gid://shopify/Customer/nonexistent-12345";
      const result = await redactCustomer(sql, TEST_SHOP_ID, nonMatchingCustomerId);

      expect(result.b2bMainContactsRedacted).toBe(0);

      const [after] = await sql<{ mainContactEmail: string | null; mainContactName: string | null; mainContactCustomerId: string | null }[]>`
        SELECT "mainContactEmail", "mainContactName", "mainContactCustomerId"
        FROM "BuyerAccount"
        WHERE id = ${B2B_ACCOUNT_ID}
      `;

      expect(after.mainContactEmail).toBe(B2B_EMAIL);
      expect(after.mainContactName).toBe(B2B_CONTACT_DISPLAY);
      expect(after.mainContactCustomerId).toBe(B2B_CONTACT_CUSTOMER_ID);
    });
  });
});
