/**
 * DB-backed integration tests for sweep skip uninstalled shops.
 *
 * Tests:
 * 1. Part 1 positive: Installed shop with overdue invoice IS enqueued
 * 2. Part 1 skip: Uninstalled shop with overdue invoice is NOT enqueued
 * 3. Part 2 positive: Installed shop, HELD, manualHold=false, no overdue invoices IS enqueued
 * 4. Part 2 skip: Uninstalled shop, HELD, manualHold=false, no overdue invoices is NOT enqueued
 * 5. Reinstalled shop (uninstalledAt cleared) is swept again
 *
 * Uses pg16-pgmq:v1.5.1 container with all migrations applied.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("sweep skip uninstalled shops", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-uninstall";
  const TEST_SHOP_ID = `shop-uninstall-${TEST_SUFFIX}`;
  const TEST_SHOP_DOMAIN = `uninstall-test-${TEST_SUFFIX}.myshopify.com`;
  const TEST_ACCOUNT_ID = `acc-uninstall-${TEST_SUFFIX}`;
  const TEST_COMPANY_LOCATION_ID = `gid://shopify/CompanyLocation/${TEST_SUFFIX}`;
  const TEST_INVOICE_ID = `inv-uninstall-${TEST_SUFFIX}`;
  const TEST_ORDER_ID = `gid://shopify/Order/uninstall-${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);

    // Create test shop (installed by default - uninstalledAt is NULL)
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt")
      VALUES (${TEST_SHOP_ID}, ${TEST_SHOP_DOMAIN}, 'INR', NOW(), NOW())
    `;

    // Create test buyer account
    await sql`
      INSERT INTO "BuyerAccount" (
        id, "shopId", kind, "companyId", "companyLocationId", name,
        "creditLimit", "holdState", bypass, "manualHold",
        "syncPending", "syncVersion", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_ACCOUNT_ID}, ${TEST_SHOP_ID}, 'COMPANY',
        ${"co-" + TEST_SUFFIX}, ${TEST_COMPANY_LOCATION_ID},
        'Test Uninstall Account', 100000.00, 'OK', false, false,
        false, 1, NOW(), NOW()
      )
    `;

    // Create overdue invoice (due 5 days ago)
    await sql`
      INSERT INTO "Invoice" (
        id, "shopId", "buyerAccountId", "orderId", name, total, outstanding,
        status, "issuedAt", "dueAt", "createdAt", "updatedAt"
      )
      VALUES (
        ${TEST_INVOICE_ID}, ${TEST_SHOP_ID}, ${TEST_ACCOUNT_ID}, ${TEST_ORDER_ID},
        '#UNINSTALL-1', 10000.00, 10000.00, 'open',
        NOW() - INTERVAL '10 days',
        NOW() - INTERVAL '5 days',
        NOW(), NOW()
      )
    `;
  });

  afterAll(async () => {
    // Clean up queue/DLQ/archive messages
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    // Clean up processed webhooks (both prefixes)
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_resync:' + TEST_ACCOUNT_ID + '%'}`;
    // Clean up test data
    await sql`DELETE FROM "Invoice" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${TEST_SHOP_ID}`;
    await sql`DELETE FROM "Shop" WHERE id = ${TEST_SHOP_ID}`;
    await sql.end();
  });

  beforeEach(async () => {
    // Clear queue between tests
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
    // Clear processed webhooks to allow re-enqueue (both prefixes)
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;
    await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_resync:' + TEST_ACCOUNT_ID + '%'}`;
    // Reset shop to installed state
    await sql`UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${TEST_SHOP_ID}`;
    // Reset account to OK state with no manual hold
    await sql`
      UPDATE "BuyerAccount"
      SET "holdState" = 'OK', "manualHold" = false, bypass = false
      WHERE id = ${TEST_ACCOUNT_ID}
    `;
    // Reset invoice to open with outstanding
    await sql`
      UPDATE "Invoice"
      SET status = 'open', outstanding = 10000.00
      WHERE id = ${TEST_INVOICE_ID}
    `;
  });

  describe("Part 1: overdue invoices", () => {
    it("installed shop with overdue invoice IS enqueued", async () => {
      // Verify shop is installed
      const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${TEST_SHOP_ID}
      `;
      expect(shop.uninstalledAt).toBeNull();

      // Verify account is in OK state with overdue invoice
      const [account] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(account.holdState).toBe("OK");

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messages = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_recompute:%'
      `;

      expect(messages.length).toBe(1);
      expect(messages[0].buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });

    it("uninstalled shop with overdue invoice is NOT enqueued", async () => {
      // Same setup as positive test, but shop is uninstalled
      const [accountBefore] = await sql<{ holdState: string }[]>`
        SELECT "holdState" FROM "BuyerAccount" WHERE id = ${TEST_ACCOUNT_ID}
      `;
      expect(accountBefore.holdState).toBe("OK");

      // Mark shop as uninstalled
      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${TEST_SHOP_ID}
      `;

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messages = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;

      expect(messages.length).toBe(0);
    });
  });

  describe("Part 2: self-heal auto-held", () => {
    it("installed shop, HELD, manualHold=false, no overdue invoices IS enqueued", async () => {
      // Set up self-heal scenario: HELD + manualHold=false + no overdue invoices
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "manualHold" = false
        WHERE id = ${TEST_ACCOUNT_ID}
      `;
      // Clear the overdue invoice (pay it)
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0
        WHERE id = ${TEST_INVOICE_ID}
      `;

      // Verify shop is installed
      const [shop] = await sql<{ uninstalledAt: Date | null }[]>`
        SELECT "uninstalledAt" FROM "Shop" WHERE id = ${TEST_SHOP_ID}
      `;
      expect(shop.uninstalledAt).toBeNull();

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messages = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_recompute:%'
      `;

      expect(messages.length).toBe(1);
      expect(messages[0].buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });

    it("uninstalled shop, HELD, manualHold=false, no overdue invoices is NOT enqueued", async () => {
      // Same setup as positive test
      await sql`
        UPDATE "BuyerAccount"
        SET "holdState" = 'HELD', "manualHold" = false
        WHERE id = ${TEST_ACCOUNT_ID}
      `;
      await sql`
        UPDATE "Invoice"
        SET status = 'paid', outstanding = 0
        WHERE id = ${TEST_INVOICE_ID}
      `;

      // But shop is uninstalled
      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${TEST_SHOP_ID}
      `;

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const messages = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;

      expect(messages.length).toBe(0);
    });
  });

  describe("reinstall behavior", () => {
    it("reinstalled shop (uninstalledAt cleared) is swept again", async () => {
      // First, mark as uninstalled and run sweep
      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NOW() WHERE id = ${TEST_SHOP_ID}
      `;

      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const beforeReinstall = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
      `;
      expect(beforeReinstall.length).toBe(0);

      // Clear queue and processed webhooks
      await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' = ${TEST_SHOP_DOMAIN}`;
      await sql`DELETE FROM s6_processed_webhooks WHERE webhook_id LIKE ${'credit_recompute:' + TEST_ACCOUNT_ID + '%'}`;

      // Reinstall: clear uninstalledAt
      await sql`
        UPDATE "Shop" SET "uninstalledAt" = NULL WHERE id = ${TEST_SHOP_ID}
      `;

      // Run sweep again
      await sql`SELECT * FROM enqueue_credit_status_recomputes()`;

      const afterReinstall = await sql<{ buyerAccountId: string }[]>`
        SELECT message->>'buyerAccountId' AS "buyerAccountId"
        FROM pgmq.q_s6_sync
        WHERE message->>'buyerAccountId' = ${TEST_ACCOUNT_ID}
          AND message->>'webhookId' LIKE 'credit_recompute:%'
      `;

      expect(afterReinstall.length).toBe(1);
      expect(afterReinstall[0].buyerAccountId).toBe(TEST_ACCOUNT_ID);
    });
  });
});
