/**
 * DB-backed integration tests for s18_enqueue_reminders gated account filtering.
 *
 * Tests verify:
 * 1. Gated accounts are NOT enqueued when invoices are due
 * 2. Non-gated accounts ARE enqueued when invoices are due
 * 3. When gating is OFF (gated_at is NULL for all), behavior is unchanged
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Compute a fixed-offset Etc/GMT±N timezone where current local hour is ~12.
 * PostgreSQL uses POSIX convention where Etc/GMT+5 means UTC-5 (opposite of ISO).
 */
function getTestTimezone(): string {
  const utcHour = new Date().getUTCHours();
  const offsetToMakeNoon = utcHour - 12;
  if (offsetToMakeNoon === 0) {
    return "Etc/GMT";
  } else if (offsetToMakeNoon > 0) {
    return `Etc/GMT+${offsetToMakeNoon}`;
  } else {
    return `Etc/GMT${offsetToMakeNoon}`;
  }
}

describeWithDb("s18_enqueue_reminders gated account filtering (DB)", () => {
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

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
    testTimezone = getTestTimezone();

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
  });

  afterAll(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
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

  describe("gated account filtering", () => {
    it("does NOT enqueue reminder for gated account's due invoice", async () => {
      await createInvoiceDueToday(
        TEST_GATED_ACCOUNT_ID,
        TEST_GATED_INVOICE_ID,
        "#GATED-DUE-1"
      );

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).not.toContain(TEST_GATED_INVOICE_ID);
    });

    it("DOES enqueue reminder for active (non-gated) account's due invoice", async () => {
      await createInvoiceDueToday(
        TEST_ACTIVE_ACCOUNT_ID,
        TEST_ACTIVE_INVOICE_ID,
        "#ACTIVE-DUE-1"
      );

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(TEST_ACTIVE_INVOICE_ID);
    });

    it("only enqueues active account when both have due invoices", async () => {
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

      expect(enqueuedIds).not.toContain(TEST_GATED_INVOICE_ID);
      expect(enqueuedIds).toContain(TEST_ACTIVE_INVOICE_ID);
      expect(enqueuedIds).toHaveLength(1);
    });
  });

  describe("non-gated accounts unchanged", () => {
    it("enqueues reminder for account that was never gated", async () => {
      await createInvoiceDueToday(
        TEST_ACTIVE_ACCOUNT_ID,
        TEST_ACTIVE_INVOICE_ID,
        "#NEVER-GATED-1"
      );

      const enqueuedIds = await callEnqueueAndGetInvoiceIds();

      expect(enqueuedIds).toContain(TEST_ACTIVE_INVOICE_ID);
    });

    it("cleared gated_at allows account to receive reminders again", async () => {
      await sql`
        UPDATE "BuyerAccount"
        SET gated_at = NULL
        WHERE id = ${TEST_GATED_ACCOUNT_ID}
      `;

      try {
        await createInvoiceDueToday(
          TEST_GATED_ACCOUNT_ID,
          TEST_GATED_INVOICE_ID,
          "#CLEARED-GATE-1"
        );

        const enqueuedIds = await callEnqueueAndGetInvoiceIds();

        expect(enqueuedIds).toContain(TEST_GATED_INVOICE_ID);
      } finally {
        await sql`
          UPDATE "BuyerAccount"
          SET gated_at = NOW()
          WHERE id = ${TEST_GATED_ACCOUNT_ID}
        `;
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
        INSERT INTO "ReminderLog" (id, "shopId", "ruleId", "invoiceId", "sentAt")
        VALUES (
          ${'log-' + TEST_SUFFIX},
          ${TEST_SHOP_ID},
          ${TEST_RULE_ID},
          ${TEST_ACTIVE_INVOICE_ID},
          NOW()
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
