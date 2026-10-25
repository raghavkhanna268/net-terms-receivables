/**
 * DB-backed integration test for shop/redact reinstall guard (#291).
 *
 * Verifies that shop/redact skips deletion when the shop has reinstalled
 * (uninstalledAt IS NULL) within the 48h window before the redact arrives.
 *
 * Test scenarios:
 * 1. Shop still uninstalled (uninstalledAt set): erase happens as before
 * 2. Shop reinstalled after uninstall: nothing deleted, skip log emitted, 200 returned
 * 3. Repeat redact on still-uninstalled shop: idempotent
 * 4. Two-connection test: reinstall holding Shop lock blocks redact, then redact skips
 *
 * NOTE: This test requires a running PostgreSQL instance with pgmq extension.
 * Run in the "Sequential DB" vitest project via DB_TEST_PATTERNS in vitest.config.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import postgres from "postgres";
import { sqlOptions } from "~/lib/db-light.server";
import { deleteShop } from "~/services/compliance/compliance.server";
import { LightSessionStorage } from "~/lib/session-storage-light.server";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb("shop/redact reinstall guard (#291)", () => {
  let sql: ReturnType<typeof postgres>;
  const TEST_SUFFIX = Date.now().toString(36) + "-reinst-guard";

  // Shop that is still uninstalled (should be deleted)
  const SHOP_UNINSTALLED_ID = `shop-uninstalled-${TEST_SUFFIX}`;
  const SHOP_UNINSTALLED_DOMAIN = `test-uninstalled-${TEST_SUFFIX}.myshopify.com`;

  // Shop that reinstalled (should be skipped)
  const SHOP_REINSTALLED_ID = `shop-reinstalled-${TEST_SUFFIX}`;
  const SHOP_REINSTALLED_DOMAIN = `test-reinstalled-${TEST_SUFFIX}.myshopify.com`;

  // Shop for idempotency test
  const SHOP_IDEMPOTENT_ID = `shop-idempotent-${TEST_SUFFIX}`;
  const SHOP_IDEMPOTENT_DOMAIN = `test-idempotent-${TEST_SUFFIX}.myshopify.com`;

  // Shop for race condition test
  const SHOP_RACE_ID = `shop-race-${TEST_SUFFIX}`;
  const SHOP_RACE_DOMAIN = `test-race-${TEST_SUFFIX}.myshopify.com`;

  const CUSTOMER_GID = `gid://shopify/Customer/${TEST_SUFFIX}`;

  beforeAll(async () => {
    sql = postgres(TEST_DATABASE_URL!, sqlOptions);
  });

  afterAll(async () => {
    // Cleanup test data
    const allDomains = [
      SHOP_UNINSTALLED_DOMAIN,
      SHOP_REINSTALLED_DOMAIN,
      SHOP_IDEMPOTENT_DOMAIN,
      SHOP_RACE_DOMAIN,
    ];
    const allIds = [
      SHOP_UNINSTALLED_ID,
      SHOP_REINSTALLED_ID,
      SHOP_IDEMPOTENT_ID,
      SHOP_RACE_ID,
    ];

    // Delete in reverse FK order
    await sql`DELETE FROM "Match" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "ReminderLog" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM rejected_matches WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "Payment" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "Invoice" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "ReminderRule" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "BankImport" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" IN ${sql(allIds)})`;
    await sql`DELETE FROM "BuyerAccount" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "AccountSource" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM "AuditEvent" WHERE "shopId" IN ${sql(allIds)}`;
    await sql`DELETE FROM s8_tagged_customers WHERE shop_id IN ${sql(allIds)}`;
    await sql`DELETE FROM s8_draft_orders WHERE shop_id IN ${sql(allIds)}`;
    await sql`DELETE FROM s22_data_requests WHERE shop_id IN ${sql(allIds)}`;
    await sql`DELETE FROM backstop_processed_orders WHERE shop_id IN ${sql(allIds)}`;
    await sql`DELETE FROM s18_shop_reminder_settings WHERE shop_id IN ${sql(allIds)}`;
    await sql`DELETE FROM webhook_receipts WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s10b_order_refetch_null WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_bulk_operations WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM order_outstanding_missing WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM s10b_customer_pii_fallback WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.q_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.q_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_sync WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM pgmq.a_s6_bulk WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM s6_dead_letter WHERE message->>'shop' IN ${sql(allDomains)}`;
    await sql`DELETE FROM "Session" WHERE shop IN ${sql(allDomains)}`;
    await sql`DELETE FROM "Shop" WHERE id IN ${sql(allIds)}`;
    await sql.end();
  });

  /**
   * Seed minimal shop data for a test.
   */
  async function seedShopData(
    shopId: string,
    shopDomain: string,
    uninstalled: boolean
  ): Promise<void> {
    const now = new Date();
    const uninstalledAt = uninstalled ? now : null;

    // Shop
    await sql`
      INSERT INTO "Shop" (id, domain, currency, "createdAt", "updatedAt", "uninstalledAt")
      VALUES (${shopId}, ${shopDomain}, 'INR', ${now}, ${now}, ${uninstalledAt})
    `;

    // Session
    await sql`
      INSERT INTO "Session" (id, shop, state, "isOnline", "accessToken")
      VALUES (${'offline_' + shopDomain}, ${shopDomain}, 'test-state', false, 'test-token')
    `;

    // BuyerAccount
    const accountId = `acc-${shopId}`;
    await sql`
      INSERT INTO "BuyerAccount" (id, "shopId", kind, name, "customerId", "createdAt", "updatedAt")
      VALUES (${accountId}, ${shopId}, 'TAGGED_CUSTOMER', 'Test Buyer', ${CUSTOMER_GID}, ${now}, ${now})
    `;

    // s8_tagged_customers
    await sql`
      INSERT INTO s8_tagged_customers (shop_id, customer_id, tags, tag_active, created_at, updated_at)
      VALUES (${shopId}, ${CUSTOMER_GID}, '["net-terms"]'::jsonb, true, ${now}, ${now})
    `;
  }

  /**
   * Get row counts for a shop.
   */
  async function getShopRowCounts(shopId: string, shopDomain: string): Promise<{
    shop: number;
    session: number;
    buyerAccount: number;
    taggedCustomers: number;
  }> {
    const [result] = await sql<[{
      shop: string;
      session: string;
      buyerAccount: string;
      taggedCustomers: string;
    }]>`
      SELECT
        (SELECT COUNT(*)::text FROM "Shop" WHERE id = ${shopId}) as shop,
        (SELECT COUNT(*)::text FROM "Session" WHERE shop = ${shopDomain}) as session,
        (SELECT COUNT(*)::text FROM "BuyerAccount" WHERE "shopId" = ${shopId}) as "buyerAccount",
        (SELECT COUNT(*)::text FROM s8_tagged_customers WHERE shop_id = ${shopId}) as "taggedCustomers"
    `;

    return {
      shop: parseInt(result.shop, 10),
      session: parseInt(result.session, 10),
      buyerAccount: parseInt(result.buyerAccount, 10),
      taggedCustomers: parseInt(result.taggedCustomers, 10),
    };
  }

  describe("when shop is still uninstalled (uninstalledAt set)", () => {
    beforeEach(async () => {
      await seedShopData(SHOP_UNINSTALLED_ID, SHOP_UNINSTALLED_DOMAIN, true);
    });

    afterEach(async () => {
      // Cleanup in case test fails
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_UNINSTALLED_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_UNINSTALLED_ID}`;
    });

    it("erases the shop and all data", async () => {
      // Verify data exists before
      const beforeCounts = await getShopRowCounts(SHOP_UNINSTALLED_ID, SHOP_UNINSTALLED_DOMAIN);
      expect(beforeCounts.shop).toBe(1);
      expect(beforeCounts.buyerAccount).toBe(1);
      expect(beforeCounts.taggedCustomers).toBe(1);

      // Run shop/redact
      const sessionStorage = new LightSessionStorage(sql);
      await sessionStorage.deleteAllForShop(SHOP_UNINSTALLED_DOMAIN);
      const result = await deleteShop(sql, SHOP_UNINSTALLED_DOMAIN);

      // Should delete successfully
      expect(result.deleted).toBe(true);
      expect(result.shopId).toBe(SHOP_UNINSTALLED_ID);
      expect(result.skippedReinstalled).toBe(false);

      // Verify all data is gone
      const afterCounts = await getShopRowCounts(SHOP_UNINSTALLED_ID, SHOP_UNINSTALLED_DOMAIN);
      expect(afterCounts.shop).toBe(0);
      expect(afterCounts.buyerAccount).toBe(0);
      expect(afterCounts.taggedCustomers).toBe(0);
    });
  });

  describe("when shop reinstalled after uninstall (uninstalledAt NULL)", () => {
    beforeEach(async () => {
      // Seed as installed (uninstalledAt = NULL, simulating reinstall after uninstall)
      await seedShopData(SHOP_REINSTALLED_ID, SHOP_REINSTALLED_DOMAIN, false);
    });

    afterEach(async () => {
      // Cleanup
      await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_REINSTALLED_ID}`;
      await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" = ${SHOP_REINSTALLED_ID})`;
      await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_REINSTALLED_ID}`;
      await sql`DELETE FROM "Session" WHERE shop = ${SHOP_REINSTALLED_DOMAIN}`;
      await sql`DELETE FROM "Shop" WHERE id = ${SHOP_REINSTALLED_ID}`;
    });

    it("skips deletion, returns skippedReinstalled=true, row counts unchanged", async () => {
      // Verify data exists before
      const beforeCounts = await getShopRowCounts(SHOP_REINSTALLED_ID, SHOP_REINSTALLED_DOMAIN);
      expect(beforeCounts.shop).toBe(1);
      expect(beforeCounts.buyerAccount).toBe(1);
      expect(beforeCounts.taggedCustomers).toBe(1);

      // Run shop/redact
      const sessionStorage = new LightSessionStorage(sql);
      await sessionStorage.deleteAllForShop(SHOP_REINSTALLED_DOMAIN);
      const result = await deleteShop(sql, SHOP_REINSTALLED_DOMAIN);

      // Should skip deletion
      expect(result.deleted).toBe(false);
      expect(result.shopId).toBe(SHOP_REINSTALLED_ID);
      expect(result.skippedReinstalled).toBe(true);
      expect(result.refetchNullPurged).toBe(0);
      expect(result.bulkOperationsPurged).toBe(0);

      // Verify shop data is preserved (only sessions deleted by sessionStorage)
      const afterCounts = await getShopRowCounts(SHOP_REINSTALLED_ID, SHOP_REINSTALLED_DOMAIN);
      expect(afterCounts.shop).toBe(1);
      expect(afterCounts.buyerAccount).toBe(1);
      expect(afterCounts.taggedCustomers).toBe(1);
      // Session was deleted by sessionStorage.deleteAllForShop before deleteShop
      expect(afterCounts.session).toBe(0);
    });
  });

  describe("repeat redact on still-uninstalled shop (idempotency)", () => {
    it("is idempotent: second call returns deleted=false, no throw", async () => {
      // Seed as uninstalled
      await seedShopData(SHOP_IDEMPOTENT_ID, SHOP_IDEMPOTENT_DOMAIN, true);

      // First redact
      const sessionStorage = new LightSessionStorage(sql);
      await sessionStorage.deleteAllForShop(SHOP_IDEMPOTENT_DOMAIN);
      const firstResult = await deleteShop(sql, SHOP_IDEMPOTENT_DOMAIN);
      expect(firstResult.deleted).toBe(true);
      expect(firstResult.skippedReinstalled).toBe(false);

      // Second redact (shop already gone)
      await sessionStorage.deleteAllForShop(SHOP_IDEMPOTENT_DOMAIN);
      const secondResult = await deleteShop(sql, SHOP_IDEMPOTENT_DOMAIN);
      expect(secondResult.deleted).toBe(false);
      expect(secondResult.shopId).toBeNull();
      expect(secondResult.skippedReinstalled).toBe(false);
    });
  });

  describe("race condition: reinstall holding Shop lock blocks redact, then redact skips", () => {
    it("reinstall transaction blocks redact, redact then sees reinstalled shop and skips", async () => {
      // Seed as uninstalled
      await seedShopData(SHOP_RACE_ID, SHOP_RACE_DOMAIN, true);

      // Create two separate database connections
      const sqlConn1 = postgres(TEST_DATABASE_URL!, sqlOptions);
      const sqlConn2 = postgres(TEST_DATABASE_URL!, sqlOptions);

      try {
        // Verify initial state
        const [initialShop] = await sql<[{ uninstalledAt: Date | null }]>`
          SELECT "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_RACE_ID}
        `;
        expect(initialShop.uninstalledAt).not.toBeNull();

        // Connection 1: Start reinstall transaction and hold FOR UPDATE lock
        // This simulates the after-auth reinstall clearing uninstalledAt
        const reinstallPromise = sqlConn1.begin(async (tx1) => {
          // Take FOR UPDATE lock on Shop row
          await tx1`SELECT id FROM "Shop" WHERE domain = ${SHOP_RACE_DOMAIN} FOR UPDATE`;
          
          // Simulate reinstall: clear uninstalledAt
          await tx1`
            UPDATE "Shop" SET "uninstalledAt" = NULL, "updatedAt" = NOW()
            WHERE domain = ${SHOP_RACE_DOMAIN}
          `;

          // Hold the lock for a bit to allow Connection 2 to try to acquire it
          await new Promise(resolve => setTimeout(resolve, 100));
          
          return { committed: true };
        });

        // Give Connection 1 time to acquire the lock
        await new Promise(resolve => setTimeout(resolve, 50));

        // Connection 2: Attempt shop/redact while Connection 1 holds the lock
        // This should block on the FOR UPDATE in deleteShop until Connection 1 commits
        const redactPromise = deleteShop(sqlConn2, SHOP_RACE_DOMAIN);

        // Wait for both to complete
        const [reinstallResult, redactResult] = await Promise.all([
          reinstallPromise,
          redactPromise,
        ]);

        // Reinstall should complete first and commit
        expect(reinstallResult.committed).toBe(true);

        // Redact should see the reinstalled shop (uninstalledAt = NULL) and skip
        expect(redactResult.deleted).toBe(false);
        expect(redactResult.shopId).toBe(SHOP_RACE_ID);
        expect(redactResult.skippedReinstalled).toBe(true);

        // Verify shop still exists and is marked as installed
        const [finalShop] = await sql<[{ id: string; uninstalledAt: Date | null } | undefined]>`
          SELECT id, "uninstalledAt" FROM "Shop" WHERE id = ${SHOP_RACE_ID}
        `;
        expect(finalShop).toBeDefined();
        expect(finalShop!.uninstalledAt).toBeNull();

        // Verify data is still intact
        const finalCounts = await getShopRowCounts(SHOP_RACE_ID, SHOP_RACE_DOMAIN);
        expect(finalCounts.shop).toBe(1);
        expect(finalCounts.buyerAccount).toBe(1);
        expect(finalCounts.taggedCustomers).toBe(1);
      } finally {
        // Cleanup connections
        await sqlConn1.end();
        await sqlConn2.end();

        // Cleanup test data
        await sql`DELETE FROM s8_tagged_customers WHERE shop_id = ${SHOP_RACE_ID}`;
        await sql`DELETE FROM "PayerAlias" WHERE "buyerAccountId" IN (SELECT id FROM "BuyerAccount" WHERE "shopId" = ${SHOP_RACE_ID})`;
        await sql`DELETE FROM "BuyerAccount" WHERE "shopId" = ${SHOP_RACE_ID}`;
        await sql`DELETE FROM "Session" WHERE shop = ${SHOP_RACE_DOMAIN}`;
        await sql`DELETE FROM "Shop" WHERE id = ${SHOP_RACE_ID}`;
      }
    });
  });
});
