/**
 * DB-backed integration tests for email filter in s18_enqueue_reminders() Part 3.
 *
 * These tests verify that the SQL function only enqueues invoices whose buyer has
 * a valid email, following the same resolution logic as getInvoiceForReminder:
 * - COMPANY accounts: use mainContactEmail from BuyerAccount
 * - TAGGED_CUSTOMER accounts with customerId: use email from s8_tagged_customers
 *
 * Tests cover:
 * 1. Customer path: buyer with email IS enqueued; NULL, '', '   ' emails are NOT
 * 2. Company path: same cases for B2B mainContactEmail
 * 3. Re-enable: buyer with no email is not enqueued; after email is set, next run enqueues exactly one
 * 4. Allowlist: buyer with email not on allowlist is still enqueued by SQL
 *
 * Clock source: Uses DB's NOW() as the single time source. Shop timezone computed
 * so business-hour check in s18_enqueue_reminders() sees a local hour of ~12.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

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

describeWithDb("s18_enqueue_reminders email filter (DB)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-email-filter";
  const TEST_SHOP_ID = `shop-email-filter-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `email-filter-test-${TEST_SUFFIX}.example.com`;
  const TEST_RULE_ID = `rule-email-filter-${TEST_SUFFIX}`;
  let testTimezone: string;

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
      INSERT INTO "ReminderRule" (id, "shopId", "offsetDays", channel, enabled, "createdAt", "updatedAt")
      VALUES (${TEST_RULE_ID}, ${TEST_SHOP_ID}, 0, 'email'::"ReminderChannel", true, NOW(), NOW())
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
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function createTaggedAccount(
    accountId: string,
    customerId: string,
    name: string
  ): Promise<void> {
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "customerId", name,
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${accountId}, ${TEST_SHOP_ID}, 'TAGGED_CUSTOMER',
        ${customerId}, ${name}, 100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;
  }

  async function createCompanyAccount(
    accountId: string,
    companyId: string,
    locationId: string,
    name: string,
    mainContactEmail: string | null
  ): Promise<void> {
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "mainContactEmail", "mainContactName",
        "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${accountId}, ${TEST_SHOP_ID}, 'COMPANY',
        ${companyId}, ${locationId}, ${name},
        ${mainContactEmail}, ${mainContactEmail ? 'B2B Contact' : null},
        100000.00, 'OK', false, false, 30, 'explicit',
        false, 1, NOW(), NOW()
      )
    `;
  }

  async function setTaggedCustomerEmail(
    customerId: string,
    email: string | null
  ): Promise<void> {
    if (email === null) {
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${TEST_SHOP_ID} AND customer_id = ${customerId}`;
    } else {
      await sql`
        INSERT INTO s8_tagged_customers (shop_id, customer_id, email, display_name, updated_at)
        VALUES (${TEST_SHOP_ID}, ${customerId}, ${email}, 'Test Customer', NOW())
        ON CONFLICT (shop_id, customer_id) DO UPDATE SET email = ${email}, updated_at = NOW()
      `;
    }
  }

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

  async function callEnqueueAndGetInvoiceIds(): Promise<string[]> {
    await sql`SELECT public.s18_enqueue_reminders()`;

    const rows = await sql<{ invoiceId: string }[]>`
      SELECT message->>'invoiceId' AS "invoiceId"
      FROM pgmq.q_s6_sync
      WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
        AND message->>'topic' = 'REMINDER_SEND'
    `;

    return rows.map((r) => r.invoiceId);
  }

  describe("1. Customer path (TAGGED_CUSTOMER with customerId)", () => {
    it("enqueues buyer with valid email", async () => {
      const accountId = `acc-cust-with-email-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/with-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-cust-with-email-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Customer With Email");
      await setTaggedCustomerEmail(customerId, "buyer-with-email@example.com");
      await createInvoiceDueToday(accountId, invoiceId, "#CUST-WITH-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(invoiceId);
    });

    it("does NOT enqueue buyer with NULL email", async () => {
      const accountId = `acc-cust-null-email-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/null-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-cust-null-email-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Customer Null Email");
      await setTaggedCustomerEmail(customerId, null);
      await createInvoiceDueToday(accountId, invoiceId, "#CUST-NULL-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });

    it("does NOT enqueue buyer with empty string email", async () => {
      const accountId = `acc-cust-empty-email-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/empty-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-cust-empty-email-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Customer Empty Email");
      await setTaggedCustomerEmail(customerId, "");
      await createInvoiceDueToday(accountId, invoiceId, "#CUST-EMPTY-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });

    it("does NOT enqueue buyer with whitespace-only email", async () => {
      const accountId = `acc-cust-ws-email-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/ws-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-cust-ws-email-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Customer Whitespace Email");
      await setTaggedCustomerEmail(customerId, "   ");
      await createInvoiceDueToday(accountId, invoiceId, "#CUST-WS-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });
  });

  describe("2. Company path (B2B COMPANY account)", () => {
    it("enqueues B2B buyer with valid mainContactEmail", async () => {
      const accountId = `acc-b2b-with-email-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/with-email-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/with-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-b2b-with-email-${TEST_SUFFIX}`;

      await createCompanyAccount(accountId, companyId, locationId, "B2B With Email", "b2b-buyer@example.com");
      await createInvoiceDueToday(accountId, invoiceId, "#B2B-WITH-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(invoiceId);
    });

    it("does NOT enqueue B2B buyer with NULL mainContactEmail", async () => {
      const accountId = `acc-b2b-null-email-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/null-email-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/null-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-b2b-null-email-${TEST_SUFFIX}`;

      await createCompanyAccount(accountId, companyId, locationId, "B2B Null Email", null);
      await createInvoiceDueToday(accountId, invoiceId, "#B2B-NULL-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });

    it("does NOT enqueue B2B buyer with empty string mainContactEmail", async () => {
      const accountId = `acc-b2b-empty-email-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/empty-email-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/empty-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-b2b-empty-email-${TEST_SUFFIX}`;

      await createCompanyAccount(accountId, companyId, locationId, "B2B Empty Email", "");
      await createInvoiceDueToday(accountId, invoiceId, "#B2B-EMPTY-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });

    it("does NOT enqueue B2B buyer with whitespace-only mainContactEmail", async () => {
      const accountId = `acc-b2b-ws-email-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/ws-email-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/ws-email-${TEST_SUFFIX}`;
      const invoiceId = `inv-b2b-ws-email-${TEST_SUFFIX}`;

      await createCompanyAccount(accountId, companyId, locationId, "B2B Whitespace Email", "   ");
      await createInvoiceDueToday(accountId, invoiceId, "#B2B-WS-EMAIL");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });

    it("B2B with customerId fallback: does NOT enqueue if mainContactEmail empty even if s8 has email", async () => {
      const accountId = `acc-b2b-fallback-${TEST_SUFFIX}`;
      const companyId = `gid://shopify/Company/fallback-${TEST_SUFFIX}`;
      const locationId = `gid://shopify/CompanyLocation/fallback-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/b2b-contact-${TEST_SUFFIX}`;
      const invoiceId = `inv-b2b-fallback-${TEST_SUFFIX}`;

      await sql`
        INSERT INTO "BuyerAccount" (
          id, "shopId", kind, "companyId", "companyLocationId", "customerId", name,
          "mainContactEmail", "mainContactName", "mainContactCustomerId",
          "creditLimit", "holdState", bypass, "manualHold", "defaultTermsDays", "defaultTermsSource",
          "syncPending", "syncVersion", "createdAt", "updatedAt"
        )
        VALUES (
          ${accountId}, ${TEST_SHOP_ID}, 'COMPANY',
          ${companyId}, ${locationId}, ${customerId}, 'B2B Fallback Test',
          NULL, NULL, ${customerId},
          100000.00, 'OK', false, false, 30, 'explicit',
          false, 1, NOW(), NOW()
        )
      `;
      await setTaggedCustomerEmail(customerId, "fallback-contact@example.com");
      await createInvoiceDueToday(accountId, invoiceId, "#B2B-FALLBACK");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(invoiceId);
    });
  });

  describe("3. Re-enable: email added triggers enqueue on next run", () => {
    it("no email then email added: only enqueued after email is set", async () => {
      const accountId = `acc-reenable-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/reenable-${TEST_SUFFIX}`;
      const invoiceId = `inv-reenable-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Re-enable Test");
      await setTaggedCustomerEmail(customerId, null);
      await createInvoiceDueToday(accountId, invoiceId, "#REENABLE");

      const firstRunIds = await callEnqueueAndGetInvoiceIds();
      expect(firstRunIds).not.toContain(invoiceId);

      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;

      await setTaggedCustomerEmail(customerId, "reenable-buyer@example.com");

      const secondRunIds = await callEnqueueAndGetInvoiceIds();
      expect(secondRunIds).toContain(invoiceId);

      const [countRow] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM pgmq.q_s6_sync
        WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}
          AND message->>'invoiceId' = ${invoiceId}
          AND message->>'topic' = 'REMINDER_SEND'
      `;
      expect(countRow.count).toBe(1);
    });
  });

  describe("4. Send path whitespace-only email skip", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", mockFetch);
      mockFetch.mockReset();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("send path skips whitespace-only email without consuming slot", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const accountId = `acc-ws-send-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/ws-send-${TEST_SUFFIX}`;
      const invoiceId = `inv-ws-send-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Whitespace Send Test");
      await setTaggedCustomerEmail(customerId, "   ");
      await createInvoiceDueToday(accountId, invoiceId, "#WS-SEND");

      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "any@example.com",
      };

      const luxon = await import("luxon");
      const [row] = await sql<{ today: string }[]>`
        SELECT ((NOW() AT TIME ZONE ${testTimezone})::DATE)::TEXT AS today
      `;
      const [year, month, day] = row.today.split("-").map(Number);
      const mockNow = luxon.DateTime.fromObject({ year, month, day, hour: 12, minute: 0 }, { zone: testTimezone });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result = await sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, 0, testTimezone, validEnv);

        expect(result.success).toBe(true);
        expect(result.action).toBe("skipped");
        expect(result.skipReason).toContain("no email");
        expect(mockFetch).not.toHaveBeenCalled();

        const [logCount] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logCount.count).toBe(0);
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });

  describe("5. Allowlist: SQL enqueues regardless of allowlist", () => {
    const mockFetch = vi.fn();

    beforeEach(() => {
      vi.stubGlobal("fetch", mockFetch);
      mockFetch.mockReset();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("buyer with email not on allowlist IS enqueued by SQL", async () => {
      const accountId = `acc-allowlist-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/allowlist-${TEST_SUFFIX}`;
      const invoiceId = `inv-allowlist-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Allowlist Test");
      await setTaggedCustomerEmail(customerId, "not-on-allowlist@example.com");
      await createInvoiceDueToday(accountId, invoiceId, "#ALLOWLIST");

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(invoiceId);
    });

    it("send path with allowlist enforced writes NO ReminderLog on two runs", async () => {
      const { sendPaymentReminder } = await import("../reminders.server");

      const accountId = `acc-allowlist-nolog-${TEST_SUFFIX}`;
      const customerId = `gid://shopify/Customer/allowlist-nolog-${TEST_SUFFIX}`;
      const invoiceId = `inv-allowlist-nolog-${TEST_SUFFIX}`;

      await createTaggedAccount(accountId, customerId, "Allowlist No Log Test");
      await setTaggedCustomerEmail(customerId, "not-allowlisted-buyer@example.com");
      await createInvoiceDueToday(accountId, invoiceId, "#ALLOWLIST-NOLOG");

      const validEnv = {
        RESEND_API_KEY: "re_test_1234",
        RESEND_FROM: "noreply@example.com",
        REMINDER_UNSUBSCRIBE_SECRET: "test-secret-fake",
        SHOPIFY_APP_URL: "https://app.example.com",
        RESEND_TEST_RECIPIENTS: "other-buyer@example.com",
      };

      const luxon = await import("luxon");
      const [row] = await sql<{ today: string }[]>`
        SELECT ((NOW() AT TIME ZONE ${testTimezone})::DATE)::TEXT AS today
      `;
      const [year, month, day] = row.today.split("-").map(Number);
      const mockNow = luxon.DateTime.fromObject({ year, month, day, hour: 12, minute: 0 }, { zone: testTimezone });
      const luxonSpy = vi.spyOn(luxon.DateTime, "now").mockReturnValue(mockNow as ReturnType<typeof luxon.DateTime.now>);

      try {
        const result1 = await sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, 0, testTimezone, validEnv);
        expect(result1.success).toBe(true);
        expect(result1.action).toBe("skipped");
        expect(result1.skipReason).toContain("allowlist");

        const [logCount1] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logCount1.count).toBe(0);

        const result2 = await sendPaymentReminder(sql, TEST_SHOP_ID, invoiceId, TEST_RULE_ID, 0, testTimezone, validEnv);
        expect(result2.success).toBe(true);
        expect(result2.action).toBe("skipped");
        expect(result2.skipReason).toContain("allowlist");

        const [logCount2] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM "ReminderLog"
          WHERE "shopId" = ${TEST_SHOP_ID} AND "invoiceId" = ${invoiceId}
        `;
        expect(logCount2.count).toBe(0);

        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        luxonSpy.mockRestore();
      }
    });
  });
});
